import { TopBarProvider } from '../panels/top-bar'
import { ShellHostsProvider, ShellOutlets } from '../panels/shell-hosts'
import { useEffect, useMemo, useRef } from 'react'
import { Workbench } from '../panels/Workbench'
import { ShellProvider } from '../panels/views'
import { Sidebar } from '../components/Sidebar'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { emptyWorkbench } from '../state/workbench'
import { overviewTeamStore } from './team-overview-fixture'
import { triggerRunsStore } from './team-runs-fixture'
import { TeamFramePreview } from './TeamFramePreview'

/** The real Team frame and unchanged sidebar, with placeholder-only membership. */
export const TeamFrame = () => {
 useTheme()
 const controls = new URLSearchParams(location.search).get('team-frame') === 'controls'
 const box = useRef<HTMLDivElement>(null)
 useEffect(() => {
  if (!controls) return
  const frame=requestAnimationFrame(() => box.current?.querySelector<HTMLButtonElement>('header button[title="More"]')?.click())
  return () => cancelAnimationFrame(frame)
 }, [controls])
 const store = useMemo(() => {
  const scene = new URLSearchParams(location.search).get('team-frame')
  const own = scene === 'trigger-runs' ? triggerRunsStore() : overviewTeamStore(scene === 'ready' ? 'done' : scene === 'running' ? 'running' : scene === 'no-run' ? 'no-run' : 'needs-you')
  const main = {root:{kind:'pane' as const,id:'frame-team',view:{kind:'room' as const,room:'overview-team'}},focused:'frame-team',expanded:null}
  const snapshot = own.getSnapshot()
  const base = emptyWorkbench()

  const run = [...snapshot.flowExecutions.values()].at(-1)!
  Object.assign(snapshot, {flowExecutions:scene === 'trigger-runs' || !run ? snapshot.flowExecutions : new Map([[run.id,{...run,target:{kind:'branch',label:'team/checkout',base:null,head:'a1b2c3d4e5f6',pr:null,dirty:false}}]]),boardEvidence:new Map([['overview-team',{room:'overview-team',stamp:1,checks:[],refused:[],unreadable:null,cards:[{card:1,running:[],facts:[{freshness:{state:'fresh'},by:null,record:{id:'frame-pr',observedAt:1,fact:{kind:'pr',number:7,head:'a1b2c3d4e5f6',state:'open',url:'https://github.com/acme/storefront/pull/7'}}}]}]}]]),workbench:{...base,main},layout:main,sidebarCollapsed:false,sidebarFloating:false,activeSessionKey:null})
  if (new URLSearchParams(location.search).has('right-panel')) void own.openBrowser()
  return own
 }, [])
 return <StoreProvider store={store}><ShellProvider actions={{chooseProject:()=>{},signIn:()=>{},openUsage:()=>{},openRuntimes:()=>{},openAgents:()=>{},reviewImports:()=>{}}}>
  <div ref={box} data-frame-id="team-frame" className={`h-screen bg-background${controls ? ' max-w-180' : ''}`}>
   <TopBarProvider><ShellHostsProvider><Workbench sidebar={<Sidebar onOpenSettings={()=>{}} onOpenPlugins={()=>{}} onOpenAgents={()=>{}} onOpenTeams={()=>{}} onOpenUsage={()=>{}} onBrowseFolders={()=>{}} onSignIn={()=>{}} onSearch={()=>{}} />} /><ShellOutlets activeOwner={null} /></ShellHostsProvider></TopBarProvider>
  </div>
 </ShellProvider></StoreProvider>
}

const TeamBarExample = ({narrow = false, sideBySide = false}:{narrow?:boolean;sideBySide?:boolean}) => {
 const box = useRef<HTMLDivElement>(null)
 const store=useMemo(()=>overviewTeamStore(narrow?'no-run':'running'),[narrow])
 const view=useMemo(()=>({kind:'room' as const,room:'overview-team',...(sideBySide ? {framePage:'room' as const,sideBySide:{tiles:[...store.getSnapshot().sessions.keys()].slice(0,2)}} : {})}),[store,sideBySide])
 useEffect(() => {
  // Keep all three catalogue cases measured on their replacement frame Bar.
  box.current?.querySelector('header[data-slot="bar"]')?.setAttribute('data-catalog-size', narrow ? 'sm' : sideBySide ? 'lg' : 'default')
 }, [narrow, sideBySide])
 return <div ref={box} className={`h-96 w-full${narrow?' max-w-180':''}`}><StoreProvider store={store}><TeamFramePreview room="overview-team" view={view} /></StoreProvider></div>
}

/** Production Team chrome at a full width, a narrowed pane and Side by side. */
export const TeamBarBoard = () => <div className="flex flex-col gap-4">
 <TeamBarExample />
 <TeamBarExample narrow />
 <TeamBarExample sideBySide />
</div>
