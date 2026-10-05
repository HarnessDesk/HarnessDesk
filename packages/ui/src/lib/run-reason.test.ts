import { expect, it } from 'vitest'
import { runReasonWords } from './run-reason'
it('removes only the leading routing label, preserving the reason', () => {
  expect(runReasonWords('Rule to-referee: Waiting for findings.', [{id:'to-referee'}])).toBe('Waiting for findings.')
  expect(runReasonWords('Choose a target: storefront.')).toBe('Choose a target: storefront.')
})

it('uses the Run’s rule ids, including colons, and preserves a user’s Rule sentence', () => {
 expect(runReasonWords('Rule review:approved: Waiting for 2 open blocking findings to be confirmed resolved.', [{id:'review:approved'}])).toBe('Waiting for 2 open blocking findings to be confirmed resolved.')
 expect(runReasonWords('Rule of thumb: keep the payment method.', [{id:'review:approved'}])).toBe('Rule of thumb: keep the payment method.')
 expect(runReasonWords('Rule review:approved: Choose a target: storefront.', [{id:'review'},{id:'review:approved'}])).toBe('Choose a target: storefront.')
})
