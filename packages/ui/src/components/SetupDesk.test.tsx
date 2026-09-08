import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { RuntimeHealth, RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { SetupDesk } from './SetupDesk'

/**
 * The whole-desk survey. What it owes: a dead agent carries its real error
 * and remediation instead of sitting there looking normal, a signed-out one
 * gets its sign-in button, a healthy one is offered as the way to keep
 * working, and the add-agent door is always on the page.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const runtime = (id: string, name: string, account = true, brand = name): RuntimeInfo =>
  ({
    id,
    name,
    capabilities: { account },
    presentation: { name: brand, tagline: `${brand}'s tagline.` },
  }) as unknown as RuntimeInfo

const mount = async (
  runtimes: readonly RuntimeInfo[],
  healthByRuntime: Record<string, RuntimeHealth>,
  accounts: Record<string, { accounts: { kind: string; label: string }[]; signInMethods: [] }>,
  active: string | null = null,
) => {
  const onSignIn = vi.fn()
  const onOpenAgents = vi.fn()
  const selectRuntime = vi.fn(async () => {})
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [...runtimes],
    healthByRuntime,
    accountsByRuntime: accounts,
    activeRuntime: active,
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAccounts: vi.fn(async () => {}),
    selectRuntime,
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <SetupDesk onSignIn={onSignIn} onOpenAgents={onOpenAgents} />
      </StoreProvider>,
    )
  })
  return { onSignIn, onOpenAgents, selectRuntime }
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(label))

const signedIn = { accounts: [{ kind: 'chatgpt', label: 'user@example.com' }], signInMethods: [] as [] }
const signedOut = { accounts: [], signInMethods: [] as [] }

it('a dead agent carries its real error and the fix', async () => {
  await mount(
    [runtime('dead', 'Dead Agent')],
    {
      dead: {
        state: 'unavailable',
        reason: 'notInstalled',
        message: 'Dead Agent did not answer the ACP handshake: spawn ENOENT.',
        remediation: 'Install it with `npm i -g dead-agent`.',
      },
    },
    { dead: signedOut },
  )

  expect(container.textContent).toContain('spawn ENOENT')
  expect(container.textContent).toContain('npm i -g dead-agent')
  // A dead agent is not offered a sign-in: signing in would not revive it.
  expect(button('Sign in')).toBeUndefined()
})

it('a signed-out agent gets its sign-in, a healthy one the offer to work', async () => {
  const { onSignIn, selectRuntime } = await mount(
    [runtime('out', 'Signed Out'), runtime('fine', 'Healthy')],
    { out: { state: 'ready' }, fine: { state: 'ready' } },
    { out: signedOut, fine: signedIn },
    'out',
  )

  expect(container.textContent).toContain('Signed out — a session sent to it would not start.')
  button('Sign in')?.click()
  expect(onSignIn).toHaveBeenCalledWith('out')

  await act(async () => {
    button('Use this agent')?.click()
  })
  expect(selectRuntime).toHaveBeenCalledWith('fine')
})

it('the active agent is not offered to itself, and the add door is always there', async () => {
  const { onOpenAgents } = await mount(
    [runtime('fine', 'Healthy')],
    { fine: { state: 'ready' } },
    { fine: signedIn },
    'fine',
  )

  expect(button('Use this agent')).toBeUndefined()
  button('Add an agent…')?.click()
  expect(onOpenAgents).toHaveBeenCalled()
})

it('two entries sharing a brand remain distinguishable while account data loads', async () => {
  await mount(
    [runtime('codex', 'Codex'), runtime('codex-work', 'codex-work', true, 'Codex')],
    { codex: { state: 'ready' }, 'codex-work': { state: 'ready' } },
    { codex: signedIn, 'codex-work': signedIn },
    'codex',
  )

  expect(container.textContent).toContain('codex-work')
  expect(container.querySelectorAll('[class*="rowWhich"]').length).toBe(1)
})

it('a lone agent is not made to wear its registry name', async () => {
  await mount(
    [runtime('codex-work', 'codex-work', true, 'Codex')],
    { 'codex-work': { state: 'ready' } },
    { 'codex-work': signedIn },
    'codex-work',
  )

  expect(container.querySelectorAll('[class*="rowWhich"]').length).toBe(0)
  expect(container.textContent).not.toContain('codex-work')
})
