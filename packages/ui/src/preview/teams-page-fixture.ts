import { sessionKey, type FlowExecution, type SessionKey, type TeamState, type GoalView, type InsightReport, type Session, type SeatRecord } from '@harnessdesk/protocol'
import { previewStore } from './harness'
import { overviewTeamStore, overviewReport } from './team-overview-fixture'
import type { AppSnapshot } from '../state/snapshot'
import { teamsInput } from '../lib/teams-snapshot'
import { teamListRow } from '../lib/teams-list'

export const TEAMS_PAGE_STATES=['active','needs-you','settled','empty','pending','failed','narrow'] as const
export type TeamsScene=typeof TEAMS_PAGE_STATES[number]
const now=Date.now()
const sentences=['Review the checkout retry','Choose the deployment target','Retry the checkout call on a 502','Keep the invoice rounding change','Finish the usage cache change']
const turnTotals=[21,8,137,46,92]
export const teamsPageStore=(scene:TeamsScene='active',finished?:'before'|'after')=>{
 const teams=new Map<string,TeamState>()
 const goals=new Map<string,GoalView>();const sessions=new Map<SessionKey,Session>()
 const executions=new Map<string,FlowExecution>()
 const reports=new Map<string,InsightReport>()
 let approvals:AppSnapshot['approvals'][number][]=[]
 for(let n=0;n<5;n++) {
  const base=overviewTeamStore(finished?'done':n===0?'needs-you':n===1?'stalled':n===2?'running':'done').getSnapshot()
  const id=`team-${n}`;const project=n===3?'/work/billing':'/work/storefront';const at=now-(45-n*8)*60_000
  const old=base.goals.get('overview-team')!
  const members=Array.from({length:n===2?6:old.members.length},(_,index)=>{
   const record=old.members[index%old.members.length]!
   return {...record,id:`${id}-seat-${index}`,session:{...record.session,sessionId:`${id}-conversation-${index}`},openedAt:at}
  }) as SeatRecord[]
  const keys=members.map(record=>sessionKey(record.session.runtime,record.session.sessionId))
  const board={...old.board,id,root:project,name:sentences[n]!,updatedAt:at,
   intents:old.board.intents.map(card=>({...card,createdAt:at,updatedAt:at,claim:card.claim?{...card.claim,sessionId:members[card.id-1]?.session.sessionId ?? keys[0]!,at}:null})),
   channel:old.board.channel.map(entry=>entry.kind==='signal'?{...entry,at,by:entry.by.kind==='agent'?{...entry.by,sessionId:members[(entry.intent ?? 1)-1]?.session.sessionId ?? members[0]!.session.sessionId}:entry.by}:entry)}
  const goal={...old,goal:{...old.goal,id,root:project,cwd:project,sentence:board.name,createdAt:at,updatedAt:at,origin:{kind:'flow' as const,run:`${id}-run`}},board,members,activity:n===0||n===1?'needs-you' as const:n===2?'working' as const:'ready-to-wrap' as const}
  goals.set(id,goal);teams.set(id,board)
  const run=base.flowExecutions.get('overview-run')!
  executions.set(`${id}-run`,{...run,id:`${id}-run`,goal:id,startedAt:at,endedAt:n>2||n===1?at:null,reason:n===3?'Review accepted the invoice rounding change.':run.reason,
   rounds:run.rounds.map(round=>({...round,seats:round.seats.map(seat=>seat.replace('seat-',`${id}-seat-`))}))})
  for(const [index,record] of members.entries()) {
   const key=keys[index]!
   const original=[...base.sessions.values()][index%base.sessions.size]!
   sessions.set(key,{...original,id:record.session.sessionId as Session['id'],cwd:project,createdAt:at,updatedAt:at,turns:original.turns.map(turn=>({...turn,startedAt:at}))})
  }
  approvals.push(...base.approvals.map(entry=>({...entry,key:keys[1]!,approval:{...entry.approval,sessionId:members[1]!.session.sessionId as Session['id'],requestedAt:at}})))
  const report=overviewReport()
  const turns=turnTotals[n]!;const writerTurns=Math.ceil(turns*0.6)
  reports.set(id,{...report,goal:id,totals:{...report.totals,turns:{...report.totals.turns,value:turns}},breakdowns:report.breakdowns.map(group=>({...group,
   unattributed:{...group.unattributed,turns:{...group.unattributed.turns,value:0}},
   rows:group.rows.slice(0,2).map((row,index)=>({...row,goal:id,seat:members[index]!.id,session:members[index]!.session,
    amounts:{...row.amounts,turns:{...row.amounts.turns,value:index===0?writerTurns:turns-writerTurns}}}))}))})
 }
 if(finished) {
  for(const id of [...teams.keys()].slice(2)){teams.delete(id);goals.delete(id);executions.delete(`${id}-run`)}
  approvals=[]
  for(const n of [0,1]) {
   const id=`team-${n}`,old=goals.get(id)!,run=executions.get(`${id}-run`)!
   const before=finished==='before',sentence=n===0?'Land the reviewed change':'Stop the investigation'
   const board={...old.board,name:sentence,intents:old.board.intents.map((card,index)=>({...card,claim:null,role:index===0?'referee':card.role,
    state:index===0&&n===1?(before?'open' as const:'abandoned' as const):'done' as const,
    outcome:index===0&&n===0?'landed':null}))}
   const reason=n===0?(before?'Land the change answered landed; no rule continues, so this waits for you.':'Land the change answered landed; this run is complete.'):'The person stopped this flow.'
   teams.set(id,board)
   goals.set(id,{...old,board,goal:{...old.goal,sentence},activity:before?'needs-you':'ready-to-wrap'})
   executions.set(run.id,{...run,state:n===0?'settled':'stopped',reason,
    end:n===0?(before?{kind:'unrouted',card:1,outcome:'landed'}:{kind:'complete'}):{kind:'stopped',by:'person'},
    rounds:[{n:1,role:'referee',cards:[1],seats:[],state:'closed',cause:'seed',evidence:[]}],
    document:{format:'agents',flow:{...(run.document.format==='agents'?run.document.flow:{version:2,name:run.document.flow.name,inputs:[],rules:[],seed:run.document.flow.seed,messaging:'board-only',wait:240}),version:2,roles:[{id:'referee',kind:'person',outcomes:['landed']}],complete:{referee:['landed']}}}})
  }
 }
 const base=previewStore({teams:scene==='empty'?new Map():teams,goals:scene==='empty'?new Map():goals,flowExecutions:executions,sessions,history:[...sessions.values()],approvals,inbox:[],goalProblem:scene==='failed'?'The Team usage record could not be read':null,workspace:{path:'/work/storefront',name:'Storefront',lastOpenedAt:now},workspaces:[{path:'/work/storefront',name:'Storefront',lastOpenedAt:now},{path:'/work/billing',name:'Billing',lastOpenedAt:now}]})
 let state=base.getSnapshot()
 const listeners=new Set<()=>void>()
 const snapshot=()=>state
 const patch=(overrides:Partial<AppSnapshot>)=>{state={...state,...overrides};for(const listener of listeners)listener()}
 return new Proxy(base,{get(target,key){
  if(key==='getSnapshot')return snapshot
  if(key==='subscribe')return (listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener)}
  if(key==='readGoalInsight')return (id:string)=>scene==='pending'?new Promise(()=>{}):scene==='failed'?Promise.reject(new Error('Usage unavailable')):Promise.resolve(reports.get(id)!)
  if(key==='setTeamHidden')return (id:string,hidden:boolean)=>{const prefs=snapshot().teamsPrefs;const input=teamsInput(snapshot()).find(one=>one.team.id===id)!;const marks={...prefs.hidden};if(hidden)marks[id]=teamListRow(input).change;else delete marks[id];patch({teamsPrefs:{...prefs,hidden:marks}})}
  if(key==='markTeamSeen')return (id:string,change:string)=>patch({teamsPrefs:{...snapshot().teamsPrefs,seen:{...snapshot().teamsPrefs.seen,[id]:change}}})
  return Reflect.get(target,key)
 }})
}
