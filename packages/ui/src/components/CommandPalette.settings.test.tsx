import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { CommandPalette } from './CommandPalette'

/**
 * ⌘K reaches your profile the way it reaches every settings page: by the name
 * on its row, or by the words someone looking for it would type.
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

const mount = async (): Promise<{ openSettings: ReturnType<typeof vi.fn> }> => {
  const snapshot = { ...emptySnapshot(), status: 'open', runtimes: [], history: [] } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request: vi.fn(async () => ({ data: [], nextCursor: null })) },
  } as unknown as AppStore
  const openSettings = vi.fn()
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <CommandPalette host={{ close: () => {}, chooseFolder: () => {}, openSettings, openUsage: () => {} }} />
      </StoreProvider>,
    )
  })
  return { openSettings }
}

const type = (value: string): void => {
  const field = container.querySelector('input')
  if (!field) throw new Error('no palette input')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('opens your profile, found by its name or by what someone would call it', async () => {
  for (const query of ['profile', 'avatar', 'picture']) {
    const { openSettings } = await mount()
    type(query)
    const row = [...container.querySelectorAll('[role="option"]')].find((option) =>
      option.textContent?.includes('Profile'),
    )
    if (!row) throw new Error(`no Profile row for "${query}"`)
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(openSettings).toHaveBeenCalledWith('profile')
    act(() => root.unmount())
    root = createRoot(container)
  }
})

it('still opens every other page by its name — the control beside the Profile row', async () => {
  const { openSettings } = await mount()
  type('appearance')
  const row = [...container.querySelectorAll('[role="option"]')].find((option) =>
    option.textContent?.includes('Appearance'),
  )
  if (!row) throw new Error('no Appearance row')
  act(() => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  expect(openSettings).toHaveBeenCalledWith('appearance')
})
