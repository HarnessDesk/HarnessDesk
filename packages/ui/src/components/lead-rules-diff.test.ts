import { expect, it } from 'vitest'
import { leadRuleDiff } from './lead-rules-diff'

it('marks what was removed, what was added and what stayed', () => {
  expect(leadRuleDiff('one\ntwo\nthree', 'one\n2\nthree\nfour')).toBe('  one\n- two\n+ 2\n  three\n+ four')
  expect(leadRuleDiff('same', 'same')).toBe('  same')
  expect(leadRuleDiff('gone', '')).toBe('- gone\n+ ')
})
