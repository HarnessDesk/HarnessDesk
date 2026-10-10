import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { INSIGHT_GOALS_LIMIT, type InsightGoalsReport, type InsightReport } from '@harnessdesk/protocol'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { teamSeats, hasConversation } from '../lib/team-seats'
import { namedGoalRun } from '../lib/goal-run'
import { teamsInput } from '../lib/teams-snapshot'
import { teamsList, type TeamFilter, type TeamListGroup, type TeamListRow } from '../lib/teams-list'
import { sanitizeHtml } from '../lib/sanitize'
import { folderName } from '../lib/projects'
import { useNarrowLayout } from '../lib/use-narrow-layout'
import { elapsedSince, instant } from '../lib/clock'
import { formatCountdownShort } from '../lib/usage'
import { AppWindow, WindowNav, WindowNavItem, WindowPage } from './AppWindow'
import { runtimeTint } from '../lib/accounts'
import { AgentIcon, ChevronIcon, MoreIcon } from './Icons'
import { Banner, Button, Chip, DisclosureChevron, Dot, EmptyState, GroupLabel, AvatarStack, ListRow, ListRows, Menu, MenuItem, Popover, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, PageHead, Text, useEscapeSurface } from '../design'

const words = (value: string): string => {
 const box=document.createElement('template'); box.innerHTML=sanitizeHtml(value)
 return box.content.textContent ?? ''
}
/** Titles repeat across renders and Teams; each distinct one is sanitised once, within a bound. */
const plainWords = new Map<string,string>()
const plain = (value: string): string => {
 const known=plainWords.get(value); if(known!==undefined)return known
 const text=words(value)
 if(plainWords.size>=2000)plainWords.delete(plainWords.keys().next().value!)
 plainWords.set(value,text); return text
}
interface RowWords { readonly sentence: string; readonly detail: string | null; readonly seats: readonly string[] }
const rowWords = (row: TeamListRow): RowWords => ({sentence:plain(row.sentence),detail:row.detail?plain(row.detail):null,seats:row.seats.map(seat=>plain(seat.name))})
/** Time in a state, in its largest unit — 47m, 5h, 2d — never a turn's minutes. */
const stateTime = (since: number | null, now: number): string => {
 const duration=elapsedSince(since,now)
 return duration===null?'—':formatCountdownShort(Math.max(1,duration)) ?? '—'
}
/** Only the time cells follow the clock, once a minute: the column shows minutes at best. */
const MinuteNow = createContext(0)
const MinuteClock = ({children}: {children: ReactNode}) => {
 const [now,setNow]=useState(Date.now)
 useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),60_000);return()=>window.clearInterval(timer)},[])
 return <MinuteNow.Provider value={now}>{children}</MinuteNow.Provider>
}
const StateTime = ({since}: {since: number | null}) => <>{stateTime(since,useContext(MinuteNow))}</>
const parts = <T,>(items: readonly T[], size: number): T[][] => Array.from({length:Math.ceil(items.length/size)},(_,index)=>items.slice(index*size,(index+1)*size))
const withCount = (label: string, count: number): string => `${label} · ${count}`
const labels = {active:'Active','needs-you':'Needs you',settled:'Settled'} as const
const stateLabels = {'needs-you':'Needs you',unread:'Unread',working:'Working',idle:'Idle',settled:'Settled',wrapped:'Wrapped',wrapping:'Wrapping',stopped:'Stopped'} as const

