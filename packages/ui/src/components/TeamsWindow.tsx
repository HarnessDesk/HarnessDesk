import { Fragment, useEffect, useMemo, useState } from 'react'
import type { InsightReport } from '@harnessdesk/protocol'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { teamSeats, hasConversation } from '../lib/team-seats'
import { goalRunOf, namedGoalRun } from '../lib/goal-run'
import { teamsInput } from '../lib/teams-snapshot'
import { teamsList, type TeamFilter, type TeamListGroup, type TeamListRow } from '../lib/teams-list'
import { sanitizeHtml } from '../lib/sanitize'
import { folderName } from '../lib/projects'
import { elapsedSince } from '../lib/clock'
import { formatDuration } from './TurnTail'
import { AppWindow, WindowNav, WindowNavItem, WindowPage } from './AppWindow'
import { runtimeTint } from '../lib/accounts'
import { AgentIcon, ChevronIcon, MoreIcon } from './Icons'
import { Banner, Button, Chip, DisclosureChevron, Dot, EmptyState, GroupLabel, AvatarStack, ListRow, ListRows, Menu, MenuItem, Popover, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, PageHead, Text, useEscapeSurface } from '../design'

const words = (value: string): string => {
 const box=document.createElement('template'); box.innerHTML=sanitizeHtml(value)
 return box.content.textContent ?? ''
}
const withCount = (label: string, count: number): string => `${label} · ${count}`
const labels = {active:'Active','needs-you':'Needs you',settled:'Settled'} as const
const stateLabels = {'needs-you':'Needs you',unread:'Unread',working:'Working',idle:'Idle',settled:'Settled',wrapped:'Wrapped',wrapping:'Wrapping',stopped:'Stopped'} as const

