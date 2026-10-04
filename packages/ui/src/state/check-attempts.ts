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
  readonly attempts: Attempts
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
}): { readonly attempts: Attempts | undefined; readonly read: 'reading' | 'failed' | undefined } => {
  const store = useStore()
  const cards = active && execution ? checkCardsOf(execution) : []
  const wants = active && execution !== undefined && cards.length > 0
  const key = execution ? `${execution.id}|${changedBy(execution, evidence, cards)}` : ''
  const [held, setHeld] = useState<Held>({ run: null, attempts: new Map(), status: 'ok' })
  useEffect(() => {
    if (!wants) return
    const run = execution.id
    let live = true
    void Promise.allSettled(cards.map(async card => [card, await store.readCheckAttempts(run, card)] as const)).then(results => {
      if (!live) return
      setHeld(was => {
        const attempts = new Map(was.run === run ? was.attempts : [])
        let failed = false
        for (const one of results) {
          if (one.status === 'fulfilled') attempts.set(one.value[0], one.value[1])
          else failed = true
        }
        return { run, attempts, status: failed ? 'failed' : 'ok' }
      })
    })
    return () => { live = false }
  }, [store, wants, key, nonce])
  if (!wants) return { attempts: undefined, read: undefined }
  if (held.run !== execution.id) return { attempts: undefined, read: 'reading' }
  return { attempts: held.attempts, read: held.status === 'failed' ? 'failed' : undefined }
}
