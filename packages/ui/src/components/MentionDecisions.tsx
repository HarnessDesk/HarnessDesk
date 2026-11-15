import { useCallback, useEffect, useRef, useState } from 'react'

import type { TriggerDecision, TriggerDecisionsPage, TriggerMode, TriggerUnconfirmedStop, TriggerWorkThread } from '@harnessdesk/protocol'

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
  readonly reviewStop: (stop: string) => Promise<void>
}

export const useMentionTriage = (root: string, id: string, enabled: boolean, revision: number | undefined, initialPage?: TriggerDecisionsPage): MentionTriageState => {
  const store = useStore()
  const [page, setPage] = useState<TriggerDecisionsPage | null>(initialPage ?? null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const identity = useRef({ root, id })

  const reload = useCallback((): void => {
    const epoch = ++generation.current
    store.triggerDecisions(root, id).then(
      (next) => { if (generation.current === epoch) { setPage(next); setProblem(null) } },
      (error: unknown) => { if (generation.current === epoch) setProblem(error instanceof Error ? error.message : String(error)) },
    )
  }, [store, root, id])

  useEffect(() => {
    if (identity.current.root !== root || identity.current.id !== id) {
      identity.current = { root, id }
      setPage(null); setProblem(null)
    }
    setBusy(false)
    if (!enabled) {
      setPage(null)
      return
    }
    reload()
    return () => { generation.current++ }
  }, [enabled, reload, revision, root, id])

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
    reviewStop: async (stop) => {
      const epoch = ++generation.current
      setBusy(true); setProblem(null)
      try {
        const reviewed = await store.reviewTriggerStop(root, id, stop)
        if (generation.current !== epoch) return
        if (reviewed.id !== stop || reviewed.state !== 'reviewed') throw new Error('The review could not be confirmed.')
        setPage(current => current ? { ...current, unconfirmedStops: current.unconfirmedStops?.map(item => item.id === stop ? reviewed : item) } : current)
      } catch (error) {
        if (generation.current === epoch) setProblem(error instanceof Error ? error.message : String(error))
      } finally {
        if (generation.current === epoch) setBusy(false)
      }
    },
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

const StopRow = ({ stop, busy, onReview }: { readonly stop: TriggerUnconfirmedStop; readonly busy: boolean; readonly onReview: () => void }) => {
  const excerpt = sanitizeText(stop.excerpt)
  const title = stop.state === 'inFlight' ? 'Stopping…' : stop.state === 'reviewed' ? 'Reviewed · Stop unconfirmed' : 'Stop unconfirmed'
  return <ListRow density="compact" title={<>{title} {stop.state !== 'reviewed' && <Chip tone="warning">Check the work</Chip>}</>} wrapTitle
    subtitle={`${stop.project} · ${stop.repository} · ${triageThreadWords(stop.thread)} · ${stop.author ?? 'Someone'}${excerpt ? ` · “${excerpt}”` : ''} — ${stop.summary}${stop.state === 'unconfirmed' ? ' Check the work before taking further action.' : ''}`}
    wrapSubtitle
    trail={stop.state === 'unconfirmed' ? <Button variant="ghost" size="sm" disabled={busy} onClick={onReview} title="Acknowledge this uncertainty; this does not retry the stop">Mark reviewed</Button> : undefined} />
}

/** Persistent attention is separate from ordinary decision history. */
export const MentionStopAttention = ({ triage, expanded }: { readonly triage: MentionTriageState; readonly expanded: boolean }) => <>
  {triage.page?.stopHistoryFull && <ListRow density="compact" title="Stop history cannot safely hold this request. Stop the work directly before taking further action." wrapTitle />}
  {!expanded && triage.problem && triage.page && <ListRow density="compact" title="That did not go through" subtitle={triage.problem} wrapSubtitle />}
  {!expanded && triage.page?.unconfirmedStops?.filter(stop => stop.state !== 'reviewed').map(stop =>
    <StopRow key={stop.id} stop={stop} busy={triage.busy} onReview={() => void triage.reviewStop(stop.id)} />)}
</>

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
export const MentionDecisionRows = ({ triage, stopsOnly = false }: { readonly triage: MentionTriageState; readonly stopsOnly?: boolean }) => {
  const { page, problem, busy } = triage
  if (problem && !page) return <ListRow density="compact" title="Its decisions could not be read" subtitle={problem} wrapSubtitle />
  if (!page) return <ListRow density="compact" title="Reading its decisions…" />
  if (stopsOnly) return <>
    {problem && <ListRow density="compact" title="That did not go through" subtitle={problem} wrapSubtitle />}
    {page.unconfirmedStops?.map(stop => <StopRow key={stop.id} stop={stop} busy={busy} onReview={() => void triage.reviewStop(stop.id)} />)}
  </>
  return (
    <>
      {problem && <ListRow density="compact" title="That did not go through" subtitle={problem} wrapSubtitle />}
      {page.unconfirmedStops?.map(stop => <StopRow key={stop.id} stop={stop} busy={busy} onReview={() => void triage.reviewStop(stop.id)} />)}
      {page.threads.map((thread) => (
        <ListRow
          key={thread.id}
          density="compact"
          title={<>{`Work on ${triageThreadWords(thread.origin)}`} {thread.state === 'open' ? <Chip tone="neutral">Open</Chip> : null}</>}
          subtitle={threadFacts(thread)}
        />
      ))}
      {page.decisions.length === 0 && !page.unconfirmedStops?.length && !page.stopHistoryFull
        ? <EmptyState variant="row" title="No mentions yet" />
        : page.decisions.map((decision) => (
          <DecisionRow key={decision.id} decision={decision} busy={busy} onReevaluate={() => void triage.reevaluate(decision.id)} />
        ))}
    </>
  )
}
