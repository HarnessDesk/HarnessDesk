import { expect, it } from 'vitest'
import { reviewPublication } from './review-publication'

it.each([
  ['posted', 7, true, 'Posted to #7', 'neutral', false],
  ['pending', 7, true, 'Waiting to post', 'neutral', false],
  ['prepared', 7, true, 'Waiting to post', 'neutral', false],
  ['started', 7, true, 'Waiting to post', 'neutral', false],
  ['partial', 7, true, 'Partly posted', 'warning', true],
  ['uncertain', 7, true, 'Not confirmed', 'warning', true],
  ['local', 7, true, 'Not posted', 'warning', true],
  ['local', 7, false, 'Kept on the desk', 'neutral', false],
  ['local', null, true, 'Kept on the desk', 'neutral', false],
] as const)('maps %s with PR %s and posting %s', (state, pr, postingOn, label, tone, needsYou) => {
  expect(reviewPublication({ state, pr, postingOn, hasFindings: true })).toEqual({ label, tone, needsYou })
  expect(reviewPublication({ state, pr, postingOn, hasFindings: false })).toBeNull()
})
it('shows no chip for a round with no decision', () => {
  expect(reviewPublication({ state: 'none', pr: 7, postingOn: true, hasFindings: true })).toBeNull()
})
it('does not use inherited Goal findings or the round budget to invent this Run’s publication', async () => {
  const { runPublication } = await import('./review-publication')
  const view = { total: 3, open: 1, blocking: 1, publication: 'local', boundPr: { repo: 'acme/widgets', pr: 7 },
    rounds: [{ round: 1, state: 'none', reason: null, pr: null, cards: [1] }] } as unknown as import('@harnessdesk/protocol').FindingRunView
  expect(runPublication(view)).toBeNull()
  expect(runPublication({ ...view, publication: 'posted', rounds: [] })?.label).toBe('Posted to #7')
})
