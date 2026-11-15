import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, type HostMethodName, type RateLimits, type UsageReport, type WireNotification } from '@harnessdesk/protocol'

import { AppStore } from './store'
import { describeLimits } from '../lib/limits'

/**
 * Where a crossing becomes an Inbox entry: the store compares two refreshes and says
 * what it saw. Content keys deduplicate the sentence, so two accounts of one agent
 * that cross one line only reach the person twice if the sentence names each
 * account (#179).
 */

// One reset for every reading: a lane whose reset moved is a new window, not the same one read again.
const RESETS = Date.now() + 2 * 86_400_000

const report = (account: string | null, usedPercent: number, runtime = 'codex'): UsageReport =>
  ({
    runtime: runtimeId(runtime),
    account,
    plan: null,
    lanes: [{ id: 'weekly', label: 'Weekly', usedPercent, windowMinutes: 10_080, resetsAt: RESETS }],
    credits: null,
    spend: null,
    reached: null,
    source: { kind: 'api', label: 'from a test' },
    fetchedAt: Date.now(),
    staleAfterMs: 60_000,
    error: null,
  }) as UsageReport

let store: AppStore
let answers: Partial<Record<HostMethodName, unknown>>

beforeEach(async () => {
  store = new AppStore('ws://localhost:0/')
  answers = {}
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => method === 'app/state/get' ? {} : answers[method] ?? null) as never)
  await store.loadPreferences()
})

describe('usage alerts from a refresh', () => {
  it('keeps each account in the Inbox of one agent that crosses a line, by its own name', async () => {
    seatTwoAccounts()
    answers['usage/refresh'] = [report('work', 70), report('personal', 70, 'codex-2')]
    await store.refreshUsage()
    expect(store.getSnapshot().notices).toEqual([])

    answers['usage/refresh'] = [report('work', 85), report('personal', 85, 'codex-2')]
    await store.refreshUsage()
    const said = store.getSnapshot().inbox.map((notice) => notice.title)
    expect(said).toHaveLength(2)
    expect(store.getSnapshot().notices).toEqual([])
    expect(said[1]).toMatch(/^OpenAI Codex \(work\) — .* is 80% used/)
    expect(said[0]).toMatch(/^OpenAI Codex \(personal\) — .* is 80% used/)
  })
})

describe('an allowance notice a newer read superseded (#2111)', () => {
  it('leaves the Inbox once a newer read puts the window back under the line', async () => {
    answers['usage/refresh'] = [report('dev@example.com', 70)]
    await store.refreshUsage()
    answers['usage/refresh'] = [report('dev@example.com', 85)]
    await store.refreshUsage()
    expect(store.getSnapshot().inbox.map((notice) => notice.kind)).toEqual(['usage:crossing'])

    // A later read of the same account in the same window, under 80% again: the notice no longer holds.
    answers['usage/refresh'] = [{ ...report('dev@example.com', 40), fetchedAt: Date.now() + 1_000 }]
    await store.refreshUsage()
    expect(store.getSnapshot().inbox).toEqual([])
  })

  it('stays while a newer read still says what it said', async () => {
    answers['usage/refresh'] = [report('dev@example.com', 70)]
    await store.refreshUsage()
    answers['usage/refresh'] = [report('dev@example.com', 85)]
    await store.refreshUsage()
    answers['usage/refresh'] = [{ ...report('dev@example.com', 88), fetchedAt: Date.now() + 1_000 }]
    await store.refreshUsage()
    expect(store.getSnapshot().inbox.map((notice) => notice.kind)).toEqual(['usage:crossing'])
  })
})

describe('what the store keeps and says (review of #216)', () => {
  it('keeps one reading of an account whose none arrives spelled two ways', async () => {
    answers['usage/refresh'] = [report(null, 70)]
    await store.refreshUsage()
    answers['usage/refresh'] = [report('  ', 85)]
    await store.refreshUsage()
    expect(store.getSnapshot().usage).toHaveLength(1)
  })

  it('keeps two readings whose runtime and account join to one string', async () => {
    /* The replacement key was `${runtime}:${account}` with nothing between
       them, so runtime `codex` with account `a:b` and runtime `codex:a` with
       account `b` were one key and the second refresh dropped the first. The
       account is quoted now, as `laneKey` quotes it (round 2 of #216). */
    answers['usage/refresh'] = [report('a:b', 70)]
    await store.refreshUsage()
    /* The collision has to cross two refreshes to bite: within one batch every
       report is kept whatever its key, because `kept` only filters what was
       there before. */
    answers['usage/refresh'] = [report('b', 70, 'codex:a')]
    await store.refreshUsage()
    expect(store.getSnapshot().usage).toHaveLength(2)
  })

  it('names no account when the agent has one', async () => {
    answers['usage/refresh'] = [report('olivia@acme.dev', 70)]
    await store.refreshUsage()
    answers['usage/refresh'] = [report('olivia@acme.dev', 85)]
    await store.refreshUsage()
    expect(store.getSnapshot().inbox.map((notice) => notice.title)).toEqual([expect.stringMatching(/^codex — .* is 80% used/)])
  })
})

