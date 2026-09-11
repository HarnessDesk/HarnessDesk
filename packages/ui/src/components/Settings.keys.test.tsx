import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { RuntimeInfo } from '@harnessdesk/protocol'
import { NO_CAPABILITIES } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import {
  emptySnapshot,
  type AppSnapshot,
  type AppStore,
  type RouteInfo,
  type StoredCredential,
} from '../state/store'
import { Settings } from './Settings'

/**
 * The keys behind the custom endpoints, and a way to forget one.
 *
 * A secret was stored by one flow and released by another, and the two could
 * come apart: `routes/delete` drops the credential its route was the last
 * owner of, so a save that failed *after* the key went into the keychain, or
 * an endpoint removed while a second one still named the same key, left a
 * secret on the machine that nothing on screen mentioned and nothing could
 * remove. `credentials/delete` was on the wire the whole time, answered by the
 * host, covered by a server test, and called by nobody.
 *
 * The section only exists when there is something in it: an empty "Stored
 * keys" heading under an empty endpoint list is a permanent reminder of a
 * state that is fine.
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

const runtime = {
  id: 'codex',
  name: 'OpenAI Codex',
  capabilities: { ...NO_CAPABILITIES },
  presentation: { name: 'OpenAI Codex' },
} as unknown as RuntimeInfo

const KEY: StoredCredential = {
  ref: 'cred_a',
  name: 'Proxy key',
  createdAt: Date.UTC(2026, 0, 9),
  owner: { kind: 'endpoint' },
}
const ORPHAN: StoredCredential = {
  ref: 'cred_b',
  name: 'Old gateway key',
  createdAt: Date.UTC(2025, 10, 2),
  owner: { kind: 'endpoint' },
}
/* Two keys with owners of their own. Same store, same list, different verbs:
   an agent's is cleared from its sign-in page and a gateway account's goes
   with the account. The host names the owner; this does not guess. */
const AGENT_KEY: StoredCredential = {
  ref: 'cred_c',
  name: 'agent:codex:OPENAI_API_KEY',
  createdAt: Date.UTC(2026, 0, 9),
  owner: { kind: 'agent', of: 'codex' },
}

const route: RouteInfo = {
  id: 'route_1',
  name: 'Acme proxy',
  endpoint: 'https://proxy.acme.dev/v1',
  wireProtocol: 'responses',
  credentialRef: 'cred_a',
}

const mount = (keys: readonly StoredCredential[], routes: readonly RouteInfo[] = [route]) => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    runtimes: [runtime],
    routes: [...routes],
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request: vi.fn(async () => null) },
    listCredentials: vi.fn(async () => keys),
    deleteCredential: vi.fn(async () => true),
    loadAccounts: vi.fn(async () => {}),
    agentCatalog: vi.fn(async () => []),
    acpRegistry: vi.fn(async () => ({ agents: [], fetchedAt: 1 })),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Settings section="models" onSection={() => {}} onClose={() => {}} onSignIn={() => {}} />
      </StoreProvider>,
    )
  })
  return store
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)

/**
 * The Remove on *this* row.
 *
 * The endpoint above has one too, and it is first in the document — so a
 * lookup by label alone opened the endpoint's dialog and the assertion about
 * the key's could not pass. Found by the row whose title is the key's name.
 */
const removeOn = (name: string): HTMLButtonElement | undefined => {
  const row = [...container.querySelectorAll<HTMLElement>('div[class*="_row_"]')].find((one) =>
    one.querySelector('[class*="_rowTitle_"]')?.textContent?.includes(name),
  )
  expect(row, `a row for ${name}`).toBeTruthy()
  return [...(row?.querySelectorAll('button') ?? [])].find(
    (one) => one.textContent?.trim() === 'Remove…',
  )
}

it('names each key by the endpoint that uses it, and the one nothing uses', async () => {
  mount([KEY, ORPHAN])
  await act(async () => {})

  expect(container.textContent).toContain('Stored keys · 2')
  expect(container.textContent).toContain('Used by Acme proxy')
  /* The leak, said out loud. This is the row that could not be reached at
     all: a key with no owner, and until now no way to remove it. */
  expect(container.textContent).toContain('No endpoint uses it')
})

