import { LEAD_AUTONOMY_DEFAULTS, type LeadAutonomyKind, type LeadAutonomyMode } from '@harnessdesk/protocol'
import type { LeadState } from './state.js'

/** What the person chose for one kind of unasked work; Act until they choose otherwise. */
export const leadAutonomyMode = (state: Pick<LeadState, 'autonomy'>, kind: LeadAutonomyKind): LeadAutonomyMode =>
  state.autonomy?.modes[kind] ?? LEAD_AUTONOMY_DEFAULTS[kind]

/** The open goal's time is up: no unasked work of its own starts. The person's own messages are still answered. */
export const leadDeadlinePassed = (state: Pick<LeadState, 'autonomy' | 'budget'>, now: number): boolean => {
  const deadline = state.autonomy?.deadline
  return !!deadline && state.budget?.logicalGoalId === deadline.logicalGoalId && now >= deadline.deadlineAt
}

/**
 * Whether a desk change or a quiet run may wake the model. `desk-change` and `stuck` are the Lead speaking up unasked, so
 * Off and Observe both keep it silent: the host looked, and for Observe says so in the wake ledger. A change in the runs
 * the current approved goal owns is the exception for `desk-change` (`ownRuns`): those changes are how the Lead follows
 * what the person asked for, so only `stuck` can be silenced there. A change in a chat, or in an earlier goal's work, is
 * not that. Once the goal's deadline has passed nothing unasked wakes the model for it, whatever the modes say.
 */
export const leadWakeAutonomy = (state: LeadState, why: 'changed' | 'stuck' | null, context: { readonly ownRuns: boolean; readonly now: number }):
  { readonly allow: boolean; readonly observe: LeadAutonomyKind | null } => {
  const kind: LeadAutonomyKind = why === 'stuck' ? 'stuck' : 'desk-change'
  if (leadDeadlinePassed(state, context.now)) return { allow: false, observe: null }
  if (kind === 'desk-change' && context.ownRuns && state.contract !== null && state.phase === 'running') return { allow: true, observe: null }
  const mode = leadAutonomyMode(state, kind)
  return { allow: mode === 'act', observe: mode === 'observe' ? kind : null }
}
