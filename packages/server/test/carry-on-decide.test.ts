import assert from 'node:assert/strict'
import { test } from 'node:test'

import { carryOnFor, DEFAULT_CARRY_ON, type ModelInfo } from '@harnessdesk/protocol'

import {
  CARRY_ON_HOPS,
  chooseModel,
  decide,
  limitCauseOf,
  SOON_MS,
  type CarryOnCandidate,
  type DecideInput,
} from '../src/carry-on/decide.js'

/** The table of the design's §11.1, against the pure decision. Rows 18 and on are seats (piece D). */

const NOW = 1_000_000_000
const HOUR = 60 * 60 * 1000

const sibling = (over: Partial<CarryOnCandidate> = {}): CarryOnCandidate => ({
  runtime: 'codex-2', agent: 'codex', name: 'Codex', account: 'personal', tier: 0, resetsAt: NOW + 3 * HOUR,
  sameThread: true, gateway: false, signedIn: true, resume: true, ...over,
})
const other = (over: Partial<CarryOnCandidate> = {}): CarryOnCandidate => ({
  runtime: 'claude', agent: 'claude', name: 'Claude Code', tier: 0, resetsAt: NOW + 2 * HOUR,
  sameThread: false, gateway: false, signedIn: true, resume: true, ...over,
})
const input = (over: Partial<DecideInput> = {}): DecideInput => ({
  choice: 'switch', from: 'desk', otherAgents: true, stuck: { runtime: 'codex', agent: 'codex' }, resetsAt: null,
  candidates: [], tried: [], hops: 0, ...over,
})

test('1: ask offers the sibling and the wait when a reset is known', () => {
  const action = decide(input({ choice: 'ask', candidates: [sibling()], resetsAt: NOW + HOUR }), NOW)
  assert.equal(action.kind, 'ask')
  if (action.kind !== 'ask') return
  assert.equal(action.target?.runtime, 'codex-2')
  assert.equal(action.mode, 'sameThread')
  assert.equal(action.wait, true)
  assert.equal(action.scope, 'desk')
})

test('2: switch to a sibling over the same store keeps the thread', () => {
  assert.deepEqual(decide(input({ candidates: [sibling()] }), NOW), { kind: 'move', target: sibling(), mode: 'sameThread' })
})

test('3: a sibling with its own conversations is a handoff, even of the same agent', () => {
  const own = sibling({ tier: 1, sameThread: false, resetsAt: null })
  assert.deepEqual(decide(input({ candidates: [own] }), NOW), { kind: 'move', target: own, mode: 'handoff' })
})

test('4: a soon reset beats a lossy handoff when the sibling is nearly spent', () => {
  const action = decide(input({ candidates: [sibling({ tier: 2 }), other()], resetsAt: NOW + HOUR }), NOW)
  assert.deepEqual(action, { kind: 'wait', resetsAt: NOW + HOUR })
})

test('5: a far reset hands off to another agent', () => {
  const action = decide(input({ candidates: [other()], resetsAt: NOW + 8 * HOUR }), NOW)
  assert.deepEqual(action, { kind: 'move', target: other(), mode: 'handoff' })
})

test('6: with other agents off, a far reset is waited for', () => {
  const action = decide(input({ otherAgents: false, candidates: [other()], resetsAt: NOW + 8 * HOUR }), NOW)
  assert.deepEqual(action, { kind: 'wait', resetsAt: NOW + 8 * HOUR })
})

test('7: nothing with room and no reset is exhausted', () => {
  const action = decide(input(), NOW)
  assert.equal(action.kind, 'stop')
  if (action.kind === 'stop') { assert.equal(action.phase, 'exhausted'); assert.match(action.note, /no other account or agent has room/) }
})

test('8: an API-key account is never taken automatically, though the card lists it', () => {
  const gateway = sibling({ gateway: true })
  const action = decide(input({ candidates: [gateway] }), NOW)
  assert.equal(action.kind, 'stop')
  if (action.kind === 'stop') assert.equal(action.phase, 'exhausted')
  const asked = decide(input({ choice: 'ask', candidates: [gateway] }), NOW)
  assert.ok(asked.kind === 'ask' && asked.target === null && asked.others.some(one => one.runtime === gateway.runtime))
})

test('9: a signed-out agent is not a candidate; the reset is waited for', () => {
  const action = decide(input({ candidates: [other({ signedIn: false })], resetsAt: NOW + 2 * HOUR }), NOW)
  assert.deepEqual(action, { kind: 'wait', resetsAt: NOW + 2 * HOUR })
})

test('10: wait with no reset known stops, and says why', () => {
  const action = decide(input({ choice: 'wait' }), NOW)
  assert.equal(action.kind, 'stop')
  if (action.kind === 'stop') { assert.equal(action.phase, 'stopped'); assert.match(action.note, /no reset time/) }
})

