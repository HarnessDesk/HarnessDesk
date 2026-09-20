import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GoalView, WrapPreview } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { choicesOf, GoalWrap } from './GoalWrap'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement; let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const view = {
  goal: { id: 'g1', root: '/repo', cwd: '/repo', sentence: 'Ship', state: 'open', revision: 1, checkout: 'shared', dependsOn: [], origin: { kind: 'person' }, createdAt: 1, updatedAt: 2, receipt: null },
  activity: 'ready-to-wrap', waitingOn: [], members: [],
  board: { id: 'g1', name: 'Ship', root: '/repo', updatedAt: 2, members: [], messaging: true, intents: [
    { id: 1, title: 'Done', state: 'done', files: [], dependsOn: [], updatedAt: 1 },
    { id: 2, title: 'Open', state: 'open', files: [], dependsOn: [], updatedAt: 1 },
  ], channel: [] },
  receipt: null, problem: null,
} as unknown as GoalView
const type = (field: HTMLTextAreaElement | HTMLInputElement, value: string): void => {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

it('keeps preview and final wrap as separate decisions and invalidates an edited preview', async () => {
  expect(choicesOf({ summary: '', cards: new Map() })).toBeNull()
  const preview = { stamp: 's1', receipt: { version: 1, goal: 'g1', sentence: 'Ship', summary: 'Finished', cards: [{ id: 1, resolution: 'finished', reason: null }, { id: 2, resolution: 'dropped', reason: 'No longer needed' }], seats: [], evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [] } } as WrapPreview
  const store = {
    subscribe: () => () => {}, getSnapshot: () => emptySnapshot(),
    previewGoalWrap: vi.fn(async () => preview), wrapGoal: vi.fn(async () => ({ ...preview.receipt, id: 'r1', wrappedAt: 3 })),
  } as unknown as AppStore
  const close = vi.fn()
  act(() => root.render(<StoreProvider store={store}><GoalWrap view={view} onClose={close} /></StoreProvider>))
  const summary = document.querySelector<HTMLTextAreaElement>('[aria-label="What finished"]')!
  act(() => type(summary, 'Finished'))
  const selects = [...document.querySelectorAll<HTMLSelectElement>('select')]
  act(() => { selects[1]!.value = 'dropped'; selects[1]!.dispatchEvent(new Event('change', { bubbles: true })) })
  const reason = document.querySelector<HTMLInputElement>('[aria-label="Reason for dropping Open"]')!
  act(() => type(reason, 'No longer needed'))
  act(() => [...document.querySelectorAll('button')].find((one) => one.textContent === 'Review receipt')!.click())
  await act(async () => {})
  expect(store.previewGoalWrap).toHaveBeenCalledTimes(1)
  expect(store.wrapGoal).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('As recorded when wrapped')
  act(() => [...document.querySelectorAll('button')].find((one) => one.textContent === 'Edit')!.click())
  expect(document.body.textContent).not.toContain('As recorded when wrapped')
})

it('sends one final commit and preserves the draft on a stale stamp refusal', async () => {
  const preview = { stamp: 'old', receipt: { version: 1, goal: 'g1', sentence: 'Ship', summary: 'Finished', cards: [{ id: 1, resolution: 'finished', reason: null }, { id: 2, resolution: 'finished', reason: null }], seats: [], evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [] } } as WrapPreview
  const store = { subscribe: () => () => {}, getSnapshot: () => emptySnapshot(), previewGoalWrap: vi.fn(async () => preview), wrapGoal: vi.fn(async () => { throw new Error('This Goal changed while you reviewed its receipt.') }) } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><GoalWrap view={view} onClose={vi.fn()} /></StoreProvider>))
  const summary = document.querySelector<HTMLTextAreaElement>('[aria-label="What finished"]')!
  act(() => type(summary, 'Finished'))
  const second = [...document.querySelectorAll<HTMLSelectElement>('select')][1]!
  act(() => { second.value = 'finished'; second.dispatchEvent(new Event('change', { bubbles: true })) })
  act(() => [...document.querySelectorAll('button')].find((one) => one.textContent === 'Review receipt')!.click())
  await act(async () => {})
  const wrap = [...document.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent === 'Wrap Goal')!
  act(() => { wrap.click(); wrap.click() })
  await act(async () => {})
  expect(store.wrapGoal).toHaveBeenCalledTimes(1)
  expect(document.body.textContent).toContain('changed while you reviewed')
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="What finished"]')?.value).toBe('Finished')
})
