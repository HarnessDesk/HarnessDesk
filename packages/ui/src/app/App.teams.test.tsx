import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
vi.mock('../lib/desktop',()=>({desktop:()=>undefined,isDesktop:()=>false,onOpenGoal:()=>()=>{},onOpenSession:()=>()=>{},onShortcut:()=>()=>{},setTraySummary:()=>{},setWindowTitle:()=>{}}))
vi.mock('../panels/Workbench',()=>({Workbench:({sidebar,pages}:{sidebar:ReactNode;pages:ReactNode})=><>{sidebar}{pages}</>}))
vi.mock('../components/Sidebar',()=>({Sidebar:({onOpenTeams,onOpenAgents,activeDestination}:{onOpenTeams:()=>void;onOpenAgents:()=>void;activeDestination:string})=><><button onClick={onOpenTeams}>Teams door</button><button onClick={onOpenAgents}>Agents door</button><output data-selected>{activeDestination}</output></>}))
vi.mock('../components/Notices',()=>({Notices:()=>null}))
vi.mock('../design',async original=>({...await original<object>(),Toaster:()=>null}))
vi.mock('../state/theme',()=>({useTheme:()=> 'light'}))
import { MAIN_PAGE_ENTRIES } from './main-page-entries'
import { App } from './App'
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
it('opens Teams from the left menu, returns with history, and deactivates it when Agents opens',async()=>{
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container)
 const store=new AppStore('ws://localhost:0/')
 Object.assign(store.getSnapshot(),{status:'open'})
 store.refreshCatalogIfStale=vi.fn(async()=>{})
 const saved={teams:MAIN_PAGE_ENTRIES.teams,agents:MAIN_PAGE_ENTRIES.agents}
 MAIN_PAGE_ENTRIES.teams=()=> <div data-teams/>
 MAIN_PAGE_ENTRIES.agents=()=> <div data-agents/>
 const settle=()=>act(async()=>{await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))})
 const click=async(label:string)=>{await act(async()=>[...container.querySelectorAll<HTMLButtonElement>('button')].find(one=>one.textContent===label)!.click());await settle()}
 try {
  await act(async()=>root.render(<StoreProvider store={store}><App/></StoreProvider>))
  await click('Teams door');expect(container.querySelector('[data-teams]')).not.toBeNull()
  expect(container.querySelector('[data-selected]')?.textContent).toBe('teams')
  await act(async()=>store.navigateBack());await settle()
  expect(container.querySelector('[data-page-destination="teams"]')?.hasAttribute('hidden')).toBe(true)
  await click('Teams door');await click('Agents door')
  expect(container.querySelector('[data-page-destination="teams"]')?.hasAttribute('hidden')).toBe(true)
  expect(container.querySelector('[data-page-destination="agents"]')?.hasAttribute('hidden')).toBe(false)
  await act(async()=>store.navigateBack());await settle()
  expect(container.querySelector('[data-page-destination="teams"]')?.hasAttribute('hidden')).toBe(false)
 }finally{Object.assign(MAIN_PAGE_ENTRIES,saved);await act(async()=>root.unmount());container.remove()}
})
