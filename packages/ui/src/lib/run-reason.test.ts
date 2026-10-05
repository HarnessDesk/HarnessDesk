import { expect, it } from 'vitest'
import { runReasonWords } from './run-reason'
it('removes only the leading routing label, preserving the reason', () => {
  expect(runReasonWords('Rule to-referee: Waiting for findings.')).toBe('Waiting for findings.')
  expect(runReasonWords('Choose a target: storefront.')).toBe('Choose a target: storefront.')
})
