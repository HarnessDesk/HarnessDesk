import { LEAD_AUTONOMY_DEFAULTS, type LeadAutonomyKind, type LeadAutonomyMode } from '@harnessdesk/protocol'
import type { LeadState } from './state.js'

/** What the person chose for one kind of unasked work; Act until they choose otherwise. */
export const leadAutonomyMode = (state: Pick<LeadState, 'autonomy'>, kind: LeadAutonomyKind): LeadAutonomyMode =>
  state.autonomy?.modes[kind] ?? LEAD_AUTONOMY_DEFAULTS[kind]

/**
 * Whether a desk change or a quiet run may wake the model. `desk-change` and `stuck` are the Lead speaking up unasked, so
 * Off and Observe both keep it silent: the host looked, and for Observe says so in the wake ledger. A goal the person
 * approved and that is running is the exception for `desk-change`: its changes are how the Lead follows what they asked
 * for, so only `stuck` can be silenced there.
 */
export const leadWakeAutonomy = (state: LeadState, why: 'changed' | 'stuck' | null): { readonly allow: boolean; readonly observe: LeadAutonomyKind | null } => {
  const kind: LeadAutonomyKind = why === 'stuck' ? 'stuck' : 'desk-change'
  if (kind === 'desk-change' && state.contract !== null && state.phase === 'running') return { allow: true, observe: null }
  const mode = leadAutonomyMode(state, kind)
  return { allow: mode === 'act', observe: mode === 'observe' ? kind : null }
}
