import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  itemId,
  runtimeId,
  sessionId,
  turnId,
  type Session,
  type Turn,
} from '@harnessdesk/protocol'

import { SessionRegistry } from '../src/registry.js'

/**
 * What the host keeps against what a runtime's store says.
 *
 * The registry is the only place that knows both, and the rules it applies are
 * the difference between coming back to a working conversation and coming back
 * to an empty one.
 */

const RUNTIME = runtimeId('fake')
const ID = sessionId('s-1')

const session = (turns: readonly Turn[], overrides: Partial<Session> = {}): Session => ({
  id: ID,
  runtime: RUNTIME,
  cwd: '/w',
  status: { type: 'idle' },
  createdAt: 0,
  updatedAt: 0,
  turns,
  itemsLoaded: true,
  ...overrides,
})

const turn = (id: string, status: Turn['status'], items: number): Turn => ({
  id: turnId(id),
  status,
  items: Array.from({ length: items }, (_, index) => ({
    id: itemId(`${id}-${index}`),
    type: 'assistantMessage' as const,
    text: `part ${index}`,
  })),
})

test('a read never takes away a turn the host watched, nor its items', (t) => {
  const registry = new SessionRegistry()
  registry.upsert(session([]), null)
  registry.apply(RUNTIME, {
    type: 'turn/started',
    sessionId: ID,
    turn: { id: turnId('t-1'), items: [], status: 'inProgress' },
  })
  registry.upsert(session([turn('t-1', 'inProgress', 3)]), null)

  // The store is behind: it has no idea this turn exists.
  const behind = registry.upsert(session([]), null).session
  assert.equal(behind.turns.length, 1, 'the turn stays')
  assert.equal(behind.turns[0]?.items.length, 3)

  // Or it knows of the turn, but not what streamed inside it.
  const outline = registry.upsert(session([turn('t-1', 'inProgress', 0)]), null).session
  assert.equal(outline.turns[0]?.items.length, 3, 'our items win over the store’s outline')
})

test('turns the conversation itself dropped are not grafted back on', (t) => {
  const registry = new SessionRegistry()
  registry.upsert(session([]), null)
  for (const id of ['t-1', 't-2']) {
    registry.apply(RUNTIME, {
      type: 'turn/started',
      sessionId: ID,
      turn: { id: turnId(id), items: [], status: 'inProgress' },
    })
    registry.apply(RUNTIME, {
      type: 'turn/completed',
      sessionId: ID,
      turn: { id: turnId(id), items: [], status: 'completed' },
    })
  }
  registry.upsert(session([turn('t-1', 'completed', 2), turn('t-2', 'completed', 2)]), null)

  registry.forgetTurns(RUNTIME, ID, 1)
  const rolledBack = registry.upsert(session([turn('t-1', 'completed', 2)]), null).session
  assert.deepEqual(rolledBack.turns.map((entry) => entry.id), ['t-1'])
})

test('a turn nothing here is driving is not in progress, whatever the store says', (t) => {
  const registry = new SessionRegistry()
  // A session read for the first time in this process: its store was written
  // by a run that was killed mid-turn.
  const read = registry.upsert(
    session([turn('t-1', 'completed', 1), turn('t-2', 'inProgress', 2)], { status: { type: 'active' } }),
    null,
  ).session
  assert.equal(read.turns[1]?.status, 'interrupted')
  assert.equal(read.status.type, 'idle')
  assert.equal(read.turns[1]?.items.length, 2, 'what it did get through is kept')
})

test('a runtime going down stops the turns it was running', (t) => {
  const registry = new SessionRegistry()
  registry.upsert(session([]), null)
  registry.apply(RUNTIME, {
    type: 'turn/started',
    sessionId: ID,
    turn: { id: turnId('t-1'), items: [], status: 'inProgress' },
  })
  assert.equal(registry.get(RUNTIME, ID)?.session.turns[0]?.status, 'inProgress')

  registry.detachAll(RUNTIME)
  assert.equal(registry.get(RUNTIME, ID)?.session.turns[0]?.status, 'interrupted')
  // And a read afterwards is not believed either.
  const later = registry.upsert(session([turn('t-1', 'inProgress', 1)]), null).session
  assert.equal(later.turns[0]?.status, 'interrupted')
})

test('a summary-shaped read never erases a transcript', (t) => {
  const registry = new SessionRegistry()
  registry.upsert(session([turn('t-1', 'completed', 4)]), null)
  const summary = registry.upsert(session([], { itemsLoaded: false }), null).session
  assert.equal(summary.itemsLoaded, true)
  assert.equal(summary.turns[0]?.items.length, 4)
})

test('a rollback takes the dropped turns out of the host\'s copy as well', () => {
  // #34: only the host's claims on them went, and the turns stayed until the next read.
  const registry = new SessionRegistry()
  registry.upsert(session([turn('t-1', 'completed', 1), turn('t-2', 'completed', 1), turn('t-3', 'completed', 1)]), null)
  registry.forgetTurns(RUNTIME, ID, 1)
  assert.deepEqual(
    registry.get(RUNTIME, ID)?.session.turns.map((entry) => entry.id),
    [turnId('t-1'), turnId('t-2')],
  )
  registry.forgetTurns(RUNTIME, ID, 0)
  assert.equal(registry.get(RUNTIME, ID)?.session.turns.length, 2, 'forgetting none forgets none')
})
