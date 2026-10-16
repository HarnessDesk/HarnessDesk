import { expect, it } from 'vitest'
import { comparisonProgress } from './team-run-words'
import { runTimeline } from './run-timeline'
import { teamWordsFixture } from '../preview/team-words-fixture'

it('distinguishes a person’s pick from a referee’s pick', () => {
  const { input } = teamWordsFixture()
  const personOnly = { ...input, evidence: { ...input.evidence!, cards: input.evidence!.cards.filter(card => card.card !== 5) } }
  expect(comparisonProgress(runTimeline(personOnly).rows)).toBe('2 attempts · You picked')
})

it('has no invented attempt count without comparison cards', () => {
  expect(comparisonProgress([])).toBeNull()
  expect(comparisonProgress(undefined)).toBeNull()
})
