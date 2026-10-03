import { approvalId, itemId, runtimeId, sessionId, sessionKey, turnId, type FlowExecution, type GoalView, type InsightAmounts, type InsightMetric, type InsightReport, type Intent, type SeatRecord, type Session } from '@harnessdesk/protocol'
import { teamOverview, type TeamOverviewInput } from '../lib/team-overview'
import { PREVIEW_GOAL } from './goal-fixture'
import { previewStore } from './harness'

export const OVERVIEW_STATES = ['running','needs-you','unread','idle','stalled','no-run','no-seats','done','done-open','narrow'] as const
export type OverviewScene = typeof OVERVIEW_STATES[number]
export const OVERVIEW_RUN_REASONS = {
 'waiting-evidence': 'Rule after-review: Waiting for its evidence.',
 unrouted: '"Review the change" (#2) answered revise; no rule continues from it, so this waits for you',
} as const
const at = Date.now() - 120_000
const ids = ['Alpha','Beta','Gamma','Delta']
const record = (n: number): SeatRecord => ({ id:`seat-${n}`,session:{runtime:'codex',sessionId:`overview-${n}`},role:n?'reviewer':'writer',openedAt:at,closed:null,agent:{name:ids[n]},seatLabel:ids[n] } as SeatRecord)
const card = (n:number,done=false):Intent => ({id:n+1,title:n?'Review the change':'Retry the checkout call',state:done?'done':'claimed',role:n?'reviewer':'writer',files:[],dependsOn:[],createdAt:at,updatedAt:at,claim:done?null:{runtime:runtimeId('codex'),sessionId:`overview-${n}`,at}})
export const overviewRun = (state: FlowExecution['state']='running'):FlowExecution => ({version:2,id:'overview-run',goal:'overview-team',state,reason:state==='stalled'?'Choose the target before this Run can continue':null,legacyRun:null,operations:[],rounds:[{n:1,role:'writer',cards:[1],seats:['seat-0'],state:'closed',cause:'seed',evidence:[]},{n:2,role:'reviewer',cards:[2,3],seats:['seat-1','seat-2'],state:'running',cause:'review',evidence:[]}],document:{format:'agents',flow:{version:2,name:'Build and review',inputs:[],roles:[],rules:[],seed:{role:'writer',title:'Retry the checkout call'},messaging:'board-only',wait:240}}})
const session = (n:number,working=false):Session => ({runtime:runtimeId('codex'),id:sessionId(`overview-${n}`),title:`${n?'Reviewer':'Writer'} conversation`,cwd:'/work/storefront',createdAt:at,updatedAt:at,status:{type:working?'active':'idle'},itemsLoaded:true,turns:working?[{id:turnId('working'),startedAt:at,status:'inProgress',items:[{id:itemId('edit'),type:'fileChange',status:'inProgress',changes:[{path:'src/checkout/a-very-long-directory-name/another-long-directory-name/another-long-directory-name/yet-another-directory-with-a-long-name/retry-request-with-a-budget-and-backoff.ts',kind:{type:'update',movePath:null},diff:''}]}]}]:[] } as unknown as Session)
const metric = (value:number,unit:InsightMetric['unit']='count'):InsightMetric => ({value,unit,quality:'exact',coverage:'complete',basis:unit==='usd'?'vendorMetered':'observed',missing:[],sourceIds:[]})
const amounts=(n:number):InsightAmounts=>({usd:metric(n===0?0.64:0.21,'usd'),turns:metric(n===0?58:38),tokens:metric(1000,'tokens'),activeMs:metric(120000,'milliseconds')})
export const overviewReport = ():InsightReport => ({id:'overview-report',goal:'overview-team',generatedAt:at,totals:amounts(0),breakdowns:[{dimension:'seat',rows:[0,1,2].map(n=>({key:`seat-${n}`,seat:`seat-${n}`,goal:'overview-team',label:ids[n]!,session:record(n).session,message:null,note:null,elapsedMs:metric(0,'milliseconds'),amounts:amounts(n)})),unattributed:amounts(0),reason:null}],seats:[],goals:[],query:{root:'/work/storefront',from:at-60000,to:at},receipt:null,elapsedMs:metric(120000,'milliseconds'),sources:[],recordedSpend:[],provenance:{state:'available',note:''},gaps:[]})
export const overviewInput = (scene:OverviewScene):TeamOverviewInput => {
 const completed=scene==='done'||scene==='done-open'
 const run=scene==='no-run'?null:overviewRun(completed?'settled':scene==='stalled'?'stalled':'running')
 const mixed=scene==='running'||scene==='narrow'
 return {team:'overview-team',seats:scene==='no-seats'?[]:(completed?[0,1,2]:[0,1,2,3]).map(n=>({record:record(n),name:ids[n]!,runtime:{capabilities:{metered:n!==2}},session:session(n,(mixed||scene==='needs-you')&&n===0),unreadSince:(mixed||scene==='unread')&&n===2?at:null,approvals:(mixed||scene==='needs-you')&&n===1?[{id:approvalId('overview-approval'),sessionId:sessionId(`overview-${n}`),requestedAt:at,type:'permission',summary:'Beta asks to edit the checkout file before retrying the payment; choose whether to keep the original payment method so this review can continue.',options:[]}]:[]})),signals:completed?[0,1,2].map(n=>({id:`completed-${n}`,kind:'signal',at,signal:'completed',intent:n+1,title:card(n).title,by:{kind:'agent',runtime:runtimeId('codex'),sessionId:`overview-${n}`,title:ids[n]!}})):[],cards:completed?[0,1,2].map(n=>card(n,true)):mixed||scene==='needs-you'?[card(0),card(1)]:[],run:run?{execution:run,startedAt:null}:null,report:overviewReport()}
}
export const overviewModel = (scene:OverviewScene) => teamOverview(overviewInput(scene))

