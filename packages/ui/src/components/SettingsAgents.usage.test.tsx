import { RuntimesTestPage as RuntimesSection } from '../test-support/settings-page'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  runtimeId,
  NO_CAPABILITIES,
  type AccountStatus,
  type RateLimits,
  type RuntimeInfo,
  type UsageLane,
  type UsageReport,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { accountKey } from '../lib/accounts'
import { formatReset } from '../lib/limits'
import { describeLane, describeLaneReset, standingSentence } from '../lib/usage'
import { usageStandingOf } from '@harnessdesk/protocol'
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
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const describeLaneResetForTest = (window: UsageLane, now: number) => describeLaneReset(describeLane(window, now, [window]))

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
  fetchedAt: Date.now(),
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

const mount = async (usage: readonly UsageReport[], limits: RateLimits | null = null, extra: Partial<AppSnapshot> = {}, openRuntime = true, hostClock?: { lowerMs: number; upperMs: number } | null): Promise<AppStore> => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [info],
    activeRuntime: CLAUDE,
    accountsByRuntime: { [CLAUDE]: status },
    healthByRuntime: { [CLAUDE]: { state: 'ready' } },
    usage,
    ...extra,
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    hostTime: () => hostClock === undefined ? { lowerMs: Date.now(), upperMs: Date.now() } : hostClock,
    getSnapshot: () => snapshot,
    transport: { request: vi.fn(async () => null) },
    loadAccounts: vi.fn(async () => {}),
    limitsFor: vi.fn(async () => limits),
    loadCarryOnPolicy: async () => ({ onLimit: 'ask', otherAgents: true }),
    readCarryOnRules: async () => true,
    readPlan: vi.fn(async () => ({ entry: null, suggestion: null, refusal: null })),
    agentCatalog: vi.fn(async () => []),
    acpRegistry: vi.fn(async () => ({ agents: [], fetchedAt: 1 })),
    setAccountPrefs: vi.fn(),
    // What the agent's own page asks for, where its accounts now are.
    healthFor: vi.fn(async () => null),
    optionsFor: vi.fn(async () => []),
    newSessionDefaultsFor: vi.fn(async () => []),
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <RuntimesSection onSignIn={() => {}} />
      </StoreProvider>,
    )
  })
  // The account rows are on the agent's own page, which its line opens; the
  // rows are the subject here.
  const line = container.querySelector('[data-slot="agent-row"]')
  if (line && openRuntime) await act(async () => (line as HTMLButtonElement).click())
  return store
}

/**
 * One row per account, in the order the page lists them.
 *
 * The figure and attention state are looked up *inside* the row, never across the
 * page: this section draws states in its block header and on rows that have no
 * account, and how many of those there are is not this test's business. A
 * document-order lookup would have gone stale the moment the header changed.
 */
const rows = (): { label: string; figure: string | null; state: string | null }[] =>
  [...container.querySelectorAll('button, a')]
    .filter((node) => /@acme\.dev/.test(node.textContent ?? ''))
    .map((node) => ({
      label: /work@acme\.dev/.test(node.textContent ?? '') ? 'work@acme.dev' : 'olivia@acme.dev',
      figure:
        [...node.querySelectorAll('[data-slot="text"]')].find((el) =>
          el.textContent?.includes('% left'),
        )?.textContent ?? null,
      state: node.querySelector('[data-state="limit"]')?.getAttribute('data-state') ?? null,
    }))

