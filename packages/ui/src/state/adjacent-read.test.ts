import { expect, it } from 'vitest'
import { runtimeId, sessionId, type AgentEvent, type Session } from '@harnessdesk/protocol'
import { AdjacentReadChanges, reconcileAdjacentRead } from './adjacent-read'

const runtime = runtimeId('agent'), id = sessionId('conversation')
const session = (text: string, title = 'same') => ({ runtime, id, title, cwd: '/synthetic', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
  turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'item', type: 'assistantMessage', text }] }] }) as unknown as Session
const delta = { type: 'item/delta', sessionId: id, turnId: 'turn', itemId: 'item', delta: { kind: 'assistantText', text: 'x' } } as unknown as AgentEvent
const titleEvent = (title: string) => ({ type: 'session/title', sessionId: id, title }) as AgentEvent

it('refuses an unfenced divergent changed field instead of guessing', () => {
  const changes = new AdjacentReadChanges(), before = session('before'), after = session('beforex')
  changes.observe(delta, before, after)
  expect(() => reconcileAdjacentRead(after, session('different fresh text'), changes)).toThrow(/changed.*Retry/i)
})

it('keeps ABA event ownership even when the last value equals the initial value', () => {
  const changes = new AdjacentReadChanges(), first = session('text', 'A'), second = session('text', 'B'), third = session('text', 'A')
  changes.observe(titleEvent('B'), first, second)
  changes.observe(titleEvent('A'), second, third)
  expect(() => reconcileAdjacentRead(third, session('text', 'C'), changes)).toThrow(/changed.*Retry/i)
  expect(reconcileAdjacentRead(third, session('text', 'A'), changes).title).toBe('A')
})

it('retains later repeated chunks as distinct accepted changes', () => {
  const changes = new AdjacentReadChanges(), first = session('a'), second = session('ax'), third = session('axx')
  changes.observe(delta, first, second); changes.observe(delta, second, third)
  expect(reconcileAdjacentRead(third, first, changes).turns[0]?.items[0]).toMatchObject({ text: 'axx' })
  expect(reconcileAdjacentRead(third, third, changes).turns[0]?.items[0]).toMatchObject({ text: 'axx' })
})

it('accepts only observed intermediate streaming values', () => {
  const changes = new AdjacentReadChanges(), first = session('A'), middle = session('AB'), last = session('ABCD')
  changes.observe(delta, first, middle); changes.observe(delta, middle, last)
  expect(reconcileAdjacentRead(last, middle, changes).turns[0]?.items[0]).toMatchObject({ text: 'ABCD' })
  expect(() => reconcileAdjacentRead(last, session('ABC'), changes)).toThrow(/changed.*Retry/i)
})

it('accepts observed intermediate index replacements but refuses an unobserved value', () => {
  const changes = new AdjacentReadChanges(), first = session('text', 'A'), middle = session('text', 'B'), last = session('text', 'C')
  changes.observeIndex(first, middle); changes.observeIndex(middle, last)
  expect(changes.forResume().applyIndex(middle).title).toBe('C')
  expect(() => changes.applyIndex(session('text', 'D'))).toThrow(/changed.*Retry/i)
})

it.each(['turn', 'item'] as const)('accepts an observed intermediate whole %s without accepting divergence', kind => {
  const noTurn = { ...session(''), turns: [] } as Session
  const noItem = { ...session(''), turns: [{ ...session('').turns[0]!, items: [] }] } as Session
  const first = kind === 'turn' ? noTurn : noItem, a = session('A'), middle = session('AB'), last = session('ABC')
  const changes = new AdjacentReadChanges()
  const start = kind === 'turn' ? { type: 'turn/started', sessionId: id, turn: a.turns[0] } : { type: 'item/started', sessionId: id, turnId: 'turn', item: a.turns[0]!.items[0] }
  changes.observe(start as AgentEvent, first, a); changes.observe(delta, a, middle); changes.observe(delta, middle, last)
  expect(reconcileAdjacentRead(last, middle, changes).turns[0]?.items[0]).toMatchObject({ text: 'ABC' })
  expect(() => reconcileAdjacentRead(last, session('AX'), changes)).toThrow(/changed.*Retry/i)
})

it('does not combine fields from different whole-item checkpoints', () => {
  const none = { ...session(''), turns: [{ ...session('').turns[0]!, items: [] }] } as Session
  const image = (text: string, extra: string) => ({ ...session(text), turns: [{ ...session(text).turns[0]!, items: [{ id: 'item', type: 'assistantMessage', text, extra }] }] }) as unknown as Session
  const a = image('A', 'one'), b = image('AB', 'two'), c = image('ABC', 'three'), changes = new AdjacentReadChanges()
  changes.observe({ type: 'item/started', sessionId: id, turnId: 'turn', item: a.turns[0]!.items[0] } as AgentEvent, none, a)
  changes.observe(delta, a, b); changes.observe(delta, b, c)
  expect(() => reconcileAdjacentRead(c, image('AB', 'one'), changes)).toThrow(/changed.*Retry/i)
})

