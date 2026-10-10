import { describe, expect, it } from 'vitest'
import { overviewInput, overviewRun } from '../preview/team-overview-fixture'
import { teamOverview } from './team-overview'
import { teamsList, teamListRow, readTeamsPrefs, type TeamListInput } from './teams-list'
import { PREVIEW_GOAL } from '../preview/goal-fixture'
import type { FindingRunView } from '@harnessdesk/protocol'

const input = (id: string, scene: Parameters<typeof overviewInput>[0] = 'idle', since = 100): { -readonly [K in keyof TeamListInput]: TeamListInput[K] } => {
 const facts = overviewInput(scene)
 const team = { ...PREVIEW_GOAL.board, id, root: '/work/storefront', name: id, updatedAt: since, intents: facts.cards }
 const execution = { ...overviewRun(scene === 'done' ? 'settled' : 'running'), goal: id, id: `${id}-run`, reason: null, startedAt: since, endedAt: scene === 'done' ? since : null }
 const model = teamOverview({ ...facts, team: id, run: { execution, startedAt: since }, report: null })
 return { team, goal: null, execution, overview: model }
}

describe('Teams list', () => {
 it('groups by project and sorts attention before unread, working and idle, longest waiting first', () => {
  const idle = input('idle'); idle.overview.seats = []
  const working = input('working'); working.overview.seats = [{ ...working.overview.seats[0]!, state: 'working', since: 40 }]
  const unread = input('unread'); unread.overview.seats = [{ ...unread.overview.seats[0]!, state: 'unread', since: 60 }]
  const newer = input('new'); newer.overview.needsYou = [{ kind: 'card', seat: null, card: 1, summary: 'Choose a target', since: 30 }]
  const older = input('old'); older.overview.needsYou = [{ kind: 'card', seat: null, card: 1, summary: 'Approve', since: 20 }]
  const other = input('other'); other.team = { ...other.team, root: '/work/other' }
  const list = teamsList([idle, working, unread, newer, older, other])
  expect(list.active.find(group => group.project === '/work/storefront')?.rows.map(row => row.id)).toEqual(['old','new','unread','working','idle'])
  expect(list.counts).toEqual({ active: 6, 'needs-you': 2, settled: 0 })
 })
 it('folds quiet settled Teams into Ready to wrap but keeps a settled Team with a question active', () => {
  const done = input('done','done'); const waiting = input('waiting','done')
  waiting.overview.needsYou = [{kind:'question',seat:null,card:null,summary:'Keep this?',since:50}]
  const list = teamsList([done, waiting])
  expect(list.active.flatMap(group => group.rows.map(row => row.id))).toEqual(['waiting'])
  expect(list.ready.flatMap(group => group.rows.map(row => row.id))).toEqual(['done'])
  expect(list.settled.flatMap(group => group.rows.map(row => row.id))).toEqual(['done'])
 })
 it('a stalled or unrouted Run needs the person without making its seats blocked', () => {
  const stalled = input('stalled'); stalled.execution = {...stalled.execution!,state:'stalled',reason:'Choose a target'}
  const unrouted = input('unrouted','done'); unrouted.execution = {...unrouted.execution!,end:{kind:'unrouted',card:1,outcome:'revise'},reason:'No rule continues'}
  for (const one of [stalled,unrouted]) {
   expect(teamListRow(one).state).toBe('needs-you')
   expect(teamListRow(one).ready).toBe(false)
   expect(teamListRow(one).detail).toBe(one.execution!.reason)
  }
 })
 it('Hide only folds the current settled revision out of Active, never out of Settled; a change revives it', () => {
  const done = input('done','done'); const token = teamListRow(done).change
  expect(teamsList([done],{hidden:{done:token},seen:{}}).ready).toEqual([])
  expect(teamsList([done],{hidden:{done:token},seen:{}}).counts.settled).toBe(1)
  done.team = {...done.team,updatedAt:200}
  expect(teamsList([done],{hidden:{done:token},seen:{}}).ready[0]?.rows).toHaveLength(1)
 })
 it('an unread dot compares the window mark with changes, never report refreshes or the clock', () => {
  const one = input('one'); const token = teamListRow(one).change
  expect(teamListRow(one,{hidden:{},seen:{one:token}}).unread).toBe(false)
  one.overview.run!.total.turns = 55
  expect(teamListRow(one,{hidden:{},seen:{one:token}}).unread).toBe(false)
  one.execution = {...one.execution!,state:'stalled'}
  expect(teamListRow(one,{hidden:{},seen:{one:token}}).unread).toBe(true)
 })
 it('a wrapped Team stays read when its review is loaded later, since its row follows none', () => {
  const review: FindingRunView = { run: 'run', goal: 'team', round: 2, finished: 2, total: 3, embargoed: false, open: 1, blocking: 1,
   reason: 'Posting stopped.', ceilingStop: false, stamp: 'read-1', publication: 'partial', rounds: [], reviewersFinished: null,
   reviewersTotal: null, pendingExceptions: [], repair: null, boundPr: null, unbound: null, undecidable: null }
  const wrapped = input('wrapped','done'); wrapped.goal = {...PREVIEW_GOAL,goal:{...PREVIEW_GOAL.goal,id:'wrapped',state:'wrapped'}}
  const open = input('open','done')
  const marks = {wrapped:teamListRow(wrapped).change,open:teamListRow(open).change}
  for (const one of [wrapped,open]) one.overview.run = {...one.overview.run!,findingRun:{...review,run:one.execution!.id,goal:one.team.id},publicationOn:true}
  expect(teamListRow(wrapped,{hidden:{},seen:marks}).unread).toBe(false)
  expect(teamListRow(open,{hidden:{},seen:marks}).unread).toBe(true)
 })
 it('wrap records are settled and manual ready Goals fold; an idle Team remains active', () => {
  const manual=input('manual'); manual.execution=null; manual.overview.run=null; manual.goal={...PREVIEW_GOAL,goal:{...PREVIEW_GOAL.goal,id:'manual'},activity:'ready-to-wrap'}
  const wrapped=input('wrapped'); wrapped.goal={...PREVIEW_GOAL,goal:{...PREVIEW_GOAL.goal,id:'wrapped',state:'wrapped'},activity:null}
  expect(teamListRow(manual).ready).toBe(true)
  expect(teamListRow(wrapped)).toMatchObject({state:'wrapped',active:false,ready:false})
  expect(teamListRow(input('idle'))).toMatchObject({state:'idle',active:true})
 })
 it('unknown time and cost remain unknown, and preference parsing refuses malformed records', () => {
  const one=input('one'); one.execution={...one.execution!,startedAt:undefined}; one.overview.seats=[]
  expect(teamListRow(one).since).toBeNull()
  expect(teamListRow(one).total).toEqual({money:null,turns:null})
  expect(readTeamsPrefs({hidden:[],seen:{ok:'revision',bad:3}})).toEqual({hidden:{},seen:{ok:'revision'}})
 })
})

