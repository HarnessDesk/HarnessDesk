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

const reportWith = (
  lanes: readonly UsageLane[],
  reached: string | null,
  failure: string | null = null,
): UsageReport => ({
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
  unverified: {
    whose: 'agy CLI sign-in',
    lanes,
    reached,
    fetchedAt: NOW,
    staleAfterMs: 5 * 60_000,
    ...(failure ? { error: { message: failure } } : {}),
  },
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

const render = async (report: UsageReport, scope: RuntimeInfo['id'] | null = null): Promise<void> => {
  await act(async () =>
    root.render(
      <StoreProvider store={storeWith(report)}>
        {/* Plans draws every account's card unconditionally, the way this
            whole page used to; Overview limits its cards to what needs
            attention first, which is a different (and separately tested)
            question from what these cases are about. */}
        <Usage view="plans" onClose={() => {}} onSignIn={() => {}} scope={scope} />
      </StoreProvider>,
    ),
  )
}

/** The Plans table's own row now collapses every account by default — expand it to reach the shape body (`Card`, reused for the windows shape) underneath. Idempotent: a re-render onto the same root keeps React's `expanded` state, so a row already open is left alone rather than toggled shut. */
const expandRow = async (name: string): Promise<void> => {
  const row = [...document.querySelectorAll<HTMLElement>('button[aria-expanded]')].find((node) =>
    node.textContent?.includes(name),
  )
  expect(row).toBeDefined()
  if (row?.getAttribute('aria-expanded') === 'true') return
  await act(async () => row?.click())
}

const card = async (report: UsageReport): Promise<string> => {
  await render(report)
  await expandRow('Antigravity')
  const article = [...document.querySelectorAll('article[data-slot="card"]')].find((node) =>
    node.textContent?.includes('Antigravity'),
  )
  expect(article).toBeDefined()
  return article?.textContent ?? ''
}

/** The header's account scope menu: its row for the agent, opened. */
const scopeMenuRow = async (report: UsageReport): Promise<string> => {
  await render(report)
  const trigger = document.querySelector<HTMLButtonElement>('[title="Scope the dashboard to one account"]')!
  await act(async () => trigger.click())
  const row = [...document.querySelectorAll('[role="menuitemradio"]')].find((node) =>
    node.textContent?.includes('Antigravity'),
  )
  expect(row).toBeDefined()
  return row?.textContent ?? ''
}

describe("another sign-in's figures", () => {
  it('carries spent readings and model warnings into the text tone', async () => {
    await render(reportWith([group('gemini-weekly', 'Gemini Models', 100)], 'gemini-weekly'))
    await expandRow('Antigravity')
    let article = [...document.querySelectorAll<HTMLElement>('article[data-slot="card"]')].find((node) =>
      node.textContent?.includes('Antigravity'),
    )
    const headline = [...(article?.querySelectorAll<HTMLElement>('[data-slot="text"]') ?? [])].find(
      (node) => node.dataset['role'] === 'figure' && node.textContent === '0%',
    )

    expect(headline?.dataset['tone']).toBe('danger')

    await render(
      reportWith(
        [group('gemini-weekly', 'Gemini Models', 100), group('3p-weekly', 'Claude and GPT models', 0)],
        'gemini-weekly',
      ),
    )
    await expandRow('Antigravity')
    article = [...document.querySelectorAll<HTMLElement>('article[data-slot="card"]')].find((node) =>
      node.textContent?.includes('Antigravity'),
    )
    const warning = [...(article?.querySelectorAll<HTMLElement>('[data-slot="text"]') ?? [])].find((node) =>
      node.textContent?.includes('Gemini Models is spent — other models still work'),
    )

    expect(warning?.dataset['tone']).toBe('warning')
  })

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

  it('stay off the header’s account menu, which names the agent only (#769, review round 2)', async () => {
    // The header's scope menu says "Antigravity" and nothing else about whose
    // figures they are, so a red 0% there would be another sign-in's quota
    // under the agent's name — it never reads a figure at all.
    const row = await scopeMenuRow(
      reportWith([group('gemini-weekly', 'Gemini Models', 100), group('3p-weekly', 'Claude and GPT models', 100)], 'gemini-weekly'),
    )
    expect(row).not.toContain('%')
  })

  // The card's heading says whose they are; the page's own sentence said
  // "Antigravity's own numbers" one line above it, in both views (#769,
  // review round 1 of the landing).
  const figures = [group('gemini-weekly', 'Gemini Models', 100), group('3p-weekly', 'Claude and GPT models', 0)]

  it("are never called the agent's own by the page scoped to it", async () => {
    await render(reportWith(figures, 'gemini-weekly'), antigravity.id)
    const text = document.body.textContent ?? ''
    expect(text).not.toContain("read from Antigravity's own numbers")
    expect(text).toContain("Its plan figures are the agy CLI sign-in's, which may not be the account Antigravity runs as.")
  })

  it('are named by the page across every agent too', async () => {
    await render(reportWith(figures, 'gemini-weekly'))
    expect(document.body.textContent ?? '').toContain('A card headed by another sign-in shows that sign-in’s.')
  })

  it('keep the chip on the agent when only their source fails (#769, review round 2)', async () => {
    const text = await card(
      reportWith(
        [group('gemini-weekly', 'Gemini Models', 100), group('3p-weekly', 'Claude and GPT models', 0)],
        'gemini-weekly',
        'agy /usage failed: HTTP 503',
      ),
    )
    expect(text).toContain('Ready')
    expect(text).not.toContain('Unavailable')
    // The failure is said, on the card it belongs to, with the last good figures.
    expect(text).toContain('agy /usage failed: HTTP 503')
    expect(text).toContain('100%')
  })
})
