import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PendingConversationNotices,
  runtimeId,
  sessionId,
  type AgentEvent,
  type Session,
} from '../src/index.js'

const RUNTIME = runtimeId('fake')

const emptySession = (id: string): Session => ({
  id: sessionId(id),
  runtime: RUNTIME,
  cwd: '/w',
  status: { type: 'idle' },
  createdAt: 0,
  updatedAt: 0,
  turns: [],
  itemsLoaded: true,
})

const warning = (session: string, number: number): AgentEvent => ({
  type: 'notice',
  sessionId: sessionId(session),
  class: 'conversation',
  level: 'warning',
  message: `Warning ${number}`,
  id: `warning-${number}`,
})

test('pending notices keep only the newest twenty for a conversation', () => {
  const pending = new PendingConversationNotices()
  for (let number = 0; number < 21; number += 1) pending.keep(RUNTIME, warning('one', number))

  const held = pending.apply(emptySession('one')).turns.flatMap((turn) => turn.items).filter((item) => item.type === 'notice')
  assert.equal(held.length, 20)
  assert.deepEqual(held.map((item) => item.text), Array.from({ length: 20 }, (_, index) => `Warning ${index + 1}`))
})

test('pending notices hold only the newest one hundred conversations', () => {
  const pending = new PendingConversationNotices()
  for (let number = 0; number < 101; number += 1) {
    const id = `session-${number}`
    pending.keep(RUNTIME, warning(id, number))
  }

  assert.equal(pending.apply(emptySession('session-0')).turns.length, 0, 'the oldest conversation was evicted')
  assert.equal(pending.apply(emptySession('session-1')).turns.flatMap((turn) => turn.items).filter((item) => item.type === 'notice').length, 1)
  assert.equal(pending.apply(emptySession('session-100')).turns.flatMap((turn) => turn.items).filter((item) => item.type === 'notice').length, 1)
})
