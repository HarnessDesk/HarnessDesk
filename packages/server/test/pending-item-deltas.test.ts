import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyDelta, itemId, type AgentItem, type ItemDelta } from '@harnessdesk/protocol'
import * as transcripts from '../src/pending-item-deltas.js'

const api = transcripts as unknown as { PendingItemDeltas?: new () => { add(delta: ItemDelta): void; apply(item: AgentItem): AgentItem; readonly operationCount: number } }

test('pending command deltas coalesce without losing bytes or growing metadata per event', () => {
  assert.equal(typeof api.PendingItemDeltas, 'function', 'semantic pending delta accumulator exists')
  const pending = new api.PendingItemDeltas!()
  const item = { id: itemId('cmd'), type: 'command', command: 'synthetic', cwd: '/tmp', origin: 'agent', actions: [], output: 'old:', status: 'inProgress' } as AgentItem
  let expected = item
  for (let i = 0; i < 1000; i++) {
    const delta: ItemDelta = { kind: 'commandOutput', stream: i % 2 ? 'stdout' : 'stderr', chunk: String(i % 10) }
    pending.add(delta); expected = applyDelta(expected, delta)
  }
  assert.deepEqual(pending.apply(item), expected)
  assert.ok(pending.operationCount <= 2, 'metadata is bounded by the logical output field')
})

test('pending deltas preserve text, reasoning indexes, file replacement order, and no-op progress', () => {
  assert.equal(typeof api.PendingItemDeltas, 'function')
  const cases: { item: AgentItem; deltas: ItemDelta[] }[] = [
    { item: { id: itemId('a'), type: 'assistantMessage', text: 'start' } as AgentItem,
      deltas: [{ kind: 'assistantText', text: ' one' }, { kind: 'assistantText', text: ' two' }] },
    { item: { id: itemId('r'), type: 'reasoning', summary: ['base'], content: [] } as AgentItem,
      deltas: [{ kind: 'reasoningSummaryPart', index: 2 }, { kind: 'reasoningSummary', index: 2, text: 'a' }, { kind: 'reasoningText', index: 0, text: 'x' }, { kind: 'reasoningSummary', index: 2, text: 'b' }] },
    { item: { id: itemId('p'), type: 'plan', text: 'base' } as AgentItem,
      deltas: [{ kind: 'planText', text: ' one' }, { kind: 'planText', text: ' two' }] },
    { item: { id: itemId('f'), type: 'fileChange', changes: [], status: 'completed' } as AgentItem,
      deltas: [{ kind: 'fileChangePatch', changes: [{ path: 'a', kind: { type: 'add' }, diff: '1' }, { path: 'b', kind: { type: 'add' }, diff: '2' }] },
        { kind: 'fileChangePatch', changes: [{ path: 'a', kind: { type: 'update' }, diff: '3' }] }, { kind: 'toolProgress', message: 'ignored' }] },
  ]
  for (const { item, deltas } of cases) {
    const pending = new api.PendingItemDeltas!()
    for (const delta of deltas) pending.add(delta)
    assert.deepEqual(pending.apply(item), deltas.reduce(applyDelta, item))
  }
})

