import { describe, expect, it } from 'vitest'

import { cardEvidence, checkView, ciView, diffView, factView, prView } from '../preview/evidence-fixture'
import { byWords, cardChips, chipOf, ciVerdict, spokenChip, standingWords } from './evidence'

const RUN = { name: 'verify', state: 'passed' as const, url: null }

describe('a fact, as its chip', () => {
  it('says what was observed, at which commit, and names its outcome in the system’s states', () => {
    expect(chipOf(checkView())).toEqual({ key: 'check:verify', label: 'verify ✓ @a1b2c3d', outcome: 'passed', stale: false, unknown: false })
    expect([chipOf(checkView({ exit: 1 })).label, chipOf(checkView({ exit: 1 })).outcome]).toEqual(['verify ✗ @a1b2c3d', 'failed'])
    expect([chipOf(checkView({ exit: null, timedOut: true })).label, chipOf(checkView({ exit: null, timedOut: true })).outcome]).toEqual(['verify timed out @a1b2c3d', 'timed out'])
    expect([chipOf(checkView({ exit: null })).label, chipOf(checkView({ exit: null })).outcome]).toEqual(['verify did not start @a1b2c3d', null])
    expect([chipOf(ciView(['passed', 'skipped'])).label, chipOf(ciView(['passed', 'skipped'])).outcome]).toEqual(['CI ✓', 'passed'])
    expect([chipOf(ciView(['passed', 'failed'])).label, chipOf(ciView(['passed', 'failed'])).outcome]).toEqual(['CI ✗', 'failed'])
    expect([chipOf(ciView(['passed', 'pending'])).label, chipOf(ciView(['passed', 'pending'])).outcome]).toEqual(['CI running', 'running'])
    expect([chipOf(ciView(['passed', 'cancelled'])).label, chipOf(ciView(['passed', 'cancelled'])).outcome]).toEqual(['CI cancelled', null])
    expect(['open', 'merged', 'closed'].map((state) => chipOf(prView(state as 'open')).outcome)).toEqual(['open', 'merged', 'closed'])
    expect([chipOf(diffView()).label, chipOf(diffView()).outcome]).toEqual(['+120 −30 in 6 files', null])
  })

  it('a stale fact says how far behind it is, and is marked stale for the chip to strike through', () => {
    const behind = chipOf(checkView({ freshness: { state: 'behind', commits: 2 } }))
    expect(behind).toEqual({ key: 'check:verify', label: 'verify ✓ @a1b2c3d — 2 commits since', outcome: 'passed', stale: true, unknown: false })
    expect(chipOf(checkView({ freshness: { state: 'moved' } })).label).toBe('verify ✓ @a1b2c3d — rewritten since')
    expect(spokenChip(behind)).toBe('verify ✓ @a1b2c3d — 2 commits since (stale)')
  })

  it('an unknown fact is not stale and not a verdict: it is marked unknown, and the dialog says why', () => {
    const view = checkView({ freshness: { state: 'unknown', why: 'it came from a backup, and this desk has not observed it' } })
    expect(chipOf(view)).toEqual({ key: 'check:verify', label: 'verify ✓ @a1b2c3d', outcome: 'passed', stale: false, unknown: true })
    expect(spokenChip(chipOf(view))).toBe('verify ✓ @a1b2c3d (unknown)')
    expect(standingWords(view.freshness)).toBe('Unknown: it came from a backup, and this desk has not observed it.')
  })

  it('a merged pull request whose branch is gone is final: current, and said so', () => {
    const final = prView('merged', { freshness: { state: 'final' } })
    expect(chipOf(final)).toEqual({ key: 'pr', label: 'PR #12 merged', outcome: 'merged', stale: false, unknown: false })
    expect(standingWords(final.freshness)).toBe('Final: the pull request was merged and its branch is gone, so nothing can land on it now.')
  })
})

describe('what CI says together', () => {
  it('a failure first; then a cancelled check, which is never a pass; then one still running', () => {
    const runs = (...states: ('passed' | 'failed' | 'pending' | 'skipped' | 'cancelled')[]) =>
      states.map((state) => ({ ...RUN, state }))
    expect(ciVerdict(runs('cancelled'))).toBe('cancelled')
    expect(ciVerdict(runs('passed', 'cancelled'))).toBe('cancelled')
    expect(ciVerdict(runs('cancelled', 'pending'))).toBe('cancelled')
    expect(ciVerdict(runs('failed', 'cancelled'))).toBe('failed')
    expect(ciVerdict(runs('passed', 'pending'))).toBe('running')
    expect(ciVerdict(runs('passed', 'skipped'))).toBe('passed')
    expect(ciVerdict(runs('skipped'))).toBe('skipped')
  })
})

describe("a card's chips", () => {
  it('a check running now stands in for that check’s last fact, and the rest keep their order', () => {
    const chips = cardChips(cardEvidence(3, [checkView({ exit: 1 }), prView('open')], [{ name: 'verify', since: 1 }]))
    expect(chips.map((one) => one.label)).toEqual(['verify running', 'PR #12 open'])
  })

  it('a card the desk observed nothing about has none', () => {
    expect(cardChips(undefined)).toEqual([])
    expect(cardChips(cardEvidence(1, []))).toEqual([])
  })
})

it('says who produced a fact, or that the desk did', () => {
  expect(byWords(checkView())).toBe('Scout on Alpha · alpha-max')
  expect(byWords(factView({ kind: 'diff', files: 1, added: 1, removed: 0, from: 'a'.repeat(40), to: 'b'.repeat(40) }, { by: null }))).toBe('The desk')
  expect(byWords(factView({ kind: 'diff', files: 1, added: 1, removed: 0, from: 'a'.repeat(40), to: 'b'.repeat(40) }, { by: { agent: null, seat: 'Beta · beta-pro' } }))).toBe('Beta · beta-pro')
})