it('there is no section at all when no key is stored', async () => {
  mount([])
  await act(async () => {})
  // The control for the assertion above: the heading is absent, not empty.
  expect(container.textContent).not.toContain('Stored keys')
  // And the endpoints above it are still drawn, so this is the keys section
  // being withheld rather than the page failing to render.
  expect(container.textContent).toContain('Custom endpoints')
})

it('forgetting a key confirms first, says what breaks, and drops the row', async () => {
  const store = mount([KEY])
  await act(async () => {})

  act(() => removeOn('Proxy key')?.click())
  /* The consequence differs by whether anything still names it, and this key
     is named: an endpoint is about to stop working. */
  expect(document.body.textContent).toContain('Acme proxy will stop working')

  act(() => button('Forget key')?.click())
  await act(async () => {})

  expect(store.deleteCredential).toHaveBeenCalledWith('cred_a')
  expect(container.textContent).not.toContain('Proxy key')
})

it('a key nothing names is housekeeping, and says so instead', async () => {
  mount([ORPHAN], [])
  await act(async () => {})

  act(() => removeOn('Old gateway key')?.click())
  expect(document.body.textContent).toContain('cannot be recovered')
  expect(document.body.textContent).not.toContain('will stop working')
})

it('a refused delete leaves the row where it is', async () => {
  /* The secret is still on the machine, so the list must still say so — the
     row going away on a failed request is the one outcome that lies. */
  const store = mount([KEY])
  await act(async () => {})
  ;(store.deleteCredential as unknown as { mockResolvedValue: (v: boolean) => void }).mockResolvedValue(
    false,
  )

  act(() => removeOn('Proxy key')?.click())
  act(() => button('Forget key')?.click())
  await act(async () => {})

  expect(container.textContent).toContain('Proxy key')
})

const GATEWAY_KEY: StoredCredential = {
  ref: 'cred_d',
  name: 'Acme gateway key',
  createdAt: Date.UTC(2026, 0, 9),
  owner: { kind: 'gateway', of: 'Acme gateway' },
}

it('a key with an owner is not one of these, and is not offered for deletion', async () => {
  /* Found in review and reproduced on the real app: `credentials/list`
     returns every secret the broker holds, so `agent:codex:OPENAI_API_KEY`
     drew here reading "No endpoint uses it" — because no endpoint ever does —
     with a Remove beside it. And `credentials/delete` is the wrong verb for
     one: `runtime/apiKey/clear` also reloads the runtime's secrets, so a
     plain delete takes the key away and leaves the agent running as though it
     still had it. */
  mount([KEY, AGENT_KEY, GATEWAY_KEY])
  await act(async () => {})

  expect(container.textContent).not.toContain('OPENAI_API_KEY')
  /* The second owner class, found a round after the first: a gateway account's
     key is named by nothing in `routes`, so "is it an agent's" read it as an
     orphan. Its name gives nothing away either — it is `<name> key`, exactly
     like a route's. */
  expect(container.textContent).not.toContain('Acme gateway key')
  // The control: the route's key beside it is still listed, and the count is
  // of what is drawn rather than of what came back.
  expect(container.textContent).toContain('Proxy key')
  expect(container.textContent).toContain('Stored keys · 1')
})

it('a list of nothing but owned keys draws no section at all', async () => {
  mount([AGENT_KEY, GATEWAY_KEY])
  await act(async () => {})
  expect(container.textContent).not.toContain('Stored keys')
  expect(container.textContent).toContain('Custom endpoints')
})

it('a key nothing here can name is listed nowhere, rather than offered for deletion', async () => {
  /* The third writer, before it exists: a kind of key this build has never
     heard of, as a newer host would store it. This section used to list
     whatever nobody claimed, which is how two live keys came to be offered
     for deletion; it lists what the endpoint dialog stored. */
  mount([KEY, { ...ORPHAN, ref: 'cred_e', name: 'Plugin key', owner: null }])
  await act(async () => {})

  // The control: the section is drawn, with the endpoint's key in it.
  expect(container.textContent).toContain('Proxy key')
  expect(container.textContent).not.toContain('Plugin key')
})
