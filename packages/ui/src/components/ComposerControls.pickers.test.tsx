import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ConfigOption, RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ModelControl } from './ComposerControls'

/**
 * The model picker draws with the system's parts, never its own: the trigger's
 * words are text roles, the long list's filter is the shared `MenuSearch`, and
 * an available update is one row whose title keeps its install command.
 */

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
  document.body.innerHTML = ''
})

const codex: RuntimeInfo = {
  id: 'codex',
  name: 'Codex',
  version: 'codex-cli 0.154.0',
  update: { version: '0.155.0', command: 'npm i -g @openai/codex@latest' },
  capabilities: {},
  presentation: { name: 'Codex' },
} as unknown as RuntimeInfo

const NAMES = ['Terra', 'Sol', 'Luna', 'Nova', 'Vega', 'Rigel', 'Deneb', 'Altair', 'Sirius', 'Codex One', 'Codex Two', 'Polaris', 'Castor', 'Pollux']

const options: ConfigOption[] = [
  {
    id: 'model',
    label: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'terra',
    choices: NAMES.map((label) => ({ value: label.toLowerCase().replace(' ', '-'), label })),
  },
  {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    choices: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
  },
] as unknown as ConfigOption[]

const frame = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 30))
})

const mount = async (draftOptions = options) => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [codex],
    activeRuntime: codex.id,
    draftOptions,
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    setOption: vi.fn(async () => {}),
    askSettings: vi.fn(),
    refreshCatalog: vi.fn(async () => null),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ModelControl />
      </StoreProvider>,
    )
  })
  return store
}

const trigger = () => document.querySelector<HTMLButtonElement>('button[title="Model and reasoning"]')!

const open = async () => {
  act(() => trigger().dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await frame()
}

const row = (name: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((one) => one.textContent?.includes(name))!

it('names the model in the row role and its effort in the muted ink', async () => {
  await mount()
  const words = [...trigger().querySelectorAll<HTMLElement>('[data-slot="text"]')]
  const model = words.find((one) => one.textContent === 'Terra')
  const effort = words.find((one) => one.textContent === 'High')
  expect(model?.getAttribute('data-role')).toBe('row')
  expect(effort?.getAttribute('data-ink')).toBe('muted')
})

it('filters the long tail with the shared MenuSearch, and a letter typed there is the field’s', async () => {
  const store = await mount()
  await open()
  const more = row('More models')
  act(() => more.focus())
  act(() => more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  await frame()
  await frame()

  const search = document.querySelector<HTMLElement>('[data-slot="search"]')
  expect(search?.closest('[data-menu-search]')).not.toBeNull()
  expect(search?.getAttribute('data-size')).toBe('compact')
  const field = search!.querySelector('input')!

  // The menu takes a letter to jump to the row it starts; inside the field it must not.
  const letter = new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true })
  act(() => { field.dispatchEvent(letter) })
  expect(letter.defaultPrevented).toBe(false)

  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setValue.call(field, 'codex')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const shown = [...document.querySelectorAll('[role="menuitemradio"]')].map((one) => one.textContent?.trim())
  expect(shown).toContain('Codex One')
  expect(shown).not.toContain('Polaris')

  act(() => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  expect(store.setOption).toHaveBeenCalledWith('model', 'codex-one')
})

const openFilter = async () => {
  await open()
  const more = row('More models')
  act(() => more.focus())
  act(() => more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  await frame()
  await frame()
  return document.querySelector<HTMLElement>('[data-slot="search"] input') as HTMLInputElement
}

it.each(['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])('keeps %s in the filter: the field edits, the flyout stays', async (key) => {
  await mount()
  const field = await openFilter()
  act(() => field.focus())
  // The key is the field's alone: neither the menu nor anything past it hears it.
  const past = vi.fn()
  document.addEventListener('keydown', past)
  const press = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => { field.dispatchEvent(press) })
  document.removeEventListener('keydown', past)
  await frame()
  await frame()
  expect(press.defaultPrevented).toBe(false)
  expect(past).not.toHaveBeenCalled()
  expect(row('More models').getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(field)
})

it('leaves ↓ with the menu: it moves from the field to a row', async () => {
  await mount()
  const field = await openFilter()
  act(() => field.focus())
  act(() => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await frame()
  expect(document.activeElement).not.toBe(field)
})

it('keeps an available update as one row, with the install command in its title', async () => {
  await mount()
  await open()
  const update = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(one => one.querySelector('[data-menu-label]')?.textContent?.trim() === `Update ${codex.presentation.name} to ${codex.update?.version}`)
  expect(update).toBeDefined()
  expect(update?.closest('[data-popup-kind]')?.getAttribute('data-menu-icons')).toBe('none')
  expect(update?.querySelector('[data-menu-icon]')).toBeNull()
  expect(update?.getAttribute('title')).toBe(codex.update?.command)
  expect(update?.querySelector('[data-menu-hint]')).toBeNull()
  expect(document.querySelector('[data-testid="runtime-update"]')).toBeNull()
  expect(document.querySelector('[data-slot="code-text"]')).toBeNull()
})


it.each([5, 6])('shows search at six tail choices and Enter skips a refused first match (%s)', async count => {
  const choices = NAMES.slice(0, count + 4).map((label, at) => ({
    label, value: label.toLowerCase(), ...(at === 4 ? { disabled: 'Unavailable here.' } : {}),
  }))
  const store = await mount([{ ...options[0], choices } as ConfigOption, options[1]!])
  await open()
  const more = row('More models')
  act(() => more.focus())
  act(() => more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  await frame()
  const field = document.querySelector<HTMLInputElement>('[data-menu-search] input')
  if (count === 5) { expect(field).toBeNull(); return }
  expect(field).not.toBeNull()
  act(() => field!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(store.setOption).toHaveBeenCalledWith('model', 'rigel')
})