/** Every Team on the desk; no per-project or runtime-specific reader. */
export const TeamsWindow = ({onClose, initialFilter='active'}: {onClose:()=>void; initialFilter?:TeamFilter}) => {
 useEscapeSurface(true,onClose)
 const store=useStore(); const snapshot=useSnapshot()
 const [filter,setFilter]=useState<TeamFilter>(initialFilter)
 const [expanded,setExpanded]=useState(false)
 const [pageBox,setPageBox]=useState<HTMLDivElement|null>(null)
 const [narrow,setNarrow]=useState(false)
 useEffect(()=>{if(!pageBox || typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(([entry])=>setNarrow((entry?.contentRect.width ?? Infinity)<600));observer.observe(pageBox);return()=>observer.disconnect()},[pageBox])
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
 const publicationScope=JSON.stringify([...snapshot.teams.values()].flatMap(team=>{const run=goalRunOf(team.id,snapshot.goals.get(team.id),snapshot.flowExecutions);return run?[[team.id,run.id]]:[]}).sort(([a],[b])=>a!.localeCompare(b!)))
 useEffect(()=>{for(const [goal,run] of JSON.parse(publicationScope) as [string,string][]){if(typeof store.loadFindingRun==='function')void store.loadFindingRun(goal,run).catch(()=>{})}},[store,publicationScope])
 const inputs=useMemo(()=>teamsInput(snapshot,reports),[snapshot,reports])
 const marks=useMemo(()=>new Map(inputs.flatMap(input=>teamSeats(input.goal,input.team,input.execution).filter(hasConversation).map(seat=>[seat.record.id,snapshot.runtimes.find(runtime=>runtime.id===seat.record.session.runtime)] as const))),[inputs,snapshot.runtimes])
 const list=useMemo(()=>teamsList(inputs,snapshot.teamsPrefs),[inputs,snapshot.teamsPrefs])
 const open=(row:TeamListRow)=>{
  store.markTeamSeen(row.id,row.change); void store.openTeamRoom(row.id,row.change); onClose()
 }
 const state=(row:TeamListRow)=>row.state==='needs-you'||row.state==='working'
  ? <Chip tone={row.state==='needs-you'?'warning':'info'}>{stateLabels[row.state]}</Chip>
  : <Text role="meta">{row.ready?'Ready to wrap':stateLabels[row.state]}</Text>
 const faces=(row:TeamListRow)=>row.seats.length ? <AvatarStack size="stack" members={row.seats.map(seat=>{
  const runtime=marks.get(seat.seat)
  return {id:seat.seat,name:words(seat.name),tint:runtime?runtimeTint(runtime.id,snapshot.accountsByRuntime,snapshot.accountPrefs):'blue',mark:runtime?<RuntimeMark runtime={runtime}/>:<AgentIcon/>}
 })}/>:undefined
 const menu=(row:TeamListRow)=>row.ready && <Popover label={<MoreIcon />} title="More" align="right">{close=><Menu close={close}><MenuItem label={snapshot.teamsPrefs.hidden[row.id]===row.change?'Show in Active':'Hide'} onSelect={()=>{store.setTeamHidden(row.id,snapshot.teamsPrefs.hidden[row.id]!==row.change);close()}}/></Menu>}</Popover>
 const time=(row:TeamListRow)=>{const duration=elapsedSince(row.since,now);return duration===null?'—':formatDuration(duration)}
 const cost=(row:TeamListRow)=>row.total.money===null?'—':`$${row.total.money.toFixed(2)}`
 const groups=(groups:readonly TeamListGroup[])=>{
 const showCost=groups.some(group=>group.rows.some(row=>row.total.money!==null))
 return narrow ? <>{groups.map(group=><section key={group.project} aria-label={folderName(group.project)} data-team-project={group.project}>
  <GroupLabel>{withCount(folderName(group.project),group.rows.length)}</GroupLabel>
  <ListRows>{group.rows.map(row=><ListRow key={row.id} data-team-row={row.id} interactive className="relative isolate"
   onClick={event=>{if(!event.currentTarget.contains(event.target as Node))return;if(!(event.target as Element).closest('button'))open(row)}}
   lead={faces(row)} mark={row.unread?<Dot aria-label="Unread changes" tone="info"/>:false}
   title={<Button stretched variant="row" size="pattern" aria-label={`Open ${words(row.sentence)}`} onClick={()=>open(row)} className="block max-w-full"><Text as="span" className="block" role="subject" truncate>{words(row.sentence)}</Text></Button>} subtitle={<span data-slot="team-detail">{[row.detail?words(row.detail):null,time(row)==='—'?null:`${time(row)} in this state`,row.total.turns===null?null:`${row.total.turns} turns`,cost(row)==='—'?null:cost(row)].filter(Boolean).join(' · ')}</span>} wrapSubtitle
   trail={<>{state(row)}{row.ready&&<span className="relative z-10">{menu(row)}</span>}<ChevronIcon /></>} />)}</ListRows>
 </section>)}</> : <Table variant="framed" className="table-auto">
  <TableHeader><TableRow><TableHead>Team</TableHead><TableHead className="w-[1%]">State</TableHead>
   <TableHead numeric className="w-[1%]">Time</TableHead><TableHead numeric className="w-[1%]">Turns</TableHead>{showCost&&<TableHead numeric className="w-[1%]">Cost</TableHead>}<TableHead className="w-[1%]"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
  <TableBody>{groups.map(group=><Fragment key={group.project}>
   <TableRow data-team-project={group.project}><TableCell colSpan={showCost?6:5}><GroupLabel>{withCount(folderName(group.project),group.rows.length)}</GroupLabel></TableCell></TableRow>
   {group.rows.map(row=><TableRow key={row.id} data-team-row={row.id} interactive className="relative isolate"
    onClick={event=>{if(!event.currentTarget.contains(event.target as Node))return;if(!(event.target as Element).closest('button'))open(row)}}>
    <TableCell className="max-w-0" lead={faces(row)}><div data-slot="team-identity" className="min-w-0 flex-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
      <span className="inline-flex w-1.5 self-center">{row.unread&&<Dot aria-label="Unread changes" tone="info"/>}</span><Button stretched variant="row" size="pattern" aria-label={`Open ${words(row.sentence)}`} onClick={()=>open(row)} className="block min-w-0 max-w-full"><Text as="span" className="block" role="subject" truncate title={words(row.sentence)}>{words(row.sentence)}</Text></Button>
      {row.detail&&<div data-slot="team-detail" title={words(row.detail)} className="col-start-2 whitespace-normal [overflow-wrap:anywhere]"><Text role="meta">{words(row.detail)}</Text></div>}
    </div></TableCell>
    <TableCell>{state(row)}</TableCell><TableCell numeric><Text role="meta" numeric title={row.since===null?'Time in this state is unavailable':undefined}>{time(row)}</Text></TableCell>
    <TableCell numeric><Text role="meta" numeric title={row.total.turns===null?'Recorded turns are unavailable':undefined}>{row.total.turns??'—'}</Text></TableCell>{showCost&&<TableCell numeric><Text role="meta" numeric title={row.total.money===null?'Recorded usage is unavailable':'Recorded Team usage; money only from metered accounts with a known rate'}>{cost(row)}</Text></TableCell>}
    <TableCell><span className="relative z-10 flex items-center gap-2">{menu(row)}<ChevronIcon /></span></TableCell>
   </TableRow>)}
  </Fragment>)}</TableBody>
 </Table>
 }
 return <AppWindow label="Teams" responsive>
  <WindowNav onBack={onClose}>{(['active','needs-you','settled'] as const).map(value=><WindowNavItem key={value} icon={undefined} label={labels[value]} count={list.counts[value]} selected={filter===value} onClick={()=>setFilter(value)}/>)}</WindowNav>
  <WindowPage><div ref={setPageBox} data-slot="teams-page" data-layout={narrow?"narrow":"table"} className="min-w-0 flex flex-col gap-4">
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
