import { flowModel, stepName } from './flow-model'
import { flowOverlay } from './flow-overlay'
import { teamListRow, type TeamListInput, type TeamListRow, type TeamsPrefs } from './teams-list'

export type TeamBoardColumn = 'needs-you' | 'working' | 'ready'
export interface TeamPathSegment { readonly id:string; readonly label:string; readonly state:'done'|'current'|'future' }

/** Every Team has one destination; wrapped receipts live below Ready to wrap. */
export const teamBoardColumn = (row: TeamListRow, runState?: NonNullable<TeamListInput['execution']>['state']): TeamBoardColumn => {
 if (row.state === 'wrapped' || row.ready) return 'ready'
 if (row.state === 'stopping' || row.state === 'wrapping') return 'working'
 if (row.state === 'needs-you' || row.state === 'stopped' || runState === 'stopped') return 'needs-you'
 return 'working'
}

/** Board presentation uses the same held facts as the Team's Overview and Flow. */
export const teamBoardItem = (input: TeamListInput, prefs?: TeamsPrefs) => {
 const row=teamListRow(input,prefs), column=teamBoardColumn(row,input.execution?.state)
 const title=row.sentence.split(/(?<=[.!?])\s+|\n/)[0]?.trim() || row.sentence
 const run=input.overview.run
 const working=row.seats.find(seat=>seat.state==='working' && seat.doing)
 const summary=column==='needs-you' ? (input.execution?.state==='stopped' && row.state!=='needs-you' ? input.execution.reason ?? 'Run stopped' : row.detail ?? 'Open the Team to answer')
  : row.state==='wrapped' ? 'Receipt kept'
   : row.ready ? row.detail ?? (input.execution?'Run complete':'Work complete')
    : [run?.role ? stepName(run.role) : null,run?.round ? `round ${run.round}` : null,
      working ? `${working.name} · ${working.doing!.replace(/\S+\/(?=[^/\s]+(?:\s|$))/g,'')}` : row.state==='stopping'?'Stopping':row.state==='wrapping'?'Wrapping':row.detail ?? 'Waiting for work'].filter(Boolean).join(' · ')
 let path:TeamPathSegment[]=[]
 if(input.execution){
  const model=flowModel(input.execution.document.flow)
  const overlay=flowOverlay({execution:input.execution,model,cards:input.team.intents,
   waitingSeats:new Set(row.seats.filter(seat=>seat.state==='needs-you').map(seat=>seat.seat))})
  path=model.steps.map(step=>{
   const state=overlay.steps.get(step.id)?.state
   return {id:step.id,label:step.name,state:state==='done'?'done':state==='future'?'future':'current'}
  })
 }
 return {row,column,title,summary,path,createdAt:input.goal?.goal.createdAt ?? input.execution?.startedAt ?? null}
}
