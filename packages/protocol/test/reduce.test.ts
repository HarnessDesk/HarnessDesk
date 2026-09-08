import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  allItems,
  applyDelta,
  currentTurn,
  isBusy,
  itemId,
  mergeRead,
  reduceAll,
  reduceSession,
  runtimeId,
  sessionId,
  turnId,
  type AgentEvent,
  type AgentItem,
  type Session,
} from '../src/index.js'

const SESSION = sessionId('s1')
const TURN = turnId('t1')

const baseSession = (): Session => ({
  id: SESSION,
  runtime: runtimeId('codex'),
  cwd: '/tmp/work',
  status: { type: 'idle' },
  createdAt: 0,
  updatedAt: 0,
  turns: [],
  itemsLoaded: true,
})

const openTurn = (): AgentEvent => ({
  type: 'turn/started',
  sessionId: SESSION,
  turn: { id: TURN, items: [], status: 'inProgress' },
})

test('turn/started appends a turn, and repeats merge instead of duplicating', () => {
  let session = reduceSession(baseSession(), openTurn())
  assert.equal(session.turns.length, 1)
  session = reduceSession(session, openTurn())
  assert.equal(session.turns.length, 1)
})

test('assistant text deltas accumulate and item/completed wins', () => {
  const started: AgentItem = { id: itemId('i1'), type: 'assistantMessage', text: '' }
  let session = reduceAll(baseSession(), [
    openTurn(),
    { type: 'item/started', sessionId: SESSION, turnId: TURN, item: started },
    {
      type: 'item/delta',
      sessionId: SESSION,
      turnId: TURN,
      itemId: itemId('i1'),
      delta: { kind: 'assistantText', text: 'Hel' },
    },
    {
      type: 'item/delta',
      sessionId: SESSION,
      turnId: TURN,
      itemId: itemId('i1'),
      delta: { kind: 'assistantText', text: 'lo' },
    },
  ])

  const streamed = allItems(session)[0]
  assert.equal(streamed?.type === 'assistantMessage' && streamed.text, 'Hello')

  session = reduceSession(session, {
    type: 'item/completed',
    sessionId: SESSION,
    turnId: TURN,
    item: { ...started, text: 'Hello world', phase: 'final' },
  })
  const final = allItems(session)[0]
  assert.equal(final?.type === 'assistantMessage' && final.text, 'Hello world')
  assert.equal(allItems(session).length, 1, 'completed replaces rather than appends')
})

test('reasoning deltas fill sparse indices without losing earlier parts', () => {
  const item: AgentItem = { id: itemId('r1'), type: 'reasoning', summary: [], content: [] }
  const session = reduceAll(baseSession(), [
    openTurn(),
    { type: 'item/started', sessionId: SESSION, turnId: TURN, item },
    {
      type: 'item/delta',
      sessionId: SESSION,
      turnId: TURN,
      itemId: itemId('r1'),
      delta: { kind: 'reasoningSummary', index: 1, text: 'second' },
    },
    {
      type: 'item/delta',
      sessionId: SESSION,
      turnId: TURN,
      itemId: itemId('r1'),
      delta: { kind: 'reasoningSummary', index: 0, text: 'first' },
    },
  ])
  const reasoning = allItems(session)[0]
  assert.deepEqual(reasoning?.type === 'reasoning' && reasoning.summary, ['first', 'second'])
})

test('command output deltas append in arrival order', () => {
  const item: AgentItem = {
    id: itemId('c1'),
    type: 'command',
    command: 'ls',
    cwd: '/tmp',
    origin: 'agent',
    status: 'inProgress',
    actions: [],
  }
  const session = reduceAll(baseSession(), [
    openTurn(),
    { type: 'item/started', sessionId: SESSION, turnId: TURN, item },
    {
      type: 'item/delta',
      sessionId: SESSION,
      turnId: TURN,
      itemId: itemId('c1'),
      delta: { kind: 'commandOutput', stream: 'stdout', chunk: 'a\n' },
    },
    {
      type: 'item/delta',
      sessionId: SESSION,
      turnId: TURN,
      itemId: itemId('c1'),
      delta: { kind: 'commandOutput', stream: 'stderr', chunk: 'b\n' },
    },
  ])
  const command = allItems(session)[0]
  assert.equal(command?.type === 'command' && command.output, 'a\nb\n')
})

