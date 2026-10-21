import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { frameDestinationStore } from '../preview/frame-destination-store'
import { SettingsTestScope } from '../test-support/settings-page'
import { accountKey } from '../lib/accounts'
import type { SettingsRoute } from '../state/destinations'
import { Settings } from './Settings'
import { RuntimesSection } from './SettingsAgents'
import { runtimeId } from '@harnessdesk/protocol'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let box: HTMLDivElement, root: Root
beforeEach(() => { box = document.createElement('div'); document.body.append(box); root = createRoot(box) })
afterEach(() => { act(() => root.unmount()); box.remove() })
const addButtons = () => [...box.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent?.trim() === 'Add a runtime')

it.each([false, true])('keeps one Add action beside the Runtimes h1 and opens the existing add route (empty=%s)', async empty => {
  const store = frameDestinationStore(previewStore(empty ? { runtimes: [] } : {})), onRoute = vi.fn()
  const route = { kind: 'section', section: 'runtimes', focus: null } as const
  store.openDestination({ kind: 'settings', route })
  await act(async () => root.render(<StoreProvider store={store}><SettingsTestScope>
    <Settings route={route} onRoute={onRoute} onSignIn={() => {}} />
  </SettingsTestScope></StoreProvider>))
  const head = box.querySelector('h1')?.closest('[data-page-head]')
  expect(head?.querySelector('button')?.textContent).toBe('Add a runtime')
  expect(addButtons()).toHaveLength(1)
  await act(async () => addButtons()[0]!.click())
  expect(onRoute).toHaveBeenCalledWith({ kind: 'add-runtime' })
})

it.each(['runtime', 'account', 'add-runtime'] as const)('keeps the parent header free of Add actions on a nested %s page', async kind => {
  const store = frameDestinationStore(previewStore()), snapshot = store.getSnapshot()
  const info = snapshot.runtimes[0]!, account = snapshot.accountsByRuntime[info.id]!.accounts[0]!
  const route: SettingsRoute = kind === 'add-runtime' ? { kind } : kind === 'runtime' ? { kind, runtime: info.id }
    : { kind, runtime: info.id, key: accountKey(info.id, account) }
  store.openDestination({ kind: 'settings', route })
  await act(async () => root.render(<StoreProvider store={store}><SettingsTestScope>
    <Settings route={route} onRoute={() => {}} onSignIn={() => {}} />
  </SettingsTestScope></StoreProvider>))
  expect(box.querySelector('h1')?.closest('[data-page-head]')?.querySelector('button')).toBeNull()
  expect(addButtons()).toHaveLength(0)
})

it('retains the Add action for a standalone runtime section', async () => {
  const store = frameDestinationStore(previewStore()), onView = vi.fn()
  await act(async () => root.render(<StoreProvider store={store}><SettingsTestScope>
    <RuntimesSection view={{ kind: 'list' }} onView={onView} onSignIn={() => {}} />
  </SettingsTestScope></StoreProvider>))
  expect(addButtons()).toHaveLength(1)
  await act(async () => addButtons()[0]!.click())
  expect(onView).toHaveBeenCalledWith({ kind: 'add' })
})

it.each(['runtime', 'account-runtime', 'account-key'] as const)('keeps the list Add action when a stale %s detail falls back to the list', async missing => {
  const store = frameDestinationStore(previewStore()), onRoute = vi.fn(), info = store.getSnapshot().runtimes[0]!
  const route: SettingsRoute = missing === 'runtime' ? { kind: 'runtime', runtime: runtimeId('removed-runtime') }
    : { kind: 'account', runtime: missing === 'account-runtime' ? runtimeId('removed-runtime') : info.id, key: 'removed-account' }
  store.openDestination({ kind: 'settings', route })
  await act(async () => root.render(<StoreProvider store={store}><SettingsTestScope>
    <Settings route={route} onRoute={onRoute} onSignIn={() => {}} />
  </SettingsTestScope></StoreProvider>))
  expect(box.querySelector('[data-slot="agent-row"]')).not.toBeNull()
  expect(addButtons()).toHaveLength(1)
  expect(box.querySelector('h1')?.closest('[data-page-head]')?.contains(addButtons()[0]!)).toBe(true)
  await act(async () => addButtons()[0]!.click())
  expect(onRoute).toHaveBeenCalledWith({ kind: 'add-runtime' })
})
