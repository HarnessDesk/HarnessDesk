import { destinationForSettings } from '../app/settings-destination'
import { SettingsTestPage as Settings } from '../test-support/settings-page'
import type { ComponentProps } from 'react'
import { TopBarProvider } from '../panels/top-bar'
import { ShellHostsProvider, ShellOutlets } from '../panels/shell-hosts'
import { fixedSubject } from '../state/workbench'
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Library, RuntimeInfo } from '@harnessdesk/protocol'
import { NO_CAPABILITIES } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import type { Profile } from '../lib/profile'
import { type Section } from './Settings'


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

const makeStore = (runtimes: readonly RuntimeInfo[], profile: Profile = {}): AppStore => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtimes[0]?.id,
    runtimes: [...runtimes],
    profile,
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
    workSubject: () => fixedSubject(snapshot.layout),
    transport: { request },
    // The Profile page writes the name when it is let go.
    setProfile: vi.fn(),
    // The Runtimes page reads the machine on mount; these are the verbs it asks
    // for, answered emptily so the redirect can be watched landing on it.
    loadAccounts: vi.fn(async () => {}),
    agentCatalog: vi.fn(async () => []),
    acpRegistry: vi.fn(async () => ({ agents: [], fetchedAt: 1 })),
    newSessionDefaultsFor: vi.fn(async () => []),
    loadPolicyRules: vi.fn(async () => []),
    savePolicyRules: vi.fn(async () => {}),
    loadUnheldCeilings: vi.fn(async () => 'seat'),
    saveUnheldCeilings: vi.fn(async () => {}),
    loadUnattendedCeilings: vi.fn(async () => 'refuse'),
    setUnattendedCeilings: vi.fn(async () => {}),
    // How long an unattended question waits: a machine setting on the same page.
    loadQuestionWait: vi.fn(async () => '5m'),
    setQuestionWait: vi.fn(async () => true),
    // The Library page's own Agent filter roster read.
    loadAgents: vi.fn(async () => {}),
    loadHooks: vi.fn(async () => []),
  } as unknown as AppStore
}

/** The title of the page on show — the nav rail's labels live outside it. */
const page = (): string =>
  document.body.querySelector('[data-slot="page"] h1')?.textContent?.trim() ?? ''