describe('an account row in Settings', () => {
  it.each([-30, 30])('renders the same account reset at %s minute renderer skew', async offset => {
    const hostNow = Date.now()
    const window = lane({ id: 'session', label: 'Session', usedPercent: 12, windowMinutes: 300, resetsAt: hostNow + 139 * 60_000 })
    const reading = { ...report('olivia@acme.dev', [window]), fetchedAt: hostNow - 60_000 }
    const expected = describeLaneResetForTest(window, hostNow)
    vi.spyOn(Date, 'now').mockReturnValue(hostNow + offset * 60_000)
    await mount([reading], null, {}, true, { lowerMs: hostNow, upperMs: hostNow + 1 })
    const row = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('olivia@acme.dev'))
    expect(row?.textContent).toContain(expected)
  })

  it('does not present a definite account toolbar state without Host time', async () => {
    const now = Date.now()
    const reading = { ...report('work@acme.dev', [lane({ id: 'weekly', usedPercent: 100, resetsAt: now + 60_000 })], 'weekly'), fetchedAt: now - 10_000 }
    await mount([reading], null, {}, true, null)
    const row = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('work@acme.dev'))
    await act(async () => row?.click())
    expect(container.querySelector('[data-slot="toolbar"] [data-state="limit"]')).toBeNull()
    expect(container.querySelector('[data-slot="toolbar"]')?.textContent).toContain('Not checked yet')
  })

  it('does not claim a current runtime limit from an unverified reading', async () => {
    const hostNow = Date.now()
    const reading = { ...report('work@acme.dev', [lane({ id: 'weekly', usedPercent: 100, resetsAt: hostNow + 60_000 })], 'weekly'), fetchedAt: hostNow - 60_000 }
    await mount([reading], null, {}, false, null)
    const runtime = container.querySelector('[data-slot="agent-row"]')
    expect(runtime?.textContent).not.toContain('Limit reached')
    expect(runtime?.textContent).toContain('Unverified')
  })

  it('labels an account reading unverified and withholds reset timing without Host time', async () => {
    const hostNow = Date.now()
    const reading = { ...report('olivia@acme.dev', [lane({ id: 'session', usedPercent: 12, resetsAt: hostNow + 139 * 60_000 })]), fetchedAt: hostNow - 60_000 }
    await mount([reading], null, {}, true, null)
    const row = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('olivia@acme.dev'))
    expect(row?.textContent).toContain('Unverified')
    expect(row?.textContent).not.toContain('resets')
    expect(row?.textContent).not.toContain('Use it first')
  })

  it.each([-30, 30])('keeps a qualified use-first label at %s minute skew', async offset => {
    const hostNow = Date.now()
    const reading = { ...report('olivia@acme.dev', [lane({ id: 'session', usedPercent: 20, windowMinutes: 300, resetsAt: hostNow + 30 * 60_000 })]), fetchedAt: hostNow - 60_000 }
    vi.spyOn(Date, 'now').mockReturnValue(hostNow + offset * 60_000)
    await mount([reading], null, {}, true, { lowerMs: hostNow, upperMs: hostNow + 1 })
    const row = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('olivia@acme.dev'))
    expect(row?.textContent).toContain('Use it first')
  })

  it('reads the account own window, not whichever lane is tightest', async () => {
    await mount([fableSpent])
    const olivia = rows().find((row) => row.label === 'olivia@acme.dev')
    expect(olivia?.figure).toBe('88% left')
    expect(olivia?.state).toBeNull()
  })

  it('still says out when the account own window is the one that is gone', async () => {
    await mount([reallySpent])
    const work = rows().find((row) => row.label === 'work@acme.dev')
    expect(work?.figure).toBe('0% left')
    expect(work?.state).toBe('limit')
  })

  it('also shows the reset beside each account in the runtime overview', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const personal = lane({ id: 'session', usedPercent: 12, resetsAt: now + 2 * 3_600_000 })
    const work = lane({ id: 'weekly', usedPercent: 50, resetsAt: now + 3 * 86_400_000 })
    await mount([report('work@acme.dev', [work]), report('olivia@acme.dev', [personal])], null, {}, false)
    const runtime = container.querySelector('[data-slot="agent-row"]')
    expect(runtime?.textContent).toContain(`in ${describeLane(personal, now, [personal]).countdown}`)
    expect(runtime?.textContent).toContain(`in ${describeLane(work, now, [work]).countdown}`)
  })

  it('shows each account the Dashboard reset for its own selected lane', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const personal = lane({ id: 'session', label: 'Session', usedPercent: 12, windowMinutes: 300, resetsAt: now + 2 * 3_600_000 })
    const scoped = lane({ id: 'fable', usedPercent: 100, scope: 'Fable', resetsAt: now + 60_000 })
    const work = lane({ id: 'weekly', usedPercent: 100, resetsAt: now + 3 * 86_400_000 })
    await mount([report('work@acme.dev', [work], 'weekly'), report('olivia@acme.dev', [personal, scoped])])
    const row = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes(name))!
    const personalRow = row('olivia@acme.dev'), workRow = row('work@acme.dev')
    expect(personalRow.textContent).toContain('88% left')
    expect(personalRow.textContent).toContain(`in ${describeLane(personal, now, [personal, scoped]).countdown}`)
    expect(personalRow.textContent).toContain(`resets ${describeLane(personal, now, [personal, scoped]).resetClock}`)
    expect(workRow.textContent).toContain('0% left')
    expect(workRow.textContent).toContain(`in ${describeLane(work, now, [work]).countdown}`)
    expect(workRow.textContent).toContain(`resets ${describeLane(work, now, [work]).resetClock}`)
    expect(personalRow.textContent).not.toContain(`in ${describeLane(work, now, [work]).countdown}`)
    expect(workRow.textContent).not.toContain(`in ${describeLane(personal, now, [personal, scoped]).countdown}`)
  })

  it('uses the pinned account lane reset, including the Dashboard provider reset text', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const session = lane({ id: 'session', label: 'Session', usedPercent: 15, windowMinutes: 300, resetsAt: now + 3_600_000 })
    const weekly = lane({ id: 'weekly', usedPercent: 50, resetText: 'next billing cycle' })
    const key = accountKey(CLAUDE, status.accounts[0]!)
    await mount([report('olivia@acme.dev', [session, weekly])], null, { accountPrefs: { [key]: { pinLaneId: 'weekly' } } })
    const row = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('olivia@acme.dev'))!
    expect(row.textContent).toContain('50% left')
    expect(row.textContent).toContain(`in ${describeLane(weekly, now, [session, weekly]).countdown}`)
    expect(row.textContent).not.toContain(`in ${describeLane(session, now, [session, weekly]).countdown}`)
  })

  it('retains the blocked account’s own reset', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const spent = lane({ id: 'weekly', usedPercent: 100, resetsAt: now + 3 * 86_400_000 })
    await mount([report('work@acme.dev', [spent], 'weekly')])
    const row = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('work@acme.dev'))!
    expect(row.querySelector('[data-state="limit"]')).not.toBeNull()
    expect(row.textContent).toContain('0% left')
    expect(row.textContent).toContain(`in ${describeLane(spent, now, [spent]).countdown}`)
  })

  it('keeps a stale failed refresh associated with its own last reading', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const saved = lane({ id: 'weekly', usedPercent: 40, resetsAt: now + 2 * 86_400_000 })
    await mount([{ ...report('work@acme.dev', [saved]), fetchedAt: now - 900_000, error: { message: 'temporary' } }])
    const row = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('work@acme.dev'))!
    expect(row.textContent).toContain('60% left')
    expect(row.textContent).toContain('Unverified')
    expect(row.textContent).not.toMatch(/resets|in \d/)
  })

  it('does not invent another account’s reset for unknown or missing readings', async () => {
    const now = Date.now()
    const unknown = lane({ id: 'session', usedPercent: 0, usageKnown: false, resetsAt: null })
    const known = lane({ id: 'weekly', usedPercent: 40, resetsAt: now + 2 * 86_400_000 })
    await mount([{ ...report('work@acme.dev', [known]), fetchedAt: now - 900_000, error: { message: 'temporary' } }, report('olivia@acme.dev', [unknown])])
    const row = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes(name))!
    expect(row('olivia@acme.dev').textContent).not.toContain('100% left')
    expect(row('olivia@acme.dev').textContent).not.toContain(`in ${describeLane(known, now, [known]).countdown}`)
  })

  it('updates an idle account countdown as the clock passes its reset', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const now = Date.now()
    const personal = lane({ id: 'session', usedPercent: 12, resetsAt: now + 2 * 60_000 })
    await mount([report('olivia@acme.dev', [personal])])
    const row = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('olivia@acme.dev'))!
    expect(row().textContent).toContain('in 2m')
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(row().textContent).toContain('in 1m')
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(row().textContent).not.toMatch(/resets|in \d/)
    expect(row().textContent).toContain('88% left')
  })

  it('does not present an absent or elapsed reset as a future time', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const missing = lane({ id: 'session', usedPercent: 10, resetsAt: null })
    const elapsed = lane({ id: 'weekly', usedPercent: 40, resetsAt: now - 60_000 })
    await mount([report('olivia@acme.dev', [missing]), report('work@acme.dev', [elapsed])])
    const row = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes(name))!
    expect(row('olivia@acme.dev').textContent).not.toMatch(/resets|in \d/)
    expect(row('work@acme.dev').textContent).not.toMatch(/resets|in \d/)
  })

  it('keeps the reset clock in the Settings countdown title', async () => {
    const now = Date.now()
    const resetsAt = now + 3 * 86_400_000
    await mount([fableSpent], { fetchedAt: now - 1000, staleAfterMs: 120_000, windows: [{ label: 'Weekly', usedPercent: 63, windowMinutes: 10_080, resetsAt }] })
    const account = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('olivia@acme.dev'))
    await act(async () => account?.click())
    const countdown = container.querySelector('[data-slot="usage-meter-row"]')?.lastElementChild
    expect(countdown?.getAttribute('title')).toBe(`resets ${formatReset(resetsAt)}`)
  })

  it('gives each row its own account reading, whatever order they arrive in', async () => {
    // The spent account's report first, so a row that took the first reading
    // for the runtime would paint both rows out.
    await mount([reallySpent, fableSpent])
    const listed = rows()
    expect(listed.find((row) => row.label === 'olivia@acme.dev')).toMatchObject({
      figure: '88% left',
      state: null,
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

  it('lets an account pin a reported usage window from its detail page', async () => {
    const store = await mount([fableSpent])
    const account = [...container.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('olivia@acme.dev'),
    )
    if (!account) throw new Error('no account row')
    await act(async () => account.click())

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Primary usage window"]')
    expect(select).not.toBeNull()
    expect([...select!.options].map((option) => option.textContent)).toEqual(['Automatic', 'Session', 'Weekly'])

    await act(async () => {
      select!.value = 'weekly'
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(store.setAccountPrefs).toHaveBeenCalledWith(accountKey(CLAUDE, status.accounts[0]!), { pinLaneId: 'weekly' })
  })
})

describe('the agent page in Settings › Runtimes', () => {
  it.each([-30, 30])('uses Host time for the usage card at %s minute renderer skew', async offset => {
    const hostNow = Date.now()
    const reading = { ...report('olivia@acme.dev', [lane({ id: 'session', label: 'Session', usedPercent: 60, windowMinutes: 300, resetsAt: hostNow + 139 * 60_000 })]), fetchedAt: hostNow - 60_000 }
    vi.spyOn(Date, 'now').mockReturnValue(hostNow + offset * 60_000)
    await mount([reading], null, {}, true, { lowerMs: hostNow, upperMs: hostNow + 1 })
    const usage = container.querySelector('[aria-label="Usage by account"]')
    expect(usage?.textContent).toContain('Short')
    expect(usage?.textContent).toContain('Runs out')
    expect(usage?.textContent).not.toContain('Unverified')
  })

  it('marks the latest settings usage reading unverified when the Host lacks a clock', async () => {
    const hostNow = Date.now()
    const reading = { ...report('olivia@acme.dev', [lane({ id: 'session', usedPercent: 60, windowMinutes: 300, resetsAt: hostNow + 139 * 60_000 })]), fetchedAt: hostNow - 60_000 }
    await mount([reading], null, {}, true, null)
    const usage = container.querySelector('[aria-label="Usage by account"]')
    expect(usage?.textContent).toContain('Unverified')
    expect(usage?.textContent).toContain('40%')
    expect(usage?.textContent).not.toContain('Runs out')
  })
  it('shows each account with the Dashboard card: its figure and the same pacing sentence', async () => {
    const resetsAt = Date.now() + 2 * 3_600_000
    const pacing = report('olivia@acme.dev', [lane({ id: 'session', label: 'Session', usedPercent: 40, windowMinutes: 300, resetsAt })])
    await mount([pacing, reallySpent])
    const usage = container.querySelector('[aria-label="Usage by account"]')
    expect(usage).not.toBeNull()
    const said = standingSentence(usageStandingOf(pacing, Date.now()), Date.now())
    expect(said).not.toBeNull()
    expect(usage!.textContent).toContain(said!)
    expect(usage!.textContent).toContain('60%')
    expect(usage!.textContent).toContain('work@acme.dev')
  })
})

describe('the Runtimes page lists the accounts the Dashboard lists', () => {
  it('leaves out an account whose usage the person stopped tracking, as the Dashboard does', async () => {
    const payg = { ...report('olivia@acme.dev', []), plan: null, spend: { currency: 'USD', todayCost: 4, windowCost: 2115, windowDays: 30, provenance: 'reported' } } as unknown as UsageReport
    await mount([payg], null, { usageOff: [CLAUDE] })
    expect(container.querySelector('[aria-label="Usage by account"]')).toBeNull()
    expect(container.textContent).not.toContain('Pay as you go')
  })

  it('says a tracked agent with no reading is not reporting, as the Dashboard and the phone do', async () => {
    await mount([])
    const region = container.querySelector('[aria-label="Usage by account"]')
    // Said once, in the chip, the word the Dashboard and the phone use.
    expect(region?.textContent?.match(/not reporting/gi)).toHaveLength(1)
    expect(region?.textContent).toContain('Not reporting')
  })

  it('calls no agent not reporting before the host has answered a usage read (#2111 review)', async () => {
    await mount([], null, { usageAsked: [] })
    expect(container.textContent?.toLowerCase()).not.toContain('not reporting')
  })

  it("waits for this agent's own read, not any read, before calling it not reporting (#2111 review round 4)", async () => {
    // Another agent's read finished; this one was added since and has not been read yet.
    await mount([], null, { usageAsked: [runtimeId('codex')] })
    expect(container.textContent?.toLowerCase()).not.toContain('not reporting')
    act(() => root.unmount())
    root = createRoot(container)
    await mount([], null, { usageAsked: [CLAUDE] })
    expect(container.textContent).toContain('Not reporting')
  })
})
