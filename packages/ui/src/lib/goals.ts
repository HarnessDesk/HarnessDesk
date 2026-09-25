import type { Goal, GoalActivity } from '@harnessdesk/protocol'

import { systemNotificationOn } from './system-notifications'

export interface GoalRow {
  readonly goal: Goal
  readonly activity: GoalActivity | null
}

const newestFirst = (a: GoalRow, b: GoalRow): number =>
  b.goal.updatedAt - a.goal.updatedAt || a.goal.id.localeCompare(b.goal.id)

export const projectGoals = (root: string, rows: readonly GoalRow[]): {
  open: GoalRow[]
  wrapped: GoalRow[]
} => {
  const matching = rows.filter(({ goal }) => goal.root === root).sort(newestFirst)
  return {
    open: matching.filter(({ goal }) => goal.state !== 'wrapped'),
    wrapped: matching.filter(({ goal }) => goal.state === 'wrapped'),
  }
}

export const goalWords = (row: GoalRow): {
  label: string
  tone: 'neutral' | 'brand' | 'warning' | 'info'
} => {
  if (row.goal.state === 'wrapped') return { label: 'Wrapped', tone: 'neutral' }
  if (row.goal.state === 'wrapping') return { label: 'Wrapping', tone: 'info' }
  if (row.activity === 'needs-you') return { label: 'Needs you', tone: 'warning' }
  if (row.activity === 'ready-to-wrap') return { label: 'Ready to wrap', tone: 'brand' }
  return { label: 'Working', tone: 'info' }
}

/**
 * What a Goal is called wherever it is named — the header, the sidebar, a
 * "Needs you" row. A person's Goal is its sentence. A trigger's Goal carries
 * a sentence the host builds from validated scalars only ("Issue #42, from
 * trigger triage-issue"): its subject is the name, and the trigger's id is
 * the desk's own bookkeeping, which the origin chip beside it already
 * answers for. The forge's own title is never in it — the host keeps no copy
 * of a subject's prose (`docs/data-boundaries.md`) — so "Issue #42" is the
 * whole name.
 */
export const goalName = (goal: Pick<Goal, 'sentence' | 'origin'>): string => {
  if (goal.origin.kind !== 'trigger') return goal.sentence
  const suffix = `, from trigger ${goal.origin.trigger}`
  return goal.sentence.endsWith(suffix) ? goal.sentence.slice(0, -suffix.length) : goal.sentence
}

export const goalActions = (goal: Goal): { disabled: boolean; reason: string | null } => {
  if (goal.state === 'wrapped') {
    return { disabled: true, reason: 'This Goal is wrapped. Its receipt is kept here.' }
  }
  if (goal.state === 'wrapping') {
    return { disabled: true, reason: 'The desk is finishing this receipt.' }
  }
  return { disabled: false, reason: null }
}

export const goalNotification = (
  previous: GoalRow | null,
  next: GoalRow,
  prefs: Readonly<Record<string, boolean>>,
  focused: boolean,
): {
  kind: 'goalNeedsYou' | 'goalReadyToWrap'
  goal: string
  title: string
  body: string
} | null => {
  if (
    previous === null || focused || previous.goal.id !== next.goal.id ||
    previous.activity === next.activity || next.goal.state !== 'open'
  ) return null
  if (next.activity === 'needs-you' && systemNotificationOn(prefs, 'goalNeedsYou')) {
    return { kind: 'goalNeedsYou', goal: next.goal.id, title: 'A Goal needs you', body: next.goal.sentence }
  }
  if (next.activity === 'ready-to-wrap' && systemNotificationOn(prefs, 'goalReadyToWrap')) {
    return { kind: 'goalReadyToWrap', goal: next.goal.id, title: 'A Goal is ready to wrap', body: next.goal.sentence }
  }
  return null
}
