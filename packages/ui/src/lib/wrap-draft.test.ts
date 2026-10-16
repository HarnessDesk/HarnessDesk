import { expect, it } from 'vitest'
import { wrapDraft } from './wrap-draft'
import { teamWordsFixture } from '../preview/team-words-fixture'

it('never upgrades a referee pick to a merge without the merge observation', () => {
  const { input, view } = teamWordsFixture()
  const evidence = { ...input.evidence!, cards: input.evidence!.cards.filter(card => card.card !== 6) }
  const draft = wrapDraft(view, input.execution, evidence)
  expect(draft.summary).toContain('#1 · Improve the session store — Kept')
  expect(draft.summary).not.toContain('Merged')
  expect(draft.cards.get(2)).toEqual({ resolution: 'dropped', reason: 'Not kept after comparing the attempts.' })
})

it('keeps unknown picks unknown when the evidence is unavailable', () => {
  const { input, view } = teamWordsFixture()
  const draft = wrapDraft(view, input.execution, undefined)
  expect(draft.notKept.size).toBe(0)
  expect(draft.summary).not.toMatch(/Merged|Kept|Not kept/)
})
