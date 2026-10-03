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
export const teamsPageStore=(scene:TeamsScene='active')=>{
 const teams=new Map<string,TeamState>()
 const goals=new Map<string,GoalView>();const sessions=new Map<SessionKey,Session>()
 const executions=new Map<string,FlowExecution>()
 const reports=new Map<string,InsightReport>()
 let approvals:AppSnapshot['approvals'][number][]=[]
 for(let n=0;n<5;n++) {
  const base=overviewTeamStore(n===0?'needs-you':n===1?'stalled':n===2?'running':'done').getSnapshot()
  const id=`team-${n}`;const project=n===3?'/work/billing':'/work/storefront';const at=now-(45-n*8)*60_000
  const old=base.goals.get('overview-team')!
  const members=old.members.map((record,index)=>({...record,id:`${id}-seat-${index}`,session:{...record.session,sessionId:`${id}-conversation-${index}`},openedAt:at})) as SeatRecord[]
  const keys=members.map(record=>sessionKey(record.session.runtime,record.session.sessionId))
  const board={...old.board,id,root:project,name:sentences[n]!,updatedAt:at,
   intents:old.board.intents.map(card=>({...card,createdAt:at,updatedAt:at,claim:card.claim?{...card.claim,sessionId:members[card.id-1]?.session.sessionId ?? keys[0]!,at}:null})),
   channel:old.board.channel.map(entry=>entry.kind==='signal'?{...entry,at,by:entry.by.kind==='agent'?{...entry.by,sessionId:members[(entry.intent ?? 1)-1]?.session.sessionId ?? members[0]!.session.sessionId}:entry.by}:entry)}
  const goal={...old,goal:{...old.goal,id,root:project,cwd:project,sentence:board.name,createdAt:at,updatedAt:at,origin:{kind:'flow' as const,run:`${id}-run`}},board,members,activity:n===0||n===1?'needs-you' as const:n===2?'working' as const:'ready-to-wrap' as const}
  goals.set(id,goal);teams.set(id,board)
  const run=base.flowExecutions.get('overview-run')!
  executions.set(`${id}-run`,{...run,id:`${id}-run`,goal:id,startedAt:at,endedAt:n>2||n===1?at:null,
   rounds:run.rounds.map(round=>({...round,seats:round.seats.map(seat=>seat.replace('seat-',`${id}-seat-`))}))})
  for(const [index,record] of members.entries()) {
   const key=keys[index]!
   const original=[...base.sessions.values()][index]!
   sessions.set(key,{...original,id:record.session.sessionId as Session['id'],cwd:project,createdAt:at,updatedAt:at,turns:original.turns.map(turn=>({...turn,startedAt:at}))})
  }
  approvals.push(...base.approvals.map(entry=>({...entry,key:keys[1]!,approval:{...entry.approval,sessionId:members[1]!.session.sessionId as Session['id'],requestedAt:at}})))
  const report=overviewReport()
  reports.set(id,{...report,goal:id,breakdowns:report.breakdowns.map(group=>({...group,rows:group.rows.slice(0,2).map((row,index)=>({...row,goal:id,seat:members[index]!.id,session:members[index]!.session}))}))})
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
