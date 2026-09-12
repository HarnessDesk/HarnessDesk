import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Library, RuntimeInfo } from '@harnessdesk/protocol'
import { NO_CAPABILITIES } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Popover, useEscapeSurface } from './Popover'
import { Settings } from './Settings'
import { Usage } from './Usage'

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

const menu = (): HTMLElement | null => document.querySelector('[role="menu"]')
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
            <Usage onClose={() => setOpen(false)} onSignIn={() => {}} runtime={null} />
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
  it(`${which} stays for an Escape the menu open inside it spent (#206)`, async () => {
    const up = await mount(which)
    // The controls, both true before this was fixed: the window is up, and the
    // menu really opens. A dismissal test that skipped them would pass just as
    // well on a menu that never rendered.
    expect(window_(which)).not.toBeNull()
    expect(up()).toBe(true)
    act(() => container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click())
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
