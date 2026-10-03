import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
vi.mock('../lib/desktop',()=>({desktop:()=>undefined,isDesktop:()=>false,onOpenGoal:()=>()=>{},onOpenSession:()=>()=>{},onShortcut:()=>()=>{},setTraySummary:()=>{},setWindowTitle:()=>{}}))
vi.mock('../panels/Workbench',()=>({Workbench:({sidebar}:{sidebar:React.ReactNode})=><>{sidebar}</>}))
vi.mock('../components/Sidebar',()=>({Sidebar:({onOpenTeams,onOpenAgents,activeDestination}:{onOpenTeams:()=>void;onOpenAgents:()=>void;activeDestination:string})=><><button onClick={onOpenTeams}>Teams door</button><button onClick={onOpenAgents}>Agents door</button><output>{activeDestination}</output></>}))
vi.mock('../components/Notices',()=>({Notices:()=>null}))
vi.mock('../components/ImportOffer',()=>({ImportOffer:()=>null}))
vi.mock('../design',()=>({Toaster:()=>null}))
vi.mock('../state/theme',()=>({useTheme:()=> 'light'}))
vi.mock('../components/TeamsWindow',()=>({TeamsWindow:({onClose}:{onClose:()=>void})=><button data-teams onClick={onClose}>Back to app</button>}))
vi.mock('../components/AgentsWindow',()=>({AgentsWindow:()=> <div data-agents/>}))
import { App } from './App'
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
it('opens Teams from the left menu, closes with Back, and replaces it when Agents opens',async()=>{
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container)
 const snapshot=emptySnapshot()
 const store={subscribe:()=>()=>{},getSnapshot:()=>snapshot,refreshCatalogIfStale:vi.fn(async()=>{})} as unknown as AppStore
 const click=async(label:string)=>act(async()=>[...container.querySelectorAll<HTMLButtonElement>('button')].find(one=>one.textContent===label)!.click())
 try {
  await act(async()=>root.render(<StoreProvider store={store}><App/></StoreProvider>))
  await click('Teams door');expect(container.querySelector('[data-teams]')).not.toBeNull()
  expect(container.querySelector('output')?.textContent).toBe('teams')
  await click('Back to app');expect(container.querySelector('[data-teams]')).toBeNull()
  await click('Teams door');await click('Agents door')
  expect(container.querySelector('[data-teams]')).toBeNull();expect(container.querySelector('[data-agents]')).not.toBeNull()
 }finally{await act(async()=>root.unmount());container.remove()}
})
