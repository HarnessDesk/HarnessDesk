import { expect, it } from 'vitest'
import { sessionKey, type GoalView, type TeamState, type FlowExecution, type SeatRecord } from '@harnessdesk/protocol'
import { teamSeats } from './team-seats'
const record = (id: string, sessionId: string): SeatRecord => ({ id, session: { runtime: 'agent-a', sessionId }, role: null, openedAt: 1, closed: null, agent: { name: id } } as SeatRecord)
const team = (members: TeamState['members'] = []): TeamState => ({ id: 'team', members } as TeamState)
const goal = (members: SeatRecord[]): GoalView => ({ goal: { id: 'team', state: 'open' }, members } as unknown as GoalView)
const run = { goal: 'team', rounds: [{ role: 'writer', seats: ['a'] }, { role: 'reviewer', seats: ['b', 'missing'] }] } as unknown as FlowExecution
it('resolves both Flow Seats with roles even without a live process, omitting an unresolved round Seat', () => {
 expect(teamSeats(goal([record('a', 'one'), record('b', 'two')]), team(), run).map(s=>[s.key,s.role])).toEqual([[sessionKey('agent-a','one'),'writer'],[sessionKey('agent-a','two'),'reviewer']])
})
it('lists a legacy member once when it is also a Goal Seat', () => {
 expect(teamSeats(goal([record('a','one')]), team([sessionKey('agent-a','one'),sessionKey('agent-b','one')]),run)).toHaveLength(2)
})
it('a Team with no Run and no members is empty', () => { expect(teamSeats(null,team(),null)).toEqual([]) })
it('a wrapped Team uses only its legacy members until receipt support arrives', () => {
 expect(teamSeats({ ...goal([record('a','one')]), goal: { state: 'wrapped' } } as GoalView,team(),run)).toEqual([])
})
