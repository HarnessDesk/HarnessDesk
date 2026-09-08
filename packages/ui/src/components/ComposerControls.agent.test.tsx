import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AgentControl } from './ComposerControls'

// AgentControl does not render either primitive, but ComposerControls imports
// them through the full design barrel. Keep this focused test from loading
// unrelated design-preview dependencies.
vi.mock('../design', () => ({ Btn: () => null, Dialog: () => null }))

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

const runtime = (id: string, name: string, tagline: string): RuntimeInfo =>
  ({
    id,
    name,
    capabilities: {},
    presentation: { name, tagline },
  }) as unknown as RuntimeInfo

const click = (element: Element): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

it('keeps an unavailable agent and its consequence visible while ordinary taglines stay on hover', () => {
  const current = runtime('current', 'Current', 'The current agent.')
  const unavailable = runtime('down', 'Down', 'The unavailable agent.')
  const available = runtime('ready', 'Ready', 'The available agent.')
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [current, unavailable, available],
    activeRuntime: current.id,
    healthByRuntime: {
      down: {
        state: 'unavailable',
        reason: 'crashed',
        message: 'Down exited.',
        remediation: 'Restart it.',
      },
    },
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    selectRuntime: vi.fn(async () => {}),
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <AgentControl />
      </StoreProvider>,
    )
  })

  const trigger = document.querySelector<HTMLButtonElement>(
    'button[title="Which agent starts this conversation"]',
  )
  expect(trigger).not.toBeNull()
  click(trigger!)

  const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
  const down = rows.find((row) => row.textContent?.includes('Down'))
  const ready = rows.find((row) => row.textContent?.includes('Ready'))

  expect(down?.textContent).toContain('Down — unavailable')
  expect(down?.textContent).toContain('This agent cannot start right now. Selecting it shows what to fix.')
  expect(down?.title).toBe('')
  expect(ready?.textContent).not.toContain('The available agent.')
  expect(ready?.title).toBe('The available agent.')
})
