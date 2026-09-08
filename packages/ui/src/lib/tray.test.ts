import { describe, expect, it } from 'vitest'

import type { AccountStatus, RuntimeInfo, UsageLane, UsageReport } from '@harnessdesk/protocol'

import { describeTray } from './tray'

/**
 * What the menu bar says with no window open.
 *
 * The claims worth pinning are the ones read at a glance: the figure on the
 * status item is the agent with least left, each row says what that agent has
 * left in the words the header strip uses, a row with no figure says its state
 * instead, and every row carries the mark the menu draws beside it — and the
 * figure the shell needs to draw a bar.
 */

const NOON = new Date('2026-08-22T12:00:00').getTime()
const HOUR = 3_600_000

const runtime = (id: string, name: string): RuntimeInfo =>
  ({ id, name, capabilities: {}, presentation: { name } }) as unknown as RuntimeInfo

const lane = (over: Partial<UsageLane> & Pick<UsageLane, 'id' | 'usedPercent'>): UsageLane => ({
  label: over.label ?? over.id,
  windowMinutes: 10_080,
  resetsAt: null,
  ...over,
})

const report = (id: string, lanes: readonly UsageLane[], over: Partial<UsageReport> = {}): UsageReport =>
  ({
    runtime: id,
    account: null,
    plan: null,
    lanes,
    credits: null,
    spend: null,
    reached: null,
    source: { kind: 'runtime', label: 'from its own API' },
    fetchedAt: NOON,
    staleAfterMs: 5 * 60_000,
    error: null,
    ...over,
  }) as unknown as UsageReport

const signedIn = { accounts: [{ id: 'me' }], signInMethods: [] } as unknown as AccountStatus

const tray = (over: Partial<Parameters<typeof describeTray>[0]> = {}) =>
  describeTray({
    runtimes: [],
    usage: [],
    accountsByRuntime: {},
    health: null,
    activeRuntime: null,
    now: NOON,
    ...over,
  })

describe('describeTray', () => {
  it('puts the agent with least left in the menu bar', () => {
    const summary = tray({
      runtimes: [runtime('claude', 'Claude Code'), runtime('cursor', 'Cursor Agent')],
      accountsByRuntime: { claude: signedIn, cursor: signedIn } as never,
      usage: [
        report('claude', [lane({ id: 'weekly', usedPercent: 42 })]),
        report('cursor', [lane({ id: 'weekly', usedPercent: 88 })]),
      ],
    })
    expect(summary.title).toBe('12%')
    expect(summary.agents.map((agent) => agent.detail)).toEqual(['58% left', '12% left'])
  })

  it('says what a row has left and when it comes back, in the strip’s own words', () => {
    const summary = tray({
      runtimes: [runtime('claude', 'Claude Code')],
      accountsByRuntime: { claude: signedIn } as never,
      usage: [report('claude', [lane({ id: 'session', usedPercent: 17, resetsAt: NOON + 3 * HOUR })])],
    })
    expect(summary.agents[0]?.detail).toBe('83% left, resets in 3h')
  })

  it('names the state when there is no figure, rather than an empty row', () => {
    const summary = tray({
      runtimes: [runtime('claude', 'Claude Code'), runtime('codex', 'OpenAI Codex')],
      accountsByRuntime: { claude: signedIn } as never,
      usage: [report('claude', [lane({ id: 'weekly', usedPercent: 10 })])],
    })
    expect(summary.agents[1]).toMatchObject({ id: 'codex', detail: 'Needs sign-in', needsSignIn: true })
  })

  it('names the account when two agents share a display name, as the strip does', () => {
    // The symlink farm: one Codex account per runtime, so the roster holds two
    // agents of the same name and a row of its own cannot tell.
    const summary = tray({
      runtimes: [runtime('codex', 'OpenAI Codex'), runtime('codex-3205b2', 'OpenAI Codex')],
      accountsByRuntime: { codex: signedIn, 'codex-3205b2': signedIn } as never,
      usage: [
        report('codex', [lane({ id: 'weekly', usedPercent: 42 })], { account: 'olivia@acme.dev' }),
        report('codex-3205b2', [lane({ id: 'weekly', usedPercent: 88 })], {
          account: 'sam@acme.dev',
        }),
      ],
    })
    expect(summary.agents.map((agent) => agent.name)).toEqual([
      'OpenAI Codex · olivia@acme.dev',
      'OpenAI Codex · sam@acme.dev',
    ])
    // The account is the only addition: each row still says what it has left.
    expect(summary.agents.map((agent) => agent.detail)).toEqual(['58% left', '12% left'])
  })

  it('leaves a name alone while it is the agent’s own, which is nearly every setup', () => {
    const summary = tray({
      runtimes: [runtime('claude', 'Claude Code'), runtime('codex', 'OpenAI Codex')],
      accountsByRuntime: { claude: signedIn, codex: signedIn } as never,
      usage: [
        report('claude', [lane({ id: 'weekly', usedPercent: 42 })], { account: 'me@example.com' }),
        report('codex', [lane({ id: 'weekly', usedPercent: 88 })], { account: 'me@example.com' }),
      ],
    })
    expect(summary.agents.map((agent) => agent.name)).toEqual(['Claude Code', 'OpenAI Codex'])
  })

  it('says which account a row shows when one agent holds several', () => {
    const summary = tray({
      runtimes: [runtime('codex', 'OpenAI Codex')],
      accountsByRuntime: { codex: signedIn } as never,
      usage: [
        report('codex', [lane({ id: 'weekly', usedPercent: 42 })], { account: 'olivia@acme.dev' }),
        report('codex', [lane({ id: 'weekly', usedPercent: 88 })], { account: 'sam@acme.dev' }),
      ],
    })
    expect(summary.agents[0]?.name).toBe('OpenAI Codex · olivia@acme.dev')
  })

  it('has nothing to add to a shared name when the reading carries no account', () => {
    const summary = tray({
      runtimes: [runtime('codex', 'OpenAI Codex'), runtime('codex-3205b2', 'OpenAI Codex')],
      accountsByRuntime: { codex: signedIn } as never,
      usage: [report('codex', [lane({ id: 'weekly', usedPercent: 42 })])],
    })
    expect(summary.agents.map((agent) => agent.name)).toEqual(['OpenAI Codex', 'OpenAI Codex'])
  })

  it('hands the shell each agent’s mark, which is what draws it in the menu', () => {
    const summary = tray({
      runtimes: [runtime('claude', 'Claude Code'), runtime('mystery', 'Something Else')],
      accountsByRuntime: {},
    })
    expect(summary.agents.map((agent) => agent.brand)).toEqual(['claudecode', null])
  })

  it('has nothing to say in the menu bar when no agent reports a figure', () => {
    expect(tray().title).toBe('')
    expect(tray().agents).toEqual([])
  })

  it('hands the shell the figure its bar is drawn from, not only the sentence', () => {
    const summary = tray({
      runtimes: [runtime('claude', 'Claude Code'), runtime('codex', 'OpenAI Codex')],
      accountsByRuntime: { claude: signedIn } as never,
      usage: [report('claude', [lane({ id: 'weekly', usedPercent: 42 })])],
    })
    expect(summary.agents[0]).toMatchObject({ left: 58 })
    // No account is no reading, and no reading is no bar: the shell must not
    // be handed a zero it would draw as an empty plan.
    expect(summary.agents[1]).toMatchObject({ left: null })
  })
})
