import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, type HostMethodName, type UsageReport, type WireNotification } from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * Where a crossing becomes a toast: the store compares two refreshes and says
 * what it saw. `notice()` dedupes on the sentence, so two accounts of one agent
 * that cross one line only reach the person twice if the sentence names each
 * account (#179).
 */

// One reset for every reading: a lane whose reset moved is a new window, not the same one read again.
const RESETS = Date.now() + 2 * 86_400_000

const report = (account: string | null, usedPercent: number): UsageReport =>
  ({
    runtime: runtimeId('codex'),
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

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  answers = {}
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => answers[method] ?? null) as never)
})

describe('usage alerts from a refresh', () => {
  it('toasts each account of one agent that crosses a line, by its own name', async () => {
    answers['usage/refresh'] = [report('work', 70), report('personal', 70)]
    await store.refreshUsage()
    expect(store.getSnapshot().notices).toEqual([])

    answers['usage/refresh'] = [report('work', 85), report('personal', 85)]
    await store.refreshUsage()
    const said = store.getSnapshot().notices.map((notice) => notice.message)
    expect(said).toHaveLength(2)
    expect(said[0]).toMatch(/^codex \(work\) — .* is 80% used/)
    expect(said[1]).toMatch(/^codex \(personal\) — .* is 80% used/)
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

  it('names no account when the agent has one', async () => {
    answers['usage/refresh'] = [report('olivia@acme.dev', 70)]
    await store.refreshUsage()
    answers['usage/refresh'] = [report('olivia@acme.dev', 85)]
    await store.refreshUsage()
    expect(store.getSnapshot().notices.map((notice) => notice.message)).toEqual([expect.stringMatching(/^codex — .* is 80% used/)])
  })
})

/** A notification, as the host pushes it. Never connected; nothing reaches a wire. */
const push = (notification: WireNotification): void => {
  const transport = store.transport as unknown as { handlers: { onNotification(notification: WireNotification): void } }
  transport.handlers.onNotification(notification)
}

describe('usage alerts as the host pushes them, one account at a time', () => {
  // Review of #216: the path the running app takes, where #179's two identical toasts came from.
  it('toasts each account that crosses a line, by its own name', () => {
    for (const account of ['work', 'personal']) push({ method: 'usage/updated', params: { report: report(account, 70) } })
    expect(store.getSnapshot().notices).toEqual([])
    for (const account of ['work', 'personal']) push({ method: 'usage/updated', params: { report: report(account, 85) } })
    const said = store.getSnapshot().notices.map((notice) => notice.message)
    expect(said).toHaveLength(2)
    expect(said[0]).toMatch(/^codex \(work\) — .* is 80% used/)
    expect(said[1]).toMatch(/^codex \(personal\) — .* is 80% used/)
  })

  it('keeps one reading of an account whose none arrives spelled two ways', () => {
    push({ method: 'usage/updated', params: { report: report(null, 70) } })
    push({ method: 'usage/updated', params: { report: report('  ', 85) } })
    expect(store.getSnapshot().usage).toHaveLength(1)
  })
})
