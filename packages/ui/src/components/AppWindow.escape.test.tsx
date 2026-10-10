import { Sidebar } from './Sidebar'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Library, RuntimeInfo } from '@harnessdesk/protocol'
import { NO_CAPABILITIES } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Menu, MenuItem, Popover, useEscapeSurface } from '../design'
import { Settings } from './Settings'
import { Usage } from './Usage'
import { AgentsWindow } from './AgentsWindow'
import { previewStore } from '../preview/harness'
import { TopBarProvider } from '../panels/top-bar'
import { ShellHostsProvider, ShellOutlets } from '../panels/shell-hosts'

/**
 * One Escape closes one thing, in the two app windows as well (#206).
 *
 * Both windows answered the key from a `document` listener registered when the
 * window mounted. A menu opened inside one registers its own `document`
 * listener later, and listeners on a node run in the order they were added — so
 * the window answered first, found nothing spent, and closed itself; the menu
 * then closed too. One press, two things dismissed, and the thing the person
 * was looking at was the one that did not need closing.
 *
 * `event.defaultPrevented` cannot help a handler that runs *before* the one
 * spending the key, which is why this is a stack rather than a check: the
 * windows join `lib/overlays.ts`, whose single listener sits on the window
 * after everything on the document, so the menu is always heard first.
 *
 * The menu here is a real `Popover` rendered beside the window rather than on
 * one of its pages — it is the same component the windows' own menus are
 * (`Usage` draws one per account), and what decides the outcome is when its
 * listener was added, not where in the tree it sits.
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

const EMPTY_LIBRARY: Library = {
  generatedAt: 1,
  home: '/home/u',
  runtimes: [],
  locations: [],
  entries: [],
  gaps: [],
}

const runtime: RuntimeInfo = {
  id: 'codex',
  name: 'OpenAI Codex',
  capabilities: { ...NO_CAPABILITIES },
  presentation: { name: 'OpenAI Codex' },
} as unknown as RuntimeInfo

/** Enough of a desk for either window to draw: both read, neither writes here. */
const makeStore = (): AppStore => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    runtimes: [runtime],
  } as AppSnapshot
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
    setProfile: vi.fn(),
    loadAccounts: vi.fn(async () => {}),
    agentCatalog: vi.fn(async () => []),
    acpRegistry: vi.fn(async () => ({ agents: [], fetchedAt: 1 })),
    loadUsage: vi.fn(async () => {}),
    refreshUsage: vi.fn(async () => {}),
    ledger: vi.fn(async () => null),
  } as unknown as AppStore
}

const escape = async (): Promise<boolean> => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await act(async () => {
    document.dispatchEvent(event)
  })
  return event.defaultPrevented
}

const menu = (): HTMLElement | null => document.querySelector('[data-slot="popover-popup"]')
const window_ = (label: string): HTMLElement | null =>
  document.querySelector(`[role="dialog"][aria-label="${label}"]`)

/** The window, with a menu beside it, and whether the window is still up. */
const mount = async (which: 'Settings' | 'Dashboard'): Promise<() => boolean> => {
  let up = true
  const Harness = () => {
    const [open, setOpen] = useState(true)
    up = open
    return (
      <>
        {open &&
          (which === 'Settings' ? (
            <Settings
              section="appearance"
              onSection={() => {}}
              onClose={() => setOpen(false)}
              onSignIn={() => {}}
            />
          ) : (
            <Usage onClose={() => setOpen(false)} onSignIn={() => {}} scope={null} />
          ))}
        <Popover label="Range" title="Range">
          {(close) => (
            <button type="button" onClick={close}>
              Last 30 days
            </button>
          )}
        </Popover>
      </>
    )
  }
  await act(async () => {
    root.render(
      <StoreProvider store={makeStore()}>
        <Harness />
      </StoreProvider>,
    )
  })
  return () => up
}

