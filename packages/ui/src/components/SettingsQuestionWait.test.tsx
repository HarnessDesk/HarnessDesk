import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { QuestionWait } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { QuestionWaitSection } from './SettingsQuestionWait'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const mount = (load: () => Promise<QuestionWait>, save: (value: QuestionWait) => Promise<boolean>) => {
  const snapshot = { ...emptySnapshot(), status: 'open' } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadQuestionWait: load,
    setQuestionWait: save,
  } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><QuestionWaitSection /></StoreProvider>))
}

const radios = (): HTMLButtonElement[] =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[aria-label="How long an agent’s question waits when nobody is here"] [role="radio"]')]
const chosen = (): string[] => radios().filter((one) => one.getAttribute('aria-checked') === 'true').map((one) => one.textContent ?? '')

it('reads this machine’s wait, five minutes by default, and offers stopping right away up to waiting until you are back', async () => {
  mount(vi.fn(async () => '5m' as const), vi.fn(async () => true))
  await act(async () => {})
  expect(radios().map((one) => one.textContent)).toEqual(['Not at all — stop right away', 'A minute', 'Five minutes', 'An hour', 'Until I’m back'])
  expect(chosen()).toEqual(['Five minutes'])
  expect(document.body.textContent).toContain('In a Goal a trigger opened')
})

it('keeps a choice once it is saved, and puts the old one back when the write does not land', async () => {
  const save = vi.fn(async (value: QuestionWait) => value === 'back')
  mount(vi.fn(async () => '5m' as const), save)
  await act(async () => {})
  await act(async () => { radios()[4]!.click() })
  expect(save).toHaveBeenLastCalledWith('back')
  expect(chosen()).toEqual(['Until I’m back'])
  await act(async () => { radios()[0]!.click() })
  expect(save).toHaveBeenLastCalledWith('now')
  expect(chosen()).toEqual(['Until I’m back'])
})