/** The nav rail's own row, found by its label rather than its position. */
const navRow = (label: string): HTMLElement | undefined =>
  [...document.body.querySelectorAll('button, [role="tab"], a')].find(
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

const mount = async (runtimes: readonly RuntimeInfo[] = [runtime()], profile: Profile = {}): Promise<Drive> => {
  // Read out of a box rather than handed over, because a test destructures
  // this once and the parent re-renders many times afterwards.
  let held: false | Section = false
  const drive = { held: () => held } as Drive
  await act(async () => {
    root.render(
      <StoreProvider store={makeStore(runtimes, profile)}>
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

it('Escape keeps Settings in main without claiming a modal surface', async () => {
  const { held } = await mount()
  expect(held()).not.toBe(false)

  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await act(async () => {
    document.dispatchEvent(event)
  })
  expect(held()).toBe('appearance')
  expect(event.defaultPrevented).toBe(false)
})

it('a page asked for while the window is open replaces the one on show', async () => {
  const { route } = await mount()
  expect(page()).toBe('Appearance')

  // ⌘K over the open window, choosing Keyboard shortcuts. This is the whole
  // bug — the window used to stay put.
  await act(async () => route('shortcuts'))
  expect(page()).toBe('Keyboard shortcuts')
  expect(document.body.textContent).toContain('⌥⌘1')
  expect(document.body.textContent).toContain('Focus tile 1')
})

it('a page asked for a second time still moves the window back to it', async () => {
  const { route } = await mount()

  // Library by route, Appearance by hand, Library by route again. With the page
  // held in two places the third step was swallowed: the parent still named
  // Library, so its state did not change and neither did the prop.
  await act(async () => route('general'))
  expect(page()).toBe('General')

  const appearance = navRow('Appearance')
  expect(appearance, 'preferences offer Appearance').toBeTruthy()
  await act(async () => appearance?.click())
  expect(page()).toBe('Appearance')

  await act(async () => route('general'))
  expect(page()).toBe('General')
  await act(async () => route('notifications'))
  expect(page()).toBe('Notifications')
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
  // the last word over the route: Runtimes, not a blank panel.
  await act(async () => route('extensions'))
  expect(page()).toBe('Runtimes')

  // And it corrects the one copy of the section, so the parent is not left
  // naming a page the window is not on — which would make the next request
  // for Runtimes a no-op against a window that had never got there by choice.
  expect(held()).toBe('runtimes')

  // The correction sticks: nothing re-asserts the route it gave way to.
  await act(async () => rerender())
  expect(page()).toBe('Runtimes')
})

it('historical Library and Plugins requests remain explicit compatibility destinations', () => {
  expect(destinationForSettings('library')).toEqual({kind:'library',section:'skill'})
  expect(destinationForSettings('plugins')).toEqual({kind:'plugins',section:'installed',id:null})
})

it('keeps Profile callable by route, with no identity in preferences', async () => {
  const drive = await mount()
  expect(navRow('HarnessDesk')).toBeUndefined()
  await act(async () => drive.route('profile'))
  expect(drive.held()).toBe('profile')
  expect(document.body.querySelector('input[aria-label="Your name"]')).not.toBeNull()
})

it('preference search excludes identity and retains account keywords', async () => {
  await mount()
  const search = document.body.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!
  const find = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, value)
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  find('picture'); expect(navRow('HarnessDesk')).toBeUndefined()
  expect(document.body.textContent).toContain('Nothing in settings matches')
  find('permissions'); expect(navRow('Permissions')).toBeDefined()
  find('account'); expect(navRow('HarnessDesk')).toBeUndefined()
  expect(document.body.textContent).not.toContain('Nothing in settings matches')
})

it('Permissions search and the ceiling fix open the same section', async () => {
  await mount()
  const search = document.body.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')
  if (!search) throw new Error('no rail search')
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  for (const word of ['ceiling', 'ceilings', 'held', 'asked']) {
    act(() => {
      setValue?.call(search, word)
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(navRow('Permissions'), `${word} should find Permissions`).toBeDefined()
  }

  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  const store = makeStore([runtime()])
  await act(async () => root.render(
    <StoreProvider store={store}>
      <Settings
        section="permissions"
        focus="ceilings"
        onSection={() => {}}
        onClose={() => {}}
        onSignIn={() => {}}
      />
    </StoreProvider>,
  ))
  const ceilings = document.body.querySelector<HTMLElement>('section[aria-label="Ceilings"]')
  expect(document.activeElement).toBe(ceilings)
  expect(scroll).toHaveBeenCalledWith({ block: 'start' })
  expect(document.body.textContent).toContain('Approvals')
  expect(document.body.textContent).toContain('Rules')
  scroll.mockRestore()
})

it('ordinary Permissions navigation preserves its controls without writing ceiling policy', async () => {
  const store = makeStore([runtime()])
  await act(async () => root.render(
    <StoreProvider store={store}>
      <Settings section="permissions" onSection={() => {}} onClose={() => {}} onSignIn={() => {}} />
    </StoreProvider>,
  ))
  expect(document.body.textContent).toContain('Approvals')
  expect(document.body.textContent).toContain('Rules')
  expect(document.activeElement).not.toBe(document.body.querySelector('section[aria-label="Ceilings"]'))
  expect(store.savePolicyRules).not.toHaveBeenCalled()
  expect(store.saveUnheldCeilings).not.toHaveBeenCalled()
  expect(store.setQuestionWait).not.toHaveBeenCalled()
})

it('takes a typed name back on Escape and keeps the Profile page open', async () => {
  const drive = await mount()
  await act(async () => drive.route('profile'))
  const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Your name"]')
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
  expect(document.body.querySelector<HTMLInputElement>('input[aria-label="Your name"]')?.value).toBe('')
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(drive.held()).toBe('profile')
})

it('keeps the routed profile page up while preference search changes', async () => {
  const drive = await mount()
  await act(async () => drive.route('profile'))
  const search = document.body.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')
  if (!search) throw new Error('no rail search')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'permissions')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(navRow('HarnessDesk')).toBeUndefined()
  expect(drive.held()).toBe('profile')
  expect(document.body.querySelector('input[aria-label="Your name"]')).not.toBeNull()
})

it('a profile name never becomes a preference search result', async () => {
  const name = 'Jane Doe'
  const drive = await mount([runtime()], { name })
  await act(async () => drive.route('profile'))
  const search = document.body.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'Jane')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(navRow(name)).toBeUndefined()
  expect(document.body.textContent).toContain('Nothing in settings matches')
  expect(document.body.querySelector<HTMLInputElement>('input[aria-label="Your name"]')?.value).toBe(name)
})

// Runtime-owned Hooks keeps a stable route and names its owner on hover.
it('keeps a stable Hooks nav label while its hover text names the runtime', async () => {
  const label = 'A runtime with a long agent supplied name'
  const info = runtime({ hooks: true })
  await mount([{ ...info, presentation: { ...info.presentation, name: label } }])
  expect(container.querySelector('[aria-label="Settings navigation"] button[aria-label="Skills"]')).toBeNull()
  const row = container.querySelector<HTMLButtonElement>(`[aria-label="Settings navigation"] button[aria-label="Hooks"]`)!
  expect(row).not.toBeNull()
  expect(row.title).toContain(label)
  const text = row.querySelector<HTMLElement>('[data-slot="sidebar-menu-label"]')!
  expect(text.className).toContain('min-w-0')
  expect(text.className).toContain('truncate')
  const rows = [...container.querySelectorAll('[aria-label="Settings navigation"] [data-left-row] > button')]
  expect(rows.length).toBeGreaterThan(10)
  expect(new Set(rows.map(one => one.className)).size).toBe(1)
  await act(async () => row.click())
  expect(page()).toBe('Hooks')
})