it('a settled Run cannot hide unfinished follow-up work or an unwrapped Goal dependency',()=>{
 const one=input('follow-up','done')
 one.goal={...PREVIEW_GOAL,goal:{...PREVIEW_GOAL.goal,id:'follow-up'},activity:'working',waitingOn:[{id:'dependency',sentence:'Finish the source change'}]}
 expect(teamListRow(one)).toMatchObject({active:true,ready:false,detail:'After Finish the source change'})
 one.goal={...one.goal,waitingOn:[]}
 one.team={...one.team,intents:[{...one.team.intents[0]!,state:'open'}]}
 expect(teamListRow(one).ready).toBe(false)
})
it('idle age remains unknown when only a Run start is known, and manual Teams keep recorded totals',()=>{
 const one=input('manual');one.overview.seats=[]
 expect(teamListRow(one).since).toBeNull()
 one.execution=null;one.overview.run=null;one.total={money:1.25,turns:12}
 expect(teamListRow(one).total).toEqual({money:1.25,turns:12})
})
it('time in attention uses the oldest matching observed wait, not the first Seat by card number',()=>{
 const one=input('waiting');const seat=one.overview.seats[0]!
 one.overview.seats=[{...seat,state:'needs-you',since:100,reason:'Wait'},{...seat,seat:'second',state:'needs-you',since:20,reason:'Choose'}]
 expect(teamListRow(one).since).toBe(20)
})
it('a follow-up approval uses its request time rather than an earlier Run end',()=>{
 const one=input('follow-up','done');one.execution={...one.execution!,endedAt:10}
 one.overview.needsYou=[{kind:'approval',seat:null,card:null,summary:'Approve the follow-up',since:100}]
 expect(teamListRow(one).since).toBe(100)
})

