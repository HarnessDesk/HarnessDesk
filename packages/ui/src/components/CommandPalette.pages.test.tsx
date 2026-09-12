import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { CommandPalette } from './CommandPalette'

/**
 * Every settings page can be reached from ⌘K (#104). The pages are keyed by
 * section, so one left out doesn't compile; the Archive is the one on purpose,
 * offered in the Actions group under its own name, and this pins that typing
 * "archive" reaches it. Profile is the other page not called by its nav row,
 * which carries your name: it is found by the words someone looking for it
 * would type.
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

const mount = async (patch: Partial<AppSnapshot> = {}): Promise<{ openSettings: ReturnType<typeof vi.fn> }> => {
  const request = vi.fn(async () => ({ data: [], nextCursor: null }))
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [],
    history: [],
    ...patch,
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request },
    openSession: vi.fn(async () => {}),
  } as unknown as AppStore
  const openSettings = vi.fn()
  const host = { close: () => {}, chooseFolder: () => {}, openSettings, openUsage: () => {} }
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <CommandPalette host={host} />
      </StoreProvider>,
    )
  })
  return { openSettings }
}

const type = (value: string): void => {
  const field = container.querySelector('input')
  if (!field) throw new Error('no palette input')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const choose = async (label: string): Promise<void> => {
  await act(async () => {})
  const option = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find((one) => one.textContent?.includes(label))
  expect(option, `an option for ${label}`).toBeTruthy()
  act(() => option!.click())
}

it('typing "archive" reaches the Archive page', async () => {
  const { openSettings } = await mount()
  type('archive')
  await choose('Archive')
  expect(openSettings).toHaveBeenCalledWith('archive')
})

it('Profile, whose nav row carries your name, is reached by what someone would call it', async () => {
  for (const query of ['profile', 'avatar', 'picture']) {
    const { openSettings } = await mount()
    type(query)
    await choose('Settings › Profile')
    expect(openSettings).toHaveBeenCalledWith('profile')
    act(() => root.unmount())
    root = createRoot(container)
  }
})

it('a settings page is reached by the name on its nav row', async () => {
  const { openSettings } = await mount()
  type('appearance')
  await choose('Settings › Appearance')
  expect(openSettings).toHaveBeenCalledWith('appearance')
})

it('the Skills page is reached by the name its nav row shows (#219)', async () => {
  // Every ACP agent calls it "Skills & commands", and so does the Settings nav.
  const runtime = { id: 'gemini', name: 'gemini', presentation: { name: 'Gemini CLI', skillsLabel: 'Skills & commands' } }
  const { openSettings } = await mount({ runtimes: [runtime], activeRuntime: 'gemini' } as unknown as Partial<AppSnapshot>)
  type('skills & commands')
  await choose('Settings › Skills & commands')
  expect(openSettings).toHaveBeenCalledWith('skills')
})