test('pending replacements and subsequent deltas match the session reducer without per-event history', async () => {
  const { reduceSession, runtimeId, sessionId, turnId } = await import('@harnessdesk/protocol')
  const module = await import('../src/pending-item-deltas.js') as unknown as { PendingItemChanges?: new () => { replace(item: AgentItem): void; add(delta: ItemDelta): void; apply(base: AgentItem | undefined): AgentItem | undefined; readonly operationCount: number } }
  assert.equal(typeof module.PendingItemChanges, 'function')
  const pending = new module.PendingItemChanges!()
  const base = { id: itemId('a'), type: 'assistantMessage', text: 'old', startedAt: 12 } as AgentItem
  const id = sessionId('s'), tid = turnId('t')
  let state = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'completed', items: [base] }] } as import('@harnessdesk/protocol').Session
  const replace = (item: AgentItem) => { pending.replace(item); state = reduceSession(state, { type: 'item/completed', sessionId: id, turnId: tid, item }) }
  const add = (delta: ItemDelta) => { pending.add(delta); state = reduceSession(state, { type: 'item/delta', sessionId: id, turnId: tid, itemId: base.id, delta }) }
  add({ kind: 'assistantText', text: 'discarded by replacement' })
  replace({ id: base.id, type: 'assistantMessage', text: 'new' } as AgentItem)
  for (let i = 0; i < 1000; i++) add({ kind: 'assistantText', text: 'x' })
  replace({ id: base.id, type: 'assistantMessage', text: 'complete' } as AgentItem)
  add({ kind: 'assistantText', text: '!' })
  assert.deepEqual(pending.apply(base), state.turns[0]?.items[0])
  assert.ok(pending.operationCount <= 3)
})

test('pending item events preserve existing order, new-item order and interleaved deltas', async () => {
  const { reduceSession, runtimeId, sessionId, turnId } = await import('@harnessdesk/protocol')
  const module = await import('../src/pending-item-deltas.js') as unknown as { PendingTurnItems?: new () => { add(event: { type: 'item/started' | 'item/completed'; item: AgentItem } | { type: 'item/delta'; itemId: ReturnType<typeof itemId>; delta: ItemDelta }): void; apply(items: readonly AgentItem[]): readonly AgentItem[]; readonly operationCount: number } }
  assert.equal(typeof module.PendingTurnItems, 'function')
  const pending = new module.PendingTurnItems!()
  const id = sessionId('s'), tid = turnId('t')
  const old = { id: itemId('old'), type: 'assistantMessage', text: 'old' } as AgentItem
  let state = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'completed', items: [old] }] } as import('@harnessdesk/protocol').Session
  const events = [
    { type: 'item/delta' as const, itemId: itemId('later'), delta: { kind: 'assistantText' as const, text: 'ignored before start' } },
    { type: 'item/started' as const, item: { id: itemId('first'), type: 'assistantMessage', text: 'first' } as AgentItem },
    { type: 'item/started' as const, item: { id: itemId('later'), type: 'assistantMessage', text: 'later' } as AgentItem },
    { type: 'item/delta' as const, itemId: old.id, delta: { kind: 'assistantText' as const, text: ' updated' } },
    { type: 'item/delta' as const, itemId: itemId('first'), delta: { kind: 'assistantText' as const, text: '!' } },
  ]
  for (const event of events) { pending.add(event); state = reduceSession(state, { ...event, sessionId: id, turnId: tid }) }
  assert.deepEqual(pending.apply([old]), state.turns[0]?.items)
  assert.ok(pending.operationCount <= 6)
})

test('pending item replacements do not resurrect context that an intervening replacement discarded', async () => {
  const { reduceSession, runtimeId, sessionId, turnId } = await import('@harnessdesk/protocol')
  const { PendingItemChanges } = await import('../src/pending-item-deltas.js')
  const pending = new PendingItemChanges()
  const id = sessionId('s'), tid = turnId('t')
  const base: AgentItem = { id: itemId('u'), type: 'userMessage', content: [{ type: 'text', text: 'old prompt', deskContext: { prefixLength: 0 } }] }
  const changed: AgentItem = { id: base.id, type: 'userMessage', content: [{ type: 'text', text: 'different prompt' }] }
  const again: AgentItem = { id: base.id, type: 'userMessage', content: [{ type: 'text', text: 'old prompt' }] }
  let state = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'completed', items: [base] }] } as import('@harnessdesk/protocol').Session
  for (const item of [changed, again]) { pending.replace(item); state = reduceSession(state, { type: 'item/completed', sessionId: id, turnId: tid, item }) }
  assert.deepEqual(pending.apply(base), state.turns[0]?.items[0])
})

