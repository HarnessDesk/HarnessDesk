/** Window adapter only: the portable selectors themselves read plain data. */
import type { InsightReport } from '@harnessdesk/protocol'
import type { AppSnapshot } from '../state/snapshot'
import { goalRunOf } from './goal-run'
import { teamSeats, hasConversation } from './team-seats'
import { teamOverview, teamTotals, type TeamOverviewInput } from './team-overview'
import type { TeamListInput } from './teams-list'

export const teamsInput = (snapshot: AppSnapshot, reports: ReadonlyMap<string,InsightReport> = new Map()): TeamListInput[] => [...snapshot.teams.values()].map(team => {
 const goal=snapshot.goals.get(team.id) ?? null
 const execution=goalRunOf(team.id,goal,snapshot.flowExecutions)
 const input: TeamOverviewInput = {
  team:team.id,cards:team.intents,signals:team.channel.filter(one=>one.kind==='signal'),
  seats:teamSeats(goal,team,execution).filter(hasConversation).map(seat=>({record:seat.record,name:seat.name,
   runtime:snapshot.runtimes.find(one=>one.id===seat.record.session.runtime) ?? null,
   session:snapshot.sessions.get(seat.key) ?? null,
   unreadSince:snapshot.inbox.find(one=>!one.read && one.from?.runtime===seat.record.session.runtime && one.from?.sessionId===seat.record.session.sessionId)?.at ?? null,
   approvals:snapshot.approvals.filter(one=>one.key===seat.key).map(one=>one.approval)})),
  run:execution?{execution,startedAt:execution.startedAt ?? null}:null,
  report:reports.get(team.id) ?? null,
  runtimeCapabilities:new Map(snapshot.runtimes.map(one=>[one.id,one.capabilities])),
 }
 return {team,goal,execution,overview:teamOverview(input),total:teamTotals(input)}
})
