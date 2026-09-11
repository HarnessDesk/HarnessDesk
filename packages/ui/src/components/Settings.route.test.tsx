import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Library, RuntimeInfo } from '@harnessdesk/protocol'
import { NO_CAPABILITIES } from '@harnessdesk/protocol'

import { kit } from '../design/primitives/Kit'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Settings, type Section } from './Settings'

/** The home every `~/…` path in these fixtures hangs off; the page prints them back with the tilde. */
const HOME = '/home/u'

/**
 * The window follows the route.
 *
 * A settings page can be asked for from anywhere: the app menu, ⌘K opened
 * over this very window, the import banner, a deep `askSettings` from a
 * composer menu. The window used to keep its own copy of the page it was on,
 * and a request that reached an open window died in the gap between the two
 * copies — Settings on Appearance, ⌘K, choose Library, and nothing moved.
 *
 * These drive it the way `App` does, through one piece of state the window
 * reads and writes back, and pin the two sequences that copy could break: a
 * route to a new page, and a repeat route to a page the parent still names
 * after the nav rail has walked away from it. The rest is what shares the
 * page with the route — the redirect that pulls Extensions out from under an
 * agent that has none, and the import banner's one-shot, which the child
 * reads on its own first render and so must arrive in the same commit.
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

const runtime = (capabilities: Partial<typeof NO_CAPABILITIES> = {}): RuntimeInfo =>
  ({
    id: 'codex',
    name: 'OpenAI Codex',
    capabilities: { ...NO_CAPABILITIES, ...capabilities },
    presentation: { name: 'OpenAI Codex' },
  }) as unknown as RuntimeInfo

const EMPTY_LIBRARY: Library = {
  generatedAt: 1,
  home: HOME,
  runtimes: [],
  locations: [],
  entries: [],
  gaps: [],
}

const makeStore = (runtimes: readonly RuntimeInfo[]): AppStore => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtimes[0]?.id,
    runtimes: [...runtimes],
  } as AppSnapshot
  // Method-aware, like the Library page's own harness: the page asks for the
  // library, then usage, then its history, and one wrong answer crashes it.
  const request = vi.fn(async (method: string) =>
    method === 'library/usage'
      ? { generatedAt: 1, sessionsScanned: 0, skills: {} }
      : method === 'library/plan'
        ? { plannedAt: 1, ops: [] }
        : method === 'audit/query'
          ? []
          : method === 'library/definition'
            ? null
            : EMPTY_LIBRARY,
  )
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request },
    // The Profile page writes the name when it is let go.
    setProfile: vi.fn(),
    // The Agents page reads the machine on mount; these are the verbs it asks
    // for, answered emptily so the redirect can be watched landing on it.
    loadAccounts: vi.fn(async () => {}),
    agentCatalog: vi.fn(async () => []),
    acpRegistry: vi.fn(async () => ({ agents: [], fetchedAt: 1 })),
  } as unknown as AppStore
}

/** The title of the page on show — the nav rail's labels live outside it. */
const page = (): string =>
  container.querySelector(`.${kit.pageTitle}`)?.textContent?.trim() ?? ''

/** The nav rail's own row, found by its label rather than its position. */
const navRow = (label: string): HTMLElement | undefined =>
  [...container.querySelectorAll('button, [role="tab"], a')].find(
    (node) => node.textContent?.trim() === label,
  ) as HTMLElement | undefined

/**
 * The window as `App` mounts it.
 *
 * The same shape, deliberately: one `settingsOpen` that is both whether the
 * window is up and the page it is on, written by every route and by the
 * window's own nav rail, plus the import banner's one-shot and the effect
 * that clears it on the next commit. A test that held the section itself
 * would prove nothing about the arrangement that had the bug.
 */
const Harness = ({
  hooks,
}: {
  hooks: (
    route: (to: Section, viaBanner?: boolean) => void,
    rerender: () => void,
    held: false | Section,
  ) => void
}) => {
  const [settingsOpen, setSettingsOpen] = useState<false | Section>('appearance')
  const [libraryImport, setLibraryImport] = useState(false)
  // Stands in for every parent re-render that is not a route: a snapshot
  // arriving, a sibling dialog opening, anything at all.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (libraryImport) setLibraryImport(false)
  }, [libraryImport])
  hooks(
    (to, viaBanner) => {
      if (viaBanner) setLibraryImport(true)
      setSettingsOpen(to)
    },
    () => setTick((value) => value + 1),
    settingsOpen,
  )
  if (!settingsOpen) return null
  return (
    <Settings
      section={settingsOpen}
      libraryImport={libraryImport}
      onSection={setSettingsOpen}
      onClose={() => setSettingsOpen(false)}
      onSignIn={() => {}}
    />
  )
}

type Drive = {
  /** A route in, the way any part of the app asks for a settings page. */
  route: (to: Section, viaBanner?: boolean) => void
  /** A parent re-render that asks for nothing. */
  rerender: () => void
  /** The page the parent believes the window is on — the only copy of it. */
  held: () => false | Section
}

