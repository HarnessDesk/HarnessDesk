import { describe, expect, it } from 'vitest'

import type { RuntimeId, RuntimeInfo, UsageReport } from '@harnessdesk/protocol'

import { canTakeTurn, firstInPool, inPoolOrder, isPaced, movedInPool, nextInPool, readAccountPools, runtimeOut, whenOutOf } from './account-pool'

const id = (value: string): RuntimeId => value as RuntimeId
const info = (value: string): RuntimeInfo => ({ id: id(value) }) as unknown as RuntimeInfo
const spent = (runtime: string): UsageReport =>
  ({ runtime: id(runtime), account: null, lanes: [{ id: 'weekly', usedPercent: 100, windowMinutes: 10_080, resetsAt: null }], reached: 'weekly' }) as unknown as UsageReport
const roomy = (runtime: string): UsageReport =>
  ({ runtime: id(runtime), account: null, lanes: [{ id: 'weekly', usedPercent: 30, windowMinutes: 10_080, resetsAt: null }], reached: null }) as unknown as UsageReport

describe('the account pool', () => {
  it('keeps only what it can read, and asks by default', () => {
    expect(readAccountPools(null)).toEqual({})
    expect(readAccountPools({ codex: { order: ['codex-2', 3, 'codex'], whenOut: 'next' }, alpha: { whenOut: 'sometimes' }, beta: 'x' }))
      .toEqual({ codex: { order: ['codex-2', 'codex'], whenOut: 'next' } })
    expect(whenOutOf(undefined)).toBe('ask')
  })

  it('follows the desk where an agent sets no rule of its own, and its own rule where it does', () => {
    expect(whenOutOf(undefined, { onLimit: 'switch', otherAgents: true })).toBe('next')
    expect(whenOutOf({}, { onLimit: 'wait', otherAgents: true })).toBe('wait')
    expect(whenOutOf({ whenOut: 'stop' }, { onLimit: 'switch', otherAgents: true })).toBe('stop')
    expect(readAccountPools({ alpha: { whenOut: 'wait' } })).toEqual({ alpha: { whenOut: 'wait' } })
  })

  it('orders siblings by the pool, with an account it has not heard of last', () => {
    const siblings = [info('codex'), info('codex-2'), info('codex-3')]
    expect(inPoolOrder(siblings, { order: [id('codex-2'), id('codex')] }).map((entry) => entry.id))
      .toEqual(['codex-2', 'codex', 'codex-3'])
    expect(inPoolOrder(siblings, undefined).map((entry) => entry.id)).toEqual(['codex', 'codex-2', 'codex-3'])
  })

  it('moves one place at a time and stops at the ends', () => {
    const order = [id('a'), id('b'), id('c')]
    expect(movedInPool(order, id('c'), -1)).toEqual(['a', 'c', 'b'])
    expect(movedInPool(order, id('a'), -1)).toEqual(['a', 'b', 'c'])
    expect(movedInPool(order, id('a'), 1)).toEqual(['b', 'a', 'c'])
  })

  it('is out only when every report it has is spent', () => {
    expect(runtimeOut(id('a'), [])).toBe(false)
    expect(runtimeOut(id('a'), [spent('a')])).toBe(true)
    expect(runtimeOut(id('a'), [spent('a'), roomy('a')])).toBe(false)
  })

  it('finds the next usable account after the current one, wrapping around', () => {
    const ordered = [info('a'), info('b'), info('c')]
    expect(nextInPool(ordered, id('a'), (runtime) => runtime !== id('b'))?.id).toBe('c')
    expect(nextInPool(ordered, id('c'), () => true)?.id).toBe('a')
    expect(nextInPool(ordered, id('a'), () => false)).toBeNull()
    expect(nextInPool(ordered, id('z'), () => true)).toBeNull()
  })
})

