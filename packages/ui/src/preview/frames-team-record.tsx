import { useEffect, useMemo } from 'react'
import { itemId, sessionKey, turnId, type GoalReceipt, type GoalView, type InsightAmounts, type Intent, type SessionSummary } from '@harnessdesk/protocol'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { SessionTree } from '../components/SessionTree'
import { RailSection } from '../design'
import { StoreProvider } from '../state/context'
import type { AppSnapshot } from '../state/store'
import { previewStore } from './harness'
import { overviewReport, overviewTeamStore } from './team-overview-fixture'

export const TEAM_RECORD_STATES = ['wrapped', 'older', 'shared', 'unlinked', 'empty', 'narrow', 'person', 'running'] as const
export type RecordScene = typeof TEAM_RECORD_STATES[number]
/** The scenes shown in a narrow pane, where the room is one half at a time and the Receipt has to be the half that opens. */
const NARROW: readonly RecordScene[] = ['narrow', 'person']

/** Wrapped host shapes: both member lists emptied; the receipt owns the links. */
export const teamRecordStore = (scene: RecordScene = 'wrapped') => {
 const original = overviewTeamStore().getSnapshot()
 const goal = original.goals.get('overview-team')!
 const seats = scene === 'empty' ? [] : goal.members
 /* `older` keeps one Seat whose conversation is gone, and links the rest through their kept answers; `unlinked` is
    the older receipt with no answer to link by either. `shared` seats Beta's conversation a second time: the receipt
    keeps both Seats and the list names the conversation once (#1317). */
 const again = scene === 'shared' ? { seat: 'seat-again', agent: 'Beta', seatLabel: 'Reviewer', session: seats[1]!.session } : null
 const receipt: GoalReceipt = {
  version:1,id:'receipt-record',goal:goal.goal.id,sentence:goal.goal.sentence,wrappedAt:goal.goal.updatedAt,
  summary:scene==='empty'?'The completed work is kept in this record. No conversations were recorded.':scene==='unlinked'?'The checkout retry was built and reviewed. This older receipt did not keep the conversations.':'The checkout retry was built and reviewed. Both conversations remain part of this record.',
  cards:goal.board.intents.map((card,index)=>({id:card.id,resolution:'finished',reason:null,...(scene==='older'||scene==='unlinked'?{}:{title:card.title,...(seats[index]?{seat:seats[index].id}:{})})})),
  seats:[...seats.map(seat=>seat.id),...(scene==='older'?['seat-unlinked']:[]),...(again?[again.seat]:[])],
  members:[...seats.map(seat=>({seat:seat.id,agent:seat.agent?.name??null,seatLabel:seat.seatLabel,...(scene==='older'||scene==='unlinked'?{}:{role:seat.role}),...(scene==='older'||scene==='unlinked'?{}:{session:seat.session})})),
   ...(scene==='older'?[{seat:'seat-unlinked',agent:'Gamma',seatLabel:'Reviewer'}]:[]),
   ...(again?[again]:[])],
  answers:scene==='unlinked'?[]:seats.map(seat=>({seat:seat.id,session:seat.session,turn:null,text:scene==='narrow'?`The change was checked: https://example.com/${'a'.repeat(180)}`:'The change was checked and is ready.',partial:false,stopReason:null})),
  evidence:[],lanes:[],revisions:[],citations:[],gaps:[],
 }
 const later:Intent={...goal.board.intents[1]!,id:3,title:'Review the retry budget again'}
 const board={...goal.board,members:[],nicknames:{},intents:[...goal.board.intents,...(again?[later]:[])]}
 /* `person` is a Team a person made, which never had a Flow Run: no origin run and no execution, only the receipt. */
 const person=scene==='person'
 const wrapped:GoalView={...goal,goal:{...goal.goal,state:'wrapped',receipt:receipt.id,origin:person?{kind:'person'}:{kind:'flow',run:'overview-run'}},members:[],activity:null,board,receipt}
 const run=original.flowExecutions.get('overview-run')!
 const rounds=[...run.rounds.map(round=>({...round,cards:round.cards.filter(id=>id<=2),seats:round.seats.filter(id=>id==='seat-0'||id==='seat-1'),state:'closed' as const})),
  ...(again?[{n:3,role:'reviewer',cards:[3],seats:[again.seat],state:'closed' as const,cause:'review-again',evidence:[]}]:[])]
 const baseReport=overviewReport()
 const partition=baseReport.breakdowns.find(one=>one.dimension==='seat')!
 const source={id:'recorded-agent-usage',kind:'corpus' as const,label:'Recorded agent usage',observedAt:baseReport.query.to,checkedAt:Date.now(),stale:false,problem:null}
 const measured=(amounts:InsightAmounts):InsightAmounts=>Object.fromEntries(Object.entries(amounts).map(([key,metric])=>[key,{...metric,sourceIds:[source.id]}])) as unknown as InsightAmounts
 const rows=partition.rows.filter(row=>seats.some(seat=>seat.id===row.seat)).map(row=>({...row,amounts:measured({...row.amounts,usd:{...row.amounts.usd,value:row.seat==='seat-0'?0.43:row.amounts.usd.value}})}))
 if(again) {
  const earlier=rows.find(one=>one.seat==='seat-1')!
  rows.push({...earlier,key:again.seat,seat:again.seat,amounts:{...earlier.amounts,usd:{...earlier.amounts.usd,value:0.13},turns:{...earlier.amounts.turns,value:12}}})
 }
 const zero=measured(Object.fromEntries(Object.entries(baseReport.totals).map(([key,metric])=>[key,{...metric,value:0}])) as unknown as InsightAmounts)
 const sum=(parts:readonly InsightAmounts[]):InsightAmounts=>Object.fromEntries(Object.entries(zero).map(([key,metric])=>[key,{...metric,value:parts.reduce((total,part)=>total+(part[key as keyof InsightAmounts].value??0),0)}])) as unknown as InsightAmounts
 const totals=sum(rows.map(row=>row.amounts))
 const agents=[...new Set(rows.map(row=>row.label))].map(label=>{
  const one=rows.find(row=>row.label===label)!
  return {...one,key:`agent-${label}`,seat:null,session:null,amounts:sum(rows.filter(row=>row.label===label).map(row=>row.amounts))}
 })
 const report={...baseReport,receipt:receipt.id,totals,sources:[source],breakdowns:[
  {...partition,dimension:'seat' as const,rows,unattributed:zero},
  {...partition,dimension:'goal' as const,rows:rows.length?[{...rows[0]!,key:goal.goal.id,label:goal.goal.sentence,seat:null,session:null,amounts:totals}]:[],unattributed:zero},
  {...partition,dimension:'agent' as const,rows:agents,unattributed:zero},
 ]}
 /* `running` is a turn still going in the first Seat's conversation after the Team wrapped: the composer takes nothing
    new, and Stop is the one control left on it, because the host leaves `turn/interrupt` open (#1317). */
 const sessions=new Map([...original.sessions].map(([key,session],index)=>{
  const going=scene==='running'&&index===0
  return [key,{...session,...(going?{status:{type:'active' as const}}:{}),turns:[{id:turnId('record-answer'),status:going?'inProgress' as const:'completed' as const,items:[{id:itemId('record-answer-text'),type:'assistantMessage' as const,text:going?'Checking the retry budget against the last release…':'The change was checked and is ready.'}]}]}]
 }))
 /* The conversation's menus offer Compact now and Review uncommitted changes only for a runtime that can; this one can,
    so the record shows both refused rather than absent. */
 const runtimes=original.runtimes.map(one=>({...one,capabilities:{...one.capabilities,compaction:true,review:true,metered:true}}))
 const seed={...original,runtimes,sessions,goals:new Map([[wrapped.goal.id,wrapped]]),teams:new Map([[board.id,board]]),
  flowExecutions:person?new Map():new Map([[run.id,{...run,state:'settled' as const,rounds,operations:rounds.flatMap(round=>round.seats.map((seat,index)=>({key:`seat-${round.n}-${index}`,kind:'seat' as const,state:'finished' as const,card:round.cards[index]??round.cards[0]!,seat}))),end:{kind:'complete' as const},endedAt:goal.goal.updatedAt}]]),
  approvals:[],inbox:[],activeSessionKey:sessionKey('codex','overview-0')}
 const store=previewStore(seed)
 return new Proxy(store,{get(target,key){if(key==='teamPeers')return async()=>[];if(key==='readGoalInsight')return async()=>report;return Reflect.get(target,key)}})
}
export const RecordExample = ({scene}:{scene:RecordScene}) => {
 const store=useMemo(()=>teamRecordStore(scene),[scene])
 return <section className={NARROW.includes(scene)?'h-144 max-w-sm':'h-144'}><StoreProvider store={store}><TeamRoomPane room="overview-team" /></StoreProvider></section>
}
export const TeamRecordBoard = () => <div className="flex flex-col gap-4">{TEAM_RECORD_STATES.map(scene=><section key={scene} data-catalog-state={scene}><RecordExample scene={scene}/></section>)}</div>
/**
 * A Run that ends wraps its Team under whatever question is already open. The host's wrap arrives on its own, and a
 * modal dialog leaves no control outside it to press, so `window.__hdWrapOpenTeam()` stands in for it — the callers
 * are `e2e/ui-system/team-record.spec.ts` and a frame capture. Everything else is the production pane on an open
 * Team (#1317).
 */