/** A notification, as the host pushes it. Never connected; nothing reaches a wire. */
const push = (notification: WireNotification): void => {
  const transport = store.transport as unknown as { handlers: { onNotification(notification: WireNotification): void } }
  transport.handlers.onNotification(notification)
}

/**
 * Two accounts of one agent, as the host really holds them: two runtimes
 * sharing a slot. One runtime id carrying two accounts is a shape nothing can
 * emit — the host caches one report per runtime id, and `accounts.add` returns
 * a runtime of its own — and it was the shape these tests used, which is why
 * they passed while the entry named nobody (round 2 of #216).
 */
const seatTwoAccounts = (): void => {
  for (const id of ['codex', 'codex-2']) {
    push({
      method: 'runtime/added',
      params: { info: { id: runtimeId(id), name: 'OpenAI Codex', slot: { agent: runtimeId('codex') }, presentation: { name: 'OpenAI Codex' } } },
    } as unknown as WireNotification)
  }
}

describe('usage alerts as the host pushes them, one account at a time', () => {
  // Review of #216: the path the running app takes, where #179's two identical messages came from.
  it('keeps each account in the Inbox that crosses a line, by its own name', () => {
    seatTwoAccounts()
    const both = [
      ['work', 'codex'],
      ['personal', 'codex-2'],
    ] as const
    for (const [account, runtime] of both) push({ method: 'usage/updated', params: { report: report(account, 70, runtime) } })
    expect(store.getSnapshot().notices).toEqual([])
    for (const [account, runtime] of both) push({ method: 'usage/updated', params: { report: report(account, 85, runtime) } })
    const said = store.getSnapshot().inbox.map((notice) => notice.title)
    expect(said).toHaveLength(2)
    expect(store.getSnapshot().notices).toEqual([])
    expect(said[1]).toMatch(/^OpenAI Codex \(work\) — .* is 80% used/)
    expect(said[0]).toMatch(/^OpenAI Codex \(personal\) — .* is 80% used/)
  })

  it('keeps one reading of an account whose none arrives spelled two ways', () => {
    push({ method: 'usage/updated', params: { report: report(null, 70) } })
    push({ method: 'usage/updated', params: { report: report('  ', 85) } })
    expect(store.getSnapshot().usage).toHaveLength(1)
  })
})

