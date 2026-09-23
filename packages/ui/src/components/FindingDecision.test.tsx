import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FindingRunView } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { FindingDecision } from './FindingDecision'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement; let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const view = (over: Partial<FindingRunView> = {}): FindingRunView => ({
  run: 'run-1', goal: 'g1', round: 2, finished: 1, total: 3, embargoed: false, open: 1, blocking: 1,
  reason: 'Round 2 ended with 1 open finding.', stamp: 'stamp-1', publication: 'posted',
  reviewersFinished: null, reviewersTotal: null,
  ...over,
})

const rig = (decideFindingRun: (input: unknown) => Promise<FindingRunView>): AppStore => {
  const snapshot = emptySnapshot()
  return { subscribe: () => () => {}, getSnapshot: () => snapshot, decideFindingRun } as unknown as AppStore
}

const render = (store: AppStore, props: { goal: string; view: FindingRunView; onClose: () => void }): void => {
  act(() => { root.render(<StoreProvider store={store}><FindingDecision {...props} /></StoreProvider>) })
}

it('a blank reason refuses before any request, and a filled one dispatches exactly once per click', async () => {
  const decideFindingRun = vi.fn(async () => view())
  const store = rig(decideFindingRun as never)
  const onClose = vi.fn()
  render(store, { goal: 'g1', view: view(), onClose })

  const another = [...document.querySelectorAll('button')].find((one) => one.textContent === 'Authorise another round')!
  act(() => another.click())
  expect(decideFindingRun).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Say why.')

  const textarea = document.querySelector('textarea')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'the ceiling was reached, one more try')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { another.click() })
  expect(decideFindingRun).toHaveBeenCalledTimes(1)
  expect(decideFindingRun).toHaveBeenCalledWith({
    goal: 'g1', run: 'run-1', round: 2, stamp: 'stamp-1',
    action: { kind: 'another-round' }, reason: 'the ceiling was reached, one more try',
  })
})

it('a refused decision keeps the dialog open and shows the reason, never a silent failure', async () => {
  const decideFindingRun = vi.fn(async () => { throw new Error('This run changed since you read it. Read it again before deciding.') })
  const store = rig(decideFindingRun as never)
  const onClose = vi.fn()
  render(store, { goal: 'g1', view: view(), onClose })
  const textarea = document.querySelector('textarea')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'drop it')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const drop = [...document.querySelectorAll('button')].find((one) => one.textContent === 'Drop')!
  await act(async () => { drop.click() })
  expect(document.body.textContent).toContain('changed since you read it')
  expect(onClose).not.toHaveBeenCalled()
})

it('a local-only Goal greys Merge anyway with its reason, and Drop remains available', () => {
  const store = rig((async () => view()) as never)
  render(store, { goal: 'g1', view: view({ publication: 'local' }), onClose: () => {} })
  const merge = [...document.querySelectorAll('button')].find((one) => one.textContent === 'Merge anyway')! as HTMLButtonElement
  expect(merge.disabled).toBe(true)
  expect(merge.title).toContain('Publish a pull request')
  const drop = [...document.querySelectorAll('button')].find((one) => one.textContent === 'Drop')! as HTMLButtonElement
  expect(drop.disabled).toBe(false)
})
