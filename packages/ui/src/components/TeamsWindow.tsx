import { useEffect, useMemo, useState } from 'react'
import type { InsightReport } from '@harnessdesk/protocol'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { teamSeats } from '../lib/team-seats'
import { namedGoalRun } from '../lib/goal-run'
import { teamsInput } from '../lib/teams-snapshot'
import { teamsList, type TeamFilter, type TeamListGroup, type TeamListRow } from '../lib/teams-list'
import { sanitizeHtml } from '../lib/sanitize'
import { folderName } from '../lib/projects'
import { elapsedSince } from '../lib/clock'
import styles from './TeamsWindow.module.css'
import { formatDuration } from './TurnTail'
import { AppWindow, WindowNav, WindowNavItem, WindowPage } from './AppWindow'
import { AgentIcon } from './Icons'
import { Banner, Button, Chip, DisclosureChevron, Dot, EmptyState, GroupLabel, IconTile, ListRow, ListRows, PageHead, Text, useEscapeSurface } from '../design'

const words = (value: string): string => {
 const box=document.createElement('template'); box.innerHTML=sanitizeHtml(value)
 return box.content.textContent ?? ''
}
const labels = {active:'Active','needs-you':'Needs you',settled:'Settled'} as const
const stateLabels = {'needs-you':'Needs you',unread:'Unread',working:'Working',idle:'Idle',settled:'Settled',wrapped:'Wrapped',wrapping:'Wrapping',stopped:'Stopped'} as const

