import { describe, expect, it } from 'vitest'

import { runtimeId, type AccountStatus, type RuntimeInfo, type UsageLane, type UsageReport } from '@harnessdesk/protocol'

import { describeStrip, MAX_PROMOTED, type StripInput } from './plan-strip'

/**
 * What the header strip says, whatever the size of the roster.
 *
 * The claims the design rests on: the strip's width does not grow with the
 * roster, the anchor is the conversation's own agent rather than whichever one
 * has least left, the token says whether anything else is in the way without
 * being opened, an out-of-quota agent can buy its way onto the strip but only
 * two of them can, and an agent with two accounts is read by the account that
 * would actually run the turn.
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

/** A plan with a share left and nothing else to say about it. */
const at = (id: string, left: number, over: Partial<UsageReport> = {}): UsageReport =>
  report(id, [lane({ id: 'weekly', label: 'Weekly', usedPercent: 100 - left })], over)

/** A plan that is over, with a reset the strip can count down to. */
const spent = (id: string, backIn: number, over: Partial<UsageReport> = {}): UsageReport =>
  report(
    id,
    [lane({ id: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: NOON + backIn })],
    { reached: 'weekly', ...over },
  )

const strip = (over: Partial<StripInput> = {}) =>
  describeStrip({
    runtimes: [],
    usage: [],
    accountsByRuntime: {},
    health: null,
    activeRuntime: null,
    sessionRuntime: null,
    now: NOON,
    ...over,
  })

/** Six agents, which is the roster the old one-bar-per-agent strip died on. */
const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => runtime(id, `Agent ${id.toUpperCase()}`))

describe('the anchor', () => {
  it('is the conversation own agent, not the one in the most trouble', () => {
    const view = strip({
      runtimes: six,
      usage: [at('a', 8), at('b', 91), at('c', 44)],
      sessionRuntime: runtimeId('b'),
    })
    expect(view.anchor?.kind).toBe('meter')
    expect(view.anchor?.kind === 'meter' && view.anchor.meter.runtime).toBe('b')
    expect(view.anchor?.kind === 'meter' && view.anchor.meter.figure).toBe('91%')
  })

  it('falls back to the selected agent when no conversation is open', () => {
    const view = strip({ runtimes: six, usage: [at('c', 44)], activeRuntime: runtimeId('c') })
    expect(view.anchor?.kind === 'meter' && view.anchor.meter.runtime).toBe('c')
  })

  it('asks for a sign-in when the conversation own agent has no account', () => {
    const view = strip({
      runtimes: [runtime('a', 'Agent A'), runtime('b', 'Agent B')],
      accountsByRuntime: { b: signedIn } as StripInput['accountsByRuntime'],
      usage: [at('b', 50)],
      sessionRuntime: runtimeId('a'),
    })
    expect(view.anchor).toEqual({ kind: 'signIn', info: expect.objectContaining({ id: 'a' }) })
  })

  it('trusts a live reading over an account list that has not arrived yet', () => {
    // The reports land before `accountsByRuntime` does on a cold start, and an
    // agent that has just said what it has left is not one to ask for a
    // password — the old strip drew a bar and a Sign in chip for the same
    // agent in that frame.
    const view = strip({ runtimes: [runtime('a', 'Agent A')], usage: [at('a', 62)], sessionRuntime: runtimeId('a') })
    expect(view.anchor?.kind).toBe('meter')
  })

  it('draws no bar for an agent that reports no lane, rather than a row of dashes', () => {
    const view = strip({
      runtimes: [runtime('a', 'Agent A')],
      usage: [report('a', [])],
      accountsByRuntime: { a: signedIn } as StripInput['accountsByRuntime'],
      sessionRuntime: runtimeId('a'),
    })
    expect(view.anchor).toBeNull()
    expect(view.rest).toBeNull()
  })
})

