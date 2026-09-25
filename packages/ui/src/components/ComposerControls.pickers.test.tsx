import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ConfigOption, RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ModelControl } from './ComposerControls'

/**
 * The model picker draws with the system's parts, never its own: the trigger's
 * words are text roles, the long list's filter is the shared `Search`, and
 * the build's foot is a note in a text role with the command in the code face.
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

const mount = async () => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [codex],
    activeRuntime: codex.id,
    draftOptions: options,
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

it('filters the long tail with the shared Search, and a letter typed there is the field’s', async () => {
  const store = await mount()
  await open()
  const more = row('More models')
  act(() => more.focus())
  act(() => more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  await frame()
  await frame()

  const search = document.querySelector<HTMLElement>('[data-slot="search"]')
  expect(search?.getAttribute('data-icon')).toBe('filter')
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

it('sets the update in a text role and its command in the code face', async () => {
  await mount()
  await open()
  const update = document.querySelector<HTMLElement>('[data-testid="runtime-update"]')
  expect(update?.getAttribute('data-slot')).toBe('text')
  expect(update?.getAttribute('data-role')).toBe('muted')
  expect(update?.querySelector('[data-slot="code-text"]')?.textContent).toBe('npm i -g @openai/codex@latest')
  // The build line is the note's own ink: nothing inside it redraws it.
  expect(document.querySelector('[data-testid="runtime-build"] span')).toBeNull()
})
