/** Window adapter only: the portable selectors themselves read plain data. */
import type { InsightReport } from '@harnessdesk/protocol'
import type { AppSnapshot } from '../state/snapshot'
import { goalRunOf } from './goal-run'
import { teamSeats, hasConversation } from './team-seats'
import { teamOverview, teamOverviewInputOf, teamTotals } from '@harnessdesk/client/views'
import { clientSnapshot } from './client-snapshot'
import type { TeamListInput } from './teams-list'

export const teamsInput = (snapshot: AppSnapshot, reports: ReadonlyMap<string,InsightReport> = new Map()): TeamListInput[] => {
 // One copy of the held facts for every Team: built per Team, it made the list quadratic.
 const held=clientSnapshot(snapshot)
 return [...snapshot.teams.values()].map(team => {
 const goal=snapshot.goals.get(team.id) ?? null
 const execution=goalRunOf(team.id,goal,snapshot.flowExecutions)
 const input = teamOverviewInputOf(held, team.id, {
  runtimes: snapshot.runtimes.map(one => ({ id: one.id, name: one.presentation.name, metered: one.capabilities.metered })),
  seats:teamSeats(goal,team,execution).filter(hasConversation).map(seat=>({record:seat.record,name:seat.name,
   runtime:snapshot.runtimes.find(one=>one.id===seat.record.session.runtime) ?? null,
   session:snapshot.sessions.get(seat.key) ?? null,
   unreadSince:snapshot.inbox.find(one=>!one.read && one.from?.runtime===seat.record.session.runtime && one.from?.sessionId===seat.record.session.sessionId)?.at ?? null,
   approvals:snapshot.approvals.filter(one=>one.key===seat.key).map(one=>one.approval)})),
  run:execution?{execution,startedAt:execution.startedAt ?? null}:null,
  findingRun:execution?snapshot.findingRuns.get(execution.id):null,
  publicationOn:goal?.goal.findingPublication !== false,
  report:reports.get(team.id) ?? null,
 })
 return {team,goal,execution,overview:teamOverview(input),total:teamTotals(input)}
 })
}
