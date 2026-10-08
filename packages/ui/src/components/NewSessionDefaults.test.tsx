import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ConfigOption, RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import type { StaleDefault } from '../lib/composer-slots'
import { NewSessionDefaults } from './SettingsAgents'

/**
 * The "New sessions" section on an agent's page: it renders the runtime's own
 * declared defaults, a pick goes through the store method the composer shares
 * (one set of picks per agent, whichever surface wrote it), and the
 * re-declared list replaces the old one — the constraint model, kept. An
 * agent that declares nothing pre-session gets the honest sentence, not an
 * empty section.
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
})

const INFO = {
  id: 'codex',
  presentation: { name: 'Codex' },
} as unknown as RuntimeInfo

const DECLARED: ConfigOption[] = [
  {
    type: 'select',
    id: 'model',
    label: 'Model',
    currentValue: 'gpt-5.6',
    choices: [
      { value: 'gpt-5.6', label: 'GPT-5.6' },
      { value: 'gpt-5.6-mini', label: 'GPT-5.6 mini' },
    ],
  },
  { type: 'boolean', id: 'sandbox', label: 'Sandbox', currentValue: true },
] as unknown as ConfigOption[]

const mount = async (
  declared: readonly ConfigOption[],
  stale: readonly StaleDefault[] = [],
): Promise<{ setNewSessionDefault: ReturnType<typeof vi.fn>; clearNewSessionDefault: ReturnType<typeof vi.fn> }> => {
  const setNewSessionDefault = vi.fn(async (_runtime: string, id: string, value: unknown) =>
    declared.map((option) => (option.id === id ? { ...option, currentValue: value } : option)),
  )
  let snapshot: AppSnapshot = { ...emptySnapshot(), status: 'open', staleDraftDefaults: { [INFO.id]: stale } } as AppSnapshot
  const listeners = new Set<() => void>()
  const clearNewSessionDefault = vi.fn(async () => { snapshot = { ...snapshot, staleDraftDefaults: {} }; for (const listener of listeners) listener(); return declared })
  const store = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    newSessionDefaultsFor: vi.fn(async () => declared),
    setNewSessionDefault,
    clearNewSessionDefault,
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <NewSessionDefaults info={INFO} />
      </StoreProvider>,
    )
  })
  return { setNewSessionDefault, clearNewSessionDefault }
}

it('renders the runtime’s declared defaults and writes a pick through the shared record', async () => {
  const { setNewSessionDefault } = await mount(DECLARED)
  expect(container.textContent).toContain('New sessions')
  expect(container.textContent).toContain('Model')
  expect(container.textContent).toContain('Sandbox')

  const mini = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('GPT-5.6 mini'),
  )
  expect(mini).toBeTruthy()
  await act(async () => {
    mini!.click()
  })
  expect(setNewSessionDefault).toHaveBeenCalledWith('codex', 'model', 'gpt-5.6-mini')
  // The re-declared list is what renders now.
  const checked = container.querySelector('[role="radio"][aria-checked="true"]')
  expect(checked?.textContent).toContain('mini')
})

it('an agent with nothing to pre-set gets the sentence, not an empty section', async () => {
  await mount([])
  expect(container.textContent).toContain('Set per conversation')
  expect(container.textContent).toContain('Codex declares its controls once a session exists')
})

it('a longer choice list keeps refused values visible and disabled', async () => {
  const profiles: ConfigOption[] = [
    {
      type: 'select',
      id: 'codexProfile',
      label: 'Profile',
      currentValue: '',
      choices: [
        { value: '', label: 'None' },
        { value: 'sol', label: 'sol' },
        { value: 'astra', label: 'astra' },
        { value: 'broken', label: 'broken', disabled: 'The file is malformed.' },
      ],
    },
  ]
  const { setNewSessionDefault } = await mount(profiles)
  const select = container.querySelector('select[aria-label="Profile"]') as HTMLSelectElement | null
  expect(select).toBeTruthy()
  const broken = select?.querySelector('option[value="broken"]')
  expect(broken?.hasAttribute('disabled')).toBe(true)
  expect(broken?.textContent).toContain('The file is malformed.')

  await act(async () => {
    select!.value = 'sol'
    select!.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(setNewSessionDefault).toHaveBeenCalledWith('codex', 'codexProfile', 'sol')
})

it('names a stale removed option and deletes its saved pick with one click', async () => {
  const { clearNewSessionDefault } = await mount(DECLARED, [{ id: 'retired-mode', label: 'Mode', category: 'mode', value: 'old-mode', valueLabel: 'Old mode', reason: 'This setting is no longer offered.' }])
  expect(container.textContent).toContain('Saved Mode: Old mode')
  expect(container.textContent).toContain('This setting is no longer offered.')
  const clear = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('Use the agent’s current value'))!
  await act(async () => { clear.click() })
  expect(clearNewSessionDefault).toHaveBeenCalledWith(INFO.id, 'retired-mode')
  expect(container.textContent).not.toContain('Old mode')
})
