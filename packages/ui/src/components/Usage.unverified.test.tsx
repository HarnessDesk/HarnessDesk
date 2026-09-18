import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeInfo, UsageLane, UsageReport } from '@harnessdesk/protocol'
import { NO_CAPABILITIES } from '@harnessdesk/protocol'

import { readinessOf } from '../lib/readiness'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Usage } from './Usage'

/**
 * Another sign-in's figures on the Dashboard card (#769, review P1).
 *
 * Antigravity's quota is read through the `agy` CLI, which signs in apart from
 * the ACP server the desk runs, so it may be another Google account's. The
 * host files those figures under `report.unverified`, not `report.lanes`. The
 * card draws them under their own name; the chip, and every readiness surface,
 * read the report itself and so cannot put "Limit reached" on an agent that
 * may be running as somebody else — nor "Use this agent" out of Setup Desk.
 */

const NOW = Date.parse('2026-09-18T06:00:00Z')
const DAY = 86_400_000

const antigravity = {
  id: 'antigravity-acp',
  name: 'Antigravity',
  capabilities: { ...NO_CAPABILITIES },
  presentation: { name: 'Antigravity' },
} as unknown as RuntimeInfo

const group = (id: string, scope: string, usedPercent: number): UsageLane => ({
  id,
  label: 'Weekly',
  scope,
  usedPercent,
  windowMinutes: 7 * 24 * 60,
  resetsAt: usedPercent >= 100 ? NOW + 6 * DAY : null,
  usageKnown: true,
})

const reportWith = (lanes: readonly UsageLane[], reached: string | null): UsageReport => ({
  runtime: antigravity.id,
  account: 'Google account',
  plan: null,
  lanes: [],
  credits: null,
  spend: null,
  reached: null,
  source: { kind: 'api', label: 'from the agy CLI' },
  fetchedAt: NOW,
  staleAfterMs: 5 * 60_000,
  error: null,
  unverified: { whose: 'agy CLI sign-in', lanes, reached, fetchedAt: NOW, staleAfterMs: 5 * 60_000 },
})

const storeWith = (report: UsageReport): AppStore => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: antigravity.id,
    runtimes: [antigravity],
    usage: [report],
  } as AppSnapshot
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request: vi.fn(async () => null) },
    loadAccounts: vi.fn(async () => {}),
    loadUsage: vi.fn(async () => {}),
    refreshUsage: vi.fn(async () => {}),
    ledger: vi.fn(async () => null),
  } as unknown as AppStore
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const card = async (report: UsageReport): Promise<string> => {
  await act(async () =>
    root.render(
      <StoreProvider store={storeWith(report)}>
        <Usage onClose={() => {}} onSignIn={() => {}} runtime={null} />
      </StoreProvider>,
    ),
  )
  const article = [...document.querySelectorAll('article')].find((node) =>
    node.textContent?.includes('Antigravity'),
  )
  expect(article).toBeDefined()
  return article?.textContent ?? ''
}

describe("another sign-in's figures", () => {
  it('are drawn under that sign-in, with the agent’s own chip', async () => {
    const text = await card(
      reportWith([group('gemini-weekly', 'Gemini Models', 100), group('3p-weekly', 'Claude and GPT models', 0)], 'gemini-weekly'),
    )
    expect(text).toContain('agy CLI sign-in')
    expect(text).not.toContain('Google account')
    expect(text).toContain('100%')
    expect(text).toContain('0%')
    expect(text).toContain('Ready')
    expect(text).toContain('from the agy CLI')
  })

  it('never say the agent is out, even when every one is spent', async () => {
    const spent = reportWith(
      [group('gemini-weekly', 'Gemini Models', 100), group('3p-weekly', 'Claude and GPT models', 100)],
      'gemini-weekly',
    )
    const text = await card(spent)
    expect(text).not.toContain('Limit reached')
    expect(text).not.toContain('new turns will fail')
    expect(text).toContain('Everything is spent on the agy CLI sign-in — Antigravity may be signed in as another account')
    // And Setup Desk, the sidebar and sign-in read the same report.
    expect(
      readinessOf({
        registered: true,
        health: { state: 'ready' },
        account: { accounts: [{ kind: 'agent', label: 'Google account' }], signInMethods: [] } as never,
        usage: [spent],
      }),
    ).toBe('ready')
  })
})
