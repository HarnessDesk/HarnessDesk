import { useOptionConfirm } from './OptionConfirm'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { runtimeId, type RuntimeId } from '@harnessdesk/protocol'
import { MainPages } from '../app/MainPages'
import { frameDestinationStore } from '../preview/frame-destination-store'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'
import { DestinationPageScope } from '../panels/destination-page'
import { Settings } from './Settings'
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
it('dismisses endpoint authoring on hide and does not restore a portal on return', async () => {
  const box=document.createElement('div');document.body.append(box);const root=createRoot(box),store=previewStore()
  const render=async(active:boolean)=>act(async()=>root.render(<StoreProvider store={store}><TopBarProvider>
    <DestinationPageScope owner="destination:settings" active={active}><Settings route={{kind:'section',section:'models',focus:null}} onRoute={()=>{}} onSignIn={()=>{}}/></DestinationPageScope>
    <TopBarOutlet owner="destination:settings" fallback={{place:'Work',more:()=>null}}/>
  </TopBarProvider></StoreProvider>))
  try {
    await render(true)
    await act(async()=>[...box.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent==='Add endpoint')!.click())
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    await render(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await render(true)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  } finally {act(()=>root.unmount());box.remove()}
})

it('dismisses an option confirmation on hide and never reopens it on reactivation', async()=>{
  const box=document.createElement('div');document.body.append(box);const root=createRoot(box),store=previewStore()
  const Owner=()=>{const {ask,dialog}=useOptionConfirm();return <><button onClick={()=>ask({id:'bounded',type:'boolean',label:'Bounded',currentValue:false,confirm:{title:'Enable bounded work?',body:'This changes its work.',action:'Enable'}},true,()=>{})}>Change</button>{dialog}</>}
  const render=(active:boolean)=>act(async()=>root.render(<StoreProvider store={store}><DestinationPageScope owner="destination:settings" active={active}><Owner/></DestinationPageScope></StoreProvider>))
  try{await render(true);await act(async()=>box.querySelector('button')!.click());expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();await render(false);expect(document.querySelector('[role="alertdialog"]')).toBeNull();await render(true);expect(document.querySelector('[role="alertdialog"]')).toBeNull()}finally{act(()=>root.unmount());box.remove()}
})

it('a real Settings custom add cannot reopen its destination after Work is selected',async()=>{
  const box=document.createElement('div');document.body.append(box);const root=createRoot(box),store=frameDestinationStore(previewStore())
  let resolve!:(value:RuntimeId|null)=>void
  const add=vi.spyOn(store,'addAgent').mockImplementation(()=>new Promise(yes=>{resolve=yes}))
  store.openDestination({kind:'settings',route:{kind:'add-runtime'}})
  try{
    await act(async()=>root.render(<StoreProvider store={store}><TopBarProvider><MainPages onNewTeam={()=>{}} libraryImportIntent={0} onSignIn={()=>{}}/></TopBarProvider></StoreProvider>))
    act(()=>[...box.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent==='Set up…')!.click())
    for(const [label,value] of [['Name','Synthetic Agent'],['Command','synthetic-agent']])act(()=>{
      const field=document.querySelector<HTMLInputElement>(`[id="${[...document.querySelectorAll('label')].find(node=>node.textContent?.trim()===label)!.htmlFor}"]`)!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}))
    })
    act(()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent==='Add runtime')!.click())
    await act(async()=>{store.returnToWork();await new Promise<void>(yes=>requestAnimationFrame(()=>yes()))})
    await act(async()=>resolve(runtimeId('synthetic-added')))
    expect(add).toHaveBeenCalledTimes(1);expect(store.getSnapshot().workbench.navigation.current.kind).toBe('work');expect(document.querySelector('[role="dialog"]')).toBeNull()
  }finally{act(()=>root.unmount());box.remove()}
})