const mount = async (runtimes: readonly RuntimeInfo[] = [runtime()]): Promise<Drive> => {
  // Read out of a box rather than handed over, because a test destructures
  // this once and the parent re-renders many times afterwards.
  let held: false | Section = false
  const drive = { held: () => held } as Drive
  await act(async () => {
    root.render(
      <StoreProvider store={makeStore(runtimes)}>
        <Harness
          hooks={(route, rerender, section) => {
            drive.route = route
            drive.rerender = rerender
            held = section
          }}
        />
      </StoreProvider>,
    )
  })
  return drive
}

it('a page asked for while the window is open replaces the one on show', async () => {
  const { route } = await mount()
  expect(page()).toBe('Appearance')

  // ⌘K over the open window, choosing Keyboard shortcuts. This is the whole
  // bug — the window used to stay put.
  await act(async () => route('shortcuts'))
  expect(page()).toBe('Keyboard shortcuts')
})

it('a page asked for a second time still moves the window back to it', async () => {
  const { route } = await mount()

  // Library by route, Plugins by hand, Library by route again. With the page
  // held in two places the third step was swallowed: the parent still named
  // Library, so its state did not change and neither did the prop.
  await act(async () => route('library'))
  expect(page()).toBe('Library')

  const plugins = navRow('Plugins')
  expect(plugins, 'the nav rail should offer Plugins').toBeTruthy()
  await act(async () => plugins?.click())
  expect(page()).toBe('Plugins')

  await act(async () => route('library'))
  expect(page()).toBe('Library')
})

it('the nav rail keeps the page it moved to when nothing new is asked for', async () => {
  const { rerender } = await mount()

  const shortcuts = navRow('Keyboard shortcuts')
  expect(shortcuts, 'the nav rail should offer Keyboard shortcuts').toBeTruthy()
  await act(async () => shortcuts?.click())
  expect(page()).toBe('Keyboard shortcuts')

  // A re-render for any other reason — a snapshot arriving, a sibling dialog
  // — is not a route, and must not drag the window back to where it opened.
  await act(async () => rerender())
  expect(page()).toBe('Keyboard shortcuts')
})

it('a route to Extensions still gives way when the agent has none', async () => {
  const { route, held, rerender } = await mount([runtime({ mcp: false, extensionStore: false })])

  // The page belongs to the agent rather than to the app, so the redirect has
  // the last word over the route: Agents, not a blank panel.
  await act(async () => route('extensions'))
  expect(page()).toBe('Agents')

  // And it corrects the one copy of the section, so the parent is not left
  // naming a page the window is not on — which would make the next request
  // for Agents a no-op against a window that had never got there by choice.
  expect(held()).toBe('agents')

  // The correction sticks: nothing re-asserts the route it gave way to.
  await act(async () => rerender())
  expect(page()).toBe('Agents')
})

it('the import banner opens the Library with its import flow, window already open', async () => {
  const { route } = await mount()
  expect(page()).toBe('Appearance')

  // App sets `libraryImport` and the section in one update and clears the flag
  // on the next commit, because `LibrarySection` reads it only on its own
  // first render. A page that arrived a commit later than the flag would mount
  // with it already cleared, and the import dialog would never open.
  await act(async () => route('library', true))
  expect(page()).toBe('Library')
  expect(container.textContent).toContain('Import between agents')
})

it('starts the rail with you, and your row opens your profile', async () => {
  const drive = await mount()
  const you = navRow('HarnessDesk')
  const general = navRow('General')
  if (!you || !general) throw new Error('no identity row, or no General row')
  // First: above every group, the way a Mac's own settings open on their owner.
  expect(you.compareDocumentPosition(general) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(you.hasAttribute('data-selected')).toBe(false)

  act(() => you.click())
  expect(drive.held()).toBe('profile')
  expect(navRow('HarnessDesk')?.hasAttribute('data-selected')).toBe(true)
  expect(container.querySelector('input[aria-label="Your name"]')).not.toBeNull()
})

it('keeps you in the rail while a search could mean you, and only then', async () => {
  await mount()
  const search = container.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')
  if (!search) throw new Error('no rail search')
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  const find = (value: string): void =>
    act(() => {
      setValue?.call(search, value)
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })

  find('picture')
  expect(navRow('HarnessDesk')).toBeDefined()
  expect(container.textContent).not.toContain('Nothing in settings matches')
  find('permissions')
  expect(navRow('HarnessDesk')).toBeUndefined()
  expect(navRow('Permissions')).toBeDefined()
})

it('takes a typed name back on the first Escape, and closes the window on the second', async () => {
  const drive = await mount()
  const you = navRow('HarnessDesk')
  if (!you) throw new Error('no identity row')
  act(() => you.click())
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Your name"]')
  if (!input) throw new Error('no name field')
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    input.focus()
    setValue?.call(input, 'Jane')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(drive.held()).toBe('profile')
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Your name"]')?.value).toBe('')
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(drive.held()).toBe(false)
})

it('keeps the profile page up while a search hides its row, as every other row behaves', async () => {
  const drive = await mount()
  const you = navRow('HarnessDesk')
  if (!you) throw new Error('no identity row')
  act(() => you.click())
  const search = container.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')
  if (!search) throw new Error('no rail search')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'permissions')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(navRow('HarnessDesk')).toBeUndefined()
  expect(drive.held()).toBe('profile')
  expect(container.querySelector('input[aria-label="Your name"]')).not.toBeNull()
})
