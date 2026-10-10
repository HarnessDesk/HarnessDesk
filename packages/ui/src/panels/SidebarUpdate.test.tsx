import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import type { AppUpdateFact, DesktopBridge } from '../lib/desktop'
import { Sidebar } from '../components/Sidebar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
const original = window.harnessdesk
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); window.harnessdesk = original; vi.restoreAllMocks() })
const mount = (strict = false) => {
  const store = previewStore()
  act(() => root.render(<StoreProvider store={store}>{strict ? <StrictMode><Sidebar onOpenSettings={() => {}} onOpenPlugins={() => {}} onOpenAgents={() => {}} onOpenTeams={() => {}} onOpenUsage={() => {}} onBrowseFolders={() => {}} onSignIn={() => {}} onSearch={() => {}} /></StrictMode> : <Sidebar onOpenSettings={() => {}} onOpenPlugins={() => {}} onOpenAgents={() => {}} onOpenTeams={() => {}} onOpenUsage={() => {}} onBrowseFolders={() => {}} onSignIn={() => {}} onSearch={() => {}} />}</StoreProvider>))
  return store
}
const label = (name: string) => [...host.querySelectorAll('button')].find(one => one.textContent === name)
const bridge = () => {
  const listeners = new Set<(fact: AppUpdateFact | null) => void>()
  const reads: ((fact: AppUpdateFact | null) => void)[] = [], order: string[] = []
  const action = vi.fn()
  window.harnessdesk = { platform: 'fixture', openExternal: () => {}, setTitle: () => {}, onShortcut: () => () => {},
    readAppUpdate: () => { order.push('read'); return new Promise(resolve => reads.push(resolve)) },
    onAppUpdate: receive => { order.push('subscribe'); listeners.add(receive); return () => listeners.delete(receive) },
    appUpdateAction: action,
  } satisfies DesktopBridge
  return { listeners, reads, order, action, push: (fact: AppUpdateFact | null) => act(() => listeners.forEach(receive => receive(fact))) }
}
it('update row immediately above the seat subscribes before reading; pushed data including null wins a late initial read', async () => {
  const rig = bridge(); mount()
  expect(rig.order).toEqual(['subscribe', 'read'])
  rig.push({ label: 'Restart to Update (1.0.0)', enabled: true })
  expect(host.querySelector('[data-left-seat]')?.parentElement?.previousElementSibling?.textContent).toContain('Restart to Update (1.0.0)')
  await act(async () => rig.reads[0]!({ label: 'Check for Updates…', enabled: true }))
  expect(label('Check for Updates…')).toBeUndefined()
  act(() => label('Restart to Update (1.0.0)')!.click()); expect(rig.action).toHaveBeenCalledOnce()
  rig.push({ label: 'Downloading Update…', enabled: false })
  expect(label('Downloading Update…')?.disabled).toBe(true)
  rig.push(null); expect(label('Downloading Update…')).toBeUndefined()
})
it('a null push beats an initial fact and StrictMode leaves one live subscriber', async () => {
  const rig = bridge(); mount(true)
  expect(rig.listeners.size).toBe(1)
  rig.push(null)
  await act(async () => rig.reads.forEach(finish => finish({ label: 'Check for Updates…', enabled: true })))
  expect(label('Check for Updates…')).toBeUndefined()
  const queued = [...rig.listeners][0]!
  act(() => root.render(null)); expect(rig.listeners.size).toBe(0)
  await act(async () => queued({ label: 'Restart to Update (1.0.0)', enabled: true }))
  expect(host.textContent).toBe('')
})
it('omits native update facts when the bridge is absent', () => {
  window.harnessdesk = undefined; mount()
  expect(host.textContent).not.toContain('Update')
})

it('ignores both initial read and queued native callbacks after unmount', async () => {
  const rig = bridge(); mount()
  const queued = [...rig.listeners][0]!
  act(() => root.render(null))
  await act(async () => {
    rig.reads[0]!({ label: 'Check for Updates…', enabled: true })
    queued({ label: 'Restart to Update (1.0.0)', enabled: true })
  })
  expect(rig.listeners.size).toBe(0)
  expect(host.textContent).toBe('')
})
