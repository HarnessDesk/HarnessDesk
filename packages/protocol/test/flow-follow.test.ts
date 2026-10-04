import assert from 'node:assert/strict'
import { test } from 'node:test'

import { followOf, type FlowPolicyRule } from '../src/index.js'

const rule = (id: string, on: string, then: string, when?: FlowPolicyRule['when']): FlowPolicyRule => ({
  id, on, ...(when ? { when } : {}), then: { role: then, title: `Open ${then}` },
})

test('a rule with no guard follows any round that has cards, an unanswered card included', () => {
  const flow = { rules: [rule('after-writer', 'writer', 'reviewer')] }
  assert.deepEqual(followOf(flow, 'writer', ['done']), { kind: 'opens', rule: 'after-writer', role: 'reviewer', guarded: false })
  // An abandoned card has no outcome; the engine still reads the round, and this rule asks nothing of it.
  assert.deepEqual(followOf(flow, 'writer', [null]), { kind: 'opens', rule: 'after-writer', role: 'reviewer', guarded: false })
})

test('empty guard lists are no guard, as the engine reads them', () => {
  const flow = { rules: [rule('any-answer', 'writer', 'reviewer', { every: [], any: [] })] }
  assert.deepEqual(followOf(flow, 'writer', [null]), { kind: 'opens', rule: 'any-answer', role: 'reviewer', guarded: false })
})

test('every needs every card to have answered one of its words', () => {
  const flow = { rules: [rule('merge', 'reviewer', 'merger', { every: ['approved'] })] }
  assert.equal(followOf(flow, 'reviewer', ['approved', 'approved']).kind, 'opens')
  assert.deepEqual(followOf(flow, 'reviewer', ['approved', 'request-changes']), { kind: 'none', ruled: true })
  // No answer is not an approval: an abandoned card keeps a round from matching `every`.
  assert.deepEqual(followOf(flow, 'reviewer', ['approved', null]), { kind: 'none', ruled: true })
  assert.deepEqual(followOf(flow, 'reviewer', [null]), { kind: 'none', ruled: true })
})

test('any needs at least one card to have answered one of its words', () => {
  const flow = { rules: [rule('fix', 'reviewer', 'fixer', { any: ['request-changes'] })] }
  assert.equal(followOf(flow, 'reviewer', ['approved', 'request-changes']).kind, 'opens')
  assert.equal(followOf(flow, 'reviewer', ['approved', 'approved']).kind, 'none')
  assert.equal(followOf(flow, 'reviewer', [null, 'request-changes']).kind, 'opens')
  assert.equal(followOf(flow, 'reviewer', [null]).kind, 'none')
})

test('every and any must both hold when a rule names both', () => {
  const flow = { rules: [rule('both', 'reviewer', 'merger', { every: ['approved', 'minor'], any: ['approved'] })] }
  assert.equal(followOf(flow, 'reviewer', ['approved', 'minor']).kind, 'opens')
  assert.equal(followOf(flow, 'reviewer', ['minor', 'minor']).kind, 'none')
})

test('rules are read in file order and the first match wins', () => {
  const flow = { rules: [
    rule('merge', 'reviewer', 'merger', { every: ['approved'] }),
    rule('fix', 'reviewer', 'fixer', { any: ['request-changes'] }),
    rule('fallback', 'reviewer', 'person'),
  ] }
  assert.deepEqual(followOf(flow, 'reviewer', ['approved']), { kind: 'opens', rule: 'merge', role: 'merger', guarded: false })
  assert.deepEqual(followOf(flow, 'reviewer', ['request-changes']), { kind: 'opens', rule: 'fix', role: 'fixer', guarded: false })
  assert.deepEqual(followOf(flow, 'reviewer', [null]), { kind: 'opens', rule: 'fallback', role: 'person', guarded: false })
})

test('only the rules of this role are read', () => {
  const flow = { rules: [rule('after-fixer', 'fixer', 'reviewer'), rule('after-writer', 'writer', 'verify')] }
  assert.deepEqual(followOf(flow, 'writer', ['done']), { kind: 'opens', rule: 'after-writer', role: 'verify', guarded: false })
})

test('a rule that also reads evidence is said to depend on it', () => {
  const flow = { rules: [rule('land', 'reviewer', 'merger', { every: ['approved'], evidence: [{ ci: 'green' }] })] }
  assert.deepEqual(followOf(flow, 'reviewer', ['approved']), { kind: 'opens', rule: 'land', role: 'merger', guarded: true })
  assert.equal(followOf(flow, 'reviewer', ['request-changes']).kind, 'none')
})

test('nothing follows a role no rule starts from, and the answer says whether any rule was there to match', () => {
  assert.deepEqual(followOf({ rules: [] }, 'writer', ['done']), { kind: 'none', ruled: false })
  assert.deepEqual(followOf({ rules: [rule('after-fixer', 'fixer', 'reviewer')] }, 'writer', ['done']), { kind: 'none', ruled: false })
})

test('a round with no cards matches nothing', () => {
  assert.deepEqual(followOf({ rules: [rule('after-writer', 'writer', 'reviewer')] }, 'writer', []), { kind: 'none', ruled: true })
})
