import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { TriggerPreferences } from '@harnessdesk/protocol'

import { triggerPreferences } from '../preview/intake-fixture'
import { StoreProvider } from '../state/context'
import { type AppStore } from '../state/store'
import { TriggerSettings } from './TriggerSettings'

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

const mount = (overrides: Partial<AppStore> = {}) => {
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => ({}),
    triggerPreferences: vi.fn(async () => triggerPreferences()),
    setTriggerPreferences: vi.fn(async () => triggerPreferences({ paused: true })),
    ...overrides,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <TriggerSettings />
      </StoreProvider>,
    )
  })
  return store
}

const pauseSwitch = (): HTMLElement =>
  container.querySelector<HTMLElement>('[role="switch"]')!

const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

it('reads its saved pause and daily cap on mount, and shows this Mac’s reserved and charged amounts', async () => {
  mount()
  await act(async () => {})
  expect(pauseSwitch().getAttribute('aria-checked')).toBe('false')
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!
  expect(input.value).toBe('20')
  expect(container.textContent).toContain('$5.00')
  expect(container.textContent).toContain('$4.50')
})

it('never shows paused before the host acknowledges it, and reads the host’s own value back', async () => {
  let resolvePause!: (value: TriggerPreferences) => void
  const setTriggerPreferences = vi.fn(() => new Promise<TriggerPreferences>((resolve) => { resolvePause = resolve }))
  mount({ setTriggerPreferences: setTriggerPreferences as never })
  await act(async () => {})
  act(() => pauseSwitch().click())
  // Still unpaused: the write has not come back yet.
  expect(pauseSwitch().getAttribute('aria-checked')).toBe('false')
  expect(setTriggerPreferences).toHaveBeenCalledWith(1, true, 20)
  await act(async () => { resolvePause(triggerPreferences({ revision: 2, paused: true })) })
  expect(pauseSwitch().getAttribute('aria-checked')).toBe('true')
})

it('a stale revision or a rejected save retains the last known values and reports why', async () => {
  const setTriggerPreferences = vi.fn(async () => { throw new Error('That revision is behind what is saved. Read the current value and try again.') })
  mount({ setTriggerPreferences: setTriggerPreferences as never })
  await act(async () => {})
  await act(async () => pauseSwitch().click())
  expect(container.textContent).toContain('That revision is behind what is saved.')
  expect(pauseSwitch().getAttribute('aria-checked')).toBe('false')
})

it('an invalid cap is refused before it is ever sent, and zero is explicitly no new paid work', async () => {
  const setTriggerPreferences = vi.fn(async () => triggerPreferences({ dailyUsd: 0 }))
  mount({ setTriggerPreferences: setTriggerPreferences as never })
  await act(async () => {})
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!
  await act(async () => type(input, '-5'))
  const save = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Save')!
  await act(async () => save.click())
  expect(setTriggerPreferences).not.toHaveBeenCalled()
  expect(container.textContent).toContain('zero or more')

  await act(async () => type(input, '0'))
  await act(async () => save.click())
  expect(setTriggerPreferences).toHaveBeenCalledWith(1, false, 0)
  expect(container.textContent).toContain('No new paid work: the daily cap is zero.')
})

it('an unknown charged amount is said as unknown, never a silent zero', async () => {
  mount({ triggerPreferences: vi.fn(async () => triggerPreferences({ chargedUsd: null })) as never })
  await act(async () => {})
  expect(container.textContent).toContain('Unknown')
  expect(container.textContent).toContain('could not be vouched for')
})

it('the pause says a check it stopped part-way waits for a person', async () => {
  mount()
  await act(async () => {})
  expect(container.textContent).toContain('a check stopped part-way waits for you to run it again')
})
