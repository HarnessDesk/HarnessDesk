import { expect, it } from 'vitest'
import { runTimeline } from './run-timeline'
import { comparisonVerdictOf } from './comparison-verdict'
import { shapeFixture, SHAPE_REV } from '../preview/run-shapes-fixture'

const comparison = () => shapeFixture('comparison')
it('uses the Run’s kept attempt and preserves the recorded judge sentence', () => {
  const input = comparison()
  const verdict = comparisonVerdictOf(runTimeline(input), input.execution, input.cards)
  expect(verdict?.kind).toBe('picked')
  if (verdict?.kind !== 'picked') throw new Error('No recorded pick')
  expect(verdict.attempt.label).toBe('Attempt A')
  expect(verdict.judge.seat).toBe('seat-5')
  expect(verdict.reason).toBe('Attempt A preserves the ordering and passes the checks.')
  expect(verdict.next?.card).toBe(6)
  expect([...verdict.keeps]).toEqual([[1, 'kept'], [2, 'not-kept']])
})
it('shows no verdict or outcome before a pick, including when no attempt passes', () => {
  const input = comparison()
  input.evidence = { ...input.evidence!, cards: input.evidence!.cards.filter(one => one.card !== 5) }
  expect(comparisonVerdictOf(runTimeline(input), input.execution, input.cards)).toBeNull()
  input.cards = input.cards.map(one => one.role === 'verify' ? { ...one, outcome: 'fail' } : one)
  expect(comparisonVerdictOf(runTimeline(input), input.execution, input.cards)).toBeNull()
})
it('does not invent a winner when the recorded revision names no attempt', () => {
  const input = comparison()
  input.evidence = { ...input.evidence!, cards: input.evidence!.cards.map(one => one.card !== 5 ? one : {
    ...one, facts: one.facts.map(view => ({ ...view, record: { ...view.record, fact: { kind: 'review', at: 'e'.repeat(40), verdict: 'picked', by: 'seat-5' as never } } })),
  }) }
  expect(comparisonVerdictOf(runTimeline(input), input.execution, input.cards)).toBeNull()
})
it('offers the existing review step when the person’s pick is waiting', () => {
  const input = comparison()
  if (input.execution.document.format !== 'agents') throw new Error('wrong fixture')
  input.execution = { ...input.execution, rounds: input.execution.rounds.filter(one => one.n <= 3).map(one => one.n === 3 ? { ...one, state: 'running', seats: [] } : one),
    document: { ...input.execution.document, flow: { ...input.execution.document.flow,
      roles: input.execution.document.flow.roles.map(one => one.id === 'judge' ? { id: 'judge', kind: 'person', outcomes: ['picked'] } : one),
      rules: [{ id: 'after-judge', on: 'judge', when: { every: ['picked'], evidence: [{ review: 'picked' }] }, then: { role: 'merge', title: 'Merge' } }],
    } } }
  input.cards = input.cards.map(one => one.id === 5 ? { ...one, state: 'open', outcome: null, note: null } : one)
  input.evidence = { ...input.evidence!, cards: input.evidence!.cards.filter(one => one.card !== 5) }
  expect(comparisonVerdictOf(runTimeline(input), input.execution, input.cards)).toMatchObject({ kind: 'waiting', card: { id: 5 }, step: { review: true, run: input.execution.id } })
})
it('omits a reason the data does not carry as one sentence', () => {
  const input = comparison()
  input.cards = input.cards.map(one => one.id === 5 ? { ...one, note: null, handoff: null } : one)
  expect(comparisonVerdictOf(runTimeline(input), input.execution, input.cards)).toMatchObject({ kind: 'picked', reason: null })
  input.cards = input.cards.map(one => one.id === 5 ? { ...one, note: 'First reason. Another sentence.' } : one)
  expect(comparisonVerdictOf(runTimeline(input), input.execution, input.cards)).toMatchObject({ kind: 'picked', reason: null })
})
it('dismissal identity changes only for a changed Run or recorded selection', () => {
  const input = comparison()
  const first = comparisonVerdictOf(runTimeline(input), input.execution, input.cards)!
  const refresh = comparisonVerdictOf(runTimeline(input), input.execution, input.cards)!
  expect(refresh.id).toBe(first.id)
  input.evidence = { ...input.evidence!, cards: input.evidence!.cards.map(one => one.card !== 5 ? one : {
    ...one, facts: one.facts.map(view => ({ ...view, record: { ...view.record, checkout: { cwd: '/repo/attempt-1', branch: 'attempt-b' }, fact: { kind: 'review', at: SHAPE_REV[1]!, verdict: 'picked', by: 'seat-5' as never } } })),
  }) }
  const next = comparisonVerdictOf(runTimeline(input), input.execution, input.cards)!
  expect(next.id).not.toBe(first.id)
})

it('uses the person’s recorded pick without mistaking the step instruction for a reason', () => {
  const input = comparison()
  if (input.execution.document.format !== 'agents') throw new Error('wrong fixture')
  input.execution = { ...input.execution, document: { ...input.execution.document, flow: { ...input.execution.document.flow,
    roles: input.execution.document.flow.roles.map(one => one.id === 'judge' ? { id: 'judge', kind: 'person', outcomes: ['picked'] } : one),
  } } }
  input.cards = input.cards.map(one => one.id === 5 ? { ...one, note: null, handoff: null, detail: 'Choose the attempt to keep.' } : one)
  expect(comparisonVerdictOf(runTimeline(input), input.execution, input.cards)).toMatchObject({ kind: 'picked', judge: { kind: 'person' }, reason: null, attempt: { label: 'Attempt A' } })
})