/** Every Team on the desk; no per-project or runtime-specific reader. */
export const TeamsWindow = ({onClose, initialFilter='active'}: {onClose:()=>void; initialFilter?:TeamFilter}) => {
 useEscapeSurface(true,onClose)
 const store=useStore(); const snapshot=useSnapshot()
 const [filter,setFilter]=useState<TeamFilter>(initialFilter)
 const [expanded,setExpanded]=useState(false)
 const {ref:pageBox,narrow}=useNarrowLayout<HTMLDivElement>(600)
 const [reports,setReports]=useState<ReadonlyMap<string,InsightReport>>(new Map())
 const [reading,setReading]=useState(false)
 const inputs=useMemo(()=>teamsInput(snapshot,reports),[snapshot,reports])
 const marks=useMemo(()=>new Map(inputs.flatMap(input=>teamSeats(input.goal,input.team,input.execution).filter(hasConversation).map(seat=>[seat.record.id,snapshot.runtimes.find(runtime=>runtime.id===seat.record.session.runtime)] as const))),[inputs,snapshot.runtimes])
 const list=useMemo(()=>teamsList(inputs,snapshot.teamsPrefs),[inputs,snapshot.teamsPrefs])
 // What the open tab shows: its rows, and Ready to wrap only while unfolded.
 const shown=useMemo(()=>[...list[filter],...(filter==='active'&&expanded?list.ready:[])].flatMap(group=>group.rows),[list,filter,expanded])
 const text=useMemo(()=>new Map(shown.map(row=>[row.id,rowWords(row)])),[shown])
 const shownIds=useMemo(()=>new Set(shown.map(row=>row.id)),[shown])
 // Read usage for the rows the open tab shows, on opening it, after one of
 // their cards completes, and once a minute while a Run goes on: one request
 // per project batch, one state update per read. Failed reads clear their old
 // value rather than promise zero.
 const usageScope=[...shownIds].filter(id=>snapshot.goals.has(id)).sort().join('\0')
 const closed=[...snapshot.teams.values()].filter(team=>shownIds.has(team.id)).flatMap(team=>team.intents.filter(card=>card.state==='done').map(card=>`${team.id}:${card.id}`)).sort().join('\0')
 const running=[...snapshot.flowExecutions.values()].some(run=>run.state==='running')
 useEffect(()=>{
  let live=true
  const ids=usageScope.split('\0').filter(Boolean)
  const read=async()=>{
   if(!ids.length){setReading(false);return}
   setReading(true)
   const answers=await Promise.all(parts(ids,INSIGHT_GOALS_LIMIT).map(goals=>store.readGoalInsights(goals).catch(():InsightGoalsReport=>({reports:[],failed:goals}))))
   if(!live)return
   setReports(current=>{
    const next=new Map(current)
    for(const answer of answers){
     for(const report of answer.reports)if(report.goal!==null)next.set(report.goal,report)
     for(const id of answer.failed)next.delete(id)
    }
    return next
   })
   setReading(false)
  }
  void read(); const timer=running?window.setInterval(read,60_000):null
  return()=>{live=false;if(timer!==null)window.clearInterval(timer)}
 },[store,usageScope,closed,running])
 // A Run and its review can move a Team into Needs you, so both are read for
 // every Team that is not wrapped. A wrapped Team's Run is read once its row
 // is shown, for its faces, and its review never: nothing on a wrapped row
 // follows it. Each is asked for once while the page is open, so an answer
 // landing never sends the others again.
 const asked=useRef({runs:new Set<string>(),reviews:new Set<string>()})
 const wrapped=(team:string)=>snapshot.goals.get(team)?.goal.state==='wrapped'
 const missingRuns=[...snapshot.goals.values()].filter(goal=>shownIds.has(goal.goal.id) || !wrapped(goal.goal.id)).map(namedGoalRun).filter((id):id is string=>Boolean(id) && !snapshot.flowExecutions.has(id!)).sort().join('\0')
 useEffect(()=>{
  const runs=missingRuns.split('\0').filter(run=>run && !asked.current.runs.has(run))
  for(const run of runs)asked.current.runs.add(run)
  if(runs.length)void store.readFlowExecutions(runs).catch(()=>{})
 },[store,missingRuns])
 const reviewScope=JSON.stringify(inputs.flatMap(input=>input.execution && !wrapped(input.team.id)?[[input.team.id,input.execution.id]]:[]).sort(([a],[b])=>a!.localeCompare(b!)))
 useEffect(()=>{
  for(const [goal,run] of JSON.parse(reviewScope) as [string,string][]){
   const key=`${goal}\0${run}`
   if(asked.current.reviews.has(key) || typeof store.loadFindingRun!=='function')continue
   asked.current.reviews.add(key); void store.loadFindingRun(goal,run).catch(()=>{})
  }
 },[store,reviewScope])
 const open=(row:TeamListRow)=>{
  store.markTeamSeen(row.id,row.change); void store.openTeamRoom(row.id,row.change); onClose()
 }
 const state=(row:TeamListRow)=>row.state==='needs-you'||row.state==='working'
  ? <Chip tone={row.state==='needs-you'?'warning':'info'}>{stateLabels[row.state]}</Chip>
  : <Text role="meta">{row.ready?'Ready to wrap':stateLabels[row.state]}</Text>
 const say=(row:TeamListRow):RowWords=>text.get(row.id) ?? rowWords(row)
 const faces=(row:TeamListRow)=>row.seats.length ? <AvatarStack size="stack" aria-label={`${row.seats.length} ${row.seats.length === 1 ? 'seat' : 'seats'}`} members={row.seats.map((seat,index)=>{
  const runtime=marks.get(seat.seat)
  return {id:seat.seat,name:say(row).seats[index] ?? plain(seat.name),tint:runtime?runtimeTint(runtime.id,snapshot.accountsByRuntime,snapshot.accountPrefs):'blue',mark:runtime?<RuntimeMark runtime={runtime}/>:<AgentIcon/>}
 })}/>:undefined
 const menu=(row:TeamListRow)=>row.ready && <Popover label={<MoreIcon />} title="More" align="right">{close=><Menu close={close}><MenuItem label={snapshot.teamsPrefs.hidden[row.id]===row.change?'Show in Active':'Hide'} onSelect={()=>{store.setTeamHidden(row.id,snapshot.teamsPrefs.hidden[row.id]!==row.change);close()}}/></Menu>}</Popover>
 const cost=(row:TeamListRow)=>row.total.money===null?'—':`$${row.total.money.toFixed(2)}`
 const groups=(groups:readonly TeamListGroup[])=>{
 const showCost=groups.some(group=>group.rows.some(row=>row.total.money!==null))
 return narrow === null ? null : narrow ? <>{groups.map(group=><section key={group.project} aria-label={folderName(group.project)} data-team-project={group.project}>
  <GroupLabel>{withCount(folderName(group.project),group.rows.length)}</GroupLabel>
  <ListRows>{group.rows.map(row=><ListRow key={row.id} data-team-row={row.id} interactive className="relative isolate"
   onClick={event=>{if(!event.currentTarget.contains(event.target as Node))return;if(!(event.target as Element).closest('button'))open(row)}}
   lead={faces(row)} mark={row.unread?<Dot aria-label="Unread changes" tone="info"/>:false}
   title={<Button stretched hoverFill={false} variant="row" size="content-min" bordered={false} aria-label={`Open ${say(row).sentence}`} onClick={()=>open(row)} className="block max-w-full"><Text as="span" className="block" role="subject" truncate>{say(row).sentence}</Text></Button>} subtitle={<span data-slot="team-detail">{[say(row).detail,instant(row.since)===null?null:<><StateTime since={row.since}/> in this state</>,row.total.turns===null?null:`${row.total.turns} turns`,cost(row)==='—'?null:cost(row)].filter(Boolean).map((part,index)=><Fragment key={index}>{index>0&&' · '}{part}</Fragment>)}</span>} wrapSubtitle
   trail={<>{state(row)}{menu(row)}<ChevronIcon /></>} />)}</ListRows>
 </section>)}</> : <Table variant="framed" className="table-auto">
  <TableHeader><TableRow><TableHead>Team</TableHead><TableHead className="w-[1%]">State</TableHead>
   <TableHead numeric className="w-[1%]">Time</TableHead><TableHead numeric className="w-[1%]">Turns</TableHead>{showCost&&<TableHead numeric className="w-[1%]">Cost</TableHead>}<TableHead className="w-[1%]"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
  <TableBody>{groups.map(group=><Fragment key={group.project}>
   <TableRow data-team-project={group.project}><TableCell colSpan={showCost?6:5}><GroupLabel>{withCount(folderName(group.project),group.rows.length)}</GroupLabel></TableCell></TableRow>
   {group.rows.map(row=><TableRow key={row.id} data-team-row={row.id} interactive className="relative isolate"
    onClick={event=>{if(!event.currentTarget.contains(event.target as Node))return;if(!(event.target as Element).closest('button'))open(row)}}>
    <TableCell className="max-w-0" lead={faces(row)}><div data-slot="team-identity" className="min-w-0 flex-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
      <span className="inline-flex w-1.5 self-center">{row.unread&&<Dot aria-label="Unread changes" tone="info"/>}</span><Button stretched hoverFill={false} variant="row" size="content-min" bordered={false} aria-label={`Open ${say(row).sentence}`} onClick={()=>open(row)} className="block min-w-0 max-w-full"><Text as="span" className="block" role="subject" truncate title={say(row).sentence}>{say(row).sentence}</Text></Button>
      {say(row).detail!==null&&<div data-slot="team-detail" title={say(row).detail!} className="col-start-2 whitespace-normal [overflow-wrap:anywhere]"><Text role="meta">{say(row).detail}</Text></div>}
    </div></TableCell>
    <TableCell>{state(row)}</TableCell><TableCell numeric><Text role="meta" numeric title={row.since===null?'Time in this state is unavailable':undefined}><StateTime since={row.since}/></Text></TableCell>
    <TableCell numeric><Text role="meta" numeric title={row.total.turns===null?'Recorded turns are unavailable':undefined}>{row.total.turns??'—'}</Text></TableCell>{showCost&&<TableCell numeric><Text role="meta" numeric title={row.total.money===null?'Recorded usage is unavailable':'Recorded Team usage; money only from metered accounts with a known rate'}>{cost(row)}</Text></TableCell>}
    <TableCell><span className="flex items-center gap-2">{menu(row)}<ChevronIcon /></span></TableCell>
   </TableRow>)}
  </Fragment>)}</TableBody>
 </Table>
 }
 return <MinuteClock><AppWindow label="Teams" responsive>
  <WindowNav onBack={onClose}>{(['active','needs-you','settled'] as const).map(value=><WindowNavItem key={value} icon={undefined} label={labels[value]} count={list.counts[value]} selected={filter===value} onClick={()=>setFilter(value)}/>)}</WindowNav>
  <WindowPage><div ref={pageBox} data-slot="teams-page" data-layout={narrow===null?"unmeasured":narrow?"narrow":"table"} className="min-w-0 flex flex-col gap-4">
   <PageHead title="Teams"/>
   {snapshot.goalProblem && <Banner tone="warning" title="Teams could not be refreshed">{words(snapshot.goalProblem)}</Banner>}
   {reading && <Text role="meta">Reading recorded usage…</Text>}
   {list[filter].length?groups(list[filter]):<EmptyState title={filter==='active'?'No active Teams':filter==='needs-you'?'No Teams need you':'No settled Teams'}/>}
   {filter==='active' && list.ready.length>0 && <section aria-label="Ready to wrap">
    <Button variant="quiet" size="content" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><DisclosureChevron open={expanded}/>Ready to wrap · {list.ready.reduce((count,group)=>count+group.rows.length,0)}</Button>
    {expanded && groups(list.ready)}
   </section>}
  </div></WindowPage>
 </AppWindow></MinuteClock>
}
