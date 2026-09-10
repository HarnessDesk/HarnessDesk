import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { runtimeId, sessionId, sessionKey, type RuntimeInfo } from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider, useRuntimeAccount, useRuntimeHealth } from './context'
import { emptySnapshot, type AppSnapshot, type AppStore } from './store'

/**
 * A pane speaks for its own agent.
 *
 * `snapshot.health` and `snapshot.account` are the default agent's alone.
 * Once the default can differ from the agent of the conversation on screen —
 * which a switch no longer prevents — a pane that read the singular slots
 * drew the default's state under its own agent's name. These hooks read the
 * per-runtime maps for the pane's runtime, and use the singular slots only
 * for the default, which is the one runtime they are about.
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
const GEMINI = runtimeId('gemini')

const runtime = (id: string, name: string): RuntimeInfo =>
  ({ id, name, capabilities: { account: true }, presentation: { name } }) as unknown as RuntimeInfo

const Probe = () => {
  const health = useRuntimeHealth()
  const account = useRuntimeAccount()
  return (
    <span data-health={health?.state ?? 'none'} data-accounts={account ? String(account.accounts.length) : 'none'} />
  )
}

const mount = (paneRuntime: string | null, overrides: Partial<AppSnapshot> = {}) => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [runtime(CODEX, 'Codex'), runtime(GEMINI, 'Gemini CLI')],
    // Gemini is the default and has exited; Codex is healthy and signed in.
    activeRuntime: GEMINI,
    health: { state: 'unavailable', reason: 'exited', message: 'Gemini CLI exited.' },
    account: { accounts: [], signInMethods: [] },
    healthByRuntime: { [CODEX]: { state: 'ready' } },
    accountsByRuntime: { [CODEX]: { accounts: [{ kind: 'chatgpt', label: 'dev@example.com' }], signInMethods: [] } },
    ...overrides,
  } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  const probe = <Probe />
  act(() => {
    root.render(
      <StoreProvider store={store}>
        {paneRuntime ? (
          <PaneProvider scope={{ paneId: 'p1' as never, view: { kind: 'conversation', session: sessionKey(paneRuntime as never, sessionId('s-1')) } as never, sessionKey: sessionKey(paneRuntime as never, sessionId('s-1')) }}>
            {probe}
          </PaneProvider>
        ) : (
          probe
        )}
      </StoreProvider>,
    )
  })
  const span = container.querySelector('span')
  return { health: span?.getAttribute('data-health'), accounts: span?.getAttribute('data-accounts') }
}

it('a pane on another agent reads that agent’s health and account, not the default’s', () => {
  expect(mount(CODEX)).toEqual({ health: 'ready', accounts: '1' })
})

it('outside a pane, or in a pane on the default, the singular slots still answer', () => {
  expect(mount(null)).toEqual({ health: 'unavailable', accounts: '0' })
  expect(mount(GEMINI)).toEqual({ health: 'unavailable', accounts: '0' })
})

it('a pane on an agent nothing is known about says nothing, rather than the default’s state', () => {
  expect(mount(CODEX, { healthByRuntime: {}, accountsByRuntime: {} })).toEqual({ health: 'none', accounts: 'none' })
})
