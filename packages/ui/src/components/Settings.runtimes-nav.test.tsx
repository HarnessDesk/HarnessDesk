import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AccountStatus, RuntimeInfo } from '@harnessdesk/protocol'
import { NO_CAPABILITIES, runtimeId } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Settings } from './Settings'

/**
 * The Runtimes nav dot (#986, PR #1020 review round 2).
 *
 * `agentReadiness`'s fallback used to read `signin` the moment no sibling had
 * an account entry, whether or not any of them had actually said so, and the
 * nav lit while accounts were still loading (or forever, after a read that
 * failed silently). It reads `unknown` for that case now, and `isBlocking`
 * (`Settings.tsx:1818-1823`) keeps it quiet — while a confirmed sign-out
 * still lights it, which is the control.
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

const dotOf = (row: HTMLElement | undefined): Element | null => row?.querySelector('[data-slot="dot"]') ?? null

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
