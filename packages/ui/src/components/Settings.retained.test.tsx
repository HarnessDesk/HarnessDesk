import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { runtimeId, type PlanRead } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { DestinationPageScope } from '../panels/destination-page'
import { PlanSection } from './SettingsAgents'
import { ProjectTriggers } from './ProjectTriggers'
import { triggerProjectView } from '../preview/intake-fixture'
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes});return {promise,resolve}}
it('activation invalidates old plan and trigger reads across hide and return',async()=>{
  const box=document.createElement('div');document.body.append(box);const root=createRoot(box),snapshot=emptySnapshot()
  const oldPlan=deferred<PlanRead>(),oldTriggers=deferred<ReturnType<typeof triggerProjectView>>()
  const readPlan=vi.fn().mockReturnValueOnce(oldPlan.promise).mockResolvedValue({entry:null,suggestion:null,refusal:'Current plan reading'})
  const projectTriggers=vi.fn().mockReturnValueOnce(oldTriggers.promise).mockResolvedValue(triggerProjectView({exists:false,triggers:[]}))
  const store={getSnapshot:()=>snapshot,subscribe:()=>()=>{},readPlan,projectTriggers} as unknown as AppStore
  const render=(active:boolean)=>act(async()=>root.render(<StoreProvider store={store}><DestinationPageScope owner="destination:settings" active={active}><PlanSection runtime={runtimeId('alpha')} account="synthetic" report={undefined} isKey={false}/><ProjectTriggers root="/synthetic/project"/></DestinationPageScope></StoreProvider>))
  try{await render(true);await render(false);expect(readPlan).toHaveBeenCalledTimes(1);expect(projectTriggers).toHaveBeenCalledTimes(1);await render(true)
    await act(async()=>{oldPlan.resolve({entry:null,suggestion:null,refusal:'Stale plan reading'});oldTriggers.resolve(triggerProjectView())})
    expect(box.textContent).toContain('Current plan reading');expect(box.textContent).not.toContain('Stale plan reading');expect(box.textContent).toContain('No triggers')
    expect(readPlan).toHaveBeenCalledTimes(2);expect(projectTriggers).toHaveBeenCalledTimes(2)
  }finally{act(()=>root.unmount());box.remove()}
})
it('an approved plan write after unmount does not start another read',async()=>{
  const box=document.createElement('div');document.body.append(box);const root=createRoot(box),snapshot=emptySnapshot(),pending=deferred<unknown>()
  const store={getSnapshot:()=>snapshot,subscribe:()=>()=>{},readPlan:vi.fn(async()=>({entry:{fee:{amount:20,currency:'USD',period:'month',source:'user',setAt:1}},suggestion:null,refusal:null})),setPlan:vi.fn(()=>pending.promise)} as unknown as AppStore
  try{await act(async()=>root.render(<StoreProvider store={store}><DestinationPageScope owner="destination:settings" active><PlanSection runtime={runtimeId('alpha')} account="synthetic" report={undefined} isKey={false}/></DestinationPageScope></StoreProvider>))
    act(()=>[...box.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent==='Clear')!.click())
    act(()=>root.render(<div>Work</div>));await act(async()=>pending.resolve(null));expect(store.setPlan).toHaveBeenCalledTimes(1);expect(store.readPlan).toHaveBeenCalledTimes(1)
  }finally{act(()=>root.unmount());box.remove()}
})
