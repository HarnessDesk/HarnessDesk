import { Sidebar } from './Sidebar'
import type { ComponentProps, ReactNode } from 'react'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { TopBarProvider } from '../panels/top-bar'
import { ShellHostsProvider, ShellOutlets } from '../panels/shell-hosts'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { AppWindow as AppWindowBody, AppWindowMode, WindowGroup, WindowNav, WindowNavIdentity, WindowNavItem } from './AppWindow'
import { Menu, MenuItem, Popover, useEscapeSurface } from '../design'

/**
 * A settings nav is a list of equal rows.
 *
 * Its labels are not all ours: a runtime supplies its own word for a page —
 * "Skills & commands" is what every ACP agent calls that one — and a label
 * long enough to wrap made its row half again as tall as the eleven around
 * it, on three of the four agents HarnessDesk ships with. The row cuts now
 * rather than wrapping, and the height stays the height.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const store = previewStore()
const Tree = ({ children }: { children: ReactNode }) => <StoreProvider store={store}><TopBarProvider><ShellHostsProvider>{children}<ShellOutlets activeOwner="settings" /></ShellHostsProvider></TopBarProvider></StoreProvider>
const AppWindow = (props: Omit<ComponentProps<typeof AppWindowBody>, 'owner' | 'onClose'>) => <AppWindowBody owner={props.label === 'Dashboard' ? 'dashboard' : 'settings'} onClose={() => {}} {...props} />

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

const render = (node: Parameters<Root['render']>[0]): void => {
  act(() => root.render(<Tree>{node}</Tree>))
}

const frame = () => act(async () => {
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
})

it('uses the shared search field for a window rail filter', () => {
  render(
    <WindowNav
      onBack={() => {}}
      search={{ value: '', placeholder: 'Search settings…', label: 'Search settings', onChange: () => {} }}
    >
      <span>Pages</span>
    </WindowNav>,
  )
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')
  expect(input?.type).toBe('search')
  expect(input?.closest('[data-slot="search"]')).not.toBeNull()
  expect(input?.closest('[data-slot="search"]')?.classList.contains('hd-no-drag')).toBe(true)
  expect(container.querySelector('[data-slot="app-window-nav"]')).not.toBeNull()
})

it.each(['darwin', 'browser'])('the actual %s window supplies native corner room only when it has traffic lights', async platform => {
  const original = window.harnessdesk
  window.harnessdesk = { platform, openExternal: () => {}, setTitle: () => {}, onShortcut: () => () => {} }
  try {
    act(() => store.setWindowSize(720, 900))
    await act(async () => root.render(<Tree><AppWindow label="Settings"><button>Inside</button></AppWindow></Tree>))
    const surface = container.querySelector<HTMLElement>('[data-slot="app-window"]')!
    expect(surface.style.getPropertyValue('--titlebar-inset')).toBe(platform === 'darwin' ? 'var(--hd-titlebar-lights)' : '0px')
    expect(surface.querySelector('[data-shell-host="top"] [data-slot="bar"]')?.hasAttribute('data-corner')).toBe(true)
  } finally { window.harnessdesk = original }
})

it('projects the top host by the actual standing sidebar width, and removes that reserve when hidden or floating', async () => {
  const store = previewStore()
  act(() => store.setWindowSize(1440, 900))
  const draw = () => <StoreProvider store={store}><TopBarProvider><ShellHostsProvider>
    <AppWindowBody owner="settings" label="Settings" onClose={() => {}}><button>Inside</button></AppWindowBody>
    <ShellOutlets activeOwner="settings" />
  </ShellHostsProvider></TopBarProvider></StoreProvider>
  act(() => store.resizePanel('sidebar', 312))
  await act(async () => root.render(draw()))
  const top = container.querySelector<HTMLElement>('[data-shell-host="top"]')!
  expect(top.style.marginInlineStart).toBe('312px')
  expect(container.querySelector('[data-shell-host="status"]')).toBeNull()
  expect(container.querySelector('[data-shell-host="main-notice"]')?.getAttribute('style')).toBeNull()
  act(() => store.toggleSidebar())
  expect(top.style.marginInlineStart).toBe('0px')
  act(() => store.setWindowSize(720, 900))
  act(() => store.toggleSidebar())
  expect(top.style.marginInlineStart).toBe('0px')
  expect(top.querySelectorAll('[data-topbar="lead"] button')).toHaveLength(1)
})

it('takes focus and hides the covered desk, then restores both when it closes', async () => {
  const content = (open: boolean) => (
    <>
      <button data-testid="desk">Open settings</button>
      {open && <AppWindow label="Settings"><button>Inside settings</button></AppWindow>}
    </>
  )
  render(content(false))
  const desk = container.querySelector<HTMLButtonElement>('[data-testid="desk"]')!
  desk.focus()
  await act(async () => root.render(<Tree>{content(true)}</Tree>))
  await frame()
  const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Settings"]')!
  expect(dialog).not.toBeNull()
  expect(dialog.getAttribute('data-slot')).toBe('app-window')
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  expect(document.activeElement).toBe(dialog)
  expect(desk.closest('[aria-hidden="true"], [inert]')).not.toBeNull()
  await act(async () => root.render(<Tree>{content(false)}</Tree>))
  await frame()
  expect(desk.closest('[aria-hidden="true"], [inert]')).toBeNull()
  expect(document.activeElement).toBe(desk)
})

it('keeps embedded preview windows named without hiding or focusing other frames', async () => {
  render(<><button data-testid="other-frame">Other frame</button></>)
  const other = container.querySelector<HTMLButtonElement>('button')!
  other.focus()
  await act(async () => root.render(<Tree><>
    <button data-testid="other-frame">Other frame</button>
    <AppWindowMode.Provider value="embedded">
      <AppWindow label="Settings"><button>Settings control</button></AppWindow>
      <AppWindow label="Dashboard"><button>Dashboard control</button></AppWindow>
    </AppWindowMode.Provider>
  </></Tree>))
  await frame()
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(2)
  expect(container.querySelector('[aria-modal="true"]')).toBeNull()
  expect(other.closest('[aria-hidden="true"], [inert]')).toBeNull()
  expect(document.activeElement).toBe(other)
})

it('spends one Escape on its nested menu and the next on the window before covered handlers', async () => {
  let closeWindow = () => {}
  const Surface = () => {
    useEscapeSurface(true, () => closeWindow())
    return <AppWindow label="Settings">
      <Popover label="Actions">{close => <Menu close={close}><MenuItem label="Choose" onSelect={() => {}} /></Menu>}</Popover>
    </AppWindow>
  }
  const Harness = () => {
    const [open, setOpen] = useState(true)
    closeWindow = () => setOpen(false)
    return <><button>Covered desk</button>{open && <Surface />}</>
  }
  await act(async () => root.render(<Tree><Harness /></Tree>))
  await frame()
  const trigger = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="popover-trigger"]')].find(one => one.textContent === 'Actions')!
  await act(async () => trigger.click())
  const escape = async () => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => document.activeElement!.dispatchEvent(event))
    return event
  }
  const heard: boolean[] = []
  const coveredHandler = (event: KeyboardEvent) => { if (event.key === 'Escape') heard.push(event.defaultPrevented) }
  window.addEventListener('keydown', coveredHandler)
  try {
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    await escape()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(container.querySelector('[role="dialog"][aria-label="Settings"]')).not.toBeNull()
    await escape()
    expect(container.querySelector('[role="dialog"][aria-label="Settings"]')).toBeNull()
    expect(heard.every(Boolean)).toBe(true)
  } finally {
    window.removeEventListener('keydown', coveredHandler)
  }
})

it('cuts a label the runtime chose rather than wrapping its row', () => {
  render(
    <WindowNavItem
      icon={<span />}
      label="Skills & commands"
      count={25}
      trail={<span>Cursor</span>}
      selected={false}
      onClick={() => {}}
    />,
  )
  const label = container.querySelector<HTMLElement>('[data-slot="sidebar-menu-label"]')
  expect(label).toBeDefined()
  expect(label?.className).toContain('min-w-0')
  expect(label?.className).toContain('truncate')
})

it('renders window destinations with the shared sidebar row parts and one current destination', () => {
  render(
    <WindowGroup label="Views">
      <WindowNavItem icon={<span aria-hidden="true" />} label="Overview" selected onClick={() => {}} />
      <WindowNavItem icon={<span aria-hidden="true" />} label="Activity" selected={false} onClick={() => {}} />
    </WindowGroup>,
  )

  const group = container.querySelector('[data-sidebar="group"]')
  const rows = [...(group?.querySelectorAll('[data-sidebar="menu-button"]') ?? [])]
  expect(group?.querySelector('[data-slot="group-label"]')?.textContent).toBe('Views')
  expect(rows).toHaveLength(2)
  expect(rows.filter(row => row.getAttribute('aria-current') === 'page')).toHaveLength(1)
  expect(rows.filter(row => row.getAttribute('data-active') === 'true')).toHaveLength(1)
  expect(rows.map(row => row.getAttribute('type'))).toEqual(['button', 'button'])
})

it('moves keyboard focus between AppWindow destinations with the arrow keys', () => {
  const selected: string[] = []
  render(
    <WindowNav onBack={() => {}}>
      <WindowGroup label="Views">
        <WindowNavItem icon={<span />} label="Overview" selected onClick={() => selected.push('Overview')} />
        <WindowNavItem icon={<span />} label="Activity" selected={false} onClick={() => selected.push('Activity')} />
      </WindowGroup>
    </WindowNav>,
  )
  const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-sidebar="menu-button"]')]
  rows[0]!.focus()
  rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  expect(document.activeElement).toBe(rows[1])
  rows[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  expect(selected).toEqual(['Activity'])
})

it('keeps the trailing values out of the label’s space', () => {
  render(
    <WindowNavItem
      icon={<span />}
      label="A runtime supplied destination label long enough to reach the trailing status badge"
      count={25}
      trail={<span>Ready</span>}
      selected={false}
      onClick={() => {}}
    />,
  )
  const label = container.querySelector<HTMLElement>('[data-slot="sidebar-menu-label"]')
  const content = container.querySelector<HTMLElement>('[data-slot="sidebar-menu-label-content"]')
  expect(label?.className).toContain('sidebar-menu-label-fade')
  expect(content?.className).toContain('pe-(--hd-space-8)')
  const count = container.querySelector<HTMLElement>('[class*="winNavCount"]')
  // `flex: none` on the count is what stops the shared trailing slot shrinking it.
  expect(getComputedStyle(count as HTMLElement).flexGrow).toBe('0')
  expect(getComputedStyle(count as HTMLElement).flexShrink).toBe('0')
})

it('gives a clipped long identity name its full title', () => {
  render(<WindowNavIdentity face={<span />} name="A very long profile name that cannot fit in the narrow navigation row" selected={false} onClick={() => {}} />)
  const label = container.querySelector<HTMLElement>('[data-role="row"]')!
  const clipped = label.parentElement as HTMLElement
  clipped.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
  expect(clipped.title).toBe('A very long profile name that cannot fit in the narrow navigation row')
})

it('includes the actual shared column in the modal focus boundary with one shell pair', async () => {
  act(() => { store.setWindowSize(1440, 900); if (store.getSnapshot().sidebarCollapsed) store.toggleSidebar() })
  await act(async () => root.render(<Tree><AppWindow label="Settings" leftColumn={<Sidebar sessionsOwner={false}
    onOpenSettings={() => {}} onOpenPlugins={() => {}} onOpenAgents={() => {}} onOpenTeams={() => {}}
    onOpenUsage={() => {}} onBrowseFolders={() => {}} onSignIn={() => {}} onSearch={() => {}}
    settings={{ section: 'general', onSection: () => {}, onBack: () => {} }} />}><button>Page control</button></AppWindow></Tree>))
  const modal = container.querySelector<HTMLElement>('[data-slot="app-window"]')!
  const column = modal.querySelector<HTMLElement>('[data-left-column]')!
  expect(column).not.toBeNull()
  const appearance = column.querySelector<HTMLButtonElement>('button[aria-label="Appearance"]')!
  act(() => appearance.focus())
  expect(modal.contains(document.activeElement)).toBe(true)
  expect(document.activeElement).toBe(appearance)
  expect(column.querySelector('button[aria-label="Settings"]')?.getAttribute('aria-pressed')).toBe('true')
  expect(modal.querySelectorAll('[data-shell-host="top"]')).toHaveLength(1)
  expect(modal.querySelectorAll('[data-shell-host="status"]')).toHaveLength(0)
  expect(modal.querySelectorAll('[data-shell-host="main-notice"]')).toHaveLength(1)
})
