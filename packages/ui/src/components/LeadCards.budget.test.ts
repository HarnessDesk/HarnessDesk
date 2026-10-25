import { expect, it } from 'vitest'
import { budgetQuestion } from './LeadCards'

it('asks only about the part of the allowance that changes', () => {
  expect(budgetQuestion({ usdMicros: 20_000_000, rounds: 50 }, { usdMicros: 30_000_000, rounds: 50 })).toBe('Raise the allowance from $20.00 to $30.00?')
  expect(budgetQuestion({ usdMicros: 20_000_000, rounds: 50 }, { usdMicros: 20_000_000, rounds: 80 })).toBe('Raise the allowance from 50 to 80 rounds?')
  expect(budgetQuestion({ usdMicros: 20_000_000, rounds: 50 }, { usdMicros: 30_000_000, rounds: 80 })).toBe('Raise the allowance from $20.00 to $30.00 and from 50 to 80 rounds?')
})
