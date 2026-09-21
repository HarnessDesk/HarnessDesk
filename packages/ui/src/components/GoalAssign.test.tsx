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
  expect(document.body.textContent).toContain('loose')
  expect(document.body.textContent).not.toContain('member')
  act(() => [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find(one => one.getAttribute('aria-label') === 'loose')!.click())
  act(() => [...document.querySelectorAll('button')].find(one => one.textContent === 'Assign')!.click())
  await act(async () => {})
  expect(assignGoal).toHaveBeenCalledWith('g1', 4, { runtime: 'codex', sessionId: 'loose' })
  expect(document.body.textContent).toContain('became busy')
})
