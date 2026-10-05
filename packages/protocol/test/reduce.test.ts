import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  allItems,
  applyDelta,
  currentTurn,
  isBusy,
  itemId,
  mergeRead,
  preserveNoticeItems,
  reduceAll,
  reduceSession,
  runtimeId,
  sessionId,
  sessionModel,
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

/**
 * The fold every runtime ends a turn with: chunks while it speaks, then the
 * whole turn again when it finishes. The completion *replaces* — a turn whose
 * items were built delta by delta must not come back with the final text
 * appended to what it already holds, or one answer reads as two spliced end to
 * end — which is how a room's message looked when two prompts shared one turn.
 */
test('a turn completing over its own deltas replaces the text rather than doubling it', () => {
  const streaming: AgentItem = { id: itemId('a1'), type: 'assistantMessage', text: '' }
  const body = 'Idempotent on the delivery id.\n\nWorth noting for #5: the provider resets its backoff.'
  let session = reduceAll(baseSession(), [
    openTurn(),
    { type: 'item/started', sessionId: SESSION, turnId: TURN, item: streaming },
    ...body.split(' ').map((word, index): AgentEvent => ({
      type: 'item/delta',
      sessionId: SESSION,
      turnId: TURN,
      itemId: itemId('a1'),
      delta: { kind: 'assistantText', text: index === 0 ? word : ` ${word}` },
    })),
  ])
  const streamed = allItems(session)[0]
  assert.equal(streamed?.type === 'assistantMessage' && streamed.text, body)

  session = reduceSession(session, {
    type: 'turn/completed',
    sessionId: SESSION,
    turn: {
      id: TURN,
      items: [{ ...streaming, text: body }],
      status: 'completed',
      completedAt: 10,
      durationMs: 10,
    },
  })
  const items = allItems(session)
  assert.equal(items.length, 1, 'one message, not one per source of the same words')
  const final = items[0]
  assert.equal(final?.type === 'assistantMessage' && final.text, body)
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

test('turn/completed cannot turn a streamed notice back into a user message when its list is fuller', () => {
  const opening = itemId('opening')
  let session = reduceAll(baseSession(), [
    openTurn(),
    {
      type: 'item/started',
      sessionId: SESSION,
      turnId: TURN,
      item: { id: opening, type: 'notice', kind: 'agentBrief', text: 'the standing order' },
    },
  ])
  session = reduceSession(session, {
    type: 'turn/completed',
    sessionId: SESSION,
    turn: {
      id: TURN,
      status: 'completed',
      items: [
        { id: opening, type: 'userMessage', content: [{ type: 'text', text: 'the standing order' }] },
        { id: itemId('answer'), type: 'assistantMessage', text: 'done' },
      ],
    },
  })

  assert.deepEqual(allItems(session).map((entry) => entry.type), ['notice', 'assistantMessage'])
  assert.equal((allItems(session)[0] as { kind?: string }).kind, 'agentBrief')
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

test('a read that starts at a reopen keeps the history held ahead of it', () => {
  const said = (id: string) => ({ id: turnId(id), status: 'completed' as const, items: [{ id: itemId(`${id}-i`), type: 'assistantMessage' as const, text: id }] })
  const held = readOf([said('t1'), said('t2')])
  const read = { ...readOf([said('r1')]), partialHistory: true }
  assert.deepEqual(mergeRead(held, read, () => false).turns.map((turn) => turn.id), ['t1', 't2', 'r1'])
  // Without the mark a read is the record, and unwatched turns go.
  assert.deepEqual(mergeRead(held, readOf([said('r1')]), () => false).turns.map((turn) => turn.id), ['r1'])
  // Once the read shares a turn with us, only what precedes that is history.
  const later = mergeRead(readOf([said('t1'), said('r1')]), { ...readOf([said('r1'), said('r2')]), partialHistory: true }, () => false)
  assert.deepEqual(later.turns.map((turn) => turn.id), ['t1', 'r1', 'r2'])
})

test('a fuller read cannot turn a held notice back into a user message', () => {
  const opening = itemId('opening')
  const held = readOf([
    { id: turnId('t1'), status: 'completed', items: [{ id: opening, type: 'notice', kind: 'agentBrief', text: 'the standing order' }] },
  ])
  const read = readOf([
    {
      id: turnId('t1'),
      status: 'completed',
      items: [
        { id: opening, type: 'userMessage', content: [{ type: 'text', text: 'the standing order' }] },
        { id: itemId('answer'), type: 'assistantMessage', text: 'done' },
      ],
    },
  ])

  assert.deepEqual(allItems(mergeRead(held, read)).map((entry) => entry.type), ['notice', 'assistantMessage'])
  assert.equal((allItems(mergeRead(held, read))[0] as { kind?: string }).kind, 'agentBrief')
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

test('sessionModel resolves model from options and settings, ignoring automatic choices (#374)', () => {
  assert.equal(sessionModel({ settings: { cwd: '/w', model: 'gpt-5.4' } }), 'gpt-5.4')
  assert.equal(
    sessionModel({
      options: [{ type: 'select', id: 'model', label: 'Model', currentValue: 'gemini-3.8-flash', choices: [] }],
      settings: { cwd: '/w', model: 'auto' },
    }),
    'gemini-3.8-flash',
  )
  assert.equal(sessionModel({ settings: { cwd: '/w', model: 'auto' } }), null)
  assert.equal(sessionModel({ settings: { cwd: '/w', model: 'default' } }), null)
  assert.equal(
    sessionModel({
      options: [{ type: 'select', id: 'model', label: 'Model', currentValue: 'auto', choices: [] }],
      settings: { cwd: '/w', model: 'auto' },
    }),
    null,
  )
})

test('session notices stay in the transcript through a richer turn completion and a fresh read', () => {
  const notice = { type: 'notice', sessionId: SESSION, level: 'info', kind: 'conversation:compacted', message: 'Context was compacted', id: 'notice-1', at: 10 } as AgentEvent
  const empty = reduceSession(baseSession(), notice)
  assert.equal(empty.turns[0]?.items[0]?.type, 'notice')
  const started = reduceSession(baseSession(), { type: 'turn/started', sessionId: SESSION, turn: { id: TURN, status: 'inProgress', items: [] } })
  const held = reduceSession(started, notice)
  const completed = reduceSession(held, { type: 'turn/completed', sessionId: SESSION, turn: { id: TURN, status: 'completed', items: [{ id: itemId('a'), type: 'assistantMessage', text: 'Done' }, { id: itemId('b'), type: 'assistantMessage', text: 'More' }] } })
  assert.equal(completed.turns[0]?.items.filter(item => item.type === 'notice').length, 1)
  const read = mergeRead(completed, { ...baseSession(), turns: [{ id: TURN, status: 'completed', items: [] }] }, () => true)
  assert.equal(read.turns[0]?.items.filter(item => item.type === 'notice').length, 1)
  assert.deepEqual(reduceSession(held, notice), held, 'a replayed event is idempotent')
})

for (const order of ['before session start', 'before review turn', 'after reviewer turn starts'] as const) {
  test(`a review keeps tool declarations arriving ${order}`, () => {
    const notice: AgentEvent = { type: 'notice', sessionId: SESSION, class: 'conversation', level: 'warning', message: 'TOOLS_DECLARED (none)', id: 'tools-1' }
    const repeated: AgentEvent = { ...notice, id: 'tools-2' }
    const opened: AgentEvent = { type: 'session/started', session: baseSession() }
    const reviewer: AgentEvent = { type: 'turn/started', sessionId: SESSION, turn: { id: turnId('reviewer'), status: 'inProgress', items: [] } }
    const early: AgentEvent[] = order === 'before session start'
      ? [notice, repeated, repeated, opened]
      : order === 'before review turn'
        ? [opened, notice, repeated, repeated]
        : [opened, reviewer, notice, repeated, repeated, { ...reviewer, type: 'turn/completed', turn: { ...reviewer.turn, status: 'completed' } }]
    const review: AgentEvent = { type: 'turn/started', sessionId: SESSION, turn: { id: TURN, status: 'inProgress', items: [] } }
    const held = reduceAll(baseSession(), [...early, review, {
      type: 'turn/completed', sessionId: SESSION,
      turn: { id: TURN, status: 'completed', items: [
        { id: itemId('finding'), type: 'assistantMessage', text: 'One cosmetic finding.' },
        { id: itemId('review-exit'), type: 'review', phase: 'exited', review: 'Review finished' },
      ] },
    }])
    const notices = allItems(held).filter(item => item.type === 'notice')
    assert.deepEqual(notices.map(item => [item.text, item.count]), [['TOOLS_DECLARED (none)', 2]])
    assert.equal(held.turns.some(turn => String(turn.id).startsWith('notice:')), false, 'the early notice joins the first real turn')
    assert.equal(held.turns[0]?.items.some(item => item.type === 'notice'), true)
    assert.equal(held.turns.at(-1)?.status, 'completed')
    assert.equal(allItems(held).filter(item => item.type === 'assistantMessage').length, 1)
  })
}

test('a registration snapshot carrying the pending notice does not duplicate it', () => {
  const held = reduceSession(baseSession(), { type: 'notice', sessionId: SESSION, level: 'warning', message: 'TOOLS_DECLARED (none)', id: 'tools-1' })
  const opened = { ...held, title: 'Review of uncommitted changes' }
  assert.equal(reduceSession(held, { type: 'session/started', session: opened }), opened)
  const other = { ...baseSession(), id: sessionId('other') }
  assert.equal(reduceSession(held, { type: 'session/started', session: other }), held)
})

test('session errors change the row state and appear inline without changing unrelated sessions', () => {
  const event: AgentEvent = { type: 'error', sessionId: SESSION, error: { code: 'unknown', message: 'Turn failed' } }
  const failed = reduceSession(baseSession(), event)
  assert.equal(failed.status.type, 'error')
  assert.equal(failed.turns[0]?.items[0]?.type, 'error')
  const other = { ...baseSession(), id: sessionId('other') }
  assert.equal(reduceSession(other, event), other)
})

test('notice classification alone never copies missing notices into a fork turn', () => {
  const notice: AgentItem = { id: itemId('host-notice'), type: 'notice', kind: 'conversation:compacted', text: 'Compacted' }
  const copied: AgentItem[] = [{ id: itemId('user'), type: 'userMessage', content: [{ type: 'text', text: 'Hello' }] }]
  assert.deepEqual(preserveNoticeItems(copied, [notice]), copied)
})
test('a rollback that omits a completed turn drops its user and tool items even when it has a notice', () => {
  const t1 = { id: TURN, status: 'completed' as const, items: [] }
  const t2 = { id: turnId('t2'), status: 'completed' as const, items: [{ id: itemId('user'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: 'Removed' }] }, { id: itemId('notice'), type: 'notice' as const, kind: 'conversation:compacted', text: 'Compacted' }] }
  const held = { ...baseSession(), turns: [t1, t2] }
  assert.deepEqual(mergeRead(held, { ...baseSession(), turns: [t1] }).turns, [t1])
})


test('a failed turn and its error event have one inline explanation', () => {
  const error = { code: 'unknown' as const, message: 'Runtime could not finish' }
  const started = reduceSession(baseSession(), { type: 'turn/started', sessionId: SESSION, turn: { id: TURN, status: 'inProgress', items: [] } })
  const completed = reduceSession(started, { type: 'turn/completed', sessionId: SESSION, turn: { id: TURN, status: 'failed', items: [], error } })
  const failed = reduceSession(completed, { type: 'error', sessionId: SESSION, error })
  assert.equal(failed.status.type, 'error')
  assert.equal(failed.turns.flatMap(turn => turn.items).filter(item => item.type === 'error').length, 0)
  const early = reduceSession(baseSession(), { type: 'error', sessionId: SESSION, error })
  assert.equal(early.turns[0]?.error, undefined, 'the synthetic row already carries the explanation')
})
test('an automatically retrying error leaves the active conversation working', () => {
  const active = { ...baseSession(), status: { type: 'active' as const }, turns: [{ id: TURN, status: 'inProgress' as const, items: [] }] }
  const retry = reduceSession(active, { type: 'error', sessionId: SESSION, error: { code: 'unknown', message: 'Retrying', retrying: true } })
  assert.equal(retry.status.type, 'active')
})


test('replaying the most recent repeated notice does not increment it again', () => {
  const first = { type: 'notice', sessionId: SESSION, level: 'info', kind: 'conversation:compacted', message: 'Compacted', id: 'first' } as AgentEvent
  const second = { ...first, id: 'second' } as AgentEvent
  const held = reduceSession(reduceSession(baseSession(), first), second)
  assert.equal(held.turns[0]?.items[0]?.type === 'notice' && held.turns[0]?.items[0]?.count, 2)
  assert.deepEqual(reduceSession(held, second), held)
})

test('a final turn or read arriving after the error event still has one explanation', () => {
  const error = { code: 'unknown' as const, message: 'Turn failed' }
  const turn = { id: TURN, status: 'inProgress' as const, items: [] }
  const started = reduceSession(baseSession(), { type: 'turn/started', sessionId: SESSION, turn })
  const held = reduceSession(started, { type: 'error', sessionId: SESSION, error })
  const final = { ...turn, status: 'failed' as const, error }
  for (const result of [reduceSession(held, { type: 'turn/completed', sessionId: SESSION, turn: final }), mergeRead(held, { ...baseSession(), turns: [final] })]) {
    assert.equal(result.turns[0]?.error?.message, error.message)
    assert.equal(result.turns[0]?.items.filter(item => item.type === 'error').length, 0)
  }
})


test('the same conversation update is counted within each turn, beside its own work', () => {
  const first = { type: 'notice', sessionId: SESSION, level: 'info', kind: 'conversation:compacted', message: 'Compacted', id: 'first', at: 10 } as Extract<AgentEvent, { type: 'notice' }>
  let held = reduceSession(baseSession(), { type: 'turn/started', sessionId: SESSION, turn: { id: TURN, status: 'inProgress', items: [] } })
  held = reduceSession(held, first)
  held = reduceSession(held, { type: 'turn/completed', sessionId: SESSION, turn: { id: TURN, status: 'completed', items: [] } })
  const next = turnId('next')
  held = reduceSession(held, { type: 'turn/started', sessionId: SESSION, turn: { id: next, status: 'inProgress', items: [] } })
  held = reduceSession(held, { ...first, id: 'second', at: 20 })
  held = reduceSession(held, { ...first, id: 'third', at: 30 })
  const notices = held.turns.map(turn => turn.items.filter(item => item.type === 'notice'))
  assert.deepEqual(notices.map(items => items.map(item => item.count)), [[1], [2]])
  assert.deepEqual(reduceSession(held, { ...first, id: 'third', at: 30 }), held)
})
