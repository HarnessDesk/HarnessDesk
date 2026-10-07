import { useEffect, useMemo, useRef } from 'react'
import { Workbench } from '../panels/Workbench'
import { ShellProvider } from '../panels/views'
import { Sidebar } from '../components/Sidebar'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { emptyWorkbench } from '../state/workbench'
import { overviewTeamStore } from './team-overview-fixture'
import { triggerRunsStore } from './team-runs-fixture'

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
  const own = scene === 'trigger-runs' ? triggerRunsStore() : overviewTeamStore(scene === 'ready' ? 'done' : scene === 'running' ? 'running' : 'needs-you')
  const main = {root:{kind:'pane' as const,id:'frame-team',view:{kind:'room' as const,room:'overview-team'}},focused:'frame-team',expanded:null}
  const snapshot = own.getSnapshot()
  const run = [...snapshot.flowExecutions.values()].at(-1)!
  Object.assign(snapshot, {flowExecutions:scene === 'trigger-runs' ? snapshot.flowExecutions : new Map([[run.id,{...run,target:{kind:'branch',label:'team/checkout',base:null,head:'a1b2c3d4e5f6',pr:null,dirty:false}}]]),boardEvidence:new Map([['overview-team',{room:'overview-team',stamp:1,checks:[],refused:[],unreadable:null,cards:[{card:1,running:[],facts:[{freshness:{state:'fresh'},by:null,record:{id:'frame-pr',observedAt:1,fact:{kind:'pr',number:7,head:'a1b2c3d4e5f6',state:'open',url:'https://github.com/acme/storefront/pull/7'}}}]}]}]]),workbench:{...emptyWorkbench(),main},layout:main,sidebarCollapsed:false,sidebarFloating:false,activeSessionKey:null})
  return own
 }, [])
 return <StoreProvider store={store}><ShellProvider actions={{chooseProject:()=>{},signIn:()=>{},openUsage:()=>{},openRuntimes:()=>{},openAgents:()=>{},reviewImports:()=>{}}}>
  <div ref={box} data-frame-id="team-frame" className={`h-screen bg-background${controls ? ' max-w-95' : ''}`}>
   <Workbench sidebar={<Sidebar onOpenSettings={()=>{}} onOpenPlugins={()=>{}} onOpenAgents={()=>{}} onOpenTeams={()=>{}} onOpenUsage={()=>{}} onBrowseFolders={()=>{}} onSignIn={()=>{}} onSearch={()=>{}} />} />
  </div>
 </ShellProvider></StoreProvider>
}
