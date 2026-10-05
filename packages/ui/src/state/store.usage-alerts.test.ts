import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, type HostMethodName, type UsageReport, type WireNotification } from '@harnessdesk/protocol'

import { AppStore } from './store'

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
