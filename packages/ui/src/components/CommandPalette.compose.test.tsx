import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import type { Destination } from '../state/destinations'
import { CommandPalette } from './CommandPalette'

/**
 * A skill picked from the palette lands in the conversation's message box, from
 * a page as from the conversation. The composer ignores a bare compose event
 * while a page is showing, so over the Library or Settings the pick was dropped
 * without a word.
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

const pick = async (current: Destination, composeEvents: string[], calls: string[]): Promise<void> => {
  const base = emptySnapshot()
  const snapshot: AppSnapshot = {
    ...base,
    status: 'open',
    runtimes: [],
    skills: [{ name: 'brainstorming', description: 'Plan before building.' }],
    workbench: { ...base.workbench, navigation: { ...base.workbench.navigation, current } },
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAgents: async () => {},
    transport: { request: vi.fn(async () => ({ data: [], nextCursor: null })) },
    returnToWork: () => calls.push('returnToWork'),
    notice: vi.fn(),
  } as unknown as AppStore
  const host = { close: () => {}, chooseFolder: () => {}, openSettings: () => {}, openUsage: () => {}, openAgents: () => {}, openFrontDoor: () => {} }
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <CommandPalette host={host} />
      </StoreProvider>,
    )
  })
  const input = document.body.querySelector('input') as HTMLInputElement
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setValue.call(input, 'brainstorming')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const result = [...document.body.querySelectorAll('[role="option"], button')]
    .find((node) => node.textContent?.includes('/brainstorming')) as HTMLElement | undefined
  expect(result, 'the palette should offer the skill as a command').toBeTruthy()

  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<{ text: string; onReceived: () => void }>).detail
    composeEvents.push(detail.text)
    calls.push(`compose ${detail.text}`)
    detail.onReceived()
  }
  window.addEventListener('harnessdesk:compose', listener)
  try {
    await act(async () => result?.click())
  } finally {
    window.removeEventListener('harnessdesk:compose', listener)
  }
}

it('a command picked over a page goes back to the conversation, then reaches the message box', async () => {
  const events: string[] = []
  const calls: string[] = []
  await pick({ kind: 'library', section: 'skill' }, events, calls)
  expect(calls).toEqual(['returnToWork', 'compose /brainstorming '])
})

it('a command picked in the conversation does not navigate first', async () => {
  const events: string[] = []
  const calls: string[] = []
  const base = emptySnapshot()
  await pick(base.workbench.navigation.current, events, calls)
  expect(calls).toEqual(['compose /brainstorming '])
})
