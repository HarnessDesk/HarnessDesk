import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FindingPublicationsView } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { FindingPublications } from './FindingPublications'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement; let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const KEY = `pub-${'a'.repeat(48)}`
const STAMP = 'b'.repeat(64)

const view = (over: Partial<FindingPublicationsView> = {}): FindingPublicationsView => ({
  goal: 'g1', run: 'run-1',
  items: [{
    key: KEY, round: 2, finding: 'finding-0001', pr: 7, state: 'uncertain',
    reason: 'The desk may have posted this before it was interrupted, and the pull request shows no copy of it. Look at the pull request before posting it again.',
  }],
  backfill: null, backfillRefusal: 'Every closed round of this run was posted or refused when it closed; none is kept on the desk.',
  ...over,
})

const rig = (read: () => Promise<FindingPublicationsView>, publish: (input: unknown) => Promise<FindingPublicationsView>): AppStore => {
  const snapshot = emptySnapshot()
  return {
    subscribe: () => () => {}, getSnapshot: () => snapshot,
    readFindingPublications: vi.fn(read), publishFinding: vi.fn(publish),
  } as unknown as AppStore
}

const render = async (store: AppStore): Promise<void> => {
  await act(async () => { root.render(<StoreProvider store={store}><FindingPublications goal="g1" run="run-1" stamp="s1" /></StoreProvider>) })
}

const button = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll('button')].find((one) => one.textContent === label)! as HTMLButtonElement

const type = (textarea: HTMLTextAreaElement, text: string): void => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('reads the run’s postings explicitly and shows each one needing a person with the desk’s reason, whole', async () => {
  const store = rig(async () => view(), async () => view())
  await render(store)
  expect(store.readFindingPublications).toHaveBeenCalledWith('g1', 'run-1')
  expect(container.textContent).toContain('finding-0001')
  expect(container.textContent).toContain('Look at the pull request before posting it again.')
  expect(button('Post again')).toBeTruthy()
  expect(button('Skip…')).toBeTruthy()
})

it('Post again sends exactly the operation shown, once per press, and a refusal stays visible', async () => {
  const publish = vi.fn(async () => { throw new Error('The pull request shows 2 copies of this. Look at them before deciding which one stands.') })
  const store = rig(async () => view(), publish)
  await render(store)
  await act(async () => { button('Post again').click() })
  expect(publish).toHaveBeenCalledTimes(1)
  expect(publish).toHaveBeenCalledWith({ goal: 'g1', run: 'run-1', action: { kind: 'post-again', key: KEY } })
  expect(container.textContent).toContain('shows 2 copies')
})

it('Skip asks why before anything is recorded, then records exactly that', async () => {
  const publish = vi.fn(async () => view({ items: [] }))
  const store = rig(async () => view(), publish)
  await render(store)
  act(() => button('Skip…').click())
  const skip = button('Skip it')
  expect(skip.disabled).toBe(true)
  type(document.querySelector('textarea')!, 'nobody needs this on the pull request')
  await act(async () => { button('Skip it').click() })
  expect(publish).toHaveBeenCalledWith({ goal: 'g1', run: 'run-1', action: { kind: 'skip', key: KEY, reason: 'nobody needs this on the pull request' } })
  expect(container.textContent).toContain('Nothing here needs you.')
})

it('a round kept on the desk is posted only after its preview is confirmed, with the previewed stamp', async () => {
  const backfill = { pr: 7, rounds: [{ round: 2, findings: 2, reviews: 2 }], stamp: STAMP }
  const publish = vi.fn(async () => view({ items: [], backfill: null }))
  const store = rig(async () => view({ items: [], backfill, backfillRefusal: null }), publish)
  await render(store)
  act(() => button('Post earlier rounds…').click())
  expect(document.body.textContent).toContain('Round 2: 2 findings and 2 reviews')
  expect(publish).not.toHaveBeenCalled()
  await act(async () => { button('Post to #7').click() })
  expect(publish).toHaveBeenCalledWith({ goal: 'g1', run: 'run-1', action: { kind: 'backfill', stamp: STAMP } })
})
