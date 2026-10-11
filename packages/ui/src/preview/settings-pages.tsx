import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { RuntimeId } from '@harnessdesk/protocol'
import { App } from '../app/App'
import { destinationForSettings } from '../app/settings-destination'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'
import { DestinationPageScope } from '../panels/destination-page'
import { StoreProvider, useStore } from '../state/context'
import { RuntimesSection, type RuntimeSettingsView } from '../components/SettingsAgents'
import { WorkspacesSection, type Section } from '../components/Settings'
import { frameDestinationStore } from './frame-destination-store'
export const SettingsPreview = ({section='general',focus=null,onSection}: {
  section?:Section;focus?:string|null;onSection?:(section:Section,focus?:string|null)=>void
}) => {
  const fixture=useStore()
  const store=useMemo(()=>frameDestinationStore(fixture),[fixture])
  useEffect(()=>{
    const page=destinationForSettings(section,focus)
    if(page.kind==='settings')store.openDestination(page)
    else store.askSettings(section,focus)
  },[store,section,focus])
  useEffect(()=>store.subscribe(()=>{
    const page=store.getSnapshot().workbench.navigation.current
    if(page.kind==='settings'&&page.route.kind==='section')onSection?.(page.route.section,page.route.focus)
  }),[store,onSection])
  return <StoreProvider store={store}><App/></StoreProvider>
}
export const SettingsPreviewScope=({children}: {children:ReactNode})=><TopBarProvider>
  <DestinationPageScope owner="destination:settings" active>{children}</DestinationPageScope>
  <TopBarOutlet owner="destination:settings" fallback={{place:'Settings',more:()=>null}}/>
</TopBarProvider>
export const RuntimesPreview=({focus,onSignIn}: {focus?:string;onSignIn:(runtime:RuntimeId)=>void})=>{
  const [view,onView]=useState<RuntimeSettingsView>(focus?{kind:'agent',runtime:focus as RuntimeId}:{kind:'list'})
  return <SettingsPreviewScope><RuntimesSection view={view} onView={onView} onSignIn={onSignIn}/></SettingsPreviewScope>
}
export const WorkspacesPreview=({focus=null}: {focus?:string|null})=>{
  const [project,onProject]=useState<string|null>(focus&&focus!=='triggers'?focus:null)
  return <SettingsPreviewScope><WorkspacesSection project={project} onProject={onProject} focus={focus}/></SettingsPreviewScope>
}