/** Membership shape measured on the host rig, with the older list emptied to cover #1278. */
export const overviewTeamStore = (scene: 'done' | 'running' | 'needs-you' | 'stalled' | keyof typeof OVERVIEW_RUN_REASONS = 'done') => {
 const input=overviewInput(scene==='waiting-evidence'?'idle':scene==='unrouted'?'done':scene)
 const seats=input.seats.slice(0,2).map(one=>one.record as SeatRecord)
 const board={...PREVIEW_GOAL.board,id:'overview-team',name:'Retry the checkout call',root:'/work/storefront',members:[],intents:input.cards.slice(0,2),channel:input.signals!.slice(0,2),nicknames:{}}
 const goal:GoalView={...PREVIEW_GOAL,goal:{...PREVIEW_GOAL.goal,id:board.id,sentence:board.name,root:board.root,cwd:board.root,origin:{kind:'person'}},board,members:seats,activity:null}
 const baseRun=overviewRun(scene==='done'||scene==='unrouted'?'settled':scene==='stalled'?'stalled':'running')
 const run:FlowExecution=scene==='waiting-evidence'
  ? {...baseRun,reason:OVERVIEW_RUN_REASONS[scene],rounds:baseRun.rounds.map(round=>round.n===2?{...round,state:'waiting-evidence'}:round)}
  : scene==='unrouted'?{...baseRun,reason:OVERVIEW_RUN_REASONS[scene],end:{kind:'unrouted',card:2,outcome:'revise'}}:baseRun
 const sessions=new Map(input.seats.slice(0,2).map(one=>[sessionKey(one.record.session.runtime,one.record.session.sessionId),one.session!]))
 const approvals=scene==='needs-you'?input.seats.flatMap(one=>one.approvals.map(approval=>({key:sessionKey(one.record.session.runtime,one.record.session.sessionId),approval}))):[]
 const base=previewStore({teams:new Map([[board.id,board]]),goals:new Map([[board.id,goal]]),flowExecutions:new Map([[run.id,run]]),sessions,history:[...sessions.values()],inbox:[],approvals,workspace:{path:board.root,name:'Storefront',lastOpenedAt:at},workspaces:[{path:board.root,name:'Storefront',lastOpenedAt:at}],listPrefs:{...previewStore().getSnapshot().listPrefs,collapsed:[],pinned:[]}})
 return new Proxy(base,{get(target,key){if(key==='teamPeers')return async()=>[];if(key==='readGoalInsight')return async()=>overviewReport();return Reflect.get(target,key)}})
}
