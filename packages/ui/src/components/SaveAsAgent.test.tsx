import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, RuntimeInfo, Session } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { SaveAsAgentDialog } from './SaveAsAgent'

/**
 * Save as an Agent: a conversation's seat, kept under a name with a brief and
 * a ceiling, written to you or the project — and then the brief, to write.
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

const LIVE = {
  id: 's1',
  runtime: 'claude-code',
  cwd: '/Users/dev/work/storefront',
  status: { type: 'idle' },
  createdAt: 1,
  updatedAt: 1,
  turns: [],
  itemsLoaded: true,
  settings: { cwd: '/Users/dev/work/storefront', model: 'opus-5' },
  options: [
    { id: 'model', label: 'Model', type: 'select', currentValue: 'opus-5', choices: [{ value: 'opus-5', label: 'Opus 5' }] },
    { id: 'effort', label: 'Effort', type: 'select', currentValue: 'high', choices: [{ value: 'high', label: 'High' }] },
  ],
} as unknown as Session

const SAVED = {
  id: 'checkout-reviewer',
  origin: 'user',
  path: '/Users/dev/.harnessdesk/agents/checkout-reviewer/AGENT.md',
} as unknown as AgentEntry

const mount = (saveAsAgent = vi.fn(async () => SAVED)) => {
  const onClose = vi.fn()
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    home: '/Users/dev',
    stateDir: '/Users/dev/.harnessdesk',
    workspace: { path: '/Users/dev/work/storefront', name: 'storefront', lastOpenedAt: 1 },
    runtimes: [{ id: 'claude-code', capabilities: {}, presentation: { name: 'Claude' } } as unknown as RuntimeInfo],
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    saveAsAgent,
    openFile: vi.fn(),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SaveAsAgentDialog session={LIVE} onClose={onClose} />
      </StoreProvider>,
    )
  })
  return { store, onClose, saveAsAgent }
}

const type = (label: string, value: string): void => {
  const tag = [...document.body.querySelectorAll('label')].find((one) => one.textContent === label)
  const field = tag ? document.getElementById(tag.htmlFor) : null
  if (!(field instanceof HTMLInputElement)) throw new Error(`no field labelled ${label}`)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const choice = (words: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((one) =>
    one.textContent?.includes(words),
  )
  if (!found) throw new Error(`no choice reading ${words}`)
  return found
}
const button = (label: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)
  if (!found) throw new Error(`no button reading “${label}”`)
  return found
}

it('says the seat in words, each Agent ceiling, and what saving to the project keeps on this Mac', () => {
  mount()
  const text = document.body.textContent ?? ''
  expect(text).toContain('Claude · Opus 5 · High')
  expect(choice('Read').textContent).toContain('Changes nothing: it reads, searches and reports.')
  expect(choice('Edit').textContent).toContain('May change files and commit in its own checkout, and never push.')
  expect(choice('Publish').textContent).toContain('May push its own branch and open a pull request, and never merge.')
  expect(choice('Merge').textContent).toContain('May merge what it is asked to merge.')
  expect(choice('For storefront').textContent).toContain('seating.json')
  // Never the spec.
  expect(text).not.toContain('opus-5')
  expect(button('Save and open the brief').disabled).toBe(true)
})

it('saves the conversation’s seat under a name, with a description and a ceiling, where it was asked — then opens the brief', async () => {
  const { store, onClose, saveAsAgent } = mount()
  type('Name', 'Checkout reviewer')
  type('What it is for', 'Reads checkout changes against our rules.')
  act(() => choice('Publish').click())
  act(() => choice('For you').click())
  act(() => button('Save and open the brief').click())
  await act(async () => {})
  expect(saveAsAgent).toHaveBeenCalledWith({
    name: 'Checkout reviewer',
    description: 'Reads checkout changes against our rules.',
    ceiling: 'publish',
    seat: { runtime: 'claude-code', model: 'opus-5', effort: 'high' },
    to: 'user',
  })
  expect(store.openFile).toHaveBeenCalledWith(SAVED.path)
  expect(onClose).toHaveBeenCalled()
})

it('says why the host refused, and stays open', async () => {
  const { onClose } = mount(
    vi.fn(async () => {
      throw new Error('An Agent called “checkout-reviewer” is already there — pick another name.')
    }),
  )
  type('Name', 'Checkout reviewer')
  act(() => button('Save and open the brief').click())
  await act(async () => {})
  expect(document.body.textContent).toContain('is already there — pick another name.')
  expect(onClose).not.toHaveBeenCalled()
})