it('accepts an earlier field checkpoint when a later event replaces the whole item', () => {
  const first = session('A'), middle = session('AB')
  const last = { ...middle, turns: [{ ...middle.turns[0]!, items: [{ id: 'item', type: 'reasoning', text: 'replacement' }] }] } as unknown as Session
  const changes = new AdjacentReadChanges()
  changes.observe(delta, first, middle)
  changes.observe({ type: 'item/completed', sessionId: id, turnId: 'turn', item: last.turns[0]!.items[0] } as AgentEvent, middle, last)
  expect(reconcileAdjacentRead(last, first, changes).turns[0]?.items[0]).toMatchObject({ type: 'reasoning', text: 'replacement' })
})

it('accepts an earlier item checkpoint when a later event removes the whole turn', () => {
  const first = session('A'), middle = session('AB'), last = { ...middle, turns: [] } as Session
  const changes = new AdjacentReadChanges()
  changes.observe(delta, first, middle)
  changes.observe({ type: 'session/started', session: last } as AgentEvent, middle, last)
  expect(reconcileAdjacentRead(last, first, changes).turns).toEqual([])
})

it('refuses a discontinuous transition instead of recording an unobserved mutation', () => {
  const changes = new AdjacentReadChanges(), a = session('A'), b = session('AB'), skipped = session('AX'), last = session('AXC')
  changes.observe(delta, a, b); changes.observe(delta, skipped, last)
  expect(() => reconcileAdjacentRead(last, b, changes)).toThrow(/complete event sequence/i)
})

it('recognizes an intermediate JSON object with an own __proto__ key', () => {
  const image = (json: string) => ({ ...session(''), turns: [{ ...session('').turns[0]!, items: [{ id: 'item', type: 'fileChange', changes: [JSON.parse(json)] }] }] }) as unknown as Session
  const a = image('{"path":"a"}'), b = image('{"path":"b","__proto__":{"kind":"own"}}'), c = image('{"path":"c"}'), d = image('{"path":"d"}')
  const changes = new AdjacentReadChanges()
  changes.observe(delta, a, b); changes.observe(delta, b, c); changes.observe(delta, c, d)
  expect(reconcileAdjacentRead(d, b, changes).turns[0]?.items[0]).toEqual(d.turns[0]?.items[0])
})

it('refuses a journal whose replacement payload exceeds its byte budget', () => {
  const changes = new AdjacentReadChanges(), a = session('a'), b = session('b'.repeat(4 * 1024 * 1024 + 1)), c = session('c')
  changes.observe(delta, a, b); changes.observe(delta, b, c)
  expect(() => reconcileAdjacentRead(c, c, changes)).toThrow(/too much.*Retry/i)
})

it('keeps many append checkpoints compact and refuses overflow', () => {
  const changes = new AdjacentReadChanges()
  let before = session(''), middle = before
  for (let i = 1; i <= 1000; i++) {
    const after = session('x'.repeat(i * 100))
    changes.observe(delta, before, after); before = after
    if (i === 500) middle = after
  }
  expect(reconcileAdjacentRead(before, middle, changes).turns[0]?.items[0]).toMatchObject({ text: 'x'.repeat(100000) })
  for (let i = 1001; i <= 4100; i++) {
    const after = session('x'.repeat(i * 100))
    changes.observe(delta, before, after); before = after
  }
  expect(() => reconcileAdjacentRead(before, before, changes)).toThrow(/too much.*Retry/i)
})

it('treats a full session event as actual changes, not ownership of unchanged history', () => {
  const first = session('old history', 'old'), after = session('old history', 'new')
  const fresh = session('corrected history', 'old'), changes = new AdjacentReadChanges()
  changes.observe({ type: 'session/started', session: after } as AgentEvent, first, after)
  const result = reconcileAdjacentRead(after, fresh, changes)
  expect(result.title).toBe('new')
  expect(result.turns[0]?.items[0]).toMatchObject({ text: 'corrected history' })
})

it('preserves structured event fields without taking unchanged item fields', () => {
  const image = (changes: unknown[], detail: string) => ({ ...session(''), turns: [{ id: 'turn', status: 'inProgress',
    items: [{ id: 'item', type: 'fileChange', changes, detail }] }] }) as unknown as Session
  const first = image([{ path: 'one', kind: 'added' }], 'old')
  const after = image([{ path: 'one', kind: 'modified' }], 'old')
  const fresh = image([{ path: 'one', kind: 'added' }], 'fresh')
  const ownership = new AdjacentReadChanges()
  ownership.observe({ type: 'item/delta', sessionId: id, turnId: 'turn', itemId: 'item', delta: { kind: 'fileChangePatch', changes: [] } } as unknown as AgentEvent, first, after)
  expect(reconcileAdjacentRead(after, fresh, ownership).turns[0]?.items[0]).toMatchObject({ changes: [{ path: 'one', kind: 'modified' }], detail: 'fresh' })
})

it('keeps index-owned title and archive while refusing divergent fresh metadata', () => {
  const changes = new AdjacentReadChanges(), before = session('text', 'before')
  const indexed = { ...before, title: 'indexed', archived: false }
  changes.observeIndex(before, indexed)
  expect(changes.applyIndex(before)).toMatchObject({ title: 'indexed', archived: false })
  expect(changes.applyIndex(indexed)).toMatchObject({ title: 'indexed', archived: false })
  expect(() => changes.applyIndex({ ...before, title: 'different' })).toThrow(/changed.*Retry/i)
})
