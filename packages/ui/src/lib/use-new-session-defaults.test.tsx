import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId, type AccountStatus } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { useNewSessionDefaults } from './use-new-session-defaults'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const runtime = runtimeId('test-agent')
const refusal = 'Authentication required — No authentication method selected. Either call the `authenticate` method, or set `auth.type` in settings.json.'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const Probe = () => {
  const { error } = useNewSessionDefaults(runtime, true)
  return <p>{error ?? 'no warning'}</p>
}

const warningFor = async (account: AccountStatus | undefined, said: string): Promise<string> => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { accountsByRuntime: account ? { [runtime]: account } : {} })
  vi.spyOn(store, 'newSessionDefaultsFor').mockRejectedValue(new Error(said))
  vi.spyOn(store, 'newSessionDefaultChoicesFor').mockResolvedValue([])
  await act(async () => root.render(<StoreProvider store={store}><Probe /></StoreProvider>))
  return container.textContent ?? ''
}

/* The page's new-conversation section drew the same refusal as a warning,
   beside the banner that already says the agent is not signed in (#1775). */
it.each([
  ['signed out', { accounts: [], signInMethods: [] }],
  ['not heard from yet', undefined],
  ['not checked yet', { accounts: [], signInMethods: [], unchecked: true }],
] as const)('draws no warning for a sign-in refusal while the agent is %s', async (_, account) => {
  expect(await warningFor(account, refusal)).toBe('no warning')
})

it('still warns about a sign-in refusal from an agent the desk shows signed in', async () => {
  expect(await warningFor({ accounts: [{ kind: 'oauth', label: 'dev@example.com' }], signInMethods: [] }, refusal)).toBe(refusal)
})

it('still warns about any other failure from a signed-out agent', async () => {
  expect(await warningFor({ accounts: [], signInMethods: [] }, 'The agent could not read its settings.')).toBe('The agent could not read its settings.')
})

it('drops the warning once the agent turns signed out after its refusal', async () => {
  const store = new AppStore('ws://localhost:0/')
  // The adapter records the refusal and reports the account only afterwards,
  // so the warning arrives while the desk still shows the agent signed in.
  let snapshot = { ...store.getSnapshot(), accountsByRuntime: { [runtime]: { accounts: [{ kind: 'oauth' as const, label: 'dev@example.com' }], signInMethods: [] } } }
  const listeners = new Set<() => void>()
  Object.assign(store, {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  })
  vi.spyOn(store, 'newSessionDefaultsFor').mockRejectedValue(new Error(refusal))
  vi.spyOn(store, 'newSessionDefaultChoicesFor').mockResolvedValue([])
  await act(async () => root.render(<StoreProvider store={store}><Probe /></StoreProvider>))
  expect(container.textContent).toBe(refusal)

  snapshot = { ...snapshot, accountsByRuntime: { [runtime]: { accounts: [], signInMethods: [] } } }
  await act(async () => { for (const listener of listeners) listener() })
  expect(container.textContent).toBe('no warning')
})
