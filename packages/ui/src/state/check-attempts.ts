import { useEffect, useState } from 'react'

import type { BoardEvidence, FlowCheckAttempt, FlowExecution } from '@harnessdesk/protocol'

import { useStore } from './context'

type Attempts = ReadonlyMap<number, readonly FlowCheckAttempt[]>

/** The cards of a Run whose role is a check. A Run on the old format has none this read answers for. */
const checkCardsOf = (execution: FlowExecution): readonly number[] => {
  if (execution.document.format !== 'agents') return []
  const checks = new Set(execution.document.flow.roles.filter(role => role.kind === 'check').map(role => role.id))
  return execution.rounds.filter(round => checks.has(round.role)).flatMap(round => round.cards)
}

/**
 * What says a check card may have another result to read: its operation (a
 * retry starts, a check ends) and the ids of the check results the board holds
 * for it (a new result lands). Nothing else on the board moves this: a refresh
 * that only stamps it again, a pull request, a diff.
 */
const changedBy = (execution: FlowExecution, evidence: BoardEvidence | undefined, cards: readonly number[]): string =>
  cards.map(card => [
    card,
    [...execution.operations].reverse().find(one => one.kind === 'check' && one.card === card)?.state ?? '',
    evidence?.cards.find(one => one.card === card)?.facts.flatMap(view => view.record.fact.kind === 'check' ? [view.record.id] : []).join(',') ?? '',
  ].join(':')).join('|')

interface Held {
  readonly run: string | null
  readonly key: string
  readonly attempts: Attempts
  readonly incomplete: ReadonlySet<number>
  readonly status: 'ok' | 'failed'
}

/**
 * What the desk recorded each time this Run's check cards ran
 * (`flow/check/attempts`), read while the Run is on show and read again when a
 * check's operation or its results change — a retry's result arrives as new
 * evidence, so the list never needs polling.
 *
 * `attempts` holds only the Run it was read for, and keeps what it has when a
 * later read fails: `read` then says `failed`, and says `reading` until the first
 * answer lands, so a surface never calls a check's attempts none before the desk
 * has been asked. `nonce` is how a *Try again* asks again.
 */
export const useCheckAttempts = ({ execution, evidence, active, nonce = 0 }: {
  readonly execution: FlowExecution | undefined
  readonly evidence: BoardEvidence | undefined
  readonly active: boolean
  readonly nonce?: number
}): { readonly attempts: Attempts | undefined; readonly incomplete: ReadonlySet<number>; readonly read: 'reading' | 'failed' | undefined } => {
  const store = useStore()
  const cards = active && execution ? checkCardsOf(execution) : []
  const wants = active && execution !== undefined && cards.length > 0
  const key = execution ? `${execution.id}|${changedBy(execution, evidence, cards)}` : ''
  const [held, setHeld] = useState<Held>({ run: null, key: '', attempts: new Map(), incomplete: new Set(), status: 'ok' })
  useEffect(() => {
    if (!wants) return
    const run = execution.id
    let live = true
    void Promise.allSettled(cards.map(async card => [card, await store.readCheckAttempts(run, card)] as const)).then(results => {
      if (!live) return
      setHeld(was => {
        const attempts = new Map(was.run === run ? was.attempts : [])
        const incomplete = new Set(was.run === run ? was.incomplete : [])
        let failed = false
        for (const one of results) {
          if (one.status === 'fulfilled') {
            const [card, read] = one.value
            if (read.complete) {
              attempts.set(card, read.attempts)
              incomplete.delete(card)
            } else {
              incomplete.add(card)
              const known = new Map((attempts.get(card) ?? []).map(attempt => [attempt.id, attempt]))
              for (const attempt of read.attempts) known.set(attempt.id, attempt)
              attempts.set(card, [...known.values()].sort((a, b) => a.at - b.at).map(attempt => ({ ...attempt, n: null })))
            }
          } else failed = true
        }
        return { run, key, attempts, incomplete, status: failed ? 'failed' : 'ok' }
      })
    })
    return () => { live = false }
  }, [store, wants, key, nonce])
  if (!wants) return { attempts: undefined, incomplete: new Set(), read: undefined }
  if (held.run !== execution.id) return { attempts: undefined, incomplete: new Set(), read: 'reading' }
  const missing = cards.some(card => !held.attempts.has(card))
  if (missing && held.key !== key) return { attempts: held.attempts, incomplete: held.incomplete, read: 'reading' }
  if (held.status === 'failed') return { attempts: held.attempts, incomplete: held.incomplete, read: 'failed' }
  if (missing) return { attempts: held.attempts, incomplete: held.incomplete, read: 'reading' }
  return { attempts: held.attempts, incomplete: held.incomplete, read: undefined }
}
