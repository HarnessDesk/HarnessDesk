import { useMemo } from 'react'
import { itemId, sessionKey, turnId, type GoalReceipt, type GoalView } from '@harnessdesk/protocol'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { SessionTree } from '../components/SessionTree'
import { RailSection } from '../design'
import { StoreProvider } from '../state/context'
import { previewStore } from './harness'
import { overviewTeamStore } from './team-overview-fixture'

export const TEAM_RECORD_STATES = ['wrapped', 'older', 'empty', 'narrow'] as const
export type RecordScene = typeof TEAM_RECORD_STATES[number]

/** Wrapped host shapes: both member lists emptied; the receipt owns the links. */
export const teamRecordStore = (scene: RecordScene = 'wrapped') => {
 const original = overviewTeamStore().getSnapshot()
 const goal = original.goals.get('overview-team')!
 const seats = scene === 'empty' ? [] : goal.members
 const receipt: GoalReceipt = {
  version:1,id:'receipt-record',goal:goal.goal.id,sentence:goal.goal.sentence,wrappedAt:goal.goal.updatedAt,
  summary:scene==='empty'?'The completed work is kept in this record. No conversations were recorded.':'The checkout retry was built and reviewed. Both conversations remain part of this record.',
  cards:goal.board.intents.map(card=>({id:card.id,resolution:'finished',reason:null})),
  seats:[...seats.map(seat=>seat.id),...(scene==='older'?['seat-unlinked']:[])],
  members:[...seats.map(seat=>({seat:seat.id,agent:seat.agent?.name??null,seatLabel:seat.seatLabel,...(scene==='older'?{}:{session:seat.session})})),
   ...(scene==='older'?[{seat:'seat-unlinked',agent:'Gamma',seatLabel:'Reviewer'}]:[])],
  answers:seats.map(seat=>({seat:seat.id,session:seat.session,turn:null,text:'The change was checked and is ready.',partial:false,stopReason:null})),
  evidence:[],lanes:[],revisions:[],citations:[],gaps:[],
 }
 const board={...goal.board,members:[],nicknames:{}}
 const wrapped:GoalView={...goal,goal:{...goal.goal,state:'wrapped',receipt:receipt.id,origin:{kind:'flow',run:'overview-run'}},members:[],activity:null,board,receipt}
 const run=original.flowExecutions.get('overview-run')!
 const sessions=new Map([...original.sessions].map(([key,session])=>[key,{...session,turns:[{id:turnId('record-answer'),status:'completed' as const,items:[{id:itemId('record-answer-text'),type:'assistantMessage' as const,text:'The change was checked and is ready.'}]}]}]))
 const seed={...original,sessions,goals:new Map([[wrapped.goal.id,wrapped]]),teams:new Map([[board.id,board]]),
  flowExecutions:new Map([[run.id,{...run,state:'settled' as const,rounds:run.rounds.map(round=>({...round,cards:round.cards.filter(id=>id<=2),seats:round.seats.filter(id=>id==='seat-0'||id==='seat-1'),state:'closed' as const})),end:{kind:'complete' as const},endedAt:goal.goal.updatedAt}]]),
  approvals:[],inbox:[],activeSessionKey:sessionKey('codex','overview-0')}
 const store=previewStore(seed)
 return new Proxy(store,{get(target,key){if(key==='teamPeers')return async()=>[];if(key==='readGoalInsight')return async()=>null;return Reflect.get(target,key)}})
}
export const RecordExample = ({scene}:{scene:RecordScene}) => {
 const store=useMemo(()=>teamRecordStore(scene),[scene])
 return <section className={scene==='narrow'?'h-144 max-w-sm':'h-144'}><StoreProvider store={store}><TeamRoomPane room="overview-team" /></StoreProvider></section>
}
export const TeamRecordBoard = () => <div className="flex flex-col gap-4">{TEAM_RECORD_STATES.map(scene=><section key={scene} data-catalog-state={scene}><RecordExample scene={scene}/></section>)}</div>
export const TeamRecordFrames = () => {
 const sidebar=useMemo(()=>teamRecordStore('older'),[])
 return <div className="flex flex-col gap-4 p-4">{TEAM_RECORD_STATES.map(scene=><section key={scene} id={`team-record-${scene}`} className={scene==='narrow'?'max-w-sm':undefined}><RecordExample scene={scene}/></section>)}
  <section id="team-record-sidebar" className="w-72"><StoreProvider store={sidebar}><RailSection stretch="list"><SessionTree now={Date.now()}/></RailSection></StoreProvider></section>
 </div>
}
