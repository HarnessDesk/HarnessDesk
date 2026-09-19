import { StrictMode } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'

vi.mock('../lib/desktop', () => ({
  desktop: () => undefined,
  isDesktop: () => false,
  onOpenSession: () => () => {},
  onShortcut: () => () => {},
  setTraySummary: () => {},
  setWindowTitle: () => {},
}))
vi.mock('../panels/Workbench', () => ({ Workbench: () => null }))
vi.mock('../components/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('../components/Notices', () => ({ Notices: () => null, StatusBanner: () => null }))
vi.mock('../components/ImportOffer', () => ({ ImportOffer: () => null }))
vi.mock('../design', () => ({ Toaster: () => null }))
vi.mock('../state/theme', () => ({ useTheme: () => 'light' }))
vi.mock('../components/Settings', async () => {
  const { useShell } = await import('../panels/views')
  return {
  resolveSection: () => 'workspaces',
  Settings: ({ focus }: { readonly focus?: string | null }) => {
    const shell = useShell()
    return (
      <div>
        <output data-testid="settings-focus">{focus ?? 'nothing focused'}</output>
        <button type="button" onClick={() => shell.openAgents('room-reviewer')}>Open its Agent</button>
      </div>
    )
  },
  }
})
vi.mock('../components/AgentsWindow', () => ({
  AgentsWindow: ({ focus }: { readonly focus: string | null }) => (
    <output data-testid="agent-focus">{focus ?? 'Agent overview'}</output>
  ),
}))

import { App } from './App'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** A store that behaves like a one-shot deep route: clearing it notifies App immediately. */
const routedStore = (focus: string): AppStore => {
  let snapshot = {
    ...emptySnapshot(),
    status: 'open',
    settingsFor: 'workspaces',
    settingsFocus: focus,
  } as AppSnapshot
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    askSettings: vi.fn((section: string | null) => {
      if (section !== null) return
      snapshot = { ...snapshot, settingsFor: null, settingsFocus: null }
      for (const listener of listeners) listener()
    }),
    refreshCatalogIfStale: vi.fn(async () => {}),
  } as unknown as AppStore
}

it('keeps a project focus through the one-shot route that opens Settings', async () => {
  const project = '/home/user/work/storefront'
  await act(async () => {
    root.render(
      <StrictMode>
        <StoreProvider store={routedStore(project)}>
          <App />
        </StoreProvider>
      </StrictMode>,
    )
  })

  expect(container.querySelector('[data-testid="settings-focus"]')?.textContent).toBe(project)
})

it('lets a project page in Settings open that Agent in the app shell', async () => {
  await act(async () => {
    root.render(
      <StoreProvider store={routedStore('/home/user/work/storefront')}>
        <App />
      </StoreProvider>,
    )
  })

  const open = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Open its Agent')
  if (!open) throw new Error('the project page did not render its Agent door')
  await act(async () => open.click())

  expect(container.querySelector('[data-testid="agent-focus"]')?.textContent).toBe('room-reviewer')
  expect(container.querySelector('[data-testid="settings-focus"]')).toBeNull()
})