describe('the token', () => {
  it('stands for every other agent, however many there are', () => {
    const view = strip({
      runtimes: six,
      usage: six.map((info, index) => at(info.id, 90 - index)),
      sessionRuntime: runtimeId('a'),
    })
    expect(view.rest?.count).toBe(5)
    // Five agents, one token: the whole point. Nothing else is drawn.
    expect(view.promoted).toHaveLength(0)
    expect(view.rest?.figure).toBe('85%')
    expect(view.rest?.tone).toBe('good')
  })

  it('says how many are out before it says a percentage', () => {
    const view = strip({
      runtimes: six,
      usage: [at('a', 70), spent('b', 2 * HOUR), spent('c', HOUR), spent('d', HOUR), at('e', 60)],
      sessionRuntime: runtimeId('a'),
    })
    expect(view.rest?.figure).toBe('3 out')
    expect(view.rest?.tone).toBe('bad')
  })

  it('carries tone, so nothing-is-wrong is legible without opening it', () => {
    const good = strip({ runtimes: six, usage: [at('a', 90), at('b', 64)], sessionRuntime: runtimeId('a') })
    const low = strip({ runtimes: six, usage: [at('a', 90), at('b', 7)], sessionRuntime: runtimeId('a') })
    expect(good.rest?.tone).toBe('good')
    expect(low.rest?.tone).toBe('warn')
    expect(low.rest?.figure).toBe('7%')
  })

  it('counts the agents it stands for even when they have no bar to draw', () => {
    const view = strip({
      runtimes: six,
      usage: [at('a', 90), at('b', 64)],
      accountsByRuntime: { a: signedIn, b: signedIn } as StripInput['accountsByRuntime'],
      sessionRuntime: runtimeId('a'),
    })
    expect(view.rest?.count).toBe(5)
    expect(view.rest?.meters).toHaveLength(1)
    // The four with nothing to report are why the count and the bars differ,
    // so the panel has to hold them.
    expect(view.rest?.asides.map((aside) => aside.detail)).toEqual([
      'Needs sign-in',
      'Needs sign-in',
      'Needs sign-in',
      'Needs sign-in',
    ])
    expect(view.rest?.signIn).toBe(4)
  })

  it('is absent when there is nobody else', () => {
    const view = strip({ runtimes: [runtime('a', 'Agent A')], usage: [at('a', 50)], sessionRuntime: runtimeId('a') })
    expect(view.rest).toBeNull()
    expect(view.anchor?.kind).toBe('meter')
  })

  it('names what it is standing for, since a bare count would have to be opened', () => {
    const view = strip({
      runtimes: six,
      usage: [at('a', 90), spent('b', 2 * HOUR), at('c', 11), at('d', 55)],
      accountsByRuntime: { e: signedIn } as StripInput['accountsByRuntime'],
      sessionRuntime: runtimeId('a'),
    })
    expect(view.rest?.title).toBe(
      '5 other agents — 1 out of quota, 1 running low, least left 11%, 1 needs sign-in',
    )
  })
})

describe('promotion', () => {
  it('gives an out-of-quota agent a chip of its own, because a count cannot say who', () => {
    const view = strip({
      runtimes: six,
      usage: [at('a', 70), spent('b', 2 * HOUR)],
      sessionRuntime: runtimeId('a'),
    })
    expect(view.promoted.map((meter) => meter.runtime)).toEqual(['b'])
    expect(view.promoted[0]?.figure).toBe('2h')
    expect(view.promoted[0]?.tone).toBe('bad')
  })

  it('stops at two, so the strip cannot grow with the bad news either', () => {
    const view = strip({
      runtimes: six,
      usage: [at('a', 70), spent('b', HOUR), spent('c', HOUR), spent('d', HOUR), spent('e', HOUR)],
      sessionRuntime: runtimeId('a'),
    })
    expect(view.promoted).toHaveLength(MAX_PROMOTED)
    // The chips are an addition, never a subtraction: the token still counts
    // all four, which is what lets a narrow header drop the chips and stay true.
    expect(view.rest?.out).toBe(4)
    expect(view.rest?.figure).toBe('4 out')
  })

  it('keeps roster order, whatever the urgency', () => {
    const view = strip({
      runtimes: six,
      usage: [at('a', 70), spent('c', HOUR), spent('b', 5 * HOUR)],
      sessionRuntime: runtimeId('a'),
    })
    expect(view.promoted.map((meter) => meter.runtime)).toEqual(['b', 'c'])
  })

  it('will not promote an agent because one of its models is spent', () => {
    // The chip and the token both mean "this one is in the way", which is an
    // account-wide claim. Claude Code with the Fable week gone is not: the
    // account-wide weekly still has 37% and every other model answers.
    const fable = report(
      'b',
      [
        lane({ id: 'weekly', label: 'Weekly', usedPercent: 63 }),
        lane({ id: 'weekly:fable', label: 'Weekly', usedPercent: 100, scope: 'Fable' }),
      ],
      { reached: 'weekly:fable' },
    )
    const view = strip({ runtimes: six, usage: [at('a', 70), fable], sessionRuntime: runtimeId('a') })
    expect(view.promoted).toHaveLength(0)
    expect(view.rest?.out).toBe(0)
    // And it is read at what the account has left, not at nothing left.
    expect(view.rest?.figure).toBe('37%')
  })

  it('never promotes the anchor, which already has the first slot', () => {
    const view = strip({ runtimes: six, usage: [spent('a', HOUR), at('b', 80)], sessionRuntime: runtimeId('a') })
    expect(view.promoted).toHaveLength(0)
    expect(view.anchor?.kind === 'meter' && view.anchor.meter.out).toBe(true)
    expect(view.anchor?.kind === 'meter' && view.anchor.meter.figure).toBe('1h')
  })
})

