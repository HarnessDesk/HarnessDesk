import { beforeEach, afterEach, vi } from 'vitest'
import { FRAME } from '../design/frame'
import { SettingsNavigation } from '../components/SettingsNavigation'
import { AddAgents } from '../components/SettingsAgents'
import { useEffect, useState, type ReactNode } from 'react'
import type { RuntimeId } from '@harnessdesk/protocol'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'
import { DestinationPageScope } from '../panels/destination-page'
import { destinationForSettings } from '../app/settings-destination'
import type { SettingsRoute } from '../state/destinations'
import { Settings, SkillsSection, WorkspacesSection, type Section } from '../components/Settings'
import { RuntimesSection, type RuntimeSettingsView } from '../components/SettingsAgents'

/** Component tests own routes just as App's destination registry does. */
export const SettingsTestScope = ({children,active=true}: {children:ReactNode;active?:boolean}) => <TopBarProvider>
  <DestinationPageScope owner="destination:settings" active={active}>{children}</DestinationPageScope>
  <TopBarOutlet owner="destination:settings" fallback={{place:'Work',more:()=>null}}/>
</TopBarProvider>
export const SettingsTestPage = ({section='runtimes',focus=null,onSection,onSignIn}: {
  section?:string;focus?:string|null;onSection?:(section:Section)=>void;onSignIn:(runtime:RuntimeId)=>void;onClose?:()=>void;libraryImport?:boolean;leftColumn?:ReactNode
}) => {
  const initial=destinationForSettings(section,focus)
  const [route,setRoute]=useState<SettingsRoute>(initial.kind==='settings'?initial.route:{kind:'section',section:'general',focus:null})
  useEffect(()=>{const next=destinationForSettings(section,focus);if(next.kind==='settings')setRoute(next.route)},[section,focus])
  return <SettingsTestScope><SettingsNavigation section={route.kind==='section'?route.section:route.kind==='project'?'workspaces':route.kind==='skill'?'skills':'runtimes'} onSection={next=>{setRoute({kind:'section',section:next==='library'||next==='plugins'?'general':next,focus:null});onSection?.(next)}} onBack={()=>{}}/><Settings route={route} onRoute={next=>{setRoute(next);if(next.kind==='section')onSection?.(next.section)}} onSignIn={onSignIn}/></SettingsTestScope>
}
export const RuntimesTestPage = ({focus,onSignIn,onBrowseHistory}: {focus?:string;onSignIn:(runtime:RuntimeId)=>void;onBrowseHistory?:(id:string)=>void}) => {
  const [view,onView]=useState<RuntimeSettingsView>(focus==='add'?{kind:'add'}:focus?{kind:'agent',runtime:focus as RuntimeId}:{kind:'list'})
  return <SettingsTestScope><RuntimesSection view={view} onView={onView} onSignIn={onSignIn} onBrowseHistory={onBrowseHistory}/></SettingsTestScope>
}
export const SkillsTestPage = ({onUse,name=null,active=true}: {onUse:()=>void;name?:string|null;active?:boolean}) =>
  <SettingsTestScope active={active}><SkillsSection name={name} onUse={onUse}/></SettingsTestScope>
export const WorkspacesTestPage = ({focus=null}: {focus?:string|null}) => {
  const [project,onProject]=useState<string|null>(focus&&focus!=='triggers'?focus:null)
  useEffect(()=>onProject(focus&&focus!=='triggers'?focus:null),[focus])
  return <SettingsTestScope><WorkspacesSection focus={focus} project={project} onProject={onProject}/></SettingsTestScope>
}

export const AddAgentsTestPage = (props: Parameters<typeof AddAgents>[0]) => <SettingsTestScope><AddAgents {...props}/></SettingsTestScope>

// jsdom supplies no flex geometry. Model a wide measured bar while keeping the production title floor.
beforeEach(()=>{
  const computed=getComputedStyle
  vi.spyOn(globalThis,'getComputedStyle').mockImplementation((node,pseudo)=>{
    const css=computed(node,pseudo)
    if(node.matches('[data-slot="top-bar"]')) {
      const property=css.getPropertyValue.bind(css)
      vi.spyOn(css,'getPropertyValue').mockImplementation(name=>name==='--hd-bar-title-min'?`${FRAME.bar.titleMin}px`:property(name))
    }
    return css
  })
  const rect=Element.prototype.getBoundingClientRect
  vi.spyOn(Element.prototype,'getBoundingClientRect').mockImplementation(function(this:Element){
    if(this.matches('[data-topbar-title],[data-topbar="place"],[data-slot="top-bar"]')) return new DOMRect(0,0,1440,FRAME.bar.height)
    return rect.call(this)
  })
})
afterEach(()=>vi.restoreAllMocks())
