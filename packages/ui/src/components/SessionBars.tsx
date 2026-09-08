import { useEffect, useMemo, useState } from 'react'

import { allItems, currentTurn, type FileChangeItem, type Session } from '@harnessdesk/protocol'

import { elapsedSince } from '../lib/clock'
import { useActiveSession, useSessionKey, useSnapshot, useStore } from '../state/context'
import { CheckIcon, CrossIcon, DiffIcon, GoalIcon, TerminalIcon } from './Icons'
import styles from './SessionBars.module.css'

/**
 * The ambient state around a conversation: the standing goal, work still
 * running, and what the last turn produced. Context pressure is the ring in
 * the composer (`ContextUsage`).
 *
 * All of it is derived from the session rather than tracked separately, so it
 * cannot drift from the transcript it describes.
 */

const STATUS_LABEL: Record<string, string> = {
  active: 'in progress',
  paused: 'paused',
  blocked: 'blocked',
  usageLimited: 'usage limit',
  budgetLimited: 'budget spent',
  complete: 'done',
}

export const GoalBar = () => {
  const store = useStore()
  const session = useActiveSession()
  const goal = session?.goal
  if (!goal) return null

  const budget =
    goal.tokenBudget && goal.tokenBudget > 0
      ? `${Math.round((goal.tokensUsed / goal.tokenBudget) * 100)}% of budget`
      : `${goal.tokensUsed.toLocaleString()} tokens`

  return (
    <div className={styles.goal}>
      <GoalIcon className={styles.goalIcon} size={14} />
      <span className={styles.goalText} title={goal.objective}>
        {goal.objective}
      </span>
      <span className={styles.goalBudget}>{budget}</span>
      <span className={styles.goalStatus} data-status={goal.status}>
        {STATUS_LABEL[goal.status] ?? goal.status}
      </span>
      <button
        type="button"
        className={styles.goalClear}
        aria-label="Clear goal"
        title="Clear this goal"
        onClick={() => void store.setGoal(null)}
      >
        <CrossIcon size={11} />
      </button>
    </div>
  )
}

const elapsed = (since: number | undefined, now: number): string => {
  const span = elapsedSince(since, now)
  if (span === null) return ''
  const seconds = Math.round(span / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/**
 * Commands still running in the live turn.
 *
 * Derived from in-flight command items rather than tracked, so it cannot
 * disagree with the transcript it describes. This is *not* the background-task
 * panel and deliberately overlaps with none of it: these commands belong to
 * the turn and are gone when it ends, where a background task is precisely the
 * work that is not. A command that has become a background task — the runtime
 * says so by pointing a task at its item — is left to that panel, which can
 * stop it and knows when it really ended.
 *
 * That distinction has to be visible, not just true. The two panels below it
 * are cards with a headline and controls, because their contents are yours to
 * act on and outlast the turn; this is bare text with neither, because it is
 * narration of the turn happening right now and will be gone without you
 * touching it. Its own headline says which of the three it is.
 */
export const JobsBar = () => {
  const session = useActiveSession()
  const key = useSessionKey()
  const snapshot = useSnapshot()
  const [now, setNow] = useState(() => Date.now())

  const backgrounded = useMemo(() => {
    const tasks = key ? snapshot.tasks.get(key) : undefined
    return new Set((tasks ?? []).map((task) => task.itemId).filter(Boolean))
  }, [key, snapshot.tasks])

  const running = useMemo(() => {
    const turn = session ? currentTurn(session) : undefined
    if (!turn || turn.status !== 'inProgress') return []
    return turn.items.filter(
      (item): item is Extract<typeof item, { type: 'command' }> =>
        item.type === 'command' && item.status === 'inProgress' && !backgrounded.has(item.id),
    )
  }, [backgrounded, session])

  // Only tick while something is actually running.
  useEffect(() => {
    if (running.length === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running.length])

  if (running.length === 0) return null

  return (
    <div className={styles.jobs}>
      <div className={styles.jobsHead}>
        {running.length === 1 ? '1 command' : `${running.length} commands`} running in this turn
      </div>
      {running.map((item) => (
        <div key={item.id} className={styles.job}>
          <span className={styles.spinner} />
          <TerminalIcon size={12} className={styles.jobIcon} />
          <span className={styles.jobCommand} title={item.command}>
            {item.command}
          </span>
          <span className={styles.jobElapsed}>{elapsed(item.startedAt, now)}</span>
        </div>
      ))}
    </div>
  )
}

/** Files the session produced, collected from every file-change item. */
export const useDeliverables = (session: Session | null) =>
  useMemo(() => {
    if (!session) return []
    const byPath = new Map<string, { path: string; kind: string; added: number; removed: number }>()
    for (const item of allItems(session)) {
      if (item.type !== 'fileChange') continue
      for (const change of (item as FileChangeItem).changes) {
        const counts = countLines(change.diff)
        const existing = byPath.get(change.path)
        byPath.set(change.path, {
          path: change.path,
          kind: change.kind.type,
          added: (existing?.added ?? 0) + counts.added,
          removed: (existing?.removed ?? 0) + counts.removed,
        })
      }
    }
    return [...byPath.values()]
  }, [session])

const countLines = (diff: string): { added: number; removed: number } => {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

export const Deliverables = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const session = useActiveSession()
  const files = useDeliverables(session)

  if (files.length === 0) return null

  const root = session?.cwd
  const relative = (path: string): string => {
    if (!root) return path
    const prefix = root.endsWith('/') ? root : `${root}/`
    return path.startsWith(prefix) ? path.slice(prefix.length) : path
  }

  return (
    <div className={styles.deliverables}>
      <DiffIcon size={12} />
      {files.length} file{files.length === 1 ? '' : 's'} changed
      {files.slice(0, 8).map((file) => (
        <button
          key={file.path}
          type="button"
          className={styles.deliverable}
          title={file.path}
          onClick={() => {
            if (snapshot.detailsTab !== 'changes') store.setDetailsTab('changes')
          }}
        >
          {file.kind === 'add' ? <CheckIcon size={10} /> : null}
          {relative(file.path).split('/').pop()}
          {file.added > 0 && <span className={styles.deliverableAdded}>+{file.added}</span>}
          {file.removed > 0 && <span className={styles.deliverableRemoved}>−{file.removed}</span>}
        </button>
      ))}
      {files.length > 8 && <span>and {files.length - 8} more</span>}
    </div>
  )
}
