import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { completesRound, followOf, type FlowPolicy, type FlowPolicyRule } from '@harnessdesk/protocol'

import { decide } from '../src/flow-execution.js'
import { parseFlowPolicy } from '../src/flow-policy.js'
import { builtinFlowRoot } from '../src/host.js'

test('the documented landing retry routes non-success exits and completes landed (#1548)', async () => {
  const doc = await readFile(join(builtinFlowRoot(), '..', '..', '..', 'docs', 'flows.md'), 'utf8')
  const section = doc.slice(doc.indexOf('**Route a non-landing outcome back to a check.**'))
  const source = /```yaml\n([\s\S]*?)```/.exec(section)?.[1]
  assert.ok(source, 'the guide carries an executable policy')
  const parsed = parseFlowPolicy(source)
  assert.deepEqual(parsed.problems, [])
  assert.ok(parsed.document?.format === 'agents')
  const flow = parsed.document.flow
  for (const outcome of ['retry', 'no-pr', 'landed']) {
    const outcomes = [outcome]
    const engine = await decide(flow, 'land', outcomes, async () => ({ state: 'matched', evidence: [] }))
    const read = followOf(flow, 'land', outcomes)
    if (outcome === 'landed') {
      assert.equal(engine.kind, 'none')
      assert.deepEqual(read, { kind: 'none', ruled: false })
      assert.equal(completesRound(flow, 'land', outcomes), true)
    } else {
      assert.equal(engine.kind, 'fire', `${outcome} opens the retry`)
      assert.equal(read.kind, 'opens')
      assert.equal(completesRound(flow, 'land', outcomes), false)
    }
  }
})

/**
 * The window says what an answer or an abandoned card will do before it is
 * given, from the Run's frozen Flow, because the host's reply says nothing of
 * it. That is only true while `followOf` reads the rules the way the engine's
 * own `decide` does, so this holds the two to every case that has told them
 * apart: a card with no answer, a guard with empty lists, evidence, and the
 * order rules are tried in.
 */
const rule = (id: string, on: string, then: string, when?: FlowPolicyRule['when']): FlowPolicyRule => ({
  id, on, ...(when ? { when } : {}), then: { role: then, title: `Open ${then}` },
})
const policyOf = (rules: readonly FlowPolicyRule[]): FlowPolicy => ({
  version: 2, name: 'parity', inputs: [], roles: [], rules, seed: { role: 'writer', title: 'Start' }, messaging: 'board-only', wait: 240,
})

const policies: readonly (readonly [string, readonly FlowPolicyRule[]])[] = [
  ['no rule', []],
  ['one rule for another role', [rule('after-fixer', 'fixer', 'reviewer')]],
  ['no guard', [rule('plain', 'reviewer', 'merger')]],
  ['empty guard lists', [rule('empty', 'reviewer', 'merger', { every: [], any: [] })]],
  ['every', [rule('every', 'reviewer', 'merger', { every: ['approved'] })]],
  ['any', [rule('any', 'reviewer', 'fixer', { any: ['request-changes'] })]],
  ['every and any', [rule('both', 'reviewer', 'merger', { every: ['approved', 'minor'], any: ['approved'] })]],
  ['evidence only', [rule('evidence', 'reviewer', 'merger', { evidence: [{ ci: 'green' }] })]],
  ['every and evidence', [rule('land', 'reviewer', 'merger', { every: ['approved'], evidence: [{ ci: 'green' }] })]],
  ['ordered rules', [
    rule('merge', 'reviewer', 'merger', { every: ['approved'] }),
    rule('fix', 'reviewer', 'fixer', { any: ['request-changes'] }),
    rule('fallback', 'reviewer', 'person'),
  ]],
  ['a guarded rule before a fallback', [
    rule('land', 'reviewer', 'merger', { every: ['approved'], evidence: [{ ci: 'green' }] }),
    rule('fallback', 'reviewer', 'person'),
  ]],
]

const rounds: readonly (readonly (string | null)[])[] = [
  [], [null], ['approved'], ['minor'], ['other'], ['approved', 'approved'], ['approved', null], ['approved', 'minor'],
  ['request-changes'], ['approved', 'request-changes'], [null, 'request-changes'], [null, null],
]

for (const [name, rules] of policies) {
  test(`followOf reads ${name} as the engine's decide does`, async () => {
    const holds = async () => ({ state: 'matched' as const, evidence: [] })
    for (const outcomes of rounds) {
      const engine = await decide(policyOf(rules), 'reviewer', outcomes, holds)
      const read = followOf({ rules }, 'reviewer', outcomes)
      const said = `${name}, outcomes ${JSON.stringify(outcomes)}`
      assert.notEqual(engine.kind, 'wait', said)
      if (engine.kind === 'fire') {
        assert.equal(read.kind, 'opens', said)
        if (read.kind === 'opens') {
          assert.equal(read.rule, engine.rule.id, said)
          assert.equal(read.role, engine.rule.then.role, said)
          assert.equal(read.guarded, (engine.rule.when?.evidence?.length ?? 0) > 0, said)
        }
      } else {
        assert.equal(read.kind, 'none', said)
        if (read.kind === 'none') assert.equal(read.ruled, rules.some((one) => one.on === 'reviewer'), said)
      }
    }
  })

  test(`followOf leaves out what the engine gives to the evidence check, in ${name}`, async () => {
    // A guarded rule whose evidence does not hold is passed over, so what follows is read from the rules without a guard.
    const refuses = async () => ({ state: 'no-match' as const })
    const unguarded = rules.filter((one) => (one.when?.evidence?.length ?? 0) === 0)
    for (const outcomes of rounds) {
      const engine = await decide(policyOf(rules), 'reviewer', outcomes, refuses)
      const read = followOf({ rules: unguarded }, 'reviewer', outcomes)
      const said = `${name}, outcomes ${JSON.stringify(outcomes)}`
      if (engine.kind === 'fire') assert.deepEqual([read.kind, read.kind === 'opens' ? read.rule : null], ['opens', engine.rule.id], said)
      else assert.equal(read.kind, 'none', said)
    }
  })
}
