import { describe, expect, it, vi } from 'vitest'
import type { LeadInbox } from '@harnessdesk/protocol'
import { inboxWaiting } from './use-inbox-waiting'

const inbox: LeadInbox = { version: 1, needsYou: 3, items: [
  { id: 'ask:m1', kind: 'ask', title: 'Which branch?', at: 3, needsYou: true, target: 'm1' },
  { id: 'team:goal-game', kind: 'team', title: 'build a game', project: 'Widgets', at: 2, needsYou: true, target: 'goal-game' },
  { id: 'chat:codex:s1', kind: 'chat', title: '\x1b[31mFix\n the tests', at: 1, needsYou: true, target: 'codex:s1' },
  { id: 'notice:n1', kind: 'notice', title: 'Usage is high', at: 0, needsYou: false },
] }

describe('inboxWaiting', () => {
  it('lists only what needs the person, as plain text, and opens each where it lives', () => {
    const open = { lead: vi.fn(), team: vi.fn(), chat: vi.fn() }
    const rows = inboxWaiting(inbox, open)
    expect(rows.map(row => row.id)).toEqual(['ask:m1', 'team:goal-game', 'chat:codex:s1'])
    expect(rows[1]!.place).toBe('Widgets')
    expect(rows[2]!.title).not.toContain('\x1b')
    rows.forEach(row => row.onOpen?.())
    expect(open.lead).toHaveBeenCalledTimes(1)
    expect(open.team).toHaveBeenCalledWith('goal-game')
    expect(open.chat).toHaveBeenCalledWith('codex', 's1')
  })

  it('lists nothing before the desk has answered', () => {
    expect(inboxWaiting(null, { lead: vi.fn(), team: vi.fn(), chat: vi.fn() })).toEqual([])
  })
})

describe('useInboxWaiting', () => {
  it('reads nothing and throws nothing when the store has no transport or Lead yet', async () => {
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { StoreProvider } = await import('../state/context')
    const { emptySnapshot } = await import('../state/store')
    const { useInboxWaiting } = await import('./use-inbox-waiting')
    vi.useFakeTimers()
    const snapshot = { ...emptySnapshot(), status: 'open' }
    const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as never
    const seen: number[] = []
    const Probe = () => { seen.push(useInboxWaiting().rows.length); return null }
    const host = document.createElement('div'), root = createRoot(host)
    act(() => root.render(<StoreProvider store={store}><Probe /></StoreProvider>))
    expect(() => act(() => { vi.advanceTimersByTime(60_000) })).not.toThrow()
    act(() => root.unmount())
    vi.useRealTimers()
    expect(seen.every(count => count === 0)).toBe(true)
  })
})

describe('useLeadInbox after an answer', () => {
  it('#2105: reads the inbox again when what became of a question changes, so an answered question leaves the bell at once', async () => {
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { StoreProvider } = await import('../state/context')
    const { emptySnapshot } = await import('../state/store')
    const { useLeadInbox } = await import('./use-inbox-waiting')
    vi.useFakeTimers()
    const snapshot = { ...emptySnapshot(), status: 'open' }
    const listeners = new Set<() => void>()
    let lead = { revision: 4, stage: 'idle', personActions: [], away: { version: 1, digest: null, brief: { enabled: false, at: '07:30' }, asks: [{ id: 'm4', status: 'open' }] } }
    const reads: string[] = []
    const store = { subscribe: () => () => {}, getSnapshot: () => snapshot,
      lead: { subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, get state() { return lead } },
      transport: { request: async (method: string) => { reads.push(method); return { version: 1, needsYou: 0, items: [] } } } } as never
    const Probe = () => { useLeadInbox(); return null }
    const host = document.createElement('div'), root = createRoot(host)
    act(() => root.render(<StoreProvider store={store}><Probe /></StoreProvider>))
    await act(async () => { vi.advanceTimersByTime(500) })
    const before = reads.length
    // The phone answered: the thread's revision has not moved yet, but the desk's record of the question has.
    lead = { ...lead, away: { ...lead.away, asks: [{ id: 'm4', status: 'answered' }] } }
    act(() => { for (const listener of listeners) listener() })
    await act(async () => { vi.advanceTimersByTime(500) })
    act(() => root.unmount())
    vi.useRealTimers()
    expect(reads.length).toBe(before + 1)
  })
})
