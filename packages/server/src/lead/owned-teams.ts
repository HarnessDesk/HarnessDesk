import type { LeadState } from '@harnessdesk/lead'

/** A Team the current Lead goal started: the plan step it was started for, and whether the person accepted the result. */
export interface LeadOwnedTeam {
  readonly step: string | null
  readonly accepted: boolean
}

/**
 * The Teams the current Lead goal owns, keyed by Team id. A Team's step comes from the start attempt its run was bound
 * to; a Team bound without a recorded step keeps no step rather than a guessed one.
 */
export const leadOwnedTeams = (state: Pick<LeadState, 'teams' | 'runs' | 'attempts' | 'contract' | 'phase'>): ReadonlyMap<string, LeadOwnedTeam> => {
  const accepted = state.phase === 'accepted'
  const titles = new Map((state.contract?.steps ?? []).map(step => [step.id, step.title]))
  const stepOf = new Map<string, string>()
  for (const attempt of state.attempts.values()) if (attempt.stepId !== null) stepOf.set(attempt.correlationId, attempt.stepId)
  const owned = new Map<string, LeadOwnedTeam>(state.teams.map(team => [team, { step: null, accepted }]))
  for (const run of state.runs) {
    const id = stepOf.get(run.correlationId)
    owned.set(run.teamId, { step: (id === undefined ? null : titles.get(id)) ?? owned.get(run.teamId)?.step ?? null, accepted })
  }
  return owned
}