describe('usage reports that go silent', () => {
  const remove = (account: string | null, runtime = 'codex'): void => {
    push({ method: 'usage/removed', params: { runtime: runtimeId(runtime), account } })
  }

  it('removes only the reported account, including its previous failure', async () => {
    const silent = { ...report('work', 70), error: { message: 'the quota service is down' } }
    const other = report('personal', 70, 'codex-2')
    answers['usage/refresh'] = [silent, other]
    await store.refreshUsage()
    remove('work')
    expect(store.getSnapshot().usage).toEqual([other])
    answers['usage/refresh'] = []
    await store.refreshUsage(runtimeId('codex'))
    expect(store.getSnapshot().usage).toHaveLength(1)
    remove('work')
    expect(store.getSnapshot().usage).toHaveLength(1)
    expect(store.getSnapshot().notices).toEqual([])
  })

  it('normalizes anonymous account spellings and accepts a returning reading', () => {
    push({ method: 'usage/updated', params: { report: report(null, 70) } })
    remove('  ')
    expect(store.getSnapshot().usage).toEqual([])
    push({ method: 'usage/updated', params: { report: report(null, 85) } })
    expect(store.getSnapshot().usage).toHaveLength(1)
    expect(store.getSnapshot().notices).toEqual([])
  })

  it('does not drop a different account now held by the runtime', () => {
    push({ method: 'usage/updated', params: { report: report('new', 70) } })
    remove('old')
    expect(store.getSnapshot().usage).toHaveLength(1)
  })

  for (const method of ['usage/refresh', 'usage/reports'] as const) {
    it(`does not restore a removed account from a delayed ${method} reply`, async () => {
      const old = { ...report('work', 70), error: { message: 'the quota service is down' } }
      const other = report('personal', 70, 'codex-2')
      push({ method: 'usage/updated', params: { report: old } })
      let reply!: (reports: UsageReport[]) => void
      vi.mocked(store.transport.request).mockImplementationOnce(() => new Promise((resolve) => { reply = resolve }) as never)
      // The host finished this runtime first, but waits for a slow sibling
      // before returning the batch. Meanwhile another read finds silence.
      const pending = method === 'usage/refresh' ? store.refreshUsage() : store.loadUsage()
      remove('work')
      reply([old, other])
      await pending
      expect(store.getSnapshot().usage).toEqual([other])

      answers['usage/refresh'] = []
      await store.refreshUsage(runtimeId('codex'))
      expect(store.getSnapshot().usage).toEqual([other])
      push({ method: 'usage/updated', params: { report: report('work', 85) } })
      expect(store.getSnapshot().usage).toHaveLength(2)
      expect(store.getSnapshot().notices).toEqual([])
    })

    it(`keeps a newer account pushed during a delayed ${method} reply`, async () => {
      const old = report('work', 70)
      const current = report('new', 85)
      const other = report('personal', 70, 'codex-2')
      push({ method: 'usage/updated', params: { report: old } })
      let reply!: (reports: UsageReport[]) => void
      vi.mocked(store.transport.request).mockImplementationOnce(() => new Promise((resolve) => { reply = resolve }) as never)
      const pending = method === 'usage/refresh' ? store.refreshUsage() : store.loadUsage()
      remove('work')
      push({ method: 'usage/updated', params: { report: current } })
      reply([old, other])
      await pending
      expect(store.getSnapshot().usage).toEqual([current, other])
      expect(store.getSnapshot().notices).toEqual([])
    })

    it(`keeps a newer reading of the same account during a delayed ${method} reply`, async () => {
      const old = report('work', 70)
      const current = report('work', 75)
      push({ method: 'usage/updated', params: { report: old } })
      let reply!: (reports: UsageReport[]) => void
      vi.mocked(store.transport.request).mockImplementationOnce(() => new Promise((resolve) => { reply = resolve }) as never)
      const pending = method === 'usage/refresh' ? store.refreshUsage() : store.loadUsage()
      push({ method: 'usage/updated', params: { report: current } })
      reply([old])
      await pending
      expect(store.getSnapshot().usage).toEqual([current])
    })
  }
})

describe('which agents a usage read has finished for (#2111 review rounds 3 and 4)', () => {
  const failingFirstRead = (): void => {
    vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
      if (method === 'app/state/get') return {}
      if (method === 'usage/reports') throw new Error('socket closed')
      return answers[method] ?? null
    }) as never)
  }

  it('counts the agents as asked once the host answers a refresh, even when the first read of the start failed', async () => {
    failingFirstRead()
    await store.loadUsage()
    expect(store.getSnapshot().usageAsked).toEqual([])
    // One agent's read failed on the host and came back as its own error; the other answered.
    answers['usage/refresh'] = [report('dev@example.com', 40), { ...report(null, 0, 'cursor'), lanes: [], error: { message: 'ledger unreadable' } } as UsageReport]
    await store.refreshUsage()
    expect(store.getSnapshot().usageAsked).toEqual([runtimeId('codex'), runtimeId('cursor')])
    expect(store.getSnapshot().usage.map((entry) => entry.runtime)).toEqual([runtimeId('codex'), runtimeId('cursor')])
  })

  it('counts one agent refreshed on its own as that agent asked, and no other', async () => {
    failingFirstRead()
    seatTwoAccounts()
    await store.loadUsage()
    answers['usage/refresh'] = [report('dev@example.com', 40)]
    await store.refreshUsage(runtimeId('codex'))
    expect(store.getSnapshot().usageAsked).toEqual([runtimeId('codex')])
  })

  it('counts every agent the window knew as asked once a full read answers, silent ones included', async () => {
    seatTwoAccounts()
    answers['usage/reports'] = [report('work', 40)]
    await store.loadUsage()
    expect(store.getSnapshot().usageAsked).toEqual([runtimeId('codex'), runtimeId('codex-2')])
  })

  it('asks an agent added after the first read, and counts it asked only once its own read is back', async () => {
    answers['usage/reports'] = []
    await store.loadUsage()
    let answer: (reports: readonly UsageReport[]) => void = () => undefined
    vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
      if (method === 'app/state/get') return {}
      if (method === 'usage/reports') return new Promise((resolve) => { answer = resolve })
      return answers[method] ?? null
    }) as never)
    push({ method: 'runtime/added', params: { info: { id: runtimeId('cursor'), name: 'cursor', presentation: { name: 'Cursor' } } } } as unknown as WireNotification)
    // Added, and asked about, but nothing has come back: not yet an agent that does not report.
    expect(store.getSnapshot().usageAsked).not.toContain(runtimeId('cursor'))
    expect(store.transport.request).toHaveBeenCalledWith('usage/reports', {})
    answer([])
    await vi.waitFor(() => expect(store.getSnapshot().usageAsked).toContain(runtimeId('cursor')))
  })
})

