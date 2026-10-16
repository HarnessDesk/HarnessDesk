import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { teamSeats, hasConversation } from '../lib/team-seats'
import { namedGoalRun } from '../lib/goal-run'
import { teamsInput } from '../lib/teams-snapshot'
import { type TeamFilter, type TeamListRow } from '../lib/teams-list'
import { teamBoardItem } from '../lib/teams-board'
import { sanitizeHtml } from '../lib/sanitize'
import { folderName } from '../lib/projects'
import { elapsedSince } from '../lib/clock'
import { formatCountdownShort } from '../lib/usage'
import { DestinationBar, useDestinationActive } from '../panels/destination-page'
import { runtimeTint } from '../lib/accounts'
import { AgentIcon, ResetIcon, TeamIcon } from './Icons'
import { Banner, Button, EmptyState, AvatarStack, MenuItem, Page, Text, TeamsBoard, TeamsBoardColumn, TeamsBoardCard, TeamsBoardToolbar, TeamsBoardWrapped } from '../design'

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
/** Every Team on the desk; no per-project or runtime-specific reader. */
interface TeamsPageProps { readonly filter: TeamFilter; readonly onFilter: (filter: TeamFilter) => void; readonly onNew: () => void }
export const TeamsWindow = (props: TeamsPageProps) => <TeamsList {...props} />
const TeamsList = ({onNew}: TeamsPageProps) => {
 const store=useStore(); const snapshot=useSnapshot()
 const [expanded,setExpanded]=useState(false)
 const [project,setProject]=useState('')
 const [search,setSearch]=useState('')
 const inputs=useMemo(()=>teamsInput(snapshot),[snapshot])
 const marks=useMemo(()=>new Map(inputs.flatMap(input=>teamSeats(input.goal,input.team,input.execution).filter(hasConversation).map(seat=>[seat.record.id,snapshot.runtimes.find(runtime=>runtime.id===seat.record.session.runtime)] as const))),[inputs,snapshot.runtimes])
 const items=useMemo(()=>inputs.map(input=>teamBoardItem(input,snapshot.teamsPrefs)),[inputs,snapshot.teamsPrefs])
 const projects=useMemo(()=>[...new Set(inputs.map(input=>input.team.root))].sort().map(id=>({id,label:folderName(id)})),[inputs])
 const matching=useMemo(()=>items.filter(item=>(!project || item.row.project===project) &&
  `${plain(item.row.sentence)} ${plain(item.summary)} ${folderName(item.row.project)}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())),[items,project,search])
 const columns={
  'needs-you':matching.filter(item=>item.column==='needs-you'),
  working:matching.filter(item=>item.column==='working'),
  ready:matching.filter(item=>item.column==='ready' && item.row.state!=='wrapped'),
 }
 const wrappedItems=matching.filter(item=>item.row.state==='wrapped')
 // Only unfolded receipts participate in the page's bounded reads.
 const shown=useMemo(()=>matching.filter(item=>item.row.state!=='wrapped'||expanded).map(item=>item.row),[matching,expanded])
 const text=useMemo(()=>new Map(shown.map(row=>[row.id,rowWords(row)])),[shown])
 const shownIds=useMemo(()=>new Set(shown.map(row=>row.id)),[shown])
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
 const say=(row:TeamListRow):RowWords=>text.get(row.id) ?? rowWords(row)
 const faces=(row:TeamListRow)=>row.seats.length ? <AvatarStack size="stack" aria-label={`${row.seats.length} ${row.seats.length === 1 ? 'seat' : 'seats'}`} members={row.seats.map((seat,index)=>{
  const runtime=marks.get(seat.seat)
  return {id:seat.seat,name:say(row).seats[index] ?? plain(seat.name),tint:runtime?runtimeTint(runtime):'blue',mark:runtime?<RuntimeMark runtime={runtime}/>:<AgentIcon/>}
 })}/>:undefined
 const card=(item:ReturnType<typeof teamBoardItem>)=><TeamsBoardCard key={item.row.id} id={item.row.id}
  title={plain(item.title)} brief={say(item.row).sentence} summary={plain(item.summary)} attention={item.column==='needs-you'} unread={item.row.unread}
  path={item.path} faces={faces(item.row)} project={folderName(item.row.project)} age={<StateTime since={item.createdAt}/>} open={()=>open(item.row)}/>
 return <MinuteClock><Page width="wide" fill>
  <DestinationBar place="Teams" more={close=><MenuItem icon={<ResetIcon/>} label="Refresh Teams" onSelect={()=>{void store.loadGoals();close()}}/>}/>
  <TeamsBoardToolbar create={onNew} disabled={!snapshot.workspace} project={project} projects={projects} changeProject={setProject} search={search} changeSearch={setSearch}/>
  {snapshot.goalProblem && <Banner tone="warning" title="Teams could not be refreshed">{words(snapshot.goalProblem)}</Banner>}
  {items.length===0?<EmptyState fill icon={<TeamIcon/>} title="No Teams yet" description="Create a Team to bring agents together on a project.">
   <Button variant="outline" disabled={!snapshot.workspace} title={!snapshot.workspace?'Open a project folder first.':undefined} onClick={onNew}>New Team</Button>
  </EmptyState>:<>
   {matching.length===0 && <Text role="meta">No Teams match this search and project.</Text>}
   <TeamsBoard>
    <TeamsBoardColumn label="Needs you" tone="warning" count={columns['needs-you'].length}>{columns['needs-you'].map(card)}</TeamsBoardColumn>
    <TeamsBoardColumn label="Working" tone="brand" count={columns.working.length}>{columns.working.map(card)}</TeamsBoardColumn>
    <TeamsBoardColumn label="Ready to wrap" tone="success" count={columns.ready.length}>
     {columns.ready.map(card)}
     {wrappedItems.length>0 && <TeamsBoardWrapped count={wrappedItems.length} open={expanded} toggle={()=>setExpanded(value=>!value)}>{wrappedItems.map(card)}</TeamsBoardWrapped>}
    </TeamsBoardColumn>
   </TeamsBoard>
  </>}
 </Page></MinuteClock>
}
