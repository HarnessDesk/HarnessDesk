import { runtimeId, type UsageReport } from '@harnessdesk/protocol'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { describeReport } from '../lib/usage'
import { balanceOf, noteGlyph, noteOf } from './Usage'

/**
 * A usage card's one line of prose, and the glyph beside it.
 *
 * `pace()` already returns `tone: 'good'` for a window that lasts to its
 * reset, and `noteOf` already passes it through. The card drew the glyph off
 * `tone === undefined` instead of off the tone, so every card carrying good
 * news carried a warning triangle with it — three of them at once, under a
 * heading that read "Nothing is close to a limit". A ⚠ that also means "you
 * are fine" is not a signal.
 */
describe('noteGlyph', () => {
  const svg = (tone: Parameters<typeof noteGlyph>[0]): string =>
    renderToStaticMarkup(<>{noteGlyph(tone)}</>)

  it('does not warn about good news', () => {
    const good = svg('good')
    expect(good).not.toBe(svg('warn'))
    expect(good).not.toBe(svg('bad'))
  })

  it('warns about what is actually wrong', () => {
    expect(svg('bad')).toBe(svg('warn'))
    expect(svg('warn')).not.toBe(svg(undefined))
  })
})

describe('noteOf, for an account that cannot run', () => {
  const NOON = Date.parse('2026-09-18T12:00:00Z')
  const report = (over: Partial<UsageReport>): UsageReport => ({
    runtime: runtimeId('a'),
    account: null,
    plan: null,
    lanes: [],
    credits: null,
    spend: null,
    reached: null,
    source: { kind: 'api', label: 'from its account' },
    fetchedAt: NOON,
    staleAfterMs: 60_000,
    error: null,
    ...over,
  })
  const note = (subject: UsageReport) =>
    noteOf(subject, describeReport(subject, { now: NOON }), balanceOf(subject.credits), false)

  it('says a spent balance waits for a top-up, not for a reset', () => {
    // Cline at −$0.016 read "new turns will fail until it resets"; a prepaid
    // balance does not come back on its own.
    const overdrawn = report({ credits: { remaining: -0.016, unit: 'USD' }, reached: 'credits' })
    expect(note(overdrawn)).toEqual({
      text: 'The balance is spent — new turns will fail until it is topped up',
      tone: 'bad',
    })
  })

  it('keeps the reset sentence for a spent window', () => {
    const spent = report({
      lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 100, windowMinutes: 10_080, resetsAt: NOON + 60_000 }],
      reached: 'weekly',
    })
    expect(note(spent)?.text).toBe('Reached — new turns will fail until it resets')
  })
})
