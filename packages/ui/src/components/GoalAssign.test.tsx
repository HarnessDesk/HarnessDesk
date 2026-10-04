import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GoalView, SessionSummary } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { GoalAssign } from './GoalAssign'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement; let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
const summary = (id: string, cwd = '/repo'): SessionSummary => ({ id, runtime: 'codex', title: id, preview: null, cwd, status: { type: 'idle' }, createdAt: 1, updatedAt: 1, git: null, repo: { root: '/repo' }, archived: false }) as SessionSummary
const goal = { goal: { id: 'g1', root: '/repo' }, members: [{ session: { runtime: 'codex', sessionId: 'member' }, closed: null }] } as unknown as GoalView

it('offers unfiltered loose same-project history and keeps refusal visible', async () => {
  const snapshot = { ...emptySnapshot(), history: [summary('loose'), summary('member'), summary('other', '/other')], workspaces: [{ path: '/repo', name: 'repo', lastOpenedAt: 1 }], workspace: { path: '/repo', name: 'repo', lastOpenedAt: 1 }, listPrefs: { ...emptySnapshot().listPrefs, agent: 'claude' } } as unknown as AppSnapshot
  const assignGoal = vi.fn(async () => { throw new Error('That conversation became busy.') })
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, assignGoal } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><GoalAssign view={goal} card={4} onClose={vi.fn()} /></StoreProvider>))
  const group = document.querySelector('[role="radiogroup"][aria-label="Conversation"]')
  expect(group).not.toBeNull()
  expect(group?.getAttribute('data-slot')).toBe('choice-list')
  expect(document.body.textContent).toContain('loose')
  expect(document.body.textContent).not.toContain('member')
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(one => one.textContent?.includes('loose'))!
  expect(option.getAttribute('data-slot')).toBe('choice-row')
  expect(option.getAttribute('aria-checked')).toBe('false')
  // Nothing chosen yet, and the keyboard can still reach the list: the first
  // row is the group's one Tab stop.
  const radios = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  expect(radios.map((one) => one.tabIndex)).toEqual([0, ...radios.slice(1).map(() => -1)])
  act(() => option.click())
  expect(option.getAttribute('aria-checked')).toBe('true')
  act(() => [...document.querySelectorAll('button')].find(one => one.textContent === 'Assign')!.click())
  await act(async () => {})
  expect(assignGoal).toHaveBeenCalledWith('g1', 4, { runtime: 'codex', sessionId: 'loose' })
  expect(document.body.textContent).toContain('became busy')
})

/* A Run that ends wraps its Team, even under a person who is choosing a
   conversation for a card. The card is the Team's record by then, so what is
   left of the choice is not an assignment (#1317, round 1). */
it('stops assigning when the Team wraps while a conversation is chosen', async () => {
  let snapshot = { ...emptySnapshot(), history: [summary('loose')], workspaces: [{ path: '/repo', name: 'repo', lastOpenedAt: 1 }], workspace: { path: '/repo', name: 'repo', lastOpenedAt: 1 } } as unknown as AppSnapshot
  const listeners = new Set<() => void>()
  const assignGoal = vi.fn(async () => {})
  const store = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => snapshot,
    assignGoal,
  } as unknown as AppStore
  const onClose = vi.fn()
  act(() => root.render(<StoreProvider store={store}><GoalAssign view={goal} card={4} onClose={onClose} /></StoreProvider>))
  act(() => document.querySelector<HTMLButtonElement>('[role="radio"]')!.click())
  const assign = (): HTMLButtonElement => [...document.querySelectorAll('button')].find(one => one.textContent === 'Assign')! as HTMLButtonElement
  expect(assign().disabled).toBe(false)
  expect(document.body.textContent).not.toContain('This Team is wrapped')

  snapshot = { ...snapshot, goals: new Map([['g1', { goal: { state: 'wrapped' }, members: [] } as unknown as GoalView]]) }
  act(() => listeners.forEach((listener) => listener()))

  expect(assign().disabled).toBe(true)
  expect(assign().title).toBe('This Team is wrapped')
  expect(document.body.textContent).toContain('This Team is wrapped')
  await act(async () => { assign().click() })
  expect(assignGoal).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
})

/* A conversation a wrapped Team keeps is that Team's record, not a loose conversation: the host refuses to seat it for
   another Team's card, so the dialog does not offer it only to be told no (#1317, round 3). Both ways a receipt names
   a conversation count — the one recorded for a Seat, and the one an older receipt's answer came from. */
it('does not offer a conversation a wrapped Team keeps', () => {
  const wrapped = {
    goal: { id: 'old', root: '/repo', state: 'wrapped' }, members: [],
    receipt: {
      seats: ['seat', 'older'],
      members: [{ seat: 'seat', session: { runtime: 'codex', sessionId: 'kept-by-seat' } }, { seat: 'older' }],
      answers: [{ seat: 'older', session: { runtime: 'codex', sessionId: 'kept-by-answer' } }],
    },
  } as unknown as GoalView
  const snapshot = {
    ...emptySnapshot(), history: [summary('first-free'), summary('kept-by-seat'), summary('kept-by-answer'), summary('second-free')],
    workspaces: [{ path: '/repo', name: 'repo', lastOpenedAt: 1 }], workspace: { path: '/repo', name: 'repo', lastOpenedAt: 1 },
    goals: new Map([['old', wrapped]]),
  } as unknown as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, assignGoal: vi.fn() } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><GoalAssign view={goal} card={4} onClose={vi.fn()} /></StoreProvider>))
  const offered = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].map((one) => one.textContent ?? '')
  expect(offered).toHaveLength(2)
  expect(offered[0]).toContain('first-free')
  expect(offered[1]).toContain('second-free')
  expect(document.body.textContent).not.toContain('kept-by-seat')
  expect(document.body.textContent).not.toContain('kept-by-answer')
})

/* Only a wrapped Team's record keeps a conversation out of the list: how the dialog treats a conversation that an open
   Team lists is not changed by it. */
it('keeps offering a conversation that only an open Team lists', () => {
  const open = {
    goal: { id: 'other', root: '/repo', state: 'open' }, receipt: null,
    members: [{ session: { runtime: 'codex', sessionId: 'free' }, closed: null }],
  } as unknown as GoalView
  const snapshot = {
    ...emptySnapshot(), history: [summary('free')],
    workspaces: [{ path: '/repo', name: 'repo', lastOpenedAt: 1 }], workspace: { path: '/repo', name: 'repo', lastOpenedAt: 1 },
    goals: new Map([['other', open]]),
  } as unknown as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, assignGoal: vi.fn() } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><GoalAssign view={goal} card={4} onClose={vi.fn()} /></StoreProvider>))
  expect([...document.querySelectorAll('[role="radio"]')].map((one) => one.textContent)).toEqual([expect.stringContaining('free')])
})
