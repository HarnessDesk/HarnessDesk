import { useMemo } from 'react'
import { App } from '../app/App'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { frameDestinationStore } from './frame-destination-store'
import { teamsPageStore } from './teams-page-fixture'
import type { TeamFilter } from '../lib/teams-list'

/** Lane-owned entry for the existing preview document; Task 9 joins its route into the common wall. */
export const TeamsDestinationFixture = () => {
 useTheme()
 const store=useMemo(()=>{
  const query=new URLSearchParams(location.search)
  const fixture=teamsPageStore(query.get('frame-empty')==='1'?'empty':'active')
  const seed=fixture.getSnapshot(),session=[...seed.sessions.keys()][0]??null
  const main={root:{kind:'pane' as const,id:'teams-fixture-main',view:{kind:'conversation' as const,session}},focused:'teams-fixture-main',expanded:null}
  Object.assign(seed,{layout:main,workbench:{...seed.workbench,main},activeSessionKey:session,
   ...(query.get('frame-no-folder')==='1'?{workspace:null}:{}),sidebarCollapsed:false,sidebarFloating:false})
  const next=frameDestinationStore(fixture)
  const request=next.transport.request.bind(next.transport)
  next.transport.request=async(method,params)=>{
   if(method==='insight/goals')return await fixture.readGoalInsights((params as {goals:string[]}).goals) as never
   if(method==='finding/run'){
    const {goal,run}=params as {goal:string;run:string}
    return {goal,run,round:0,finished:0,total:0,embargoed:false,open:0,blocking:0,reason:null,ceilingStop:false,stamp:'fixture-empty',publication:'local',rounds:[],reviewersFinished:null,reviewersTotal:null,pendingExceptions:[],repair:null,boundPr:null,unbound:null,undecidable:null} as never
   }
   return request(method,params as never)
  }
  const value=query.get('frame-filter')
  const filter:TeamFilter=value==='needs-you'||value==='settled'?value:'active'
  next.openDestination({kind:'teams',filter})
  return next
 },[])
 return <StoreProvider store={store}><div data-frame-id="frame-wall" data-destination="teams"><App/></div></StoreProvider>
}
export const FrameWall = TeamsDestinationFixture
