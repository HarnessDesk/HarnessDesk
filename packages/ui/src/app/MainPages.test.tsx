import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import { useDestinationActive } from '../panels/destination-page'
import { MAIN_PAGE_ENTRIES } from './main-page-entries'
import { MainPages, MIGRATED_PAGE_KINDS } from './MainPages'
import type { MainPageInput } from './main-page-entries'
vi.mock('../components/Settings',()=>({Settings:()=>null}))
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const original={...MAIN_PAGE_ENTRIES}
afterEach(()=>{for(const key of Object.keys(MAIN_PAGE_ENTRIES))delete MAIN_PAGE_ENTRIES[key as keyof typeof MAIN_PAGE_ENTRIES];Object.assign(MAIN_PAGE_ENTRIES,original)})
it('the production registry assembles every phase E page',()=>expect([...MIGRATED_PAGE_KINDS].sort()).toEqual(['agents','changes-review','dashboard','flows','lead','library','plugins','settings','teams']))
it('retains one keyed body per kind, deactivates its callbacks and resets on project ownership change',async()=>{
  const box=document.createElement('div');document.body.append(box);const root=createRoot(box),store=new AppStore('ws://localhost:0/')
  const Body=({visit}:{visit:()=>void})=>{const active=useDestinationActive(),[draft,setDraft]=useState('remembered');return <div><input value={draft} onChange={event=>setDraft(event.target.value)}/><output>{String(active)}</output><button onClick={visit}>Visit</button></div>}
  MAIN_PAGE_ENTRIES.settings=({visit})=><Body visit={()=>visit({kind:'dashboard',view:'overview',scope:null})}/>
  MAIN_PAGE_ENTRIES.dashboard=()=><span>Dashboard body</span>
  const render=(key='project-a',suspended=false)=>act(async()=>root.render(<StoreProvider store={store}><MainPages key={key} suspended={suspended} onSignIn={()=>{}} onNewTeam={()=>{}} libraryImportIntent={0}/></StoreProvider>))
  try{
    store.openDestination({kind:'settings',route:{kind:'section',section:'general',focus:null}});await render()
    const input=box.querySelector('input')!;input.focus()
    await act(async()=>{store.openDestination({kind:'dashboard',view:'overview',scope:null});await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))})
    const held=box.querySelector('[data-page-destination="settings"]')!
    expect(held.hasAttribute('hidden')).toBe(true);expect(held.hasAttribute('inert')).toBe(true)
    expect(held.querySelector('output')?.textContent).toBe('false')
    act(()=>held.querySelector('button')!.click());expect(store.getSnapshot().workbench.navigation.current.kind).toBe('dashboard')
    await act(async()=>{await store.navigateBack();await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))});expect(box.querySelector('input')).toBe(input)
    await render('project-a',true);expect(box.querySelector('output')?.textContent).toBe('false')
    await render('project-a',false);expect(box.querySelector('input')).toBe(input)
    await render('project-b');expect(box.querySelector('input')).not.toBe(input)
    expect(box.querySelectorAll('[data-page-destination="settings"]')).toHaveLength(1)
  }finally{act(()=>root.unmount());box.remove()}
})

it('rejects captured visit and replace after leaving, returning, suspending or unmounting its owner',async()=>{
  const box=document.createElement('div');document.body.append(box);const root=createRoot(box),store=new AppStore('ws://localhost:0/')
  let captured!:MainPageInput
  MAIN_PAGE_ENTRIES.settings=input=>{captured=input;return <span>Settings</span>}
  const page={kind:'settings',route:{kind:'section',section:'general',focus:null}} as const
  const target={kind:'settings',route:{kind:'section',section:'appearance',focus:null}} as const
  const render=(suspended=false,key='project-a')=>act(async()=>root.render(<StoreProvider store={store}><MainPages key={key} suspended={suspended} onSignIn={()=>{}} onNewTeam={()=>{}} libraryImportIntent={0}/></StoreProvider>))
  try{
    store.openDestination(page);await render();const departed=captured
    await act(async()=>{store.returnToWork();await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))})
    departed.visit(target);departed.replace(target);expect(store.getSnapshot().workbench.navigation.current.kind).toBe('work')
    await act(async()=>{await store.navigateBack();await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))})
    departed.visit(target);departed.replace(target);expect(store.getSnapshot().workbench.navigation.current).toEqual(page)
    const suspended=captured;await render(true);suspended.visit(target);suspended.replace(target);expect(store.getSnapshot().workbench.navigation.current).toEqual(page)
    await render(false);const oldProject=captured;await render(false,'project-b');oldProject.visit(target);expect(store.getSnapshot().workbench.navigation.current).toEqual(page)
    const mounted=captured;act(()=>root.unmount());mounted.replace(target);expect(store.getSnapshot().workbench.navigation.current).toEqual(page)
  }finally{if(box.childNodes.length)act(()=>root.unmount());box.remove()}
})
