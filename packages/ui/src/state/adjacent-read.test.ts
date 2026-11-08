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