test('11: stop stops, whatever has room', () => {
  const action = decide(input({ choice: 'stop', candidates: [sibling(), other()], resetsAt: NOW + HOUR }), NOW)
  assert.equal(action.kind, 'stop')
  if (action.kind === 'stop') assert.equal(action.phase, 'stopped')
})

test('12: an agent set to "next" switches even under a desk-wide ask', () => {
  const rule = carryOnFor({ ...DEFAULT_CARRY_ON, onLimit: 'ask' }, { whenOut: 'next' })
  assert.deepEqual(rule, { choice: 'switch', from: 'agent' })
  assert.deepEqual(decide(input({ ...rule, candidates: [sibling()] }), NOW), { kind: 'move', target: sibling(), mode: 'sameThread' })
})

test('13: an agent with no rule of its own follows the desk', () => {
  const rule = carryOnFor({ ...DEFAULT_CARRY_ON, onLimit: 'switch' }, {})
  assert.deepEqual(rule, { choice: 'switch', from: 'desk' })
  assert.equal(carryOnFor({ ...DEFAULT_CARRY_ON, onLimit: 'switch' }, { whenOut: 'sometimes' }).from, 'desk')
  assert.deepEqual(decide(input({ ...rule, candidates: [sibling()] }), NOW), { kind: 'move', target: sibling(), mode: 'sameThread' })
})

test('14: a model the sibling does not list becomes its default, and the marker says so', () => {
  const models = [
    { id: 'gpt-small', displayName: 'Small', isDefault: true },
    { id: 'gpt-secret', displayName: 'Secret', hidden: true },
  ] as unknown as ModelInfo[]
  assert.deepEqual(chooseModel('gpt-large', models, true), { model: 'gpt-small', note: 'gpt-large is not on this account; using gpt-small' })
  assert.deepEqual(chooseModel('gpt-small', models, true), { model: 'gpt-small' })
  // Never a hidden one, even when it is the id the conversation was on.
  assert.equal(chooseModel('gpt-secret', models, true).model, 'gpt-small')
  // Across agents, ids do not carry: the target's default, without a note.
  assert.deepEqual(chooseModel('gpt-small', models, false), { model: 'gpt-small' })
})

test('15: three hops is the cap', () => {
  const action = decide(input({ candidates: [sibling()], hops: CARRY_ON_HOPS }), NOW)
  assert.equal(action.kind, 'stop')
  if (action.kind === 'stop') assert.equal(action.phase, 'exhausted')
  // And a candidate already tried is not taken again.
  assert.equal(decide(input({ candidates: [sibling()], tried: ['codex-2'] }), NOW).kind, 'stop')
})

test('16: a rate limit the meter does not confirm is a throttle, not an incident', () => {
  assert.equal(limitCauseOf({ code: 'rateLimit' }, { reached: false, blocked: false }), 'throttle')
  assert.equal(limitCauseOf({ code: 'rateLimit' }, null), 'throttle')
  assert.equal(limitCauseOf({ code: 'rateLimit' }, { reached: true, blocked: false }), 'rateLimit')
  assert.equal(limitCauseOf({ code: 'credits' }, null), 'credits')
  assert.equal(limitCauseOf({ code: 'credits', retrying: true }, null), null)
  assert.equal(limitCauseOf({ code: 'network' }, { reached: true, blocked: true }), null)
})

test('17: no code at all is a limit only when a fresh meter reads blocked', () => {
  assert.equal(limitCauseOf({}, { reached: true, blocked: true }), 'blocked')
  assert.equal(limitCauseOf({}, { reached: false, blocked: false }), null)
  assert.equal(limitCauseOf({}, null), null)
  // And a limit read that way is carried on like any other.
  assert.equal(decide(input({ candidates: [sibling()] }), NOW).kind, 'move')
})

test('tier 0 is ranked by the soonest reset, and the edge of "soon" is inclusive', () => {
  const later = sibling({ runtime: 'codex-3', resetsAt: NOW + 4 * HOUR })
  const sooner = sibling({ runtime: 'codex-2', resetsAt: NOW + HOUR })
  const action = decide(input({ candidates: [later, sooner] }), NOW)
  assert.ok(action.kind === 'move' && action.target.runtime === 'codex-2')
  assert.equal(decide(input({ candidates: [other()], resetsAt: NOW + SOON_MS }), NOW).kind, 'wait')
  assert.equal(decide(input({ candidates: [other()], resetsAt: NOW + SOON_MS + 1 }), NOW).kind, 'move')
})

test('a person’s pick on the card may spend a nearly-out or API-key account, never a signed-out one', () => {
  const nearly = sibling({ tier: 2 })
  assert.deepEqual(decide(input({ candidates: [nearly], target: 'codex-2' }), NOW), { kind: 'move', target: nearly, mode: 'sameThread' })
  assert.equal(decide(input({ candidates: [sibling({ signedIn: false })], target: 'codex-2' }), NOW).kind, 'stop')
})