describe('two accounts, one agent', () => {
  it('reads the agent by the account that would run the turn', () => {
    // The strip used to take the first report it found for the agent, so which
    // account it was drawing depended on which one answered first.
    const view = strip({
      runtimes: [runtime('a', 'Agent A')],
      usage: [spent('a', 3 * HOUR, { account: 'work' }), at('a', 88, { account: 'personal' })],
      sessionRuntime: runtimeId('a'),
    })
    expect(view.anchor?.kind === 'meter' && view.anchor.meter.account).toBe('personal')
    expect(view.anchor?.kind === 'meter' && view.anchor.meter.figure).toBe('88%')
  })

  it('is out only when every one of its accounts is', () => {
    const view = strip({
      runtimes: six,
      usage: [at('a', 70), spent('b', 3 * HOUR, { account: 'work' }), spent('b', HOUR, { account: 'personal' })],
      sessionRuntime: runtimeId('a'),
    })
    expect(view.promoted.map((meter) => meter.runtime)).toEqual(['b'])
    // The one that comes back soonest decides: when is the only question left.
    expect(view.promoted[0]?.figure).toBe('1h')
    expect(view.rest?.out).toBe(1)
  })

  it('names the account only when there is more than one to name', () => {
    const one = strip({ runtimes: six, usage: [at('a', 50, { account: 'solo' })], sessionRuntime: runtimeId('a') })
    const two = strip({
      runtimes: six,
      usage: [at('a', 50, { account: 'work' }), at('a', 20, { account: 'personal' })],
      sessionRuntime: runtimeId('a'),
    })
    expect(one.anchor?.kind === 'meter' && one.anchor.meter.account).toBeNull()
    expect(two.anchor?.kind === 'meter' && two.anchor.meter.account).toBe('work')
  })

  it('names the account when two agents share a display name, as a symlink farm makes them', () => {
    // Each Codex account is registered as its own runtime, so the roster holds
    // two agents with one name and neither report can see the other.
    const view = strip({
      runtimes: [runtime('codex', 'OpenAI Codex'), runtime('codex-2', 'OpenAI Codex'), runtime('c', 'Agent C')],
      usage: [at('codex', 42, { account: 'work@example.com' }), at('codex-2', 88, { account: 'me@example.com' })],
      sessionRuntime: runtimeId('c'),
    })
    expect(view.rest?.meters.map((meter) => [meter.name, meter.account])).toEqual([
      ['OpenAI Codex', 'work@example.com'],
      ['OpenAI Codex', 'me@example.com'],
    ])
    expect(view.rest?.meters[0]?.title).toBe('OpenAI Codex · work@example.com — Weekly, 42% left')
  })

  it('lists both accounts in the token panel, so the count is not the whole story', () => {
    const view = strip({
      runtimes: six,
      usage: [at('a', 70), at('b', 50, { account: 'work' }), at('b', 20, { account: 'personal' })],
      sessionRuntime: runtimeId('a'),
    })
    expect(view.rest?.count).toBe(5)
    expect(view.rest?.meters.map((meter) => meter.account)).toEqual(['work', 'personal'])
    // The token reads the agent by the account that works, not by the worst.
    expect(view.rest?.figure).toBe('50%')
  })
})
