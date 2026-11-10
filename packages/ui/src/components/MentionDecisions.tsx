import { useCallback, useEffect, useRef, useState } from 'react'

import type { TriggerDecision, TriggerDecisionsPage, TriggerMode, TriggerWorkThread } from '@harnessdesk/protocol'

import { Button, Chip, EmptyState, ListRow } from '../design'
import { triageThreadWords, triageWords } from '../lib/intake'
import { sanitizeText } from '../lib/sanitize'
import { useStore } from '../state/context'

/**
 * A mention trigger's triage on this machine: its mode, every decision it
 * made with Re-evaluate, and the threads of work it opened.
 *
 * A decision's excerpt is the comment's own words — someone else's text,
 * shown as plain text and never as markup or a link. Everything else on a
 * row is the host's own sentence.
 */
export interface MentionTriageState {
  readonly page: TriggerDecisionsPage | null
  readonly problem: string | null
  readonly busy: boolean
  readonly reload: () => void
  readonly setMode: (mode: TriggerMode) => Promise<void>
  readonly reevaluate: (decision: string) => Promise<void>
}

export const useMentionTriage = (root: string, id: string, enabled: boolean, revision: number | undefined): MentionTriageState => {
  const store = useStore()
  const [page, setPage] = useState<TriggerDecisionsPage | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)

  const reload = useCallback((): void => {
    const epoch = ++generation.current
    store.triggerDecisions(root, id).then(
      (next) => { if (generation.current === epoch) { setPage(next); setProblem(null) } },
      (error: unknown) => { if (generation.current === epoch) setProblem(error instanceof Error ? error.message : String(error)) },
    )
  }, [store, root, id])

  useEffect(() => {
    if (!enabled) {
      setPage(null)
      return
    }
    reload()
    return () => { generation.current++ }
  }, [enabled, reload, revision])

  const act = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      await work()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return {
    page, problem, busy, reload,
    setMode: (mode) => act(async () => {
      generation.current++
      setPage(await store.setTriggerMode(root, id, mode))
    }),
    reevaluate: (decision) => act(async () => {
      await store.reevaluateTriggerDecision(root, id, decision)
      reload()
    }),
  }
}

const TONE = {
  accept: 'info', ignore: 'neutral', stop: 'neutral', ask: 'warning',
} as const

const DecisionRow = ({ decision, busy, onReevaluate }: { readonly decision: TriggerDecision; readonly busy: boolean; readonly onReevaluate: () => void }) => {
  const excerpt = sanitizeText(decision.comment.excerpt)
  const who = decision.comment.author ?? 'Someone'
  return (
    <ListRow
      density="compact"
      title={<>{`${triageThreadWords(decision.thread)} · ${who}`} <Chip tone={decision.decision === 'accept' && decision.acted ? 'success' : TONE[decision.decision]}>{triageWords(decision)}</Chip></>}
      wrapTitle
      subtitle={excerpt ? `“${excerpt}” — ${decision.reason}` : decision.reason}
      wrapSubtitle
      trail={(
        <Button variant="ghost" size="sm" disabled={busy} onClick={onReevaluate} title="Judge this comment again, as it reads now">
          Re-evaluate
        </Button>
      )}
    />
  )
}

const threadFacts = (thread: TriggerWorkThread): string => {
  const pulls = thread.links.pulls.length
  const parts = [
    pulls === 0 ? 'No pull request yet' : `${pulls} pull request${pulls === 1 ? '' : 's'}`,
    thread.resumes > 0 ? `resumed ${thread.resumes} time${thread.resumes === 1 ? '' : 's'}` : null,
    thread.state === 'closed' && thread.closed ? (thread.closed.reason === 'merged' ? 'merged' : thread.closed.reason === 'stopped' ? 'stopped' : 'closed') : null,
  ]
  return parts.filter(Boolean).join(' · ')
}

/** The rows a mention trigger's history shows above its firings. */
export const MentionDecisionRows = ({ triage }: { readonly triage: MentionTriageState }) => {
  const { page, problem, busy } = triage
  if (problem && !page) return <ListRow density="compact" title="Its decisions could not be read" subtitle={problem} wrapSubtitle />
  if (!page) return <ListRow density="compact" title="Reading its decisions…" />
  return (
    <>
      {problem && <ListRow density="compact" title="That did not go through" subtitle={problem} wrapSubtitle />}
      {page.threads.map((thread) => (
        <ListRow
          key={thread.id}
          density="compact"
          title={<>{`Work on ${triageThreadWords(thread.origin)}`} {thread.state === 'open' ? <Chip tone="neutral">Open</Chip> : null}</>}
          subtitle={threadFacts(thread)}
        />
      ))}
      {page.decisions.length === 0
        ? <EmptyState variant="row" title="No mentions yet" />
        : page.decisions.map((decision) => (
          <DecisionRow key={decision.id} decision={decision} busy={busy} onReevaluate={() => void triage.reevaluate(decision.id)} />
        ))}
    </>
  )
}