it('a custom add after visiting Add a runtime closes its dialog and returns to the current runtime list', async () => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box), store = frameDestinationStore(previewStore())
  const add = vi.spyOn(store, 'addAgent').mockResolvedValue(runtimeId('synthetic-added'))
  store.openDestination({ kind: 'settings', route: { kind: 'section', section: 'runtimes', focus: null } })
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)!
  try {
    await act(async () => root.render(<StoreProvider store={store}><TopBarProvider><MainPages onNewTeam={() => {}} libraryImportIntent={0} onSignIn={() => {}} /></TopBarProvider></StoreProvider>))
    await act(async () => { button('Add a runtime').click(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
    await act(async () => button('Set up…').click())
    for (const [label, value] of [['Name', 'Synthetic Agent'], ['Command', 'synthetic-agent']]) act(() => {
      const id = [...document.querySelectorAll('label')].find(node => node.textContent?.trim() === label)!.htmlFor
      const field = document.getElementById(id) as HTMLInputElement
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { button('Add runtime').click(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
    expect(add).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().workbench.navigation.current).toEqual({ kind: 'settings', route: { kind: 'section', section: 'runtimes', focus: null } })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  } finally { act(() => root.unmount()); box.remove() }
})

it('ignores an old browser discovery after hide and reactivation',async()=>{
  const box=document.createElement('div');document.body.append(box);const root=createRoot(box),store=previewStore()
  let resolve!:(value:readonly {name:string;path:string}[])=>void
  Object.assign(store.getSnapshot(),{browserPrefs:{...store.getSnapshot().browserPrefs,placement:'window'}})
  const read=vi.spyOn(store,'listBrowsers').mockReturnValueOnce(new Promise(yes=>{resolve=yes})).mockResolvedValue([{name:'Current Browser',path:'/synthetic/current'}])
  const render=(active:boolean)=>act(async()=>root.render(<StoreProvider store={store}><TopBarProvider><DestinationPageScope owner="destination:settings" active={active}><Settings route={{kind:'section',section:'browser',focus:null}} onRoute={()=>{}} onSignIn={()=>{}}/></DestinationPageScope></TopBarProvider></StoreProvider>))
  try{await render(true);await render(false);await render(true);await act(async()=>resolve([{name:'Stale Browser',path:'/synthetic/stale'}]));expect(read).toHaveBeenCalledTimes(2);expect(box.textContent).toContain('Current Browser');expect(box.textContent).not.toContain('Stale Browser')}
  finally{act(()=>root.unmount());box.remove()}
})

it.each(['permissions','skills'] as const)('ignores obsolete %s readings across hide and reactivation',async(section)=>{
  const box=document.createElement('div');document.body.append(box);const root=createRoot(box),store=previewStore()
  const snapshot=store.getSnapshot()
  Object.assign(snapshot,{runtimes:snapshot.runtimes.map(info=>({...info,capabilities:{...info.capabilities,hooks:true}}))})
  let resolve!:(value:never)=>void
  const pending=new Promise<never>(yes=>{resolve=yes})
  const current=section==='permissions'?[{id:'current',name:'Current rule',action:'approve' as const,match:{}}]:[{id:'current',event:'Current hook',source:'synthetic',trust:'trusted',enabled:true,managed:false}]
  const stale=section==='permissions'?[{id:'stale',name:'Stale rule',action:'deny' as const,match:{}}]:[{id:'stale',event:'Stale hook',source:'synthetic',trust:'trusted',enabled:true,managed:false}]
  const read=section==='permissions'?vi.spyOn(store,'loadPolicyRules'):vi.spyOn(store,'loadHooks')
  read.mockReturnValueOnce(pending).mockResolvedValue(current as never)
  const render=(active:boolean)=>act(async()=>root.render(<StoreProvider store={store}><TopBarProvider><DestinationPageScope owner="destination:settings" active={active}><Settings route={{kind:'section',section,focus:null}} onRoute={()=>{}} onSignIn={()=>{}}/></DestinationPageScope></TopBarProvider></StoreProvider>))
  try{await render(true);await render(false);await render(true);await act(async()=>resolve(stale as never));expect(read).toHaveBeenCalledTimes(2);expect(box.textContent).toContain(section==='permissions'?'Current rule':'Current hook');expect(box.textContent).not.toContain(section==='permissions'?'Stale rule':'Stale hook')}
  finally{act(()=>root.unmount());box.remove()}
})
