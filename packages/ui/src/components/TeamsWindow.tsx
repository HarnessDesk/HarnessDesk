import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { INSIGHT_GOALS_LIMIT, type InsightGoalsReport, type InsightReport } from '@harnessdesk/protocol'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { teamSeats, hasConversation } from '../lib/team-seats'
import { namedGoalRun } from '../lib/goal-run'
import { teamsInput } from '../lib/teams-snapshot'
import { teamsList, type TeamFilter, type TeamListGroup, type TeamListRow } from '../lib/teams-list'
import { sanitizeHtml } from '../lib/sanitize'
import { folderName } from '../lib/projects'
import { elapsedSince, instant } from '../lib/clock'
import { formatCountdownShort } from '../lib/usage'
import { DestinationBar, useDestinationActive } from '../panels/destination-page'
import { runtimeTint } from '../lib/accounts'
import { AgentIcon, ChevronIcon, MoreIcon, ResetIcon, BlindIcon, TeamIcon } from './Icons'
import { Banner, Button, Chip, DisclosureChevron, Dot, EmptyState, AvatarStack, Menu, MenuItem, Popover, Page, PageRecords, Section, PageRecordViews, Text } from '../design'

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
 const active=useDestinationActive()
 const [now,setNow]=useState(Date.now)
 useEffect(()=>{if(!active)return;setNow(Date.now());const timer=window.setInterval(()=>setNow(Date.now()),60_000);return()=>window.clearInterval(timer)},[active])
 return <MinuteNow.Provider value={now}>{children}</MinuteNow.Provider>
}
const StateTime = ({since}: {since: number | null}) => <>{stateTime(since,useContext(MinuteNow))}</>
const parts = <T,>(items: readonly T[], size: number): T[][] => Array.from({length:Math.ceil(items.length/size)},(_,index)=>items.slice(index*size,(index+1)*size))
/** Successful reads stay read; refusals get two delayed retries during this opening. */
const useReadOnce = (scope: string, read: (keys: readonly string[]) => Promise<readonly string[]>) => {
 const reads=useRef({pending:new Set<string>(),waiting:new Set<string>(),done:new Set<string>(),attempts:new Map<string,number>()})
 const active=useDestinationActive()
 const activeNow=useRef(active);activeNow.current=active
 const live=useRef(false)
 const timers=useRef(new Set<number>())
 const [retry,setRetry]=useState(0)
 useEffect(()=>{
  live.current=true
  return()=>{live.current=false;for(const timer of timers.current)window.clearTimeout(timer);timers.current.clear()}
 },[])
 useEffect(()=>{
  if(!active){for(const timer of timers.current)window.clearTimeout(timer);timers.current.clear();reads.current.waiting.clear();return}
  const state=reads.current
  const keys=scope.split('\0').filter(key=>key && !state.pending.has(key) && !state.waiting.has(key) && !state.done.has(key) && (state.attempts.get(key)??0)<3)
  if(!keys.length)return
  for(const key of keys){state.pending.add(key);state.attempts.set(key,(state.attempts.get(key)??0)+1)}
  void read(keys).catch(()=>[] as string[]).then(success=>{
   if(!live.current)return
   for(const key of keys)state.pending.delete(key)
   for(const key of success)state.done.add(key)
   const failed=keys.filter(key=>!state.done.has(key) && state.attempts.get(key)!<3)
   if(failed.length && activeNow.current){
    for(const key of failed)state.waiting.add(key)
    const timer=window.setTimeout(()=>{
     timers.current.delete(timer)
     for(const key of failed)state.waiting.delete(key)
     setRetry(value=>value+1)
    },5_000)
    timers.current.add(timer)
   }
  })
 },[scope,read,retry,active])
}
const withCount = (label: string, count: number): string => `${label} · ${count}`
const labels = {active:'Active','needs-you':'Needs you',settled:'Settled'} as const
const stateLabels = {'needs-you':'Needs you',unread:'Unread',working:'Working',idle:'Idle',settled:'Settled',wrapped:'Wrapped',wrapping:'Wrapping',stopped:'Stopped',stopping:'Stopping'} as const

