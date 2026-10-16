import { expect, it } from 'vitest'
import { wrapDraft } from './wrap-draft'
import { teamWordsFixture } from '../preview/team-words-fixture'
import { teamWordsRepairFixture } from '../preview/team-words-repairs-fixture'
import { encodeComparisonMerge } from './comparison-merge'

it.each([1, 2])('uses the verified person merge of attempt #%s over the referee pick', chosen => {
  const { input, view } = teamWordsRepairFixture(chosen)
  // The host stores the merge in the person card's handoff, without a review fact.
  expect(input.evidence!.cards.some(card => card.card === 6)).toBe(false)
  const draft = wrapDraft(view, input.execution, input.evidence)
  const other = chosen === 1 ? 2 : 1
  expect(draft.summary).toContain(`#${chosen} · Improve the session store — Merged`)
  expect(draft.summary).toContain(`#${other} · Improve the session store — Not kept`)
  expect(draft.notKept).toEqual(new Set([other]))
  expect(draft.cards.get(chosen)).toEqual({ resolution: 'finished', reason: '' })
  expect(draft.cards.get(other)).toEqual({ resolution: 'dropped', reason: 'Not kept after comparing the attempts.' })
  expect(wrapDraft(view, input.execution, undefined).summary).toBe(draft.summary)
})

it.each(['other run', 'agent card', 'unknown attempt'])('does not trust a merge receipt for %s', invalid => {
  const { input, view } = teamWordsRepairFixture()
  const cards = view.board.intents.map(card => {
    if (invalid === 'agent card' && card.id === 6) return { ...card, handoff: null }
    if (card.id !== (invalid === 'agent card' ? 5 : 6)) return card
    return { ...card, outcome: 'merged', handoff: encodeComparisonMerge({ version: 1,
      run: invalid === 'other run' ? 'other-run' : input.execution.id, card: invalid === 'unknown attempt' ? 99 : 2,
      revision: 'b'.repeat(40), commit: 'c'.repeat(40), branch: 'main', at: 1_800_000_000_000,
    }) }
  })
  const draft = wrapDraft({ ...view, board: { ...view.board, intents: cards } }, input.execution, input.evidence)
  expect(draft.summary).toContain('#1 · Improve the session store — Kept')
  expect(draft.summary).not.toContain('Merged')
  expect(draft.notKept).toEqual(new Set([2]))
})

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
