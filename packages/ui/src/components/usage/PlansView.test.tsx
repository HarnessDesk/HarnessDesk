;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { NO_CAPABILITIES, runtimeId, type RuntimeInfo, type UsageReport } from '@harnessdesk/protocol'
import { emptySnapshot } from '../../state/store'
import { PlansView } from './PlansView'

it('counts a signed-out runtime with ledger history once and keeps sign-in in its detail', () => {
 const info={id:runtimeId('alpha'),capabilities:NO_CAPABILITIES,presentation:{name:'Alpha'}} as RuntimeInfo
 const report:UsageReport={runtime:info.id,account:null,plan:null,lanes:[],credits:null,spend:null,reached:null,source:{kind:'ledger',label:'Recorded tokens'},fetchedAt:1,staleAfterMs:100,error:null}
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);const signIn=vi.fn()
 act(()=>root.render(<PlansView reports={[report]} byId={new Map([[info.id,info]])} snapshot={emptySnapshot()} now={1} summary={{} as never} scoped={null} silent={[{info,reason:'Sign in to read plan usage.'}]} untracked={[]} onSignIn={signIn} onRefreshAccount={()=>{}} onStopTracking={()=>{}} onTrack={()=>{}} onOpenPlanSettings={()=>{}} />))
 expect(container.textContent).toContain('All · 1')
 expect(container.textContent).toContain('Not reporting · 1')
 expect(container.textContent).not.toContain('has nothing to report')
 act(()=>container.querySelector<HTMLButtonElement>('button[aria-label="Show details for Alpha"]')!.click())
 act(()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='Sign in to Alpha')!.click())
 expect(signIn).toHaveBeenCalledWith(info.id)
 act(()=>root.unmount());container.remove()
})