/** Every Team on the desk; no per-project or runtime-specific reader. */
export const TeamsWindow = ({onClose, initialFilter='active'}: {onClose:()=>void; initialFilter?:TeamFilter}) => {
 useEscapeSurface(true,onClose)
 const store=useStore(); const snapshot=useSnapshot()
 const [filter,setFilter]=useState<TeamFilter>(initialFilter)
 const [expanded,setExpanded]=useState(false)
 const [reports,setReports]=useState<ReadonlyMap<string,InsightReport>>(new Map())
 const [reading,setReading]=useState(false)
 const [now,setNow]=useState(Date.now)
 // Read usage on opening, after card completions, and once a minute while a
 // Run goes on. Failed reads clear their old value rather than promise zero.
 const usageScope=[...snapshot.goals.keys()].sort().join('\0')
 const closed=[...snapshot.teams.values()].flatMap(team=>team.intents.filter(card=>card.state==='done').map(card=>`${team.id}:${card.id}`)).sort().join('\0')
 const running=[...snapshot.flowExecutions.values()].some(run=>run.state==='running')
 useEffect(()=>{
  let live=true
  const read=async()=>{
   setReading(true)
   await Promise.all(usageScope.split('\0').filter(Boolean).map(id=>store.readGoalInsight(id).then(report=>{if(live)setReports(current=>{const next=new Map(current);next.set(id,report);return next})},()=>{if(live)setReports(current=>{const next=new Map(current);next.delete(id);return next})})))
   if(live)setReading(false)
  }
  void read(); const timer=running?window.setInterval(read,60_000):null
  return()=>{live=false;if(timer!==null)window.clearInterval(timer)}
 },[store,usageScope,closed,running])
 useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer)},[])
 const missingRuns=[...snapshot.goals.values()].map(namedGoalRun).filter((id):id is string=>Boolean(id) && !snapshot.flowExecutions.has(id!)).sort().join('\0')
 useEffect(()=>{for(const id of missingRuns.split('\0').filter(Boolean))void store.readFlowExecution(id).catch(()=>{})},[store,missingRuns])
 const inputs=useMemo(()=>teamsInput(snapshot,reports),[snapshot,reports])
 const marks=useMemo(()=>new Map(inputs.flatMap(input=>teamSeats(input.goal,input.team,input.execution).map(seat=>[seat.record.id,snapshot.runtimes.find(runtime=>runtime.id===seat.record.session.runtime)] as const))),[inputs,snapshot.runtimes])
 const list=useMemo(()=>teamsList(inputs,snapshot.teamsPrefs),[inputs,snapshot.teamsPrefs])
 const open=(row:TeamListRow)=>{
  store.markTeamSeen(row.id,row.change); void store.openTeamRoom(row.id,row.change); onClose()
 }
 const groups=(groups:readonly TeamListGroup[])=><>{groups.map(group=><section key={group.project} aria-label={folderName(group.project)} data-team-project={group.project}>
  <GroupLabel>{folderName(group.project)}</GroupLabel>
  <ListRows className={styles.rows}>{group.rows.map(row=>{
   const duration=elapsedSince(row.since,now)
   const cost=[row.total.money!==null?`$${row.total.money.toFixed(2)}`:null,row.total.turns!==null?`${row.total.turns} turns`:null].filter(Boolean).join(' · ') || '—'
   const hidden=snapshot.teamsPrefs.hidden[row.id]===row.change
   return <ListRow key={row.id} data-team-row={row.id} className={styles.row}
    lead={row.seats.length ? <span aria-label={`${row.seats.length} seats`} className="flex -space-x-2">{row.seats.slice(0,4).map(seat=><IconTile key={seat.seat} shape="face" size="sm" title={words(seat.name)}>{marks.get(seat.seat)?<RuntimeMark runtime={marks.get(seat.seat)!}/>:<AgentIcon/>}</IconTile>)}{row.seats.length>4 && <Text role="meta">+{row.seats.length-4}</Text>}</span> : undefined}
    title={<div className="flex min-w-0 items-center gap-2">
     <Button variant="link" size="inline-link" className="min-w-0 flex-1 justify-start" onClick={()=>open(row)} title={words(row.sentence)}>
      {row.unread && <Dot aria-label="Unread changes" tone="info"/>}<Text role="row" truncate>{words(row.sentence)}</Text>
     </Button>
     <Chip variant="quiet" tone={row.state==='needs-you'?'warning':['working','unread','wrapping'].includes(row.state)?'info':'neutral'}>{stateLabels[row.state]}</Chip>
    </div>}
    subtitle={row.detail?words(row.detail):undefined} wrapSubtitle
    trail={<div className="flex flex-wrap items-center gap-2">
     <Text role="meta" numeric title={row.since===null?'Time in this state is unavailable':undefined}>{duration===null?'—':formatDuration(duration)} · <span title={cost==='—'?'Recorded usage is unavailable':'Recorded Team usage; money only from metered accounts with a known rate'}>{cost}</span></Text>
     {row.ready && <Button variant="ghost" size="inline" onClick={()=>store.setTeamHidden(row.id,!hidden)}>{hidden?'Show in Active':'Hide'}</Button>}
    </div>}/>
  })}</ListRows>
 </section>)}</>
 return <AppWindow label="Teams" responsive>
  <WindowNav onBack={onClose}>{(['active','needs-you','settled'] as const).map(value=><WindowNavItem key={value} icon={undefined} label={labels[value]} count={list.counts[value]} selected={filter===value} onClick={()=>setFilter(value)}/>)}</WindowNav>
  <WindowPage><div data-slot="teams-page" className="min-w-0 flex flex-col gap-4">
   <PageHead title="Teams"/>
   {snapshot.goalProblem && <Banner tone="warning" title="Teams could not be refreshed">{words(snapshot.goalProblem)}</Banner>}
   {reading && <Text role="meta">Reading recorded usage…</Text>}
   {list[filter].length?groups(list[filter]):<EmptyState title={filter==='active'?'No active Teams':filter==='needs-you'?'No Teams need you':'No settled Teams'}/>}
   {filter==='active' && list.ready.length>0 && <section aria-label="Ready to wrap">
    <Button variant="quiet" size="content" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><DisclosureChevron open={expanded}/>Ready to wrap · {list.ready.reduce((count,group)=>count+group.rows.length,0)}</Button>
    {expanded && groups(list.ready)}
   </section>}
  </div></WindowPage>
 </AppWindow>
}
