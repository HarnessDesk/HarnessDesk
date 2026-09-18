import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CodexProtocol } from '@harnessdesk/codex'

import { ReviewTurns } from '../src/review-turns.js'

/**
 * `ReviewTurns` on its own, notification by notification: the order below is
 * the order 0.145.0 and 0.155.0 send an inline review in
 * (`script/probe/review-side-thread.mjs --shapes`).
 */

type Notification = CodexProtocol.ServerNotification

const T = 'thread-1'
const turn = (id: string, status: 'inProgress' | 'completed' = 'inProgress') => ({
  id,
  items: [],
  itemsView: 'notLoaded' as const,
  status,
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
})
const started = (id: string): Notification => ({ method: 'turn/started', params: { threadId: T, turn: turn(id) } })
const completed = (id: string): Notification => ({
  method: 'turn/completed',
  params: { threadId: T, turn: turn(id, 'completed') },
})
const item = (method: 'item/started' | 'item/completed', turnId: string, body: Record<string, unknown>): Notification =>
  ({
    method,
    params: { threadId: T, turnId, item: body, ...(method === 'item/started' ? { startedAtMs: 1_000_000 } : { completedAtMs: 1_000_000 }) },
  }) as Notification
const entered = (turnId: string) => item('item/started', turnId, { type: 'enteredReviewMode', id: 'e', review: 'current changes' })
const exited = (turnId: string) => item('item/completed', turnId, { type: 'exitedReviewMode', id: 'x', review: 'findings' })
const said = (turnId: string, id: string) =>
  item('item/started', turnId, { type: 'agentMessage', id, text: '', phase: null, memoryCitation: null })

/** Each notification in, and what went on, by method and turn. */
const run = (turns: ReviewTurns, notifications: readonly Notification[]): string[] =>
  notifications.flatMap((notification) =>
    turns.see(notification).map((out) => {
      const params = out.params as { turnId?: string; turn?: { id: string }; item?: { type: string } }
      return [out.method, params.item?.type, params.turnId ?? params.turn?.id].filter(Boolean).join(' ')
    }),
  )

test('an ordinary turn goes through untouched', () => {
  assert.deepEqual(run(new ReviewTurns(), [started('t1'), said('t1', 'm1'), completed('t1')]), [
    'turn/started t1',
    'item/started agentMessage t1',
    'turn/completed t1',
  ])
})

test("a review opens its own turn, and the reviewer's start and words go no further", () => {
  assert.deepEqual(
    run(new ReviewTurns(), [
      entered('r1'),
      started('reviewer'),
      said('r1', 'withheld'),
      exited('r1'),
      said('r1', 'findings'),
      completed('r1'),
    ]),
    [
      'turn/started r1',
      'item/started enteredReviewMode r1',
      'item/completed exitedReviewMode r1',
      'item/started agentMessage r1',
      'turn/completed r1',
    ],
  )
})

test('once the review is over, the next turn starts as any turn does', () => {
  const turns = new ReviewTurns()
  run(turns, [entered('r1'), exited('r1'), completed('r1')])
  assert.deepEqual(run(turns, [started('t2'), said('t2', 'm')]), ['turn/started t2', 'item/started agentMessage t2'])
})

test('a review Codex did announce is not opened twice', () => {
  assert.deepEqual(run(new ReviewTurns(), [started('r1'), entered('r1'), completed('r1')]), [
    'turn/started r1',
    'item/started enteredReviewMode r1',
    'turn/completed r1',
  ])
})

test('a thread that stops working has no review running, however its turn ended', () => {
  const turns = new ReviewTurns()
  run(turns, [entered('r1')])
  turns.see({ method: 'thread/status/changed', params: { threadId: T, status: { type: 'idle' } } })
  assert.deepEqual(run(turns, [started('t2')]), ['turn/started t2'])
})

test('a review on one thread leaves the others alone', () => {
  const turns = new ReviewTurns()
  run(turns, [entered('r1')])
  const elsewhere: Notification = { method: 'turn/started', params: { threadId: 'thread-2', turn: turn('t9') } }
  assert.deepEqual(turns.see(elsewhere), [elsewhere])
})

test("a review is stopped by naming the reviewer's turn, once Codex has started one", () => {
  const turns = new ReviewTurns()
  assert.equal(turns.interruptible(T, 't1'), 't1', 'an ordinary turn is its own')
  run(turns, [entered('r1')])
  assert.equal(turns.interruptible(T, 'r1'), 'r1', 'no reviewer yet: nothing better to name')
  run(turns, [started('reviewer')])
  assert.equal(turns.interruptible(T, 'r1'), 'reviewer')
  run(turns, [completed('r1')])
  assert.equal(turns.interruptible(T, 'r1'), 'r1', 'over')
})

test('a thread let go of and opened again has no review left open on it', () => {
  const turns = new ReviewTurns()
  run(turns, [entered('r1'), started('reviewer')])
  turns.forget(T)
  assert.deepEqual(run(turns, [started('t2')]), ['turn/started t2'])
  assert.equal(turns.interruptible(T, 'r1'), 'r1')
})