test('coalesced per-item changes agree with reducer across replacement and delta interleavings', async () => {
  const { reduceSession, runtimeId, sessionId, turnId } = await import('@harnessdesk/protocol')
  const { PendingItemChanges } = await import('../src/pending-item-deltas.js')
  let seed = 0x12345678
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  const id = sessionId('s'), tid = turnId('t'), iid = itemId('i')
  for (let run = 0; run < 200; run++) {
    const base: AgentItem = { id: iid, type: 'userMessage', content: [{ type: 'text', text: next() % 2 ? 'one' : 'two', deskContext: { prefixLength: 0 } }], startedAt: 3 }
    let state = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
      turns: [{ id: tid, status: 'completed', items: [base] }] } as import('@harnessdesk/protocol').Session
    const pending = new PendingItemChanges()
    for (let i = 0; i < 30; i++) {
      const choice = next() % 4
      if (choice === 0) {
        const delta: ItemDelta = { kind: 'assistantText', text: String(next() % 10) }
        pending.add(delta); state = reduceSession(state, { type: 'item/delta', sessionId: id, turnId: tid, itemId: iid, delta })
      } else {
        const item: AgentItem = choice === 1 ? { id: iid, type: 'assistantMessage', text: 'answer' } :
          { id: iid, type: 'userMessage', content: [{ type: 'text', text: choice === 2 ? 'one' : 'two' }] }
        pending.replace(item); state = reduceSession(state, { type: 'item/completed', sessionId: id, turnId: tid, item })
      }
    }
    assert.deepEqual(pending.apply(base), state.turns[0]?.items[0], `sequence ${run}`)
  }
})

test('item-only pending transcript operations preserve independent turns and ignore unknown turns', async () => {
  const { reduceSession, runtimeId, sessionId, turnId } = await import('@harnessdesk/protocol')
  const module = await import('../src/pending-item-deltas.js') as unknown as { PendingTranscriptItems?: new () => { add(event: import('@harnessdesk/protocol').AgentEvent): void; apply(session: import('@harnessdesk/protocol').Session): import('@harnessdesk/protocol').Session } }
  assert.equal(typeof module.PendingTranscriptItems, 'function')
  const pending = new module.PendingTranscriptItems!()
  const id = sessionId('s'), a = turnId('a'), b = turnId('b')
  const itemA = { id: itemId('a'), type: 'assistantMessage', text: 'a' } as AgentItem
  const itemB = { id: itemId('b'), type: 'assistantMessage', text: 'b' } as AgentItem
  let state = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: a, status: 'completed', items: [itemA] }, { id: b, status: 'completed', items: [itemB] }] } as import('@harnessdesk/protocol').Session
  const events: import('@harnessdesk/protocol').AgentEvent[] = [
    { type: 'item/delta', sessionId: id, turnId: b, itemId: itemB.id, delta: { kind: 'assistantText', text: '2' } },
    { type: 'item/completed', sessionId: id, turnId: a, item: { id: itemId('new'), type: 'assistantMessage', text: 'new' } },
    { type: 'item/completed', sessionId: id, turnId: turnId('missing'), item: { id: itemId('ignored'), type: 'assistantMessage', text: 'ignored' } },
  ]
  const original = state
  for (const event of events) { pending.add(event); state = reduceSession(state, event) }
  assert.deepEqual(pending.apply(original), state)
})

