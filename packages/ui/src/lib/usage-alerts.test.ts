import { describe, expect, it } from 'vitest'

import type { RuntimeId, UsageLane, UsageReport } from '@harnessdesk/protocol'

import { conditionFor, crossings } from './usage-alerts'

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
const nameFor = (runtime: RuntimeId): string => (runtime === id('codex') ? 'OpenAI Codex' : 'Claude Code')

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
    const alerts = crossings(before, after, nameFor, NOON)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.message).toBe('Claude Code — Weekly is 80% used, 18% left, back in 2d.')
  })

  it('says a reset a minute short of a day away is back in 1d, never 24h', () => {
    const near = NOON + 23 * HOUR + 59 * MINUTE + 40_000
    const before = [report('claude', [lane({ usedPercent: 70, resetsAt: near })])]
    const after = [report('claude', [lane({ usedPercent: 82, resetsAt: near })])]
    const alerts = crossings(before, after, nameFor, NOON)
    expect(alerts[0]?.message).toBe('Claude Code — Weekly is 80% used, 18% left, back in 1d.')
  })

  it('says nothing about a lane it is seeing for the first time', () => {
    const alerts = crossings([], [report('claude', [lane({ usedPercent: 97 })])], nameFor, NOON)
    expect(alerts).toEqual([])
  })

  it('says nothing twice: the second reading is already over the line', () => {
    const before = [report('claude', [lane({ usedPercent: 82 })])]
    const after = [report('claude', [lane({ usedPercent: 88 })])]
    expect(crossings(before, after, nameFor, NOON)).toEqual([])
  })

  it('crosses both lines at once when a reading jumps past them', () => {
    const before = [report('claude', [lane({ usedPercent: 40 })])]
    const after = [report('claude', [lane({ usedPercent: 96 })])]
    expect(crossings(before, after, nameFor, NOON).map((alert) => alert.key)).toEqual([
      `claude:weekly:${NOON + 2 * DAY}:80`,
      `claude:weekly:${NOON + 2 * DAY}:95`,
    ])
  })

  it('treats a reset window as a lane it has not seen, not as a fall from 90 to 0', () => {
    const before = [report('claude', [lane({ usedPercent: 90, resetsAt: NOON })])]
    const after = [report('claude', [lane({ usedPercent: 5, resetsAt: NOON + 7 * DAY })])]
    expect(crossings(before, after, nameFor, NOON)).toEqual([])
  })

  it('ignores a lane whose usage the source never reported', () => {
    const before = [report('claude', [lane({ usedPercent: 0, usageKnown: false })])]
    const after = [report('claude', [lane({ usedPercent: 99, usageKnown: false })])]
    expect(crossings(before, after, nameFor, NOON)).toEqual([])
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
    expect(crossings([personal(90), work(50)], [personal(90), work(50)], nameFor, NOON)).toEqual([])
    // Personal crossed 80 while work stayed at 90: one alert, and it is personal's.
    const alerts = crossings([personal(50), work(90)], [personal(85), work(90)], nameFor, NOON)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.key).toContain('codex@personal:')
  })
})

describe('a report that names no account', () => {
  it('a report without the account field keys as one that names none', () => {
    // Round 1 of #170: tested against null alone, a payload that left the field out keyed as `codex@undefined`.
    const before = [report('codex', [lane({ usedPercent: 50 })])]
    const after = [{ ...report('codex', [lane({ usedPercent: 85 })]), account: undefined as unknown as null }]
    expect(crossings(before, after, nameFor, NOON)).toHaveLength(1)
  })
})
