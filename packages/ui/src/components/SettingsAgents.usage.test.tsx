import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  runtimeId,
  NO_CAPABILITIES,
  type AccountStatus,
  type RuntimeInfo,
  type UsageLane,
  type UsageReport,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AgentsSection } from './SettingsAgents'

/**
 * What an account row in Settings says it has left, and whether it says the
 * account is out.
 *
 * Both answers used to come from the whole lane list: the chip from
 * `report.reached`, which names a model-scoped window as readily as an
 * account-wide one, and the figure from the tightest lane of any scope. With
 * Claude Code's Fable week spent that made the row read `0% left` beside a
 * limit dot, on an account with 37% of its weekly left and every other model
 * answering — and fixing only the chip would have left `0% left` beside a
 * *ready* dot, which is worse, because the two halves of one row would
 * disagree. Both now come from the account-wide binding lane.
 *
 * The other thing pinned here is which report a row reads at all. A row is one
 * account, and it finds its report by matching the account's own label, so the
 * order the host happens to deliver two accounts' readings in cannot decide
 * which one a row describes.
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

const CLAUDE = runtimeId('claude')

const info: RuntimeInfo = {
  id: CLAUDE,
  name: 'claude',
  presentation: { name: 'Claude Code' },
  capabilities: { ...NO_CAPABILITIES, account: true },
} as unknown as RuntimeInfo

const status: AccountStatus = {
  accounts: [
    { kind: 'oauth', label: 'olivia@acme.dev' },
    { kind: 'oauth', label: 'work@acme.dev' },
  ],
  signInMethods: [],
} as unknown as AccountStatus

const lane = (over: Partial<UsageLane> & Pick<UsageLane, 'id' | 'usedPercent'>): UsageLane => ({
  label: 'Weekly',
  windowMinutes: 10_080,
  resetsAt: null,
  ...over,
})

const report = (account: string, lanes: readonly UsageLane[], reached: string | null = null): UsageReport => ({
  runtime: CLAUDE,
  account,
  plan: 'Max 20x',
  lanes,
  credits: null,
  spend: null,
  reached,
  source: { kind: 'runtime', label: 'from its own API' },
  fetchedAt: 0,
  staleAfterMs: 600_000,
  error: null,
})

/** Claude Code on Max 20x: the Fable week gone, the account's own weekly fine. */
const fableSpent = report(
  'olivia@acme.dev',
  [
    lane({ id: 'session', label: 'Session', usedPercent: 12, windowMinutes: 300 }),
    lane({ id: 'weekly', usedPercent: 63 }),
    lane({ id: 'weekly:fable', usedPercent: 100, scope: 'Fable' }),
  ],
  'weekly:fable',
)

/** A second account whose own weekly really is gone. */
const reallySpent = report('work@acme.dev', [lane({ id: 'weekly', usedPercent: 100 })], 'weekly')

const mount = async (usage: readonly UsageReport[]): Promise<void> => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [info],
    activeRuntime: CLAUDE,
    accountsByRuntime: { [CLAUDE]: status },
    healthByRuntime: { [CLAUDE]: { state: 'ready' } },
    usage,
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAccounts: vi.fn(async () => {}),
    agentCatalog: vi.fn(async () => []),
    acpRegistry: vi.fn(async () => ({ agents: [], fetchedAt: 1 })),
    setAccountPrefs: vi.fn(),
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <AgentsSection onSignIn={() => {}} />
      </StoreProvider>,
    )
  })
  // Nothing needs attention, so the block starts closed; the rows are the
  // subject here.
  const toggle = [...container.querySelectorAll('button')].find((node) =>
    node.getAttribute('aria-label')?.startsWith('Show the accounts under'),
  )
  if (toggle) await act(async () => toggle.click())
}

/**
 * One row per account, in the order the page lists them.
 *
 * The figure and the dot are looked up *inside* the row, never across the
 * page: this section draws dots in its block header and on rows that have no
 * account, and how many of those there are is not this test's business. A
 * document-order lookup would have gone stale the moment the header changed.
 */
const rows = (): { label: string; figure: string | null; state: string | null }[] =>
  [...container.querySelectorAll('button, a')]
    .filter((node) => /@acme\.dev/.test(node.textContent ?? ''))
    .map((node) => ({
      label: /work@acme\.dev/.test(node.textContent ?? '') ? 'work@acme.dev' : 'olivia@acme.dev',
      figure: node.querySelector('[class*="figure"]')?.textContent ?? null,
      state: node.querySelector('[class*="dot"]')?.getAttribute('data-state') ?? null,
    }))

describe('an account row in Settings', () => {
  it('reads the account own window, not whichever lane is tightest', async () => {
    await mount([fableSpent])
    const olivia = rows().find((row) => row.label === 'olivia@acme.dev')
    expect(olivia?.figure).toBe('37% left')
    expect(olivia?.state).toBe('ready')
  })

  it('still says out when the account own window is the one that is gone', async () => {
    await mount([reallySpent])
    const work = rows().find((row) => row.label === 'work@acme.dev')
    expect(work?.figure).toBe('0% left')
    expect(work?.state).toBe('limit')
  })

  it('gives each row its own account reading, whatever order they arrive in', async () => {
    // The spent account's report first, so a row that took the first reading
    // for the runtime would paint both rows out.
    await mount([reallySpent, fableSpent])
    const listed = rows()
    expect(listed.find((row) => row.label === 'olivia@acme.dev')).toMatchObject({
      figure: '37% left',
      state: 'ready',
    })
    expect(listed.find((row) => row.label === 'work@acme.dev')).toMatchObject({
      figure: '0% left',
      state: 'limit',
    })
    // And the reverse order says exactly the same thing.
    await act(async () => root.unmount())
    root = createRoot(container)
    await mount([fableSpent, reallySpent])
    expect(rows().find((row) => row.label === 'work@acme.dev')).toMatchObject({
      figure: '0% left',
      state: 'limit',
    })
  })
})
