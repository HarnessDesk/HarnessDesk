import { describe, expect, it } from 'vitest'

import type { Account, RuntimeId, RuntimeInfo, UsageLane, UsageReport } from '@harnessdesk/protocol'

import { accountKey } from './accounts'
import { conditionFor, crossings, toastName } from './usage-alerts'

/**
 * When the desk speaks, and when it keeps quiet.
 *
 * The quiet cases are the ones worth testing: a lane seen for the first time
 * already over the line, a second reading at the same level, and a window that
 * has reset. Each of those, announced, would be a lie or a nag.
 */

const NOON = new Date('2026-08-22T12:00:00').getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const id = (value: string): RuntimeId => value as RuntimeId
const nameFor = (runtime: RuntimeId, account: string | null = null): string =>
  `${String(runtime).startsWith('codex') ? 'OpenAI Codex' : 'Claude Code'}${account ? ` (${account})` : ''}`

/*
 * Two accounts of one agent are two runtimes, which is the shape the host
 * emits: `accounts.add` returns a runtime of its own and the host caches one
 * report per runtime id. A fixture giving two reports the *same* id is a shape
 * nothing can produce, and it was the only shape the account tests had (round
 * 2 of #216).
 */
const runtime = (runtimeId: string, agent: string): RuntimeInfo =>
  ({ id: id(runtimeId), name: 'OpenAI Codex', slot: { agent: id(agent) } }) as unknown as RuntimeInfo
const RUNTIMES: readonly RuntimeInfo[] = [
  runtime('codex', 'codex'),
  runtime('codex-2', 'codex'),
  runtime('claude', 'claude'),
]

const lane = (over: Partial<UsageLane> = {}): UsageLane => ({
  id: 'weekly',
  label: 'Weekly',
  usedPercent: 50,
  windowMinutes: 10_080,
  resetsAt: NOON + 2 * DAY,
  ...over,
})

const report = (runtime: string, lanes: readonly UsageLane[], over: Partial<UsageReport> = {}): UsageReport =>
  ({
    runtime: id(runtime),
    account: null,
    plan: null,
    lanes,
    credits: null,
    spend: null,
    reached: null,
    source: { kind: 'api', label: 'from a test' },
    fetchedAt: NOON,
    staleAfterMs: 60_000,
    error: null,
    ...over,
  }) as UsageReport

describe('crossings', () => {
  it('announces a line the desk watched being crossed', () => {
    const before = [report('claude', [lane({ usedPercent: 70 })])]
    const after = [report('claude', [lane({ usedPercent: 82 })])]
    const alerts = crossings(before, after, nameFor, RUNTIMES, NOON)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.message).toBe('Claude Code — Weekly is 80% used, 18% left, back in 2d.')
  })

  it('says a reset a minute short of a day away is back in 1d, never 24h', () => {
    const near = NOON + 23 * HOUR + 59 * MINUTE + 40_000
    const before = [report('claude', [lane({ usedPercent: 70, resetsAt: near })])]
    const after = [report('claude', [lane({ usedPercent: 82, resetsAt: near })])]
    const alerts = crossings(before, after, nameFor, RUNTIMES, NOON)
    expect(alerts[0]?.message).toBe('Claude Code — Weekly is 80% used, 18% left, back in 1d.')
  })

  it('says nothing about a lane it is seeing for the first time', () => {
    const alerts = crossings([], [report('claude', [lane({ usedPercent: 97 })])], nameFor, RUNTIMES, NOON)
    expect(alerts).toEqual([])
  })

  it('says nothing twice: the second reading is already over the line', () => {
    const before = [report('claude', [lane({ usedPercent: 82 })])]
    const after = [report('claude', [lane({ usedPercent: 88 })])]
    expect(crossings(before, after, nameFor, RUNTIMES, NOON)).toEqual([])
  })

  it('crosses both lines at once when a reading jumps past them', () => {
    const before = [report('claude', [lane({ usedPercent: 40 })])]
    const after = [report('claude', [lane({ usedPercent: 96 })])]
    expect(crossings(before, after, nameFor, RUNTIMES, NOON).map((alert) => alert.key)).toEqual([
      `claude:weekly:${NOON + 2 * DAY}:80`,
      `claude:weekly:${NOON + 2 * DAY}:95`,
    ])
  })

  it('treats a reset window as a lane it has not seen, not as a fall from 90 to 0', () => {
    const before = [report('claude', [lane({ usedPercent: 90, resetsAt: NOON })])]
    const after = [report('claude', [lane({ usedPercent: 5, resetsAt: NOON + 7 * DAY })])]
    expect(crossings(before, after, nameFor, RUNTIMES, NOON)).toEqual([])
  })

  it('ignores a lane whose usage the source never reported', () => {
    const before = [report('claude', [lane({ usedPercent: 0, usageKnown: false })])]
    const after = [report('claude', [lane({ usedPercent: 99, usageKnown: false })])]
    expect(crossings(before, after, nameFor, RUNTIMES, NOON)).toEqual([])
  })
})