for (const which of ['Settings', 'Dashboard'] as const) {
  it(`${which} returns to the menu trigger after opening from a menu action`, async () => {
    const Harness = () => {
      const [open, setOpen] = useState(false)
      return <>
        <Popover label="Account">{close => <Menu close={close}>
          <MenuItem label={`Open ${which}`} onSelect={() => setOpen(true)} />
        </Menu>}</Popover>
        {open && (which === 'Settings'
          ? <Settings section="appearance" onSection={() => {}} onClose={() => setOpen(false)} onSignIn={() => {}} />
          : <Usage onClose={() => setOpen(false)} onSignIn={() => {}} />)}
      </>
    }
    const frame = () => act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
    await act(async () => root.render(<StoreProvider store={makeStore()}><Harness /></StoreProvider>))
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="popover-trigger"]')!
    trigger.focus()
    await act(async () => trigger.click())
    const action = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!
    action.focus()
    await act(async () => action.click())
    await frame()
    expect(document.activeElement).toBe(window_(which))
    await escape()
    await frame()
    expect(window_(which)).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it(`${which} stays for an Escape the menu open inside it spent (#206)`, async () => {
    const up = await mount(which)
    // The controls, both true before this was fixed: the window is up, and the
    // menu really opens. A dismissal test that skipped them would pass just as
    // well on a menu that never rendered.
    expect(window_(which)).not.toBeNull()
    expect(up()).toBe(true)
    act(() => container.querySelector<HTMLButtonElement>('button[title="Range"]')!.click())
    expect(menu()).not.toBeNull()

    // One press: the menu goes, the window stays. This is what closed both.
    expect(await escape()).toBe(true)
    expect(menu()).toBeNull()
    expect(window_(which), 'the window closed along with the menu inside it').not.toBeNull()
    expect(up()).toBe(true)

    // And the window still answers a key nothing else wanted.
    expect(await escape()).toBe(true)
    expect(up()).toBe(false)
    expect(window_(which)).toBeNull()
  })
}

it('Agents spends footer menu Escape before its own close and returns focus to the opener', async () => {
  const store = previewStore(), closed = vi.fn()
  const Harness = () => {
    const [open, setOpen] = useState(false)
    return <TopBarProvider><ShellHostsProvider>
      <button data-testid="open-agents" onClick={() => setOpen(true)}>Open Agents</button>
      {open && <AgentsWindow focus={null} onFocus={() => {}} onClose={() => { closed(); setOpen(false) }} />}
      <ShellOutlets activeOwner={open ? 'agents' : null} />
    </ShellHostsProvider></TopBarProvider>
  }
  await act(async () => root.render(<StoreProvider store={store}><Harness /></StoreProvider>))
  const opener = container.querySelector<HTMLButtonElement>('[data-testid="open-agents"]')!
  act(() => { opener.focus(); opener.click() })
  const frame = () => act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
  await frame()
  const agents = window_('Agents')!
  expect(agents).not.toBeNull()
  const trigger = agents.querySelector<HTMLButtonElement>('[data-slot="status-bar"] [data-slot="popover-trigger"]')!
  expect(trigger).not.toBeNull()
  act(() => { trigger.focus(); trigger.click() })
  expect(menu()).not.toBeNull()
  expect(await escape()).toBe(true)
  expect(menu()).toBeNull()
  expect(window_('Agents')).toBe(agents)
  expect(closed).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(trigger)
  expect(await escape()).toBe(true)
  await frame()
  expect(closed).toHaveBeenCalledOnce()
  expect(window_('Agents')).toBeNull()
  expect(document.activeElement).toBe(opener)
})

it('overlapping real Agents and Settings windows close the active window before the underlying owner', async () => {
  const store = previewStore(), settingsClosed = vi.fn(), agentsClosed = vi.fn()
  const Harness = () => {
    const [settings, setSettings] = useState(true), [agents, setAgents] = useState(true)
    return <TopBarProvider><ShellHostsProvider>
      {settings && <Settings section="appearance" onSection={() => {}} onSignIn={() => {}}
        onClose={() => { settingsClosed(); setSettings(false) }} />}
      {agents && <AgentsWindow focus={null} onFocus={() => {}} onClose={() => { agentsClosed(); setAgents(false) }} />}
      <ShellOutlets activeOwner={agents ? 'agents' : settings ? 'settings' : null} />
    </ShellHostsProvider></TopBarProvider>
  }
  await act(async () => root.render(<StoreProvider store={store}><Harness /></StoreProvider>))
  expect(window_('Settings')).not.toBeNull()
  expect(window_('Agents')).not.toBeNull()
  expect(await escape()).toBe(true)
  expect(agentsClosed).toHaveBeenCalledOnce()
  expect(settingsClosed).not.toHaveBeenCalled()
  expect(window_('Agents')).toBeNull()
  expect(window_('Settings')).not.toBeNull()
  expect(await escape()).toBe(true)
  expect(settingsClosed).toHaveBeenCalledOnce()
  expect(window_('Settings')).toBeNull()
})

/**
 * The order the stack promises, which is what the surfaces under it rely on.
 *
 * The approval card and the floating sidebar answer Escape on the window and
 * stand aside for a key something else has spent — so the thing spending it has
 * to run first. That is why the stack's listener is registered as its module is
 * evaluated, ahead of anything a component adds in an effect, and why it marks
 * the key spent when a surface takes it.
 */
it('the surface on top answers, and the pane below hears that the key is spent (#206)', async () => {
  const under = vi.fn()
  const over = vi.fn()
  const Surface = ({ close }: { close: () => void }) => {
    useEscapeSurface(true, close)
    return null
  }
  await act(async () => {
    root.render(
      <>
        <Surface close={under} />
        <Surface close={over} />
      </>,
    )
  })

  // Stands in for the approval card: a window listener added in an effect,
  // which is to say after the stack's own.
  const spent: boolean[] = []
  const inThePane = (event: KeyboardEvent): void => void spent.push(event.defaultPrevented)
  window.addEventListener('keydown', inThePane)

  expect(await escape()).toBe(true)
  // The one opened last is the one being looked at.
  expect(over).toHaveBeenCalledTimes(1)
  expect(under).not.toHaveBeenCalled()
  expect(spent).toEqual([true])

  act(() => root.unmount())
  root = createRoot(container)
  await escape()
  // Left the stack with the surfaces: an unmounted window answers nothing.
  expect(over).toHaveBeenCalledTimes(1)
  expect(spent).toEqual([true, false])
  window.removeEventListener('keydown', inThePane)
})

it('the shared Settings column spends Escape on its menu, float, then window', async () => {
  const frame = () => act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
  // jsdom omits inert focus refusal. React restores the pre-commit account
  // focus after the float hides; browsers refuse that hidden inert target.
  const focusMethod = HTMLElement.prototype.focus
  const inertFocus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options) {
    if (!this.closest('[inert]')) focusMethod.call(this, options)
  })
  const store = previewStore()
  act(() => store.setWindowSize(720, 900))
  const Harness = () => {
    const [open, setOpen] = useState(true)
    return open && <Settings section="appearance" onSection={() => {}} onClose={() => setOpen(false)} onSignIn={() => {}}
      leftColumn={<Sidebar sessionsOwner={false} onOpenSettings={() => {}} onOpenPlugins={() => {}}
        onOpenAgents={() => {}} onOpenTeams={() => {}} onOpenUsage={() => {}} onBrowseFolders={() => {}}
        onSignIn={() => {}} onSearch={() => {}}
        settings={{ section: 'appearance', onSection: () => {}, onBack: () => setOpen(false) }} />} />
  }
  await act(async () => root.render(<StoreProvider store={store}><TopBarProvider><ShellHostsProvider>
    <Harness /><ShellOutlets activeOwner="settings" />
  </ShellHostsProvider></TopBarProvider></StoreProvider>))
  await frame()
  const modal = window_('Settings')!
  const show = modal.querySelector<HTMLButtonElement>('[data-shell-host="top"] button[aria-label="Show sidebar"]')!
  expect(show).not.toBeNull()
  act(() => show.focus())
  expect(document.activeElement).toBe(show)
  await act(async () => show.click())
  const column = modal.querySelector<HTMLElement>('[data-left-column]')!
  expect(column.closest('[data-app-window-left]')?.hasAttribute('hidden')).toBe(false)
  const account = column.querySelector<HTMLButtonElement>('[data-left-seat] [data-slot="popover-trigger"]')!
  await act(async () => account.click())
  expect(menu()).not.toBeNull()
  const covered = vi.fn()
  const handler = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) covered() }
  window.addEventListener('keydown', handler)
  try {
    expect(await escape()).toBe(true); expect(menu()).toBeNull(); await frame()
    expect(store.getSnapshot().sidebarFloating).toBe(true)
    expect(await escape()).toBe(true); expect(store.getSnapshot().sidebarFloating).toBe(false); await frame()
    expect(window_('Settings')).not.toBeNull(); expect(document.activeElement).toBe(show)
    expect(await escape()).toBe(true); expect(window_('Settings')).toBeNull()
    expect(covered).not.toHaveBeenCalled()
  } finally { window.removeEventListener('keydown', handler); inertFocus.mockRestore() }
})