/** Every Team on the desk; no per-project or runtime-specific reader. */
interface TeamsPageProps { readonly filter: TeamFilter; readonly onFilter: (filter: TeamFilter) => void; readonly onNew: () => void }
export const TeamsWindow = (props: TeamsPageProps) => <TeamsList {...props} />
const TeamsList = ({filter,onFilter,onNew}: TeamsPageProps) => {
 const active=useDestinationActive()
 const store=useStore(); const snapshot=useSnapshot()
 const [expanded,setExpanded]=useState(false)
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
  if(!active)return
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
 },[store,usageScope,closed,running,active])
 // A Run and its review can move a Team into Needs you, so both are read for
 // every Team that is not wrapped. A wrapped Team's Run is read once its row
 // is shown, for its faces, and its review never: nothing on a wrapped row
 // follows it. Successful reads are kept for this opening; failures get at
 // most two retries, five seconds apart, without duplicating pending reads.
 const wrapped=(team:string)=>snapshot.goals.get(team)?.goal.state==='wrapped'
 const missingRuns=[...snapshot.goals.values()].filter(goal=>shownIds.has(goal.goal.id) || !wrapped(goal.goal.id)).map(namedGoalRun).filter((id):id is string=>Boolean(id) && !snapshot.flowExecutions.has(id!)).sort().join('\0')
 const readRuns=useCallback(async(runs:readonly string[])=>{
  await store.readFlowExecutions(runs)
  // The batch reader resolves after partial refusals: only a stored Run was read.
  return runs.filter(run=>store.getSnapshot().flowExecutions.has(run))
 },[store])
 useReadOnce(missingRuns,readRuns)
 const reviewScope=inputs.flatMap(input=>input.execution && !wrapped(input.team.id)?[JSON.stringify([input.team.id,input.execution.id])]:[]).sort().join('\0')
 const readReviews=useCallback(async(keys:readonly string[])=>{
  if(typeof store.loadFindingRun!=='function')return []
  const answers=await Promise.allSettled(keys.map(key=>{
   const [goal,run]=JSON.parse(key) as [string,string]
   return store.loadFindingRun(goal,run)
  }))
  return keys.filter((_,index)=>answers[index]!.status==='fulfilled')
 },[store])
 useReadOnce(reviewScope,readReviews)
 const open=(row:TeamListRow)=>{
  store.markTeamSeen(row.id,row.change); void store.openTeamRoom(row.id,row.change)
 }
 const state=(row:TeamListRow)=>row.state==='needs-you'||row.state==='working'
  ? <Chip tone={row.state==='needs-you'?'warning':'info'}>{stateLabels[row.state]}</Chip>
  : <Text role="meta">{row.ready?'Ready to wrap':stateLabels[row.state]}</Text>
 const say=(row:TeamListRow):RowWords=>text.get(row.id) ?? rowWords(row)
 const faces=(row:TeamListRow)=>row.seats.length ? <AvatarStack size="stack" aria-label={`${row.seats.length} ${row.seats.length === 1 ? 'seat' : 'seats'}`} members={row.seats.map((seat,index)=>{
  const runtime=marks.get(seat.seat)
  return {id:seat.seat,name:say(row).seats[index] ?? plain(seat.name),tint:runtime?runtimeTint(runtime.id,snapshot.accountsByRuntime,snapshot.accountPrefs):'blue',mark:runtime?<RuntimeMark runtime={runtime}/>:<AgentIcon/>}
 })}/>:undefined
 const menu=(row:TeamListRow)=>active && row.ready && <Popover label={<MoreIcon />} title="More" align="right" icons="all">{close=><Menu close={close}><MenuItem icon={snapshot.teamsPrefs.hidden[row.id]===row.change?<ResetIcon/>:<BlindIcon/>} label={snapshot.teamsPrefs.hidden[row.id]===row.change?'Show in Active':'Hide'} onSelect={()=>{store.setTeamHidden(row.id,snapshot.teamsPrefs.hidden[row.id]!==row.change);close()}}/></Menu>}</Popover>
 const cost=(row:TeamListRow)=>row.total.money===null?'—':`$${row.total.money.toFixed(2)}`
 const groups = (source: readonly TeamListGroup[]) => {
   const showCost = source.some(group => group.rows.some(row => row.total.money !== null))
   return <PageRecords label="Team" columns={[
     { id: 'time', label: 'Time', numeric: true }, { id: 'turns', label: 'Turns', numeric: true },
     ...(showCost ? [{ id: 'cost', label: 'Cost', numeric: true }] : []),
   ]} groups={source.map(group => ({ id: group.project,
     label: withCount(folderName(group.project), group.rows.length),
     rows: group.rows.map(row => ({ id: row.id, title: say(row).sentence,
       description: say(row).detail ?? undefined, lead: faces(row),
       mark: row.unread ? <Dot aria-label="Unread changes" tone="info" /> : undefined,
       state: state(row), actions: <>{menu(row)}<ChevronIcon /></>, open: () => open(row),
       values: {
         time: <Text role="meta" numeric title={row.since === null ? 'Time in this state is unavailable' : undefined}><StateTime since={row.since}/></Text>,
         turns: <Text role="meta" numeric title={row.total.turns === null ? 'Recorded turns are unavailable' : undefined}>{row.total.turns ?? '—'}</Text>,
         cost: <Text role="meta" numeric title={row.total.money === null ? 'Recorded usage is unavailable' : 'Recorded Team usage; money only from metered accounts with a known rate'}>{cost(row)}</Text>,
       },
       compact: [say(row).detail, instant(row.since) === null ? null : <><StateTime since={row.since}/> in this state</>,
         row.total.turns === null ? null : `${row.total.turns} turns`, cost(row) === '—' ? null : cost(row)]
         .filter(Boolean).map((part,index) => <Fragment key={index}>{index > 0 && ' · '}{part}</Fragment>),
     })),
   }))} />
 }
 return <MinuteClock><Page width="wide" fill>
  <DestinationBar place="Teams" verb={{label:'New Team',run:onNew,disabled:snapshot.workspace?false:'Open a project folder first.'}}/>
  <PageRecordViews label="Teams views" value={filter} change={onFilter} choices={(['active','needs-you','settled'] as const).map(value=>({value,label:labels[value],count:list.counts[value]}))}/>
  {snapshot.goalProblem && <Banner tone="warning" title="Teams could not be refreshed">{words(snapshot.goalProblem)}</Banner>}
  {reading && <Text role="meta">Reading recorded usage…</Text>}
  {list[filter].length?groups(list[filter]):<EmptyState
   fill
   icon={<TeamIcon />}
   title={filter==='active'?'No active Teams':filter==='needs-you'?'No Teams need you':'No settled Teams'}
   description="Create a Team to bring agents together on a project."
  >
   <Button variant="outline" disabled={!snapshot.workspace} title={!snapshot.workspace?'Open a project folder first.':undefined} onClick={onNew}>New Team</Button>
  </EmptyState>}
  {filter==='active' && list.ready.length>0 && <Section title="Ready to wrap" action={
   <Button variant="outline" size="sm" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>
    <DisclosureChevron open={expanded}/>Ready to wrap · {list.ready.reduce((count,group)=>count+group.rows.length,0)}
   </Button>}>
   {expanded && groups(list.ready)}
  </Section>}
 </Page></MinuteClock>
}
