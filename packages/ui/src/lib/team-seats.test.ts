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

it('leads a generated duplicate address with its distinguishing model and effort', async () => {
 const { seatDisplayName } = await import('./team-seats')
 const record = {agent:{name:'Implementer'},seatLabel:'Runtime A Model A · High'}
 expect(seatDisplayName(record, 'Implementer · Runtime A Model A · High', 'Runtime A')).toBe('Model A · High')
 expect(seatDisplayName(record, 'Jane Doe', 'Runtime A')).toBe('Jane Doe')
 expect(seatDisplayName(record, 'Implementer', 'Runtime A')).toBe('Implementer')
})

it('keeps full nicknames when shortened names collide across Agents or custom names', async () => {
 const { seatDisplayName } = await import('./team-seats')
 const a={record:{agent:{name:'Writer'},seatLabel:'Runtime A Model A · High'},nickname:'Writer · Runtime A Model A · High',runtimeName:'Runtime A'}
 const b={record:{agent:{name:'Reviewer'},seatLabel:'Runtime A Model A · High'},nickname:'Reviewer · Runtime A Model A · High',runtimeName:'Runtime A'}
 expect(seatDisplayName(a.record,a.nickname,a.runtimeName,[a,b])).toBe(a.nickname)
 expect(seatDisplayName(b.record,b.nickname,b.runtimeName,[a,b])).toBe(b.nickname)
 expect(seatDisplayName(a.record,a.nickname,a.runtimeName,[a,{nickname:'Model A · High'}])).toBe(a.nickname)
 expect(seatDisplayName(a.record,a.nickname,a.runtimeName,[a])).toBe('Model A · High')
})

it('keeps stopped Seats beside active membership, with one row per conversation', () => {
 const stopped = record('a','one')
 const view = { ...goal([]), pastMembers: [stopped] }
 expect(teamSeats(view,team(),run).map(one=>[one.record.id,one.role])).toEqual([['a','writer']])
})

it('keeps live seats first and a live repeated conversation wins over its stopped record', () => {
 const live=record('live','one'), stopped={...record('old','one'),closed:{at:4,why:'released'}}, past={...record('past','two'),closed:{at:3,why:'released'}}
 const view={...goal([live]),pastMembers:[past,stopped]}
 const seats=teamSeats(view,team(),run)
 expect(seats.map(one=>one.record.id)).toEqual(['live','past'])
 expect(seats[1]?.record.closed?.at).toBe(3)
})

it('keeps the latest Seat facts for repeated live and stopped conversations', () => {
 const live=record('live-first','one'), latest=record('live-latest','one')
 const past={...record('past-first','two'),closed:{at:2,why:'released'}}
 const pastLatest={...record('past-latest','two'),closed:{at:3,why:'released'}}
 const seats=teamSeats({...goal([live,latest]),pastMembers:[past,pastLatest]},team(),run)
 expect(seats.map(one=>one.record.id)).toEqual(['live-latest','past-latest'])
})

it('uses chronological generated Seat ordinals across active and stopped Seats while preserving custom names', async () => {
 const { compactTeamSeatName } = await import('./team-seats')
 const first={...record('first','one'),agent:{...record('first','one').agent!,name:'Implementer'},seatLabel:'Model A · High',openedAt:1,closed:{at:3,why:'released'}}
 const second={...record('second','two'),agent:{...record('second','two').agent!,name:'Implementer'},seatLabel:'Model A · Low',openedAt:2}
 const third={...record('third','three'),agent:{...record('third','three').agent!,name:'Implementer'},seatLabel:'Model A · Low',openedAt:3}
 const view={...goal([second,third]),pastMembers:[first]}
 const board={...team(),nicknames:{[sessionKey('agent-a','one')]:'Implementer · Model A · High',[sessionKey('agent-a','two')]:'Implementer · Model A · Low',[sessionKey('agent-a','three')]:'Jane Doe'}}
 const seats=teamSeats(view,board,null)
 expect(seats.map(seat=>compactTeamSeatName(seat,seats,view))).toEqual(['Implementer 2','Jane Doe','Implementer 1'])
})
