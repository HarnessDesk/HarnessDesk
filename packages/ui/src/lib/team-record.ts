import { sessionKey, type GoalView, type SessionKey } from '@harnessdesk/protocol'

/** One read-only rule for every dispatching surface. */
export const isRecordState = (state: GoalView['goal']['state'] | null | undefined): boolean => state === 'wrapped'
export const isRecord = (team: GoalView | null | undefined): boolean => isRecordState(team?.goal.state)
export const RECORD_REASON = 'This Team is wrapped'

/** Receipt links survive membership closing; older records may only have answers. */
export const isRecordConversation = (teams: Iterable<GoalView>, key: SessionKey | null): boolean => key !== null && [...teams].some(team =>
  isRecord(team) && [...(team.receipt?.members ?? []), ...(team.receipt?.answers ?? []), ...team.members].some(one =>
    one.session && sessionKey(one.session.runtime, one.session.sessionId) === key),
)
