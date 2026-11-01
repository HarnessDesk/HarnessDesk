import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, type HostMethodName, type UsageReport, type WireNotification } from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * The pool's one automatic move: when the account new sessions run as is out
 * and its agent says "Use the next account", new sessions move — once, said
 * once — and only to an account that could take a turn.
 */

const report = (usedPercent: number, runtime: string): UsageReport =>
  ({
    runtime: runtimeId(runtime),
    account: null,
    plan: null,
    lanes: [{ id: 'weekly', label: 'Weekly', usedPercent, windowMinutes: 10_080, resetsAt: Date.now() + 86_400_000 }],
    credits: null,
    spend: null,
    reached: usedPercent >= 100 ? 'weekly' : null,
    source: { kind: 'api', label: 'from a test' },
    fetchedAt: Date.now(),
    staleAfterMs: 60_000,
    error: null,
  }) as UsageReport

let store: AppStore
let preferences: Record<string, unknown>

const push = (notification: WireNotification): void => {
  const transport = store.transport as unknown as { handlers: { onNotification(notification: WireNotification): void } }
  transport.handlers.onNotification(notification)
}

beforeEach(async () => {
  store = new AppStore('ws://localhost:0/')
  preferences = {}
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: { runtime?: string }) => {
    if (method === 'app/state/get') return preferences
    if (method === 'runtime/account') {
      const label = params.runtime === 'codex' ? 'work' : 'personal'
      return { accounts: [{ kind: 'chatgpt', label, email: null }], signInMethods: [] }
    }
    return null
  }) as never)
  for (const id of ['codex', 'codex-2']) {
    push({
      method: 'runtime/added',
      params: { info: { id: runtimeId(id), name: 'Agent', slot: { agent: runtimeId('codex') }, presentation: { name: 'Agent' }, capabilities: {} } },
    } as unknown as WireNotification)
  }
  await store.loadAccounts()
})

describe('the account pool', () => {
  it('moves new sessions to the next account when told to, and says so', async () => {
    preferences = { activeRuntime: 'codex', accountPools: { codex: { whenOut: 'next' } } }
    await store.loadPreferences()
    expect(store.getSnapshot().activeRuntime).toBe('codex')
    push({ method: 'usage/updated', params: { report: report(30, 'codex-2') } })
    push({ method: 'usage/updated', params: { report: report(100, 'codex') } })
    await vi.waitFor(() => expect(store.getSnapshot().activeRuntime).toBe('codex-2'))
    expect(store.getSnapshot().inbox.map((notice) => notice.title)).toContain('work reached its limit. New sessions use personal.')
  })

  it('stays put when the rule is to ask', async () => {
    preferences = { activeRuntime: 'codex', accountPools: { codex: { whenOut: 'ask' } } }
    await store.loadPreferences()
    push({ method: 'usage/updated', params: { report: report(30, 'codex-2') } })
    push({ method: 'usage/updated', params: { report: report(100, 'codex') } })
    expect(store.getSnapshot().activeRuntime).toBe('codex')
  })

  it('stays put when every account is out', async () => {
    preferences = { activeRuntime: 'codex', accountPools: { codex: { whenOut: 'next' } } }
    await store.loadPreferences()
    push({ method: 'usage/updated', params: { report: report(100, 'codex-2') } })
    push({ method: 'usage/updated', params: { report: report(100, 'codex') } })
    expect(store.getSnapshot().activeRuntime).toBe('codex')
  })

  it('moves to a gateway, which has a key rather than a vendor account', async () => {
    push({
      method: 'runtime/added',
      params: { info: { id: runtimeId('codex-gw'), name: 'Agent', slot: { agent: runtimeId('codex'), gateway: { name: 'Team gateway', endpoint: 'https://gateway.acme.dev' } }, presentation: { name: 'Agent' }, capabilities: {} } },
    } as unknown as WireNotification)
    preferences = { activeRuntime: 'codex', accountPools: { codex: { order: ['codex', 'codex-gw', 'codex-2'], whenOut: 'next' } } }
    await store.loadPreferences()
    push({ method: 'usage/updated', params: { report: report(100, 'codex') } })
    await vi.waitFor(() => expect(store.getSnapshot().activeRuntime).toBe('codex-gw'))
  })

  it('moves when a spent reading is already cached at connect', async () => {
    preferences = { activeRuntime: 'codex', accountPools: { codex: { whenOut: 'next' } } }
    await store.loadPreferences()
    vi.mocked(store.transport.request).mockImplementation((async (method: HostMethodName) => {
      if (method === 'usage/reports') return [report(100, 'codex'), report(30, 'codex-2')]
      return null
    }) as never)
    await store.loadUsage()
    expect(store.getSnapshot().activeRuntime).toBe('codex-2')
  })

  it('moves once a sibling that could not take a turn comes back', async () => {
    preferences = { activeRuntime: 'codex', accountPools: { codex: { whenOut: 'next' } } }
    await store.loadPreferences()
    const health = (state: string) => ({ method: 'runtime/healthChanged', params: { runtime: runtimeId('codex-2'), health: { state } } }) as unknown as WireNotification
    push(health('unavailable'))
    push({ method: 'usage/updated', params: { report: report(100, 'codex') } })
    expect(store.getSnapshot().activeRuntime).toBe('codex')
    push(health('ready'))
    await vi.waitFor(() => expect(store.getSnapshot().activeRuntime).toBe('codex-2'))
  })

  it('remembers a new order', async () => {
    store.setAccountPool(runtimeId('codex'), { order: [runtimeId('codex-2'), runtimeId('codex')] })
    expect(store.getSnapshot().accountPools['codex']).toEqual({ order: ['codex-2', 'codex'] })
    expect(store.transport.request).toHaveBeenCalledWith('app/state/set', { patch: { accountPools: { codex: { order: ['codex-2', 'codex'] } } } })
  })
})