it('the window adapter preserves known Team totals when no Flow has run',async()=>{
 const {overviewTeamStore,overviewReport}=await import('../preview/team-overview-fixture')
 const {teamsInput}=await import('./teams-snapshot')
 const snapshot={...overviewTeamStore().getSnapshot(),flowExecutions:new Map()}
 const reports=new Map([['overview-team',overviewReport()]])
 expect(teamListRow(teamsInput(snapshot,reports)[0]!).total.turns).toBe(58)
})

it('settled rows show the recorded Run end reason or no second line, never live round counts',()=>{
 const one=input('done','done')
 expect(teamListRow(one)).toMatchObject({state:'settled',detail:null})
 one.execution={...one.execution!,reason:'Review accepted the change.'}
 expect(teamListRow(one).detail).toBe('Review accepted the change.')
})

it.each(['local','partial','uncertain'] as const)('publication %s only needs the person once the shared read is present', publication => {
 const one = input('publication', 'done')
 const view = { run: one.execution!.id, goal: one.execution!.goal, publication, open: 1, blocking: 1,
  rounds: [{ round: 1, state: publication, reason: null, pr: 7, cards: [1] }], boundPr: {repo:'acme/widgets',pr:7}, reason:'The review needs a posting decision.' } as unknown as import('@harnessdesk/protocol').FindingRunView
 const facts = { ...overviewInput('done'), team: one.team.id, run: {execution:one.execution!,startedAt:100} }
 expect(teamListRow(one).state).toBe('settled')
 one.overview = teamOverview({...facts,findingRun:view,publicationOn:true})
 expect(teamListRow(one).state).toBe('needs-you')
 expect(teamListRow(one).detail).toBe(view.reason)
 if(publication==='local') {
  one.overview = teamOverview({...facts,findingRun:view,publicationOn:false})
  expect(teamListRow(one).state).toBe('settled')
 }
})
it('does not make a new Run Needs you because an earlier Run left Goal findings open', () => {
 const one = input('new-run', 'done')
 const findingRun = { run: one.execution!.id, goal: one.team.id, publication: 'local', open: 1, blocking: 1, total: 3,
  rounds: [{round:1,state:'none',reason:null,pr:null,cards:[1]}],boundPr:{repo:'acme/widgets',pr:7} } as unknown as import('@harnessdesk/protocol').FindingRunView
 one.overview=teamOverview({...overviewInput('done'),team:one.team.id,run:{execution:one.execution!,startedAt:100},findingRun})
 expect(one.overview.run?.needsYou).toBe(false)
 expect(teamListRow(one).state).toBe('settled')
})

it('completed and stopped Runs need no person, and a stopped Run is not Ready to wrap (#1548)',()=>{
 const complete=input('complete','done');complete.execution={...complete.execution!,end:{kind:'complete'}}
 const stopped=input('stopped','done');stopped.execution={...stopped.execution!,state:'stopped',end:{kind:'stopped',by:'person'}}
 stopped.goal={...PREVIEW_GOAL,goal:{...PREVIEW_GOAL.goal,id:'stopped'},activity:'ready-to-wrap',waitingOn:[]}
 const list=teamsList([complete,stopped])
 expect(list.counts['needs-you']).toBe(0)
 expect(teamListRow(complete)).toMatchObject({state:'settled',ready:true})
 expect(teamListRow(stopped)).toMatchObject({state:'stopped',ready:false})
})
