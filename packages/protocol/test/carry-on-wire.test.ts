import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CARRY_ON_PREFERENCE,
  DEFAULT_CARRY_ON,
  carryOnFor,
  carryOnPolicyOf,
  parseClientMessage,
  whenOutForChoice,
  ValidationError,
  type HostParams,
} from '../src/index.js'

const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })

test('the carry-on rule defaults to ask, with other agents allowed', () => {
  assert.deepEqual(carryOnPolicyOf(undefined), { onLimit: 'ask', otherAgents: true })
  assert.deepEqual(carryOnPolicyOf({}), DEFAULT_CARRY_ON)
  assert.deepEqual(carryOnPolicyOf({ [CARRY_ON_PREFERENCE]: 'switch' }), DEFAULT_CARRY_ON, 'a malformed value is the default')
  assert.deepEqual(carryOnPolicyOf({ [CARRY_ON_PREFERENCE]: { onLimit: 'later', otherAgents: 'yes' } }), DEFAULT_CARRY_ON, 'unknown fields read as their defaults')
  assert.deepEqual(carryOnPolicyOf({ [CARRY_ON_PREFERENCE]: { onLimit: 'switch', otherAgents: false } }), { onLimit: 'switch', otherAgents: false })
})

test("an agent's own whenOut wins over the desk rule, and absent follows it", () => {
  const desk = { onLimit: 'ask' as const, otherAgents: true }
  assert.deepEqual(carryOnFor(desk, { whenOut: 'next' }), { choice: 'switch', from: 'agent' })
  assert.deepEqual(carryOnFor(desk, { whenOut: 'wait' }), { choice: 'wait', from: 'agent' })
  assert.deepEqual(carryOnFor(desk, { whenOut: 'ask' }), { choice: 'ask', from: 'agent' })
  assert.deepEqual(carryOnFor({ onLimit: 'switch', otherAgents: true }, {}), { choice: 'switch', from: 'desk' })
  assert.deepEqual(carryOnFor(desk, undefined), { choice: 'ask', from: 'desk' })
  assert.deepEqual(carryOnFor(desk, { whenOut: 'sometimes' }), { choice: 'ask', from: 'desk' }, 'an unknown stored value is absent')
  assert.equal(whenOutForChoice('switch'), 'next')
})

test('app/state/set accepts the carry-on rule whole and refuses anything else', () => {
  assert.doesNotThrow(() => request('app/state/set', { patch: { [CARRY_ON_PREFERENCE]: { onLimit: 'switch', otherAgents: false } } }))
  for (const bad of [
    'switch',
    { onLimit: 'switch' },
    { onLimit: 'later', otherAgents: true },
    { onLimit: 'wait', otherAgents: 'no' },
    { onLimit: 'stop', otherAgents: true, gateway: true },
  ]) {
    assert.throws(() => request('app/state/set', { patch: { [CARRY_ON_PREFERENCE]: bad } }), ValidationError, JSON.stringify(bad))
  }
})

test('carryOn/list takes nothing', () => {
  assert.doesNotThrow(() => request('carryOn/list', {}))
  assert.throws(() => request('carryOn/list', { runtime: 'codex' }), ValidationError)
})

test('carryOn/decide takes an incident, a choice, an optional target and always', () => {
  const params = request('carryOn/decide', { incidentId: 'inc-1', choice: 'switch', target: 'codex-2', always: true }).params as HostParams<'carryOn/decide'>
  assert.deepEqual(params, { incidentId: 'inc-1', choice: 'switch', target: 'codex-2', always: true })
  assert.doesNotThrow(() => request('carryOn/decide', { incidentId: 'inc-1', choice: 'wait', always: false }))
  for (const bad of [
    { incidentId: '', choice: 'stop', always: false },
    { incidentId: 'inc-1', choice: 'ask', always: false },
    { incidentId: 'inc-1', choice: 'switch' },
    { incidentId: 'inc-1', choice: 'switch', always: 'yes' },
    { incidentId: 'x'.repeat(301), choice: 'stop', always: false },
    { incidentId: 'inc-1', choice: 'stop', always: false, state: 'moved' },
  ]) {
    assert.throws(() => request('carryOn/decide', bad), ValidationError, JSON.stringify(bad))
  }
})
