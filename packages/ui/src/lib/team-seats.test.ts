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
it('a wrapped Team reads its receipt, falls back to answered conversations and keeps unlinked Seats', () => {
 const wrapped = { ...goal([]), goal: { id:'team', state:'wrapped' }, receipt: {
  seats:['a','b','missing'], members:[{seat:'a',agent:'Writer',seatLabel:'Alpha',session:{runtime:'agent-a',sessionId:'one'}},{seat:'b',agent:'Reviewer',seatLabel:'Beta'},{seat:'missing',agent:null,seatLabel:'Gamma'}],
  answers:[{seat:'b',session:{runtime:'agent-b',sessionId:'two'}}],
 } } as unknown as GoalView
 expect(teamSeats(wrapped,team([sessionKey('wrong','stale')]),run).map(one=>[one.record.id,one.key,one.name])).toEqual([
  ['a',sessionKey('agent-a','one'),'Writer'],['b',sessionKey('agent-b','two'),'Reviewer'],['missing',null,'Gamma'],
 ])
})
/* A conversation can be seated more than once in a Team's life, and a receipt keeps every Seat. The list is of
   conversations — rail rows, tree rows and React keys are all keyed by the session — so it names each one once, the
   way an open Team's list does: where the first Seat put it, described by the last Seat that held it (#1317). */
it('a wrapped Team names a conversation once however many Seats were retained for it', () => {
 const wrapped = { ...goal([]), goal: { id:'team', state:'wrapped' }, receipt: {
  seats:['a','missing','a2','b','b2'],
  members:[
   {seat:'a',agent:'Writer',seatLabel:'Alpha',session:{runtime:'agent-a',sessionId:'one'}},
   {seat:'missing',agent:null,seatLabel:'Gamma'},
   {seat:'a2',agent:'Reviewer',seatLabel:'Alpha again',session:{runtime:'agent-a',sessionId:'one'}},
   {seat:'b',agent:'Judge',seatLabel:'Beta'},
   {seat:'b2',agent:'Judge',seatLabel:'Beta again'},
  ],
  answers:[{seat:'b',session:{runtime:'agent-b',sessionId:'two'}},{seat:'b2',session:{runtime:'agent-b',sessionId:'two'}}],
 } } as unknown as GoalView
 const seats = teamSeats(wrapped,team(),run)
 expect(seats.map(one=>[one.record.id,one.key,one.name])).toEqual([
  ['a2',sessionKey('agent-a','one'),'Reviewer'],['missing',null,'Gamma'],['b2',sessionKey('agent-b','two'),'Judge'],
 ])
 const linked = seats.flatMap(one=>one.key===null?[]:[one.key])
 expect(new Set(linked).size).toBe(linked.length)
})

it('retains every receipt Seat by ID for a Run inspector, including repeated conversations', () => {
 const wrapped = { ...goal([]), goal: { id:'team', state:'wrapped' }, receipt: {
  seats:['a','b'], members:[
   {seat:'a',agent:'Writer',seatLabel:'First',session:{runtime:'agent-a',sessionId:'one'}},
   {seat:'b',agent:'Reviewer',seatLabel:'Later',session:{runtime:'agent-a',sessionId:'one'}},
  ], answers:[],
 } } as unknown as GoalView
 expect(teamSeats(wrapped,team(),run,'seat').map(one=>[one.record.id,one.key,one.role])).toEqual([
  ['a',sessionKey('agent-a','one'),'writer'],['b',sessionKey('agent-a','one'),'reviewer'],
 ])
 expect(teamSeats(wrapped,team(),run).map(one=>one.record.id)).toEqual(['b'])
})