describe('a notice the first read of a window no longer bears out (#2111 review round 4)', () => {
  it('leaves the Inbox when the reading usage/reports brings puts the window back under the line', async () => {
    answers['usage/refresh'] = [report('dev@example.com', 70)]
    await store.refreshUsage()
    answers['usage/refresh'] = [report('dev@example.com', 85)]
    await store.refreshUsage()
    expect(store.getSnapshot().inbox.map((notice) => notice.kind)).toEqual(['usage:crossing'])

    answers['usage/reports'] = [{ ...report('dev@example.com', 40), fetchedAt: Date.now() + 1_000 }]
    await store.loadUsage()
    expect(store.getSnapshot().inbox).toEqual([])
  })
})

describe('accepted usage keeps timestamped legacy limits synchronized', () => {
  const oldLimits = (): RateLimits => ({
    account: 'work', fetchedAt: Date.now() - 180_000, staleAfterMs: 120_000,
    planType: 'old', planLabel: 'Previous plan',
    windows: [{ label: 'Weekly', usedPercent: 10, windowMinutes: 10_080, resetsAt: RESETS }],
    billing: { kinds: ['windows'] },
  })
  const select = async (limits = oldLimits()): Promise<void> => {
    answers['runtime/limits'] = limits
    answers['runtime/models'] = []
    answers['runtime/options'] = []
    answers['routes/list'] = []
    await store.selectRuntime(runtimeId('codex'))
  }
  const current = (): UsageReport => ({
    ...report('work', 65), plan: 'pro', planLabel: 'Pro plan',
    lanes: [{ ...report('work', 65).lanes[0]!, scope: 'fast', severity: 'warning' }],
    credits: { remaining: 42, unit: 'credits', unlimited: true },
    billing: { kinds: ['windows', 'balance'] }, reached: 'weekly',
  })
  const expectProjected = (reading: UsageReport): void => {
    expect(store.getSnapshot().limits).toMatchObject({
      account: reading.account, fetchedAt: reading.fetchedAt, staleAfterMs: reading.staleAfterMs,
      planType: reading.plan, planLabel: reading.planLabel, lanes: reading.lanes,
      windows: [{ label: 'Weekly · fast', usedPercent: 65, windowMinutes: 10_080, resetsAt: RESETS }],
      reached: reading.reached, source: reading.source, credits: reading.credits,
      hasCredits: true, balance: 42, unlimited: true, billing: reading.billing,
    })
    expect(describeLimits(store.getSnapshot().limits)?.usage?.remainingPercent).toBe(35)
  }

  for (const method of ['usage/reports', 'usage/refresh'] as const) {
    it(`projects a current same-account ${method} reading over expired limits`, async () => {
      await select()
      expect(describeLimits(store.getSnapshot().limits)).toBeNull()
      const reading = current()
      answers[method] = [reading]
      vi.mocked(store.transport.request).mockClear()
      if (method === 'usage/reports') await store.loadUsage()
      else await store.refreshUsage(runtimeId('codex'))
      expectProjected(reading)
      expect(store.transport.request).toHaveBeenCalledTimes(1)
    })

    it(`uses the reconciled push instead of a late ${method} batch`, async () => {
      await select()
      const reading = current()
      let reply!: (reports: UsageReport[]) => void
      vi.mocked(store.transport.request).mockImplementationOnce(() => new Promise(resolve => { reply = resolve }) as never)
      const pending = method === 'usage/reports' ? store.loadUsage() : store.refreshUsage()
      push({ method: 'usage/updated', params: { report: reading } })
      reply([{ ...reading, fetchedAt: reading.fetchedAt - 10_000, lanes: report('work', 10).lanes }])
      await pending
      expectProjected(reading)
    })
  }

  it('projects a pushed reading without another transport call and preserves extra metadata', async () => {
    await select({ ...oldLimits(), billing: { kinds: ['windows'], budget: { amount: 20, currency: 'USD', period: 'month' } } })
    const { billing: _billing, planLabel: _label, ...reading } = current()
    vi.mocked(store.transport.request).mockClear()
    push({ method: 'usage/updated', params: { report: reading } })
    expect(store.getSnapshot().limits).toMatchObject({ fetchedAt: reading.fetchedAt, lanes: reading.lanes,
      billing: { budget: { amount: 20, currency: 'USD', period: 'month' } } })
    expect(store.transport.request).not.toHaveBeenCalled()
  })

  for (const [name, limits, reading] of [
    ['another account', oldLimits(), { ...current(), account: 'personal' }],
    ['another runtime', oldLimits(), { ...current(), runtime: runtimeId('other') }],
    ['legacy undated adapter', { ...oldLimits(), fetchedAt: undefined }, current()],
    ['unidentified adapter', { ...oldLimits(), account: undefined }, current()],
    ['explicit unavailable plan', { ...oldLimits(), planLimitsUnavailable: true }, current()],
  ] as const) {
    it(`does not borrow from ${name}`, async () => {
      await select(limits)
      const before = store.getSnapshot().limits
      push({ method: 'usage/updated', params: { report: reading } })
      expect(store.getSnapshot().limits).toBe(before)
    })
  }

  it('never promotes the figures in an unverified sign-in', async () => {
    await select()
    const reading = { ...current(), lanes: [], credits: null, reached: null,
      unverified: { whose: 'Other sign-in', lanes: current().lanes, reached: 'weekly', fetchedAt: Date.now(), staleAfterMs: 60_000 } }
    push({ method: 'usage/updated', params: { report: reading } })
    expect(store.getSnapshot().limits?.windows).toEqual([])
    expect(store.getSnapshot().limits?.lanes).toEqual([])
    expect(describeLimits(store.getSnapshot().limits)?.usage).toBeNull()
  })

  for (const [name, patch] of [
    ['failed', { error: { message: 'Source unavailable' } }],
    ['unknown clock', { fetchedAt: 0 }],
    ['invalid clock', { fetchedAt: Number.NaN }],
  ] as const) {
    it(`hides quota for an accepted ${name} reading`, async () => {
      await select({ ...oldLimits(), fetchedAt: Date.now() - 1_000 })
      push({ method: 'usage/updated', params: { report: { ...current(), ...patch } } })
      expect(store.getSnapshot().limits?.fetchedAt).toBe(0)
      expect(describeLimits(store.getSnapshot().limits)).toBeNull()
    })
  }

  it('does not let a slow older runtime limits reply replace a newer usage reading', async () => {
    await select()
    const reading = current()
    let reply!: (limits: RateLimits) => void
    const request = vi.mocked(store.transport.request)
    const normal = request.getMockImplementation()!
    request.mockImplementation(((method: HostMethodName, params: never) => method === 'runtime/limits'
      ? new Promise(resolve => { reply = resolve }) : normal(method, params)) as never)
    const pending = store.refreshRuntime()
    push({ method: 'usage/updated', params: { report: reading } })
    reply(oldLimits())
    await pending
    expectProjected(reading)
  })

  it('does not let an older report replace a newer runtime source clock', async () => {
    const limits = { ...oldLimits(), fetchedAt: Date.now() }
    await select(limits)
    push({ method: 'usage/updated', params: { report: { ...current(), fetchedAt: limits.fetchedAt - 1_000 } } })
    expect(store.getSnapshot().limits).toBe(limits)
  })

  it('allows a newer runtime observation to recover an older failed report', async () => {
    const limits = { ...oldLimits(), fetchedAt: Date.now() }
    await select(limits)
    push({ method: 'usage/updated', params: { report: { ...current(), fetchedAt: limits.fetchedAt - 1_000,
      error: { message: 'Earlier refresh failed' } } } })
    expect(store.getSnapshot().limits).toBe(limits)
  })

  it('does not apply a cached report to a new effective account in runtime limits', async () => {
    await select()
    push({ method: 'usage/updated', params: { report: current() } })
    const limits = { ...oldLimits(), account: 'personal' }
    answers['runtime/limits'] = limits
    await store.refreshRuntime()
    expect(store.getSnapshot().limits).toBe(limits)
  })
})
