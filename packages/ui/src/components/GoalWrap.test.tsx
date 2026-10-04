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
  expect(document.querySelector('[data-slot="goal-receipt"]')).not.toBeNull()
  act(() => [...document.querySelectorAll('button')].find((one) => one.textContent === 'Edit')!.click())
  expect(document.querySelector('[data-slot="goal-receipt"]')).toBeNull()
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

/*
 * A Run that ends wraps its Team too, even under a person who has the receipt
 * open for review. Wrapping a Team that is wrapped is not a decision left to
 * make, so the question stays on screen and says so (#1317, round 1).
 */
it('stops offering to wrap a Goal that is wrapped while its receipt is under review', async () => {
  const preview = { stamp: 's1', receipt: { version: 1, goal: 'g1', sentence: 'Ship', summary: 'Finished', cards: [{ id: 1, resolution: 'finished', reason: null }, { id: 2, resolution: 'finished', reason: null }], seats: [], evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [] } } as WrapPreview
  const store = { subscribe: () => () => {}, getSnapshot: () => emptySnapshot(), previewGoalWrap: vi.fn(async () => preview), wrapGoal: vi.fn(async () => ({ ...preview.receipt, id: 'r1', wrappedAt: 3 })) } as unknown as AppStore
  const close = vi.fn()
  act(() => root.render(<StoreProvider store={store}><GoalWrap view={view} onClose={close} /></StoreProvider>))
  act(() => type(document.querySelector<HTMLTextAreaElement>('[aria-label="What finished"]')!, 'Finished'))
  const second = [...document.querySelectorAll<HTMLSelectElement>('select')][1]!
  act(() => { second.value = 'finished'; second.dispatchEvent(new Event('change', { bubbles: true })) })
  act(() => [...document.querySelectorAll('button')].find((one) => one.textContent === 'Review receipt')!.click())
  await act(async () => {})
  const wrap = (): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent === 'Wrap Goal')!
  expect(wrap().disabled).toBe(false)
  expect(document.body.textContent).not.toContain('This Team is wrapped')

  const wrapped = { ...view, goal: { ...view.goal, state: 'wrapped' } } as unknown as GoalView
  act(() => root.render(<StoreProvider store={store}><GoalWrap view={wrapped} onClose={close} /></StoreProvider>))

  expect(wrap().disabled).toBe(true)
  expect(wrap().title).toBe('This Team is wrapped')
  expect(document.body.textContent).toContain('This Team is wrapped')
  await act(async () => { wrap().click() })
  expect(store.wrapGoal).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
})

/*
 * The host says a Team is wrapped a moment before it answers the request that
 * wrapped it. That is this dialog's own question being answered, so it must
 * not tell the person who just pressed Wrap Goal that the Team is wrapped.
 */
it('does not announce the wrap it is itself in the middle of making', async () => {
  const preview = { stamp: 's1', receipt: { version: 1, goal: 'g1', sentence: 'Ship', summary: 'Finished', cards: [{ id: 1, resolution: 'finished', reason: null }, { id: 2, resolution: 'finished', reason: null }], seats: [], evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [] } } as WrapPreview
  let answer: () => void = () => {}
  const wrapGoal = vi.fn(() => new Promise<never>((resolve) => { answer = () => resolve(undefined as never) }))
  const store = { subscribe: () => () => {}, getSnapshot: () => emptySnapshot(), previewGoalWrap: vi.fn(async () => preview), wrapGoal } as unknown as AppStore
  const close = vi.fn()
  act(() => root.render(<StoreProvider store={store}><GoalWrap view={view} onClose={close} /></StoreProvider>))
  act(() => type(document.querySelector<HTMLTextAreaElement>('[aria-label="What finished"]')!, 'Finished'))
  const second = [...document.querySelectorAll<HTMLSelectElement>('select')][1]!
  act(() => { second.value = 'finished'; second.dispatchEvent(new Event('change', { bubbles: true })) })
  act(() => [...document.querySelectorAll('button')].find((one) => one.textContent === 'Review receipt')!.click())
  await act(async () => {})
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent === 'Wrap Goal')!.click() })
  expect(wrapGoal).toHaveBeenCalledTimes(1)

  const wrapped = { ...view, goal: { ...view.goal, state: 'wrapped' } } as unknown as GoalView
  act(() => root.render(<StoreProvider store={store}><GoalWrap view={wrapped} onClose={close} /></StoreProvider>))
  expect(document.body.textContent).not.toContain('This Team is wrapped')

  await act(async () => { answer() })
  expect(close).toHaveBeenCalledTimes(1)
})

/*
 * A card added to the Goal while its wrap dialog is open — the wrap is then
 * refused as unreviewed — joins the dialog as one more card to choose for,
 * rather than breaking it, and no receipt can be reviewed until it is chosen.
 */
it('a card added while the dialog is open is one more to choose for, never a crash', async () => {
  const store = { subscribe: () => () => {}, getSnapshot: () => emptySnapshot(), previewGoalWrap: vi.fn(), wrapGoal: vi.fn() } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><GoalWrap view={view} onClose={vi.fn()} /></StoreProvider>))
  act(() => type(document.querySelector<HTMLTextAreaElement>('[aria-label="What finished"]')!, 'Finished'))
  const pickFinished = (select: HTMLSelectElement) => act(() => { select.value = 'finished'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  pickFinished([...document.querySelectorAll<HTMLSelectElement>('select')][1]!)
  const grown = { ...view, board: { ...view.board, intents: [...view.board.intents, { id: 3, title: 'Added later', state: 'open', files: [], dependsOn: [], updatedAt: 3 }] } } as unknown as GoalView
  act(() => root.render(<StoreProvider store={store}><GoalWrap view={grown} onClose={vi.fn()} /></StoreProvider>))
  expect(document.querySelector('[aria-label="Disposition for Added later"]')).not.toBeNull()
  const review = () => [...document.querySelectorAll('button')].find((one) => one.textContent === 'Review receipt') as HTMLButtonElement
  expect(review().disabled).toBe(true)
  pickFinished(document.querySelector<HTMLSelectElement>('[aria-label="Disposition for Added later"]')!)
  expect(review().disabled).toBe(false)
})
