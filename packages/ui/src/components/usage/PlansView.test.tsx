;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { NO_CAPABILITIES, runtimeId, type Account, type AccountStatus, type RuntimeInfo, type UsageReport } from '@harnessdesk/protocol'
import { emptySnapshot } from '../../state/store'
import { accountKey } from '../../lib/accounts'
import { PlansView } from './PlansView'

it('counts a signed-out runtime with ledger history once and keeps sign-in in its detail', () => {
 const info={id:runtimeId('alpha'),capabilities:NO_CAPABILITIES,presentation:{name:'Alpha'}} as RuntimeInfo
 const report:UsageReport={runtime:info.id,account:null,plan:null,lanes:[],credits:null,spend:null,reached:null,source:{kind:'ledger',label:'Recorded tokens'},fetchedAt:1,staleAfterMs:100,error:null}
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);const signIn=vi.fn()
 act(()=>root.render(<PlansView reports={[report]} byId={new Map([[info.id,info]])} snapshot={emptySnapshot()} now={1} summary={{} as never} scoped={null} silent={[{info,reason:'Sign in to read plan usage.'}]} untracked={[]} onSignIn={signIn} onRefreshAccount={()=>{}} onStopTracking={()=>{}} onTrack={()=>{}} onOpenPlanSettings={()=>{}} />))
 expect(container.textContent).toContain('All · 1')
 expect(container.textContent).toContain('Not reporting · 1')
 expect(container.textContent).not.toContain('has nothing to report')
 act(()=>container.querySelector<HTMLButtonElement>('button[aria-label="Details for Alpha"]')!.click())
 expect(container.querySelector('button[aria-label="Details for Alpha"]')?.getAttribute('aria-expanded')).toBe('true')
 act(()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='Sign in to Alpha')!.click())
 expect(signIn).toHaveBeenCalledWith(info.id)
 act(()=>root.unmount());container.remove()
})

it('falls back to All when a selected shape no longer has any accounts', () => {
 const info = { id: runtimeId('alpha'), capabilities: NO_CAPABILITIES, presentation: { name: 'Alpha' } } as RuntimeInfo
 const base: UsageReport = { runtime: info.id, account: null, plan: null, lanes: [], credits: null, spend: null, reached: null, source: { kind: 'ledger', label: 'Recorded tokens' }, fetchedAt: 1, staleAfterMs: 100, error: null }
 const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
 const draw = (reports: UsageReport[]) => act(() => root.render(<PlansView reports={reports} byId={new Map([[info.id, info]])} snapshot={emptySnapshot()} now={1} summary={{} as never} scoped={null} silent={[]} untracked={[]} onRefreshAccount={() => {}} onStopTracking={() => {}} onTrack={() => {}} onOpenPlanSettings={() => {}} />))
 try {
  draw([{ ...base, billing: { kinds: ['free'] } }])
  act(() => [...container.querySelectorAll('button')].find(button => button.textContent === 'Free · 1')!.click())
  draw([base])
  expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('All · 1')
  expect(container.textContent).not.toContain('No account matches this filter')
  draw([{ ...base, billing: { kinds: ['free'] } }, base])
  expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('All · 2')
 } finally { act(() => root.unmount()); container.remove() }
})

it('uses each report account’s own tint when one runtime has multiple accounts', () => {
 const info = { id: runtimeId('alpha'), capabilities: NO_CAPABILITIES, presentation: { name: 'Alpha' } } as RuntimeInfo
 const first: Account = { kind: 'oauth', label: 'first@example.com' }
 const second: Account = { kind: 'oauth', label: 'second@example.com' }
 const status = { accounts: [first, second], signInMethods: [] } as unknown as AccountStatus
 const snapshot = {
  ...emptySnapshot(),
  accountsByRuntime: { [info.id]: status },
  accountPrefs: {
   [accountKey(info.id, first)]: { tint: 'rose' as const },
   [accountKey(info.id, second)]: { tint: 'violet' as const },
  },
 }
 const base: UsageReport = { runtime: info.id, account: null, plan: null, lanes: [], credits: null, spend: null, reached: null, source: { kind: 'ledger', label: 'Recorded tokens' }, fetchedAt: 1, staleAfterMs: 100, error: null }
 const reports = [
  { ...base, account: first.label },
  { ...base, account: second.label },
 ]
 const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
 try {
  act(() => root.render(<PlansView reports={reports} byId={new Map([[info.id, info]])} snapshot={snapshot} now={1} summary={{} as never} scoped={null} silent={[]} untracked={[]} onRefreshAccount={() => {}} onStopTracking={() => {}} onTrack={() => {}} onOpenPlanSettings={() => {}} />))
  expect([...container.querySelectorAll('[data-tint]')].map(node => node.getAttribute('data-tint'))).toEqual(['rose', 'violet'])
 } finally { act(() => root.unmount()); container.remove() }
})
