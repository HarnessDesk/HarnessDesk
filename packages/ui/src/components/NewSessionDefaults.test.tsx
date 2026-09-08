import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ConfigOption, RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
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
): Promise<{ setNewSessionDefault: ReturnType<typeof vi.fn> }> => {
  const setNewSessionDefault = vi.fn(async (_runtime: string, id: string, value: unknown) =>
    declared.map((option) => (option.id === id ? { ...option, currentValue: value } : option)),
  )
  const snapshot: AppSnapshot = { ...emptySnapshot(), status: 'open' } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    newSessionDefaultsFor: vi.fn(async () => declared),
    setNewSessionDefault,
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <NewSessionDefaults info={INFO} />
      </StoreProvider>,
    )
  })
  return { setNewSessionDefault }
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