const WrapsUnderQuestion = () => {
 const store=useMemo(()=>overviewTeamStore('running'),[])
 useEffect(()=>{
  const host=window as unknown as {__hdWrapOpenTeam?:()=>void}
  host.__hdWrapOpenTeam=()=>{
   const current=store.getSnapshot().goals.get('overview-team')!
   const wrapped:GoalView={...current,goal:{...current.goal,state:'wrapped'},activity:null}
   ;(store as unknown as {patch(partial:Partial<AppSnapshot>):void}).patch({goals:new Map([[wrapped.goal.id,wrapped]])})
  }
  return ()=>{ delete host.__hdWrapOpenTeam }
 },[store])
 return <section id="team-record-open" className="h-144"><StoreProvider store={store}><TeamRoomPane room="overview-team" /></StoreProvider></section>
}
/**
 * "Give this to…" on an open Team's card nobody holds, in a project where a wrapped Team keeps a conversation: the
 * dialog offers the two conversations nothing holds and leaves out the one that Team's receipt keeps, because the host
 * would refuse it for another Team's card (#1317).
 */
const AssignWhereOneIsKept = () => {
 const store=useMemo(()=>{
  const base=overviewTeamStore('running')
  const snapshot=base.getSnapshot()
  const open=snapshot.goals.get('overview-team')!
  const card:Intent={id:3,title:'Check the retry budget',state:'open',files:[],dependsOn:[],claim:null,createdAt:open.goal.createdAt,updatedAt:open.goal.updatedAt}
  const board={...open.board,intents:[...open.board.intents,card]}
  const summary=(id:string,title:string):SessionSummary=>({id,runtime:'codex',title,preview:null,cwd:board.root,status:{type:'idle'},createdAt:open.goal.createdAt,updatedAt:open.goal.updatedAt,git:null,repo:{root:board.root},archived:false}) as SessionSummary
  const kept={runtime:'codex',sessionId:'retired-conversation'}
  const retired:GoalView={...open,goal:{...open.goal,id:'retired-team',sentence:'Tighten the checkout copy',state:'wrapped',receipt:'receipt-retired'},members:[],activity:null,
   receipt:{version:1,id:'receipt-retired',goal:'retired-team',sentence:'Tighten the checkout copy',wrappedAt:open.goal.updatedAt,summary:'The checkout copy was tightened.',cards:[],seats:['seat-retired'],
    members:[{seat:'seat-retired',agent:'Gamma',seatLabel:'Writer',session:kept}],
    answers:[{seat:'seat-retired',session:kept,turn:null,text:'The copy is shorter.',partial:false,stopReason:null}],
    evidence:[],lanes:[],revisions:[],citations:[],gaps:[]}}
  ;(base as unknown as {patch(partial:Partial<AppSnapshot>):void}).patch({
   goals:new Map([[open.goal.id,{...open,board}],[retired.goal.id,retired]]),teams:new Map([[board.id,board]]),
   history:[...snapshot.history,summary('free-copy','Tidy the settings copy'),summary(kept.sessionId,'Tighten the checkout copy'),summary('free-tests','Add a test for the retry budget')]})
  return base
 },[])
 return <section id="team-record-assign" className="h-144"><StoreProvider store={store}><TeamRoomPane room="overview-team" /></StoreProvider></section>
}
export const TeamRecordFrames = () => {
 const sidebar=useMemo(()=>teamRecordStore('older'),[])
 const shared=useMemo(()=>teamRecordStore('shared'),[])
 const unlinked=useMemo(()=>teamRecordStore('unlinked'),[])
 return <div className="flex flex-col gap-4 p-4">{TEAM_RECORD_STATES.map(scene=><section key={scene} id={`team-record-${scene}`} className={NARROW.includes(scene)?'max-w-sm':undefined}><RecordExample scene={scene}/></section>)}
  <section id="team-record-sidebar" className="w-72"><StoreProvider store={sidebar}><RailSection stretch="list"><SessionTree now={Date.now()}/></RailSection></StoreProvider></section>
  <section id="team-record-sidebar-shared" className="w-72"><StoreProvider store={shared}><RailSection stretch="list"><SessionTree now={Date.now()}/></RailSection></StoreProvider></section>
  <section id="team-record-sidebar-unlinked" className="w-72"><StoreProvider store={unlinked}><RailSection stretch="list"><SessionTree now={Date.now()}/></RailSection></StoreProvider></section>
  <WrapsUnderQuestion />
  <AssignWhereOneIsKept />
 </div>
}