test('fileChange patch deltas replace by path rather than duplicating a file', () => {
  const item: AgentItem = {
    id: itemId('f1'),
    type: 'fileChange',
    status: 'inProgress',
    changes: [{ path: '/a.ts', kind: { type: 'update' }, diff: 'v1' }],
  }
  const updated = applyDelta(item, {
    kind: 'fileChangePatch',
    changes: [
      { path: '/a.ts', kind: { type: 'update' }, diff: 'v2' },
      { path: '/b.ts', kind: { type: 'add' }, diff: 'new' },
    ],
  })
  assert.equal(updated.type === 'fileChange' && updated.changes.length, 2)
  assert.equal(
    updated.type === 'fileChange' && updated.changes.find((c) => c.path === '/a.ts')?.diff,
    'v2',
  )
})

test('events for other sessions are ignored by identity', () => {
  const session = baseSession()
  const next = reduceSession(session, {
    type: 'session/status',
    sessionId: sessionId('other'),
    status: { type: 'active' },
  })
  assert.equal(next, session)
})

test('deltas for unknown turns or items are dropped, not thrown', () => {
  const session = baseSession()
  const next = reduceSession(session, {
    type: 'item/delta',
    sessionId: SESSION,
    turnId: turnId('missing'),
    itemId: itemId('missing'),
    delta: { kind: 'assistantText', text: 'x' },
  })
  assert.deepEqual(next.turns, [])
})

test('isBusy tracks the live turn and currentTurn returns the last one', () => {
  let session = reduceSession(baseSession(), openTurn())
  assert.equal(isBusy(session), true)
  assert.equal(currentTurn(session)?.id, TURN)

  session = reduceSession(session, {
    type: 'turn/completed',
    sessionId: SESSION,
    turn: { id: TURN, items: [], status: 'completed' },
  })
  assert.equal(isBusy(session), false)
})

test('turn/completed keeps streamed items when the summary is thinner', () => {
  const item: AgentItem = { id: itemId('i1'), type: 'assistantMessage', text: 'streamed' }
  let session = reduceAll(baseSession(), [
    openTurn(),
    { type: 'item/started', sessionId: SESSION, turnId: TURN, item },
  ])
  session = reduceSession(session, {
    type: 'turn/completed',
    sessionId: SESSION,
    turn: { id: TURN, items: [], status: 'completed' },
  })
  assert.equal(allItems(session).length, 1)
  assert.equal(currentTurn(session)?.status, 'completed')
})

// --------------------------------------------------------------- mergeRead

const readOf = (turns: Session['turns'], itemsLoaded = true): Session => ({
  ...baseSession(),
  turns,
  itemsLoaded,
})

test('a read brings new turns and corrects settled ones', () => {
  const held = readOf([
    { id: turnId('t1'), status: 'completed', items: [{ id: itemId('i1'), type: 'assistantMessage', text: 'one' }] },
  ])
  const read = readOf([
    { id: turnId('t1'), status: 'completed', items: [], diff: 'a diff' },
    { id: turnId('t2'), status: 'completed', items: [{ id: itemId('i2'), type: 'assistantMessage', text: 'two' }] },
  ])
  const merged = mergeRead(held, read)
  assert.deepEqual(merged.turns.map((turn) => turn.id), ['t1', 't2'])
  // Ours streamed; the store's copy of the same turn is thinner, but its diff
  // is news.
  assert.equal(merged.turns[0]?.items.length, 1)
  assert.equal(merged.turns[0]?.diff, 'a diff')
  assert.equal(allItems(merged).length, 2)
})

