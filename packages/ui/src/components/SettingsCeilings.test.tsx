import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { NO_CAPABILITIES, runtimeId, type RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore, type UnheldCeilings } from '../state/store'
import { CeilingsSection } from './SettingsCeilings'

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

const runtime = (id: string, name: string, held = false): RuntimeInfo => ({
  id: runtimeId(id),
  capabilities: NO_CAPABILITIES,
  presentation: { name },
  ...(held ? {
    ceilings: {
      read: { settings: [{ option: 'sandbox', value: 'read-only' }], how: 'Read-only sandbox' },
      edit: { settings: [{ option: 'sandbox', value: 'workspace' }], how: 'Workspace sandbox' },
    },
  } : {}),
}) as RuntimeInfo

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const mount = ({
  runtimes = [runtime('alpha', 'Alpha', true), runtime('beta', 'Beta')],
  load = vi.fn(async () => 'seat' as UnheldCeilings),
  save = vi.fn(async () => {}),
  focus = null,
}: {
  runtimes?: readonly RuntimeInfo[]
  load?: AppStore['loadUnheldCeilings']
  save?: AppStore['saveUnheldCeilings']
  focus?: string | null
} = {}) => {
  let snapshot = { ...emptySnapshot(), status: 'open', runtimes: [...runtimes] } as AppSnapshot
  const listeners = new Set<() => void>()
  const store = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    loadUnheldCeilings: load,
    saveUnheldCeilings: save,
  } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><CeilingsSection focus={focus} /></StoreProvider>))
  return {
    store,
    push: (next: readonly RuntimeInfo[]) => act(() => {
      snapshot = { ...snapshot, runtimes: [...next] }
      for (const listener of listeners) listener()
    }),
  }
}

const choices = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
const chips = (): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>('[data-ceiling][data-hold]')]

it('says, per runtime and per level, whether it holds the ceiling or is only asked', async () => {
  mount()
  await act(async () => {})
  expect(chips().map((chip) => `${chip.dataset.ceiling}:${chip.dataset.hold}`)).toEqual([
    'read:held', 'edit:held', 'publish:asked', 'merge:asked',
    'read:asked', 'edit:asked', 'publish:asked', 'merge:asked',
  ])
  expect(chips().map((chip) => chip.firstElementChild?.getAttribute('data-tone'))).toEqual([
    'neutral', 'neutral', 'warning', 'warning',
    'warning', 'warning', 'warning', 'warning',
  ])
  expect(chips()[0]?.title).toContain('Read-only sandbox')
  expect(document.body.textContent).toContain('Alpha')
  expect(document.body.textContent).toContain('Beta')
})

it('capabilities update after a runtime starts', async () => {
  const alpha = runtime('alpha', 'Alpha')
  const beta = runtime('beta', 'Beta')
  const { push } = mount({ runtimes: [alpha, beta] })
  await act(async () => {})
  expect(chips().every((chip) => chip.dataset.hold === 'asked')).toBe(true)
  push([runtime('alpha', 'Alpha', true), beta])
  expect(chips().slice(0, 2).map((chip) => chip.dataset.hold)).toEqual(['held', 'held'])
  expect(chips().slice(4).every((chip) => chip.dataset.hold === 'asked')).toBe(true)
})

it('seats and says so by default, and writes the other choice when it is made', async () => {
  const save = vi.fn(async () => {})
  mount({ save })
  await act(async () => {})
  expect(choices().map((choice) => choice.getAttribute('aria-checked'))).toEqual(['true', 'false'])
  await act(async () => choices()[1]!.click())
  expect(save).toHaveBeenCalledWith('refuse')
})

it('a pending load or save cannot be overtaken by a click', async () => {
  const loading = deferred<UnheldCeilings>()
  const saving = deferred<void>()
  const save = vi.fn(() => saving.promise)
  mount({ load: vi.fn(() => loading.promise), save })
  expect(choices().every((choice) => choice.disabled)).toBe(true)
  expect(choices().every((choice) => choice.getAttribute('aria-checked') === 'false')).toBe(true)
  await act(async () => loading.resolve('refuse'))
  expect(choices().map((choice) => choice.getAttribute('aria-checked'))).toEqual(['false', 'true'])
  act(() => { choices()[0]!.click(); choices()[0]!.click() })
  expect(save).toHaveBeenCalledTimes(1)
  expect(choices().every((choice) => choice.disabled)).toBe(true)
  await act(async () => saving.resolve())
  expect(choices().every((choice) => !choice.disabled)).toBe(true)
})

it('is where a refusal’s fix lands: focused', async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  mount({ focus: 'ceilings' })
  await act(async () => {})
  const section = document.body.querySelector<HTMLElement>('section[aria-label="Ceilings"]')
  expect(document.activeElement).toBe(section)
  expect(scroll).toHaveBeenCalledWith({ block: 'start' })
  scroll.mockClear()
  container.tabIndex = -1
  container.focus()
  mount({ focus: 'rules' })
  await act(async () => {})
  expect(document.activeElement).toBe(container)
  expect(scroll).not.toHaveBeenCalled()
  scroll.mockRestore()
})
