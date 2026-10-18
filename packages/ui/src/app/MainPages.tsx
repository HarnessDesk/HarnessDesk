import { useEffect, useRef, useState } from 'react'
import type { RuntimeId } from '@harnessdesk/protocol'
import { DestinationBody } from '../design'
import { DestinationPageScope } from '../panels/destination-page'
import { useSnapshot, useStore } from '../state/context'
import type { PageDestination } from '../state/destinations'
import { MAIN_PAGE_ENTRIES } from './main-page-entries'
export const MIGRATED_PAGE_KINDS = Object.keys(MAIN_PAGE_ENTRIES) as PageDestination['kind'][]
export const isMainPage = (kind: string, leadAvailable = false): boolean => (kind !== 'lead' || leadAvailable) && Object.hasOwn(MAIN_PAGE_ENTRIES, kind)
export const MainPages = ({onSignIn,onNewTeam,libraryImportIntent,suspended=false}: {
  readonly onSignIn:(runtime:RuntimeId)=>void;readonly onNewTeam:()=>void;readonly libraryImportIntent:number;readonly suspended?:boolean
}) => {
  const store=useStore(), snapshot=useSnapshot(), current=snapshot.workbench.navigation.current
  const live=useRef({current,suspended,generation:0,mounted:true})
  if(live.current.current!==current || live.current.suspended!==suspended) live.current={current,suspended,generation:live.current.generation+1,mounted:live.current.mounted}
  useEffect(()=>{live.current.mounted=true;return()=>{live.current.mounted=false}},[])
  const [held,setHeld]=useState<Partial<Record<PageDestination['kind'],PageDestination>>>({})
  if (!snapshot.leadAvailable && held.lead) { const {lead: _lead, ...remaining} = held; setHeld(remaining) }
  if(current.kind!=='work' && isMainPage(current.kind, snapshot.leadAvailable) && held[current.kind]!==current) setHeld({...held,[current.kind]:current})
  return <>{Object.values(held).flatMap(page=>page && isMainPage(page.kind, snapshot.leadAvailable)?[page]:[]).map(page=>{
    const active=!suspended && current.kind===page.kind
    const generation=live.current.generation
    const owns=():boolean=>active && live.current.mounted && !live.current.suspended && live.current.generation===generation && store.getSnapshot().workbench.navigation.current===page
    const visit=(target:PageDestination):void=>{if(owns())store.openDestination(target)}
    const replace=(target:PageDestination):void=>{if(owns())store.replaceDestination(target)}
    return <DestinationBody key={page.kind} id={page.kind} active={active}>
      <DestinationPageScope owner={`destination:${page.kind}`} active={active}>
        {MAIN_PAGE_ENTRIES[page.kind]?.({page,visit,replace,onSignIn,onNewTeam,libraryImportIntent})}
      </DestinationPageScope>
    </DestinationBody>
  })}</>
}
