import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { runtimeId, type UsageLane, type UsageReport } from '@harnessdesk/protocol'

import { Card } from './shared'

/**
 * A pin picks which window a card leads with; it never changes the account's
 * standing, which the host decides for the phone without ever seeing the pin.
 * The window that decides — the first to run dry, or the lowest — is named
 * when it is not the headline, rather than pinning its "runs out" on it.
 */

const NOW = new Date('2026-08-22T12:00:00').getTime()
const HOUR = 3_600_000

const lane = (over: Partial<UsageLane> & Pick<UsageLane, 'id' | 'usedPercent'>): UsageLane => ({
  label: over.label ?? over.id,
  windowMinutes: 300,
  resetsAt: NOW + 4 * HOUR,
  ...over,
})

const report = (lanes: readonly UsageLane[]): UsageReport => ({
  runtime: runtimeId('claude'),
  account: 'jane.doe@acme.dev',
  plan: 'Max 20x',
  lanes,
  credits: null,
  spend: null,
  reached: null,
  source: { kind: 'runtime', label: 'from its own API' },
  fetchedAt: NOW,
  staleAfterMs: 5 * 60_000,
  error: null,
})

const textOf = (subject: UsageReport, pinLaneId: string): string => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(
    <Card report={subject} info={null} preference={{ pinLaneId }} now={NOW} onRefresh={() => {}} onStopTracking={() => {}} />,
  )
  return host.textContent ?? ''
}

describe('Card with a pinned lane', () => {
  it('says Short when the binding Session runs out, and names it under a pinned Weekly', () => {
    const text = textOf(
      report([
        lane({ id: 'session', label: 'Session', usedPercent: 60 }),
        lane({ id: 'weekly', label: 'Weekly', usedPercent: 10, windowMinutes: 10_080, resetsAt: NOW + 24 * HOUR }),
      ]),
      'weekly',
    )
    expect(text).toContain('Short')
    expect(text).toMatch(/Session runs out ~/)
    expect(text).not.toMatch(/Weekly · Runs out/)
  })

  it('says Short for a fast-burning Weekly behind a healthy Session, whichever is pinned', () => {
    const lanes = [
      lane({ id: 'session', label: 'Session', usedPercent: 10 }),
      lane({ id: 'weekly', label: 'Weekly', usedPercent: 90, windowMinutes: 10_080, resetsAt: NOW + 24 * HOUR }),
    ]
    // Pinned, the Weekly is the headline and its own sentence says the time.
    const pinned = textOf(report(lanes), 'weekly')
    expect(pinned).toContain('Short')
    expect(pinned).toMatch(/Runs out ~/)
    // Not pinned, the Session leads and the sentence names the Weekly.
    const unpinned = textOf(report(lanes), 'session')
    expect(unpinned).toContain('Short')
    expect(unpinned).toMatch(/Weekly runs out ~/)
  })
})
