import { expect, it } from 'vitest'
import { runReasonWords } from './run-reason'

it('reads recorded Seat-opening refusals with the current next step and no checkout id', () => {
  const reason = 'The Seat for card #1 could not be opened: the project is unavailable. Lane lane-1 was retained for review; its checkout and ports were kept.\nNext: wrap this Goal, which stops this run, then fix what stopped card #1 and start the flow again in a new Goal.'
  expect(runReasonWords(reason)).toBe('The Seat for card #1 could not be opened: the project is unavailable. Its checkout and ports were kept for review.\nNext: open the project folder again, then choose Run again.')
  expect(runReasonWords('The notes say “wrap this Goal” and name Lane lane-1.')).toBe('The notes say “wrap this Goal” and name Lane lane-1.')
})

it('reads the earlier missing-split next step without changing the required file split', () => {
  const detail = 'one list of paths for each "Builder" card, in card order, no two overlapping.'
  expect(runReasonWords(`Next: wrap this Goal, which stops this run, and start the flow again in a new Goal; the "Planner" card has to record its split of the files when it finishes — ${detail}`)).toBe(`Next: choose Run again. The "Planner" card needs to record its split of the files when it finishes — ${detail}`)
})
it('removes only the leading routing label, preserving the reason', () => {
  expect(runReasonWords('Rule to-referee: Waiting for findings.', [{id:'to-referee'}])).toBe('Waiting for findings.')
  expect(runReasonWords('Choose a target: storefront.')).toBe('Choose a target: storefront.')
})

it('uses the Run’s rule ids, including colons, and preserves a user’s Rule sentence', () => {
 expect(runReasonWords('Rule review:approved: Waiting for 2 open blocking findings to be confirmed resolved.', [{id:'review:approved'}])).toBe('Waiting for 2 open blocking findings to be confirmed resolved.')
 expect(runReasonWords('Rule of thumb: keep the payment method.', [{id:'review:approved'}])).toBe('Rule of thumb: keep the payment method.')
 expect(runReasonWords('Rule review:approved: Choose a target: storefront.', [{id:'review'},{id:'review:approved'}])).toBe('Choose a target: storefront.')
})

it('preserves distinct recovery for other opening refusals', () => {
  expect(runReasonWords('The Seat for card #1 could not be opened: the model is unavailable.\nNext: choose an available model, then choose Run again.')).toContain('choose an available model')
})
