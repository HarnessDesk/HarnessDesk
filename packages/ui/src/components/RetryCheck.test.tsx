import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FlowPreview } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { RetryCheck, RunAgain } from './RetryCheck'

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

const settle = (): Promise<void> => act(async () => {})
const button = (label: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll('button')].find((one) => one.textContent === label)

const DOCUMENT = { format: 'agents' as const, flow: { version: 2 as const, name: 'Fix', inputs: [], roles: [], rules: [], seed: { role: 'fixer', title: 'Go' }, messaging: 'board-only' as const, wait: 240 } }
const CONSENT: FlowPreview = {
  token: 'consent-1', compiled: { document: DOCUMENT, bindings: [], problems: [] }, seats: [], guards: [], messaging: 'board-only', problems: [],
  commands: [{ role: 'verify', run: 'pnpm verify --filter "app"', cwd: '/repo', timeout: 600 }],
}
const storeWith = (preview: FlowPreview | Error) => {
  const previewFlowRetry = vi.fn(async () => { if (preview instanceof Error) throw preview; return preview })
  const retryFlowCheck = vi.fn(async () => ({}))
  const store = { subscribe: () => () => {}, getSnapshot: () => emptySnapshot(), previewFlowRetry, retryFlowCheck } as unknown as AppStore
  return { store, previewFlowRetry, retryFlowCheck }
}
const render = async (store: AppStore, child: ReactNode): Promise<void> => {
  act(() => root.render(<StoreProvider store={store}>{child}</StoreProvider>))
  await settle()
}

for (const state of ['stopped', 'settled']) it(`the consent dialog explains a ${state} refusal, keeps its answer disabled and never starts a check`, async () => {
  const text = `This run is ${state}. Start a new run to run this check again.`
  const { store, retryFlowCheck } = storeWith({ ...CONSENT, token: null, commands: [], problems: [{ level: 'error', at: 'run', text }] })
  await render(store, <RetryCheck run="run-1" card={3} onClose={() => {}} />)
  expect(document.body.textContent).toContain(text)
  expect(button('Run again')!.disabled).toBe(true)
  act(() => button('Run again')!.click())
  await settle()
  expect(retryFlowCheck).not.toHaveBeenCalled()
})

it('a refusal the host sends as an error keeps the answer disabled and says what the host said', async () => {
  const { store, retryFlowCheck } = storeWith(new Error('This Team is wrapped.'))
  await render(store, <RetryCheck run="run-1" card={3} onClose={() => {}} />)
  expect(document.body.textContent).toContain('This Team is wrapped.')
  expect(button('Run again')!.disabled).toBe(true)
  expect(retryFlowCheck).not.toHaveBeenCalled()
})

it('shows the command verbatim, and starts that check with the consent token the host minted, then closes', async () => {
  const { store, previewFlowRetry, retryFlowCheck } = storeWith(CONSENT)
  const onClose = vi.fn()
  await render(store, <RetryCheck run="run-1" card={3} onClose={onClose} />)
  expect(previewFlowRetry).toHaveBeenCalledWith('run-1', 3)
  expect(document.body.textContent).toContain('pnpm verify --filter "app" — in /repo, 600s')
  expect(button('Run again')!.disabled).toBe(false)
  act(() => button('Run again')!.click())
  await settle()
  expect(retryFlowCheck).toHaveBeenCalledWith('run-1', 3, 'consent-1')
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('a check that may be asked again offers Run again…, and nothing runs until the person confirms', async () => {
  const { store, previewFlowRetry, retryFlowCheck } = storeWith(CONSENT)
  await render(store, <RunAgain run="run-1" card={3} refusal={null} />)
  expect(previewFlowRetry).not.toHaveBeenCalled()
  const again = button('Run again…')!
  expect(again.disabled).toBe(false)
  act(() => again.click())
  await settle()
  expect(previewFlowRetry).toHaveBeenCalledWith('run-1', 3)
  expect(document.body.textContent).toContain('Run this check again?')
  expect(retryFlowCheck).not.toHaveBeenCalled()
  act(() => button('Keep')!.click())
  await settle()
  expect(document.body.textContent).not.toContain('Run this check again?')
})

it('a check that cannot run again keeps its control, disabled, with the reason on screen — and opens nothing', async () => {
  const reason = 'The checkout moved. Read it before trying again.'
  const { store, previewFlowRetry } = storeWith(CONSENT)
  await render(store, <RunAgain run="run-1" card={3} refusal={reason} />)
  const again = button('Run again…')!
  expect(again.hasAttribute('disabled') || again.getAttribute('aria-disabled') === 'true').toBe(true)
  // On screen, not only for a screen reader: the refused control's tooltip repeats it in text no one sees.
  const shown = [...container.querySelectorAll('*')].filter((one) => one.children.length === 0 && one.textContent === reason)
  expect(shown.some((one) => !one.closest('.sr-only'))).toBe(true)
  act(() => again.click())
  await settle()
  expect(previewFlowRetry).not.toHaveBeenCalled()
  expect(document.body.textContent).not.toContain('Run this check again?')
})

it('on a timeline row a refused check shows no control at all, because the inspector is where the reason is read', async () => {
  const { store } = storeWith(CONSENT)
  await render(store, <RunAgain run="run-1" card={3} refusal="This check is not waiting to be run again." onRow />)
  expect(container.innerHTML).toBe('')
  await render(store, <RunAgain run="run-1" card={3} refusal={null} onRow />)
  expect(button('Run again…')).toBeDefined()
})

for (const reason of ['This run is settled. Start a new run to run this check again.', 'This Team is wrapped']) {
  it(`keeps the terminal refusal without a retry act: ${reason}`, async () => {
    const { store, previewFlowRetry } = storeWith(CONSENT)
    await render(store, <RunAgain run="run-1" card={3} refusal={reason} terminal />)
    expect(container.textContent).toContain(reason)
    expect(button('Run again…')).toBeUndefined()
    expect(previewFlowRetry).not.toHaveBeenCalled()
  })
}
it('uses lifecycle state rather than refusal wording when a mounted Run ends', async () => {
  const { store } = storeWith(CONSENT)
  const reason = 'This check is not waiting to be run again.'
  await render(store, <RunAgain run="run-1" card={3} refusal={reason} />)
  expect(button('Run again…')).toBeDefined()
  await render(store, <RunAgain run="run-1" card={3} refusal={reason} terminal />)
  expect(button('Run again…')).toBeUndefined()
  expect(container.textContent).toContain(reason)
})

for (const onRow of [false, true]) for (const state of ['settled', 'stopped']) {
  it(`keeps open consent explained and focused when the ${onRow ? 'timeline' : 'inspector'} Run becomes ${state}`, async () => {
    const { store, retryFlowCheck } = storeWith(CONSENT)
    await render(store, <RunAgain run="run-1" card={3} refusal={null} onRow={onRow} />)
    act(() => button('Run again…')!.click())
    await settle()
    const confirm = button('Run again')!
    act(() => confirm.focus())
    const reason = `This run is ${state}. Start a new run to run this check again.`
    await render(store, <RunAgain run="run-1" card={3} refusal={reason} terminal onRow={onRow} />)
    const dialog = document.body.querySelector('[role="alertdialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain(reason)
    expect(button('Run again')!.disabled).toBe(true)
    expect(dialog.contains(document.activeElement)).toBe(true)
    act(() => button('Run again')!.click())
    await settle()
    expect(retryFlowCheck).not.toHaveBeenCalled()
    act(() => button('Keep')!.click())
    await settle()
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(button('Run again…')).toBeUndefined()
  })
}
