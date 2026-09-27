import { describe, expect, it } from 'vitest'

import { runtimeId, type UsageLane, type UsageReport } from '@harnessdesk/protocol'

import { previewUsage } from '../../preview/sidebar-fixture'
import { reportNeedsAttention } from './shared'

/**
 * The rail's "N low" count and Overview's "What is left" band read one
 * function, on the report's own lanes: `reportNeedsAttention`. It used to
 * read only the headline lane's tone and a borrowed sign-in's figures, so an
 * account whose headline was fine but whose Weekly lane was not — the fixture
 * below — read as nothing wrong (review of #1057, item 2).
 */

const NOW = new Date('2026-08-22T12:00:00').getTime()

const lane = (over: Partial<UsageLane> & Pick<UsageLane, 'id' | 'usedPercent'>): UsageLane => ({
  label: over.label ?? over.id,
  windowMinutes: 10_080,
  resetsAt: NOW + 51 * 60_000,
  ...over,
})

const report = (over: Partial<UsageReport>): UsageReport => ({
  runtime: runtimeId('claude'),
  account: 'olivia@acme.dev',
  plan: 'Max 20x',
  lanes: [],
  credits: null,
  spend: null,
  reached: null,
  source: { kind: 'runtime', label: 'from its own API' },
  fetchedAt: NOW,
  staleAfterMs: 5 * 60_000,
  error: null,
  ...over,
})

describe('reportNeedsAttention', () => {
  it('is true for the preview fixture whose headline is fine but whose Weekly lane is not', () => {
    const beta = previewUsage.find((entry) => entry.runtime === runtimeId('claude') && entry.account?.includes('harnessdesk.app'))
    expect(beta).toBeDefined()
    expect(reportNeedsAttention(beta!, Date.now())).toBe(true)
  })

  it('is false when only a scoped model lane is spent and every account-wide lane is fine', () => {
    const scopedSpent = report({
      lanes: [
        lane({ id: 'session', label: 'Session', usedPercent: 10 }),
        lane({ id: 'weekly', label: 'Weekly', usedPercent: 20 }),
        lane({ id: 'weekly:fable', label: 'Weekly', usedPercent: 100, scope: 'Fable' }),
      ],
    })
    expect(reportNeedsAttention(scopedSpent, NOW)).toBe(false)
  })

  it('is true when an account-wide lane other than the headline is low', () => {
    const weeklyLow = report({
      lanes: [
        lane({ id: 'session', label: 'Session', usedPercent: 10 }),
        lane({ id: 'weekly', label: 'Weekly', usedPercent: 88 }),
      ],
    })
    expect(reportNeedsAttention(weeklyLow, NOW)).toBe(true)
  })

  it('is true when the report itself carries an error', () => {
    expect(
      reportNeedsAttention(report({ error: { message: 'Could not reach the account' } }), NOW),
    ).toBe(true)
  })
})