test('pending turn diff and plan replacements coexist with item updates', async () => {
  const { reduceSession, runtimeId, sessionId, turnId } = await import('@harnessdesk/protocol')
  const { PendingTranscriptItems } = await import('../src/pending-item-deltas.js')
  const pending = new PendingTranscriptItems(), id = sessionId('s'), tid = turnId('t')
  const original = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'completed', items: [{ id: itemId('a'), type: 'assistantMessage', text: 'a' }] }] } as import('@harnessdesk/protocol').Session
  const events: import('@harnessdesk/protocol').AgentEvent[] = [
    { type: 'turn/diff', sessionId: id, turnId: tid, diff: 'old' },
    { type: 'item/delta', sessionId: id, turnId: tid, itemId: itemId('a'), delta: { kind: 'assistantText', text: 'b' } },
    { type: 'turn/plan', sessionId: id, turnId: tid, steps: [] },
    { type: 'turn/diff', sessionId: id, turnId: tid, diff: 'new' },
  ]
  for (const event of events) pending.add(event)
  assert.deepEqual(pending.apply(original), events.reduce(reduceSession, original))
})

test('pending file patches retain original path order and ignore deltas for missing items', async () => {
  const { reduceSession, runtimeId, sessionId, turnId } = await import('@harnessdesk/protocol')
  const { PendingItemChanges } = await import('../src/pending-item-deltas.js')
  const pending = new PendingItemChanges(), id = sessionId('s'), tid = turnId('t')
  const base = { id: itemId('f'), type: 'fileChange', status: 'inProgress', changes: [
    { path: 'x', kind: { type: 'update' }, diff: 'old' }, { path: 'y', kind: { type: 'add' }, diff: 'old' },
  ] } as AgentItem
  let state = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'completed', items: [base] }] } as import('@harnessdesk/protocol').Session
  const deltas: ItemDelta[] = [
    { kind: 'fileChangePatch', changes: [{ path: 'y', kind: { type: 'update' }, diff: 'new' }, { path: 'z', kind: { type: 'add' }, diff: 'one' }] },
    { kind: 'fileChangePatch', changes: [{ path: 'x', kind: { type: 'delete' }, diff: '' }, { path: 'z', kind: { type: 'update' }, diff: 'two' }] },
  ]
  for (const delta of deltas) { pending.add(delta); state = reduceSession(state, { type: 'item/delta', sessionId: id, turnId: tid, itemId: base.id, delta }) }
  assert.deepEqual(pending.apply(base), state.turns[0]?.items[0])
  assert.equal(pending.apply(undefined), undefined)
})

test('pending data reports protected UTF-8 pressure without retaining event history', async () => {
  const { PendingItemDeltas } = await import('../src/pending-item-deltas.js')
  const pending = new PendingItemDeltas()
  for (let i = 0; i < 1000; i++) pending.add({ kind: 'assistantText', text: 'é' })
  const measured = pending as unknown as { readonly protectedBytes?: number; readonly operationCount: number }
  assert.equal(typeof measured.protectedBytes, 'number', 'pending bytes are observable as protected pressure')
  assert.ok(measured.protectedBytes! >= 2000)
  assert.equal(measured.operationCount, 1)
})

test('pending turn lifecycle composes with interleaved item updates', async () => {
  const { reduceSession, runtimeId, sessionId, turnId } = await import('@harnessdesk/protocol')
  const { PendingSessionOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s'), tid = turnId('t')
  const original = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'completed', items: [{ id: itemId('old'), type: 'assistantMessage', text: 'old' }] }] } as import('@harnessdesk/protocol').Session
  const events: import('@harnessdesk/protocol').AgentEvent[] = [
    { type: 'turn/started', sessionId: id, turn: { id: tid, status: 'inProgress', items: [] } },
    { type: 'item/started', sessionId: id, turnId: tid, item: { id: itemId('new'), type: 'assistantMessage', text: '' } },
    { type: 'item/delta', sessionId: id, turnId: tid, itemId: itemId('new'), delta: { kind: 'assistantText', text: 'new' } },
    { type: 'turn/completed', sessionId: id, turn: { id: tid, status: 'completed', items: [] } },
  ]
  const pending = new PendingSessionOverlay(recoveryDescriptor(original))
  for (const event of events) pending.apply(event)
  assert.deepEqual(pending.materialize(original), events.reduce(reduceSession, original))
})
