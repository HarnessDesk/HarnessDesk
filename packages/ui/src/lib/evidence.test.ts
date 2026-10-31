import { describe, expect, it } from 'vitest'

import { cardEvidence, checkView, ciView, diffView, factView, prView } from '../preview/evidence-fixture'
import { byWords, cardChips, evidenceSummary, chipOf, chipWords, ciVerdict, spokenChip, standingWords } from './evidence'

const RUN = { name: 'verify', state: 'passed' as const, url: null }

describe('a fact, as its chip', () => {
  it('says what was observed, at which commit, and names its outcome in the system’s states', () => {
    expect(chipOf(checkView())).toEqual({ key: 'check:verify', label: 'verify ✓ @a1b2c3d', since: null, outcome: 'passed', stale: false, unknown: false })
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

  it('a stale fact keeps its label to the fact, and says how far behind it is aloud and in its title', () => {
    const behind = chipOf(checkView({ freshness: { state: 'behind', commits: 2 } }))
    expect(behind).toEqual({ key: 'check:verify', label: 'verify ✓ @a1b2c3d', since: '2 commits since', outcome: 'passed', stale: true, unknown: false })
    expect(chipWords(chipOf(checkView({ freshness: { state: 'moved' } })))).toBe('verify ✓ @a1b2c3d — rewritten since')
    expect(chipWords(behind)).toBe('verify ✓ @a1b2c3d — 2 commits since')
    expect(spokenChip(behind)).toBe('verify ✓ @a1b2c3d — 2 commits since (stale)')
  })

  it('an unknown fact is not stale and not a verdict: it is marked unknown, and the dialog says why', () => {
    const view = checkView({ freshness: { state: 'unknown', why: 'it came from a backup, and this desk has not observed it' } })
    expect(chipOf(view)).toEqual({ key: 'check:verify', label: 'verify ✓ @a1b2c3d', since: null, outcome: 'passed', stale: false, unknown: true })
    expect(spokenChip(chipOf(view))).toBe('verify ✓ @a1b2c3d (unknown)')
    expect(standingWords(view.freshness)).toBe('Unknown: it came from a backup, and this desk has not observed it.')
  })

  it('a merged pull request whose branch is gone is final: current, and said so', () => {
    const final = prView('merged', { freshness: { state: 'final' } })
    expect(chipOf(final)).toEqual({ key: 'pr', label: 'PR #12 merged', since: null, outcome: 'merged', stale: false, unknown: false })
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
  it('keeps one judge’s reviews of two revisions as separately keyed chips', () => {
    const reviews = [
      factView({ kind: 'review', by: 'seat-judge', at: 'a'.repeat(40), verdict: 'picked' }),
      factView({ kind: 'review', by: 'seat-judge', at: 'b'.repeat(40), verdict: 'neither' }),
    ]
    const chips = cardChips(cardEvidence(5, reviews))
    expect(chips.map(one => one.label)).toEqual(['review: picked', 'review: neither'])
    expect(new Set(chips.map(one => one.key)).size).toBe(2)
  })

  it('a check running now stands in for that check’s last fact, and the rest keep their order', () => {
    const chips = cardChips(cardEvidence(3, [checkView({ exit: 1 }), prView('open')], [{ name: 'verify', since: 1 }]))
    expect(chips.map((one) => one.label)).toEqual(['verify running', 'PR #12 open'])
  })

  it('a diff that changed nothing draws no chip beside other facts, while one that changed something does', () => {
    const none = factView({ kind: 'diff', files: 0, added: 0, removed: 0, from: 'a'.repeat(40), to: 'b'.repeat(40) })
    expect(cardChips(cardEvidence(1, [none, prView('open')])).map((one) => one.label)).toEqual(['PR #12 open'])
    expect(cardChips(cardEvidence(1, [diffView()])).map((one) => one.label)).toEqual(['+120 −30 in 6 files'])
  })

  it('a finished card whose only fact is a zero diff keeps one quiet "no changes" chip', () => {
    const none = factView({ kind: 'diff', files: 0, added: 0, removed: 0, from: 'a'.repeat(40), to: 'b'.repeat(40) })
    const chips = cardChips(cardEvidence(1, [none]), true)
    expect(chips.map((one) => [one.label, one.outcome])).toEqual([['no changes', null]])
    expect(cardChips(cardEvidence(1, [none, none]), true).map((one) => one.label)).toEqual(['no changes'])
  })

  it('a card still being worked, whose only fact is a zero diff, draws nothing: nothing is known yet', () => {
    const none = factView({ kind: 'diff', files: 0, added: 0, removed: 0, from: 'a'.repeat(40), to: 'b'.repeat(40) })
    expect(cardChips(cardEvidence(1, [none]))).toEqual([])
    expect(cardChips(cardEvidence(1, [none]), false)).toEqual([])
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


describe('compact evidence summary', () => {
  const review = (verdict: string, freshness: import('@harnessdesk/protocol').Freshness = { state: 'fresh' }) => factView({ kind: 'review', verdict, by: 'seat-judge', at: 'a'.repeat(40) }, { freshness })
  const finding = (state: 'open' | 'repaired' | 'withdrawn', freshness: import('@harnessdesk/protocol').Freshness = { state: 'fresh' }) => factView({ kind: 'finding', id: 'finding-1', state, at: 'a'.repeat(40) }, { freshness })
  const label = (facts: ReturnType<typeof checkView>[], running: {name: string; since: number}[] = []) => evidenceSummary(cardEvidence(1, facts, running))?.label
  it('prioritizes current failure, review and finding over running, regardless of order', () => {
    const facts = [checkView({exit: 1}), review('request-changes'), finding('open')]
    expect(label(facts)).toBe('Failed')
    expect(label([...facts].reverse())).toBe('Failed')
    expect(label([review('request-changes'), finding('open')], [{name:'verify', since:1}])).toBe('Changes requested')
    expect(label([finding('open')], [{name:'verify', since:1}])).toBe('Finding open')
    expect(label([checkView({timedOut:true, exit:null})])).toBe('Failed')
    expect(label([ciView(['failed'])])).toBe('Failed')
  })
  it('suppresses only the earlier result for the running name', () => {
    const running = [{name:'verify', since:1}]
    expect(label([checkView({exit:1})], running)).toBe('Running')
    expect(label([checkView({exit:1}), checkView({name:'lint', exit:1})], running)).toBe('Failed')
    expect(label([checkView({exit:1, freshness:{state:'behind', commits:2}}), ciView(['pending'])])).toBe('Running')
  })
  it('reports relevant stale before unknown and never promotes an old failure', () => {
    for (const freshness of [{state:'behind', commits:1} as const, {state:'moved'} as const, {state:'uncommitted'} as const]) {
      expect(label([checkView({exit:1, freshness})])).toBe('Out of date')
      expect(label([review('request-changes', freshness)])).toBe('Out of date')
      expect(label([finding('open', freshness)])).toBe('Out of date')
    }
    const unknown = {state:'unknown', why:'checkout gone'} as const
    expect(label([finding('open', unknown)])).toBe('Unknown')
    expect(label([checkView({freshness:unknown})])).toBe('Unknown')
    expect(label([ciView(['failed'], {freshness:unknown})])).toBe('Unknown')
    expect(label([checkView({freshness:unknown}), finding('open', {state:'moved'})])).toBe('Out of date')
    expect(label([prView('open', {freshness:unknown})])).toBe('Observed')
    expect(label([diffView({freshness:{state:'moved'}})])).toBe('Observed')
  })
  it('uses aggregate CI and never claims every required check passed', () => {
    expect(label([ciView(['passed','skipped'])])).toBe('Checks recorded')
    for (const states of [['cancelled'], ['skipped'], []] as const) expect(label([ciView(states)])).toBe('Incomplete')
    expect(label([checkView({exit:null}), checkView({name:'lint'})])).toBe('Incomplete')
    expect(label([checkView({freshness:{state:'final'}})])).toBe('Checks recorded')
    expect(label([review('picked')])).toBe('Observed')
    expect(evidenceSummary(cardEvidence(1, [checkView({exit:1})]))).toEqual({label:'Failed', tone:'danger'})
  })
  it('preserves omission of empty observations and unfinished zero diffs', () => {
    const none = factView({kind:'diff', files:0, added:0, removed:0, from:'a'.repeat(40), to:'b'.repeat(40)})
    expect(evidenceSummary(undefined)).toBeNull()
    expect(evidenceSummary(cardEvidence(1, []))).toBeNull()
    expect(evidenceSummary(cardEvidence(1, [none]))).toBeNull()
    expect(evidenceSummary(cardEvidence(1, [none]), true)?.label).toBe('Observed')
  })
})