describe('how a toast names an anonymous account (round 2 of #216)', () => {
  it('names the agent once, not twice', () => {
    const anonymous = [{ label: 'Signed in', anonymous: true } as unknown as Account]
    // `accountName` hands back the agent's name for an account the runtime cannot name,
    // so the address this built was the agent again: "Claude Code (Claude Code)".
    expect(toastName('Claude Code', id('claude'), 'Signed in', anonymous, {})).toBe('Claude Code')
    // The controls: a named account still rides along, and so does a nickname.
    expect(toastName('Claude Code', id('claude'), 'olivia@acme.dev', [], {})).toBe('Claude Code (olivia@acme.dev)')
    expect(
      toastName('Claude Code', id('claude'), 'Signed in', anonymous, {
        [accountKey(id('claude'), anonymous[0] as Account)]: { nickname: 'the work one' },
      }),
    ).toBe('Claude Code (the work one)')
  })
})

describe('crossings for an agent with more than one account (#179)', () => {
  it('names the account, so two accounts crossing one line are two toasts', () => {
    const at = (usedPercent: number) => [
      report('codex', [lane({ usedPercent })], { account: 'work' }),
      report('codex-2', [lane({ usedPercent })], { account: 'personal' }),
    ]
    const alerts = crossings(at(70), at(85), nameFor, RUNTIMES, NOON)
    expect(alerts.map((alert) => alert.message.split(' — ')[0])).toEqual(['OpenAI Codex (work)', 'OpenAI Codex (personal)'])
    expect(new Set(alerts.map((alert) => alert.message)).size).toBe(2)
  })

  it('reads an account that is only whitespace as none', () => {
    const alerts = crossings(
      [report('codex', [lane({ usedPercent: 70 })], { account: null })],
      [report('codex', [lane({ usedPercent: 85 })], { account: '  ' })],
      nameFor,
      RUNTIMES,
      NOON,
    )
    expect(alerts.map((alert) => alert.message.split(' — ')[0])).toEqual(['OpenAI Codex'])
  })

  it("keeps a colon in an account's name from making it another account's lane", () => {
    // Unquoted, account `a:b` with lane `c` and account `a` with lane `b:c` had one key.
    const alerts = crossings(
      [report('codex', [lane({ id: 'c', usedPercent: 70 })], { account: 'a:b' })],
      [report('codex', [lane({ id: 'b:c', usedPercent: 85 })], { account: 'a' })],
      nameFor,
      RUNTIMES,
      NOON,
    )
    expect(alerts).toEqual([])
  })
})

describe('conditionFor', () => {
  it('names the way out when this agent is spent and another has room', () => {
    const condition = conditionFor(
      id('claude'),
      [
        report('claude', [lane({ usedPercent: 100 })], { reached: 'weekly' }),
        report('codex', [lane({ usedPercent: 20 })]),
      ],
      nameFor,
      NOON,
    )
    expect(condition?.tone).toBe('danger')
    expect(condition?.title).toBe('Claude Code is out of quota')
    expect(condition?.detail).toBe('Weekly is back in 2d — past sessions are still readable')
    expect(condition?.handoff).toEqual({ runtime: id('codex'), name: 'OpenAI Codex' })
  })

  it('offers no way out to an agent that has none either', () => {
    const condition = conditionFor(
      id('claude'),
      [
        report('claude', [lane({ usedPercent: 100 })], { reached: 'weekly' }),
        report('codex', [lane({ usedPercent: 97 })]),
      ],
      nameFor,
      NOON,
    )
    expect(condition?.handoff).toBeNull()
  })

  it('warns when the pace will not reach the reset', () => {
    // Half a day into a seven-day window and already 40% spent.
    const condition = conditionFor(
      id('claude'),
      [report('claude', [lane({ usedPercent: 40, resetsAt: NOON + 6.5 * DAY })])],
      nameFor,
      NOON,
    )
    expect(condition?.tone).toBe('warning')
    expect(condition?.title).toBe('Claude Code will run out before it refills')
    expect(condition?.detail).toContain('runs out in')
  })

  it('keys a condition on the window, not on the sentence that moves', () => {
    // The same condition, read a minute apart. The detail says "runs out in
    // 3h 12m" and then "3h 11m"; a banner keyed on what it *says* would come
    // back a minute after it was put away.
    const reports = [report('claude', [lane({ usedPercent: 40, resetsAt: NOON + 6.5 * DAY })])]
    const first = conditionFor(id('claude'), reports, nameFor, NOON)
    const later = conditionFor(id('claude'), reports, nameFor, NOON + 60_000)
    expect(first?.key).toBeTruthy()
    expect(later?.key).toBe(first?.key)
    expect(later?.detail).not.toBe(first?.detail)
  })

  it('gives running out and being out different keys', () => {
    const pace = conditionFor(
      id('claude'),
      [report('claude', [lane({ usedPercent: 40, resetsAt: NOON + 6.5 * DAY })])],
      nameFor,
      NOON,
    )
    const spent = conditionFor(
      id('claude'),
      [report('claude', [lane({ usedPercent: 100, resetsAt: NOON + 6.5 * DAY })], { reached: 'weekly' })],
      nameFor,
      NOON,
    )
    // Dismissing "you will run out" must not also silence "you are out".
    expect(spent?.key).not.toBe(pace?.key)
  })

  it('is silent about an agent that is simply fine', () => {
    const condition = conditionFor(
      id('claude'),
      [report('claude', [lane({ usedPercent: 5, resetsAt: NOON + 6.5 * DAY })])],
      nameFor,
      NOON,
    )
    expect(condition).toBeNull()
  })

  it('is silent about an agent this conversation does not talk to', () => {
    const condition = conditionFor(
      id('codex'),
      [report('claude', [lane({ usedPercent: 100 })], { reached: 'weekly' })],
      nameFor,
      NOON,
    )
    expect(condition).toBeNull()
  })
})

