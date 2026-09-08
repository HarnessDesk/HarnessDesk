import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ValidationError,
  arrayOf,
  isKnownMethod,
  isString,
  knownMethods,
  literalUnion,
  optional,
  parseClientMessage,
  shape,
  tryParse,
} from '../src/index.js'

test('shape validates listed keys and passes unknown ones through', () => {
  const validator = shape({ a: isString, b: optional(isString) })
  const parsed = validator({ a: 'x', extra: 1 }) as Record<string, unknown>
  assert.equal(parsed['a'], 'x')
  assert.equal(parsed['extra'], 1, 'forward compatibility: unknown fields survive')
})

test('validation errors carry the failing path', () => {
  const validator = shape({ nested: shape({ value: isString }) })
  const result = tryParse(validator, { nested: { value: 5 } }, 'root')
  assert.equal(result.ok, false)
  assert.ok(result.ok === false && result.error instanceof ValidationError)
  assert.match(result.ok === false ? result.error.message : '', /root\.nested\.value/)
})

test('arrayOf reports the failing index', () => {
  const result = tryParse(arrayOf(isString), ['a', 2], 'items')
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error.message : '', /items\[1\]/)
})

test('literalUnion rejects values outside the set', () => {
  const validator = literalUnion('a', 'b')
  assert.equal(validator('a'), 'a')
  assert.throws(() => validator('c'), ValidationError)
})

test('the method table is the allowlist', () => {
  assert.ok(knownMethods.length > 0)
  assert.equal(isKnownMethod('turn/send'), true)
  assert.equal(isKnownMethod('turn/definitely-not-real'), false)
})

test('parseClientMessage accepts a well-formed request', () => {
  const message = parseClientMessage({
    id: 7,
    method: 'turn/send',
    params: { runtime: 'r', sessionId: 's1', input: [{ type: 'text', text: 'hi' }] },
  })
  assert.equal(message.method, 'turn/send')
  assert.equal(message.id, 7)
})

test('parseClientMessage rejects unknown methods and bad params', () => {
  assert.throws(
    () => parseClientMessage({ id: 1, method: 'evil/method', params: {} }),
    /unknown method/,
  )
  assert.throws(
    () => parseClientMessage({ id: 1, method: 'turn/send', params: { runtime: 'r', sessionId: 's1' } }),
    ValidationError,
  )
  // A session id alone does not name a conversation; the runtime is required.
  assert.throws(
    () =>
      parseClientMessage({
        id: 1,
        method: 'turn/send',
        params: { sessionId: 's1', input: [{ type: 'text', text: 'hi' }] },
      }),
    /runtime/,
  )
  assert.throws(() => parseClientMessage({ method: 'turn/interrupt', params: {} }), ValidationError)
})

/**
 * Every user verb the board has, at the wire.
 *
 * This table is a second copy of a union that already exists in `wire.ts`, and
 * nothing makes the two agree. `block` was added to the type, the host, the
 * store and the surface, and left out of here — so the app looked finished,
 * every test above the transport passed, and the running host refused the
 * request. The refusal arrived as "the board is as it was", which is true and
 * tells nobody anything. Only the app running against a real host found it.
 */
test('the board takes every verb the user has, and no others', () => {
  for (const action of ['reopen', 'abandon', 'done', 'release', 'block']) {
    const message = parseClientMessage({
      id: 1,
      method: 'team/intent',
      params: { room: 'room-1', id: 3, action },
    })
    assert.equal((message.params as { action: string }).action, action)
  }
  // The reason `block` carries, and the refusal for a verb nobody has.
  const withReason = parseClientMessage({
    id: 1,
    method: 'team/intent',
    params: { room: 'room-1', id: 3, action: 'block', reason: 'waiting on the rename' },
  })
  assert.equal((withReason.params as { reason?: string }).reason, 'waiting on the rename')
  assert.throws(
    () => parseClientMessage({ id: 1, method: 'team/intent', params: { room: 'room-1', id: 3, action: 'delete' } }),
    ValidationError,
  )
})

test('approval decisions validate their branch', () => {
  const message = parseClientMessage({
    id: 2,
    method: 'approval/respond',
    params: { runtime: 'r', sessionId: 's', approvalId: 'a', decision: { type: 'option', optionId: 'accept' } },
  })
  assert.equal(message.method, 'approval/respond')
  assert.throws(
    () =>
      parseClientMessage({
        id: 3,
        method: 'approval/respond',
        params: { runtime: 'r', sessionId: 's', approvalId: 'a', decision: { type: 'nope' } },
      }),
    /unknown type/,
  )
})

test('team/handout carries a template and per-member values, and is refused without its list', () => {
  const message = parseClientMessage({
    id: 7,
    method: 'team/handout',
    params: {
      room: 'room-1',
      template: 'Take card #{{card}} — {{title}}.',
      recipients: [
        { runtime: 'cursor', sessionId: 's1', vars: { card: '1', title: 'Audit /about' } },
        { runtime: 'cursor', sessionId: 's2' },
      ],
    },
  })
  assert.equal(message.method, 'team/handout')
  assert.throws(
    () => parseClientMessage({ id: 8, method: 'team/handout', params: { room: 'room-1', template: 'x' } }),
    ValidationError,
  )
  assert.throws(
    () =>
      parseClientMessage({
        id: 9,
        method: 'team/handout',
        params: { room: 'room-1', template: 'x', recipients: [{ runtime: 'cursor', sessionId: 's1', vars: { card: 1 } }] },
      }),
    ValidationError,
  )
})
