import { expect, it } from 'vitest'
import { comparisonMergeOf, encodeComparisonMerge } from './comparison-merge'
const receipt = { version: 1 as const, run: 'run-1', card: 2, revision:'b'.repeat(40), commit:'c'.repeat(40), branch:'main', at:1000 }
it('reads only a valid receipt for this Run and a completed person merge', () => {
  const card = {state:'done' as const, outcome:'merged', handoff:encodeComparisonMerge(receipt)}
  expect(comparisonMergeOf('run-1', [card])).toEqual(receipt)
  expect(comparisonMergeOf('run-2', [card])).toBeNull()
  expect(comparisonMergeOf('run-1', [{...card, outcome:'accepted'}])).toBeNull()
  expect(comparisonMergeOf('run-1', [{...card, state:'open' as const}])).toBeNull()
})
it.each([null, {}, { ...receipt, card:-1 }, { ...receipt, revision:'HEAD' }, { ...receipt, at:null }, { ...receipt, commit:'moved' }])('refuses malformed receipt %j', value => {
  expect(comparisonMergeOf('run-1', [{state:'done', outcome:'merged', handoff:JSON.stringify({comparisonMerge:value})}])).toBeNull()
})
it('does not mistake an ordinary handoff for a merge receipt', () => {
  expect(comparisonMergeOf('run-1', [{state:'done', outcome:'merged', handoff:'Merged A into main'}])).toBeNull()
})
