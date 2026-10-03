import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { AppStore, emptySnapshot } from '../state/store'
import { Settings } from './Settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LABEL = 'Let command-line clients answer for me'
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

const mount = (load?: () => Promise<boolean>, save?: (value: boolean) => Promise<boolean>) => {
  const snapshot = { ...emptySnapshot(), status: 'open' as const }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadPolicyRules: vi.fn(async () => []),
    loadUnheldCeilings: vi.fn(async () => 'seat'),
    loadUnattendedCeilings: vi.fn(async () => 'refuse'),
    loadQuestionWait: vi.fn(async () => '5m'),
    ...(load ? { loadClientsMayAnswer: load } : {}),
    ...(save ? { setClientsMayAnswer: save } : {}),
  } as unknown as AppStore
  act(() => root.render(
    <StoreProvider store={store}>
      <Settings section="permissions" onSection={() => {}} onClose={() => {}} onSignIn={() => {}} />
    </StoreProvider>,
  ))
}

const control = (): HTMLElement => {
  const found = container.querySelector<HTMLElement>(`[role="switch"][aria-label="${LABEL}"]`)
  expect(found, 'Permissions offers the client answer preference').not.toBeNull()
  return found!
}

it('reads client answering from this desk, defaults off and accepts only literal true', async () => {
  const store = new AppStore('ws://localhost:0/')
  const values: unknown[] = [undefined, false, true, 'true', '1', 1, null, {}, []]
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async () => ({ clientsMayAnswer: values.shift() })) as never)
  const answers: boolean[] = []
  for (const _value of values.slice()) answers.push(await store.loadClientsMayAnswer())
  expect(answers).toEqual([false, false, true, false, false, false, false, false, false])
  expect(request.mock.calls.every(([method, params]) => method === 'app/state/get' && JSON.stringify(params) === '{}')).toBe(true)
})

it('an unreadable client answer preference stays off', async () => {
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockRejectedValueOnce(new Error('state is unreadable'))
  await expect(store.loadClientsMayAnswer()).resolves.toBe(false)
})

it('writes only the client answer preference and reads it back, including revocation', async () => {
  const store = new AppStore('ws://localhost:0/')
  const stored: Record<string, unknown> = { theme: 'dark' }
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: unknown) => {
    if (method === 'app/state/set') Object.assign(stored, (params as { patch: Record<string, unknown> }).patch)
    return method === 'app/state/get' ? stored : null
  }) as never)
  await expect(store.setClientsMayAnswer(true)).resolves.toBe(true)
  expect(await store.loadClientsMayAnswer()).toBe(true)
  await expect(store.setClientsMayAnswer(false)).resolves.toBe(true)
  expect(await store.loadClientsMayAnswer()).toBe(false)
  expect(stored).toEqual({ theme: 'dark', clientsMayAnswer: false })
  expect(request).toHaveBeenCalledWith('app/state/set', { patch: { clientsMayAnswer: true } })
  expect(request).toHaveBeenCalledWith('app/state/set', { patch: { clientsMayAnswer: false } })
})

it('reports a refused client answer preference write through the common preference failure notice', async () => {
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockRejectedValueOnce(new Error('writes are unavailable'))
  await expect(store.setClientsMayAnswer(true)).resolves.toBe(false)
  expect(store.getSnapshot().notices.map((notice) => notice.message).join(' ')).toContain('could not be saved')
})

it('renders one Permissions row without a second line and covers other local clients in its hover title', async () => {
  mount(vi.fn(async () => false), vi.fn(async () => true))
  await act(async () => {})
  expect(control().getAttribute('aria-checked')).toBe('false')
  const row = control().closest('[data-slot="row"]')!
  expect(row.querySelector('[data-slot="row-title"]')?.textContent).toBe(LABEL)
  expect(row.textContent).toBe(LABEL)
  expect(control().closest('[title]')?.getAttribute('title')).toContain('other local clients')
})

it('disables the switch until the stored choice has loaded', async () => {
  let finish!: (value: boolean) => void
  mount(() => new Promise((resolve) => { finish = resolve }), vi.fn(async () => true))
  await act(async () => {})
  expect(control().hasAttribute('data-disabled')).toBe(true)
  await act(async () => { finish(true) })
  expect(control().hasAttribute('data-disabled')).toBe(false)
  expect(control().getAttribute('aria-checked')).toBe('true')
})

it('keeps a saved choice and rolls back when a write is refused', async () => {
  const save = vi.fn(async (value: boolean) => value)
  mount(vi.fn(async () => false), save)
  await act(async () => {})
  await act(async () => { control().click() })
  expect(save).toHaveBeenLastCalledWith(true)
  expect(control().getAttribute('aria-checked')).toBe('true')
  await act(async () => { control().click() })
  expect(save).toHaveBeenLastCalledWith(false)
  expect(control().getAttribute('aria-checked')).toBe('true')
})

it('prevents a second choice while the first write is pending', async () => {
  let finish!: (value: boolean) => void
  const save = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
  mount(vi.fn(async () => false), save)
  await act(async () => {})
  act(() => control().click())
  expect(control().hasAttribute('data-disabled')).toBe(true)
  act(() => control().click())
  expect(save).toHaveBeenCalledTimes(1)
  await act(async () => { finish(true) })
  expect(control().hasAttribute('data-disabled')).toBe(false)
  expect(control().getAttribute('aria-checked')).toBe('true')
})

it('an unavailable preference reader or writer leaves the switch off and disabled', async () => {
  mount()
  await act(async () => {})
  expect(control().getAttribute('aria-checked')).toBe('false')
  expect(control().hasAttribute('data-disabled')).toBe(true)
})