test('a plan the read is silent about is the one we watched arrive', () => {
  // Every ACP agent reports its plan over the wire and stores none, so a
  // re-read of a settled turn carries the items and no plan. Keeping the plan
  // only when our items outnumber the read's emptied the Tasks panel the
  // moment a conversation was reopened.
  const plan = [{ step: 'explore', status: 'completed' as const }, { step: 'write', status: 'inProgress' as const }]
  const items = [{ id: itemId('i1'), type: 'assistantMessage' as const, text: 'one' }]
  const held = readOf([{ id: turnId('t1'), status: 'completed', items, plan }])
  const merged = mergeRead(held, readOf([{ id: turnId('t1'), status: 'completed', items }]))
  assert.deepEqual(merged.turns[0]?.plan, plan)

  // A read that has its own opinion still wins.
  const fresher = [{ step: 'ship', status: 'pending' as const }]
  assert.deepEqual(
    mergeRead(held, readOf([{ id: turnId('t1'), status: 'completed', items, plan: fresher }])).turns[0]?.plan,
    fresher,
  )
})

test('a read cannot delete the turn that is running', () => {
  const held = readOf([
    { id: turnId('t1'), status: 'completed', items: [{ id: itemId('i1'), type: 'assistantMessage', text: 'done' }] },
    { id: turnId('t2'), status: 'inProgress', items: [{ id: itemId('i2'), type: 'assistantMessage', text: 'working' }] },
  ])
  const merged = mergeRead(held, readOf([held.turns[0]!]))
  assert.deepEqual(merged.turns.map((turn) => turn.id), ['t1', 't2'], 'the running turn is kept, and kept last')
  assert.equal(isBusy(merged), true)
})

test('what a read may drop is the caller’s rule to make', () => {
  const held = readOf([
    { id: turnId('t1'), status: 'completed', items: [{ id: itemId('i1'), type: 'assistantMessage', text: 'done' }] },
  ])
  // The default keeps only a turn in progress: a completed turn the read does
  // not list is gone as far as the renderer is concerned.
  assert.deepEqual(mergeRead(held, readOf([])).turns, [])
  // A caller that knows it watched the turn keeps it.
  assert.equal(mergeRead(held, readOf([]), () => true).turns.length, 1)
})

test('a summary-shaped read keeps the transcript it cannot see', () => {
  const held = readOf([
    { id: turnId('t1'), status: 'completed', items: [{ id: itemId('i1'), type: 'assistantMessage', text: 'one' }] },
  ])
  const merged = mergeRead(held, readOf([], false))
  assert.equal(merged.itemsLoaded, true)
  assert.equal(merged.turns.length, 1)
  // With nothing loaded on either side there is nothing to protect.
  assert.equal(mergeRead(readOf([], false), readOf([], false)).itemsLoaded, false)
})

const USAGE = {
  total: { totalTokens: 100, inputTokens: 90, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
  last: { totalTokens: 100, inputTokens: 90, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
  contextUsed: 100,
  contextWindow: 1000,
} as const

test('a read that says nothing about tokens does not erase the ones we heard', () => {
  const turns: Session['turns'] = [
    { id: turnId('t1'), status: 'completed', items: [{ id: itemId('i1'), type: 'assistantMessage', text: 'one' }] },
  ]
  const held: Session = { ...readOf(turns), usage: USAGE }

  // An agent re-registering under us announces the session afresh, with no
  // tokens on it — every adapter reports usage from a live handle it just lost.
  assert.deepEqual(mergeRead(held, readOf(turns)).usage, USAGE)
  // Including the summary-shaped announcement, which knows even less.
  assert.deepEqual(mergeRead(held, readOf([], false)).usage, USAGE)

  // What the read does say still wins: it heard from the agent more recently.
  const fresher = { ...USAGE, contextUsed: 250 }
  assert.deepEqual(mergeRead(held, { ...readOf(turns), usage: fresher }).usage, fresher)

  // And never across conversations.
  assert.equal(mergeRead(held, { ...readOf([]), id: sessionId('s2') }).usage, undefined)
})

test('a read of another conversation is not folded in', () => {
  const held = readOf([{ id: turnId('t1'), status: 'completed', items: [] }])
  const other: Session = { ...readOf([]), id: sessionId('s2') }
  assert.equal(mergeRead(held, other), other)
})