describe('canTakeTurn', () => {
  const entry = (over: Partial<RuntimeInfo>): RuntimeInfo =>
    ({ id: 'agent' as RuntimeId, capabilities: { account: true }, ...over }) as unknown as RuntimeInfo
  const view = (accounts: number, state = 'ready') => ({
    healthByRuntime: { agent: { state } },
    accountsByRuntime: { agent: { accounts: Array.from({ length: accounts }, () => ({})) } },
  })

  it('takes a signed-in account, a gateway, and an agent that has no accounts at all', () => {
    expect(canTakeTurn(entry({}), view(1))).toBe(true)
    expect(canTakeTurn(entry({ slot: { gateway: { name: 'Acme gateway' } } } as never), view(0))).toBe(true)
    expect(canTakeTurn(entry({ capabilities: { account: false } } as never), view(0))).toBe(true)
  })

  it('refuses a signed-out account, and one that is starting or did not start', () => {
    expect(canTakeTurn(entry({}), view(0))).toBe(false)
    expect(canTakeTurn(entry({}), view(1, 'starting'))).toBe(false)
    expect(canTakeTurn(entry({ capabilities: { account: false } } as never), view(0, 'unavailable'))).toBe(false)
  })
})

describe('the soonest-reset order', () => {
  const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)
  const HOUR = 3_600_000
  const report = (runtime: string, usedPercent: number, resetsIn: number): UsageReport =>
    ({
      runtime: id(runtime), account: null, lanes: [{ id: 'session', label: '5 hour', usedPercent, windowMinutes: 300, resetsAt: NOW + resetsIn }],
      reached: null, error: null, fetchedAt: NOW - 60_000, staleAfterMs: 900_000,
    }) as unknown as UsageReport
  const siblings = [info('codex'), info('codex-2'), info('codex-3')]
  const pace = { pace: 'soonest' as const }

  it('is read back, and only that one word', () => {
    expect(readAccountPools({ codex: { pace: 'soonest' }, claude: { pace: 'later' } })).toEqual({ codex: { pace: 'soonest' } })
    expect(isPaced({ pace: 'soonest' })).toBe(true)
    expect(isPaced({ order: [id('a')] })).toBe(false)
  })

  it('puts the account that refills soonest first, whatever the person order says', () => {
    const reports = [report('codex', 20, 4 * HOUR), report('codex-2', 40, 1 * HOUR), report('codex-3', 10, 2 * HOUR)]
    expect(inPoolOrder(siblings, { ...pace, order: [id('codex'), id('codex-2'), id('codex-3')] }, { reports, now: NOW }).map((entry) => entry.id))
      .toEqual(['codex-2', 'codex-3', 'codex'])
  })

  it('leaves the person order alone when pacing is off, or when nothing is known to read', () => {
    const reports = [report('codex', 20, 4 * HOUR), report('codex-2', 40, HOUR)]
    expect(inPoolOrder(siblings, { order: [id('codex')] }, { reports, now: NOW }).map((entry) => entry.id)).toEqual(['codex', 'codex-2', 'codex-3'])
    expect(inPoolOrder(siblings, pace).map((entry) => entry.id)).toEqual(['codex', 'codex-2', 'codex-3'])
    expect(inPoolOrder(siblings, pace, { reports: [], now: NOW }).map((entry) => entry.id)).toEqual(['codex', 'codex-2', 'codex-3'])
  })

  it('picks the soonest-resetting account with room for new sessions, and skips one that is out', () => {
    const reports = [report('codex', 20, 4 * HOUR), report('codex-2', 100, HOUR), report('codex-3', 30, 2 * HOUR)]
    const ordered = inPoolOrder(siblings, pace, { reports, now: NOW })
    const view = { usage: reports, healthByRuntime: {}, accountsByRuntime: {} }
    const open = (entry: RuntimeInfo) => ({ ...entry, capabilities: { account: false } }) as unknown as RuntimeInfo
    expect(firstInPool(ordered.map(open), view, id('codex'))).toBe('codex-3')
  })
})
