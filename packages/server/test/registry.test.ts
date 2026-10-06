import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  itemId,
  runtimeId,
  sessionId,
  turnId,
  type AgentEvent,
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

for (const noticeFirst of [true, false]) {
  test(`an empty registry keeps conversation notices with registration ${noticeFirst ? 'last' : 'first'}`, () => {
    const registry = new SessionRegistry()
    const notice: AgentEvent = { type: 'notice', sessionId: ID, class: 'conversation', level: 'warning', message: 'No tools declared', id: 'tools-1' }
    const repeated: AgentEvent = { ...notice, id: 'tools-2' }
    const opened: AgentEvent = { type: 'session/started', session: session([]) }
    for (const event of noticeFirst ? [notice, repeated, repeated, opened] : [opened, notice, repeated, repeated]) {
      registry.apply(RUNTIME, event)
    }
    const registered = registry.snapshot()[0]!
    assert.deepEqual(registered.turns.flatMap(turn => turn.items).filter(item => item.type === 'notice').map(item => [item.text, item.count]), [['No tools declared', 2]])
    registry.apply(RUNTIME, opened)
    registry.apply(RUNTIME, { type: 'turn/started', sessionId: ID, turn: turn('review', 'inProgress', 0) })
    registry.apply(RUNTIME, repeated)
    const held = registry.snapshot()[0]!
    assert.deepEqual(held.turns.flatMap(turn => turn.items).filter(item => item.type === 'notice').map(item => [item.text, item.count]), [['No tools declared', 2]])
    assert.equal(held.turns.some(turn => String(turn.id).startsWith('notice:')), false)
  })
}

test('pending notices belong to one runtime and are consumed by a read or discarded on deletion', () => {
  const registry = new SessionRegistry()
  const other = runtimeId('other')
  registry.apply(RUNTIME, { type: 'notice', sessionId: ID, level: 'warning', message: 'No tools declared', id: 'tools-1' })
  assert.deepEqual(registry.snapshot(), [], 'a notice cannot invent conversation metadata')
  assert.deepEqual(registry.upsert(session([], { runtime: other }), null).session.turns, [])
  const registered = registry.upsert(session([]), null).session
  assert.equal(registered.turns.flatMap(turn => turn.items).filter(item => item.type === 'notice').length, 1)
  registry.delete(RUNTIME, ID)
  assert.deepEqual(registry.upsert(session([]), null).session.turns, [], 'the consumed buffer cannot replay on another registration')
  const missing = sessionId('missing')
  registry.apply(RUNTIME, { type: 'notice', sessionId: missing, level: 'warning', message: 'No tools declared' })
  registry.delete(RUNTIME, missing)
  assert.deepEqual(registry.upsert(session([], { id: missing }), null).session.turns, [], 'deletion discards an unregistered conversation too')
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

test('a fork inherits notice classifications without becoming a seated session', () => {
  const registry = new SessionRegistry()
  const opening = itemId('opening')
  registry.upsert(
    session([
      {
        id: turnId('t-1'),
        status: 'completed',
        items: [{ id: opening, type: 'notice', text: 'the standing order' }],
      },
    ]),
    null,
  )

  const fork = registry.upsert(
    session(
      [
        {
          id: turnId('t-1'),
          status: 'completed',
          items: [{ id: opening, type: 'userMessage', content: [{ type: 'text', text: 'the standing order' }] }],
        },
      ],
      { id: sessionId('fork'), forkedFrom: ID },
    ),
    null,
  ).session

  assert.equal(fork.turns[0]?.items[0]?.type, 'notice')
  assert.equal(fork.settings?.agent, undefined)
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

test('the Seat attachments were frozen under survives a settings re-announcement, exactly like seatedAs', () => {
  const registry = new SessionRegistry()
  registry.upsert(session([]), null)
  assert.equal(registry.attachmentSeatOf(RUNTIME, ID), null, 'nothing recorded yet for a plain conversation')

  registry.recordAttachmentSeat(RUNTIME, ID, 'seat-1')
  assert.equal(registry.attachmentSeatOf(RUNTIME, ID), 'seat-1')

  // A model change, or any other re-announcement, replaces the whole session
  // read — the runtime has never heard of this Seat, so if the fold read it
  // from the incoming `Session` rather than keeping what is already held,
  // this would silently go back to null.
  registry.apply(RUNTIME, {
    type: 'session/settings',
    sessionId: ID,
    settings: { cwd: '/w', model: 'a-different-model' },
  })
  assert.equal(registry.attachmentSeatOf(RUNTIME, ID), 'seat-1', 'a settings re-announcement must not forget it')

  const reread = registry.upsert(session([], { settings: { cwd: '/w', model: 'a-different-model' } }), null)
  assert.equal(reread.attachmentSeat, 'seat-1', 'a fresh read folded through upsert must not forget it either')

  // A second, unrelated live conversation never sees the first one's Seat.
  const other = sessionId('s-2')
  registry.upsert(session([], { id: other }), null)
  assert.equal(registry.attachmentSeatOf(RUNTIME, other), null, 'one conversation’s Seat must never leak to another')
})
