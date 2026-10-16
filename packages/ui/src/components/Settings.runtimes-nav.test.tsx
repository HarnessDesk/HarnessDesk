import { SettingsTestPage as Settings } from '../test-support/settings-page'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AccountStatus, RuntimeInfo } from '@harnessdesk/protocol'
import { NO_CAPABILITIES, runtimeId } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const CODEX = runtimeId('codex')

const codex: RuntimeInfo = {
  id: CODEX,
  name: 'OpenAI Codex',
  capabilities: { ...NO_CAPABILITIES, account: true },
  presentation: { name: 'OpenAI Codex' },
} as unknown as RuntimeInfo

const signedOut: AccountStatus = {
  accounts: [],
  signInMethods: [{ id: 'browser', label: 'Sign in', flow: 'browser' }],
} as unknown as AccountStatus

const mount = (accountsByRuntime: AppSnapshot['accountsByRuntime']): void => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    section: 'appearance',
    activeRuntime: CODEX,
    runtimes: [codex],
    healthByRuntime: { [CODEX]: { state: 'ready' } },
    accountsByRuntime,
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request: vi.fn(async () => null) },
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Settings section="appearance" onSection={() => {}} onClose={() => {}} onSignIn={() => {}} />
      </StoreProvider>,
    )
  })
}

/** The nav rail's own Runtimes row. */
const runtimesRow = (): HTMLElement | undefined =>
  [...container.querySelectorAll('button')].find((node) => node.textContent?.trim().startsWith('Runtimes'))

const dotOf = (row: HTMLElement | undefined): Element | null =>
  row?.closest('[data-left-row]')?.querySelector('[data-slot="dot"]') ?? null

it('does not light for an agent that has not answered yet', () => {
  // Absent from accountsByRuntime altogether: still loading, or a read that
  // failed silently — not a fact worth pulling the eye for.
  mount({})
  expect(dotOf(runtimesRow())).toBeNull()
})

it('lights for an agent that answered and confirmed nobody is signed in', () => {
  mount({ [CODEX]: signedOut })
  const dot = dotOf(runtimesRow())
  expect(dot).not.toBeNull()
  expect(dot?.getAttribute('data-state')).toBe('signin')
})


it('uses the left-column anatomy for the existing Settings pages and groups', () => {
  mount({})
  const nav = container.querySelector('[aria-label="Settings navigation"]')!
  expect(nav.querySelectorAll('[data-left-group]')).toHaveLength(4)
  const row = runtimesRow()!
  expect(row.closest('[data-left-row]')).not.toBeNull()
  expect(row.closest('[data-left-row]')?.querySelectorAll('[data-left-trailing]')).toHaveLength(1)
  expect([...nav.querySelectorAll('[data-left-group-text]')].map(node => node.textContent))
    .toEqual(['Preferences', 'Conversations', 'Runtimes', 'Access'])
})