describe('two accounts on one agent', () => {
  it('each account crosses its own lines, and neither speaks for the other', () => {
    // #88: the lane key had no account, so one account's reading was compared with the other's.
    const personal = (usedPercent: number) => report('codex', [lane({ usedPercent })], { account: 'personal' })
    const work = (usedPercent: number) => report('codex', [lane({ usedPercent })], { account: 'work' })
    // Nothing changed for either: nothing to say, although work's 50 came last and personal sits at 90.
    expect(crossings([personal(90), work(50)], [personal(90), work(50)], nameFor, RUNTIMES, NOON)).toEqual([])
    // Personal crossed 80 while work stayed at 90: one alert, and it is personal's.
    const alerts = crossings([personal(50), work(90)], [personal(85), work(90)], nameFor, RUNTIMES, NOON)
    expect(alerts).toHaveLength(1)
    // The account is quoted in the key (#179).
    expect(alerts[0]?.key).toContain('codex@"personal":')
  })
})

describe('a report that names no account', () => {
  it('a report without the account field keys as one that names none', () => {
    // Round 1 of #170: tested against null alone, a payload that left the field out keyed as `codex@undefined`.
    const before = [report('codex', [lane({ usedPercent: 50 })])]
    const after = [{ ...report('codex', [lane({ usedPercent: 85 })]), account: undefined as unknown as null }]
    expect(crossings(before, after, nameFor, RUNTIMES, NOON)).toHaveLength(1)
  })
})

describe('which toasts name the account (review of #216)', () => {
  it('a lone account is not named, so the common toast carries no address', () => {
    const alerts = crossings(
      [report('codex', [lane({ usedPercent: 70 })], { account: 'olivia@acme.dev' })],
      [report('codex', [lane({ usedPercent: 85 })], { account: 'olivia@acme.dev' })],
      nameFor,
      RUNTIMES,
      NOON,
    )
    expect(alerts.map((alert) => alert.message.split(' — ')[0])).toEqual(['OpenAI Codex'])
  })

  it('an account is named as the person named it', () => {
    const olivia = { kind: 'oauth', label: 'olivia@acme.dev', email: 'olivia@acme.dev' } as unknown as Account
    const work = { kind: 'oauth', label: 'work@acme.dev', email: 'work@acme.dev' } as unknown as Account
    const prefs = { [accountKey(id('codex'), work)]: { nickname: 'Work laptop' } }
    expect(toastName('OpenAI Codex', id('codex'), 'work@acme.dev', [olivia, work], prefs)).toBe('OpenAI Codex (Work laptop)')
    // Without a nickname, the address's own name rather than the whole address.
    expect(toastName('OpenAI Codex', id('codex'), 'olivia@acme.dev', [olivia, work], prefs)).toBe('OpenAI Codex (olivia)')
    // An account the desk doesn't hold is named as the report named it.
    expect(toastName('OpenAI Codex', id('codex'), 'ci@acme.dev', [olivia, work], prefs)).toBe('OpenAI Codex (ci@acme.dev)')
    expect(toastName('OpenAI Codex', id('codex'), null, [olivia, work], prefs)).toBe('OpenAI Codex')
  })
})
