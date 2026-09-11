import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { dock, emptyWorkbench, type Workbench as Model } from '../state/workbench'
import { Workbench } from './Workbench'
import { views } from './views'
import './builtins'

/**
 * The workbench in a window too narrow for the sidebar's column.
 *
 * `state/sidebar.test.ts` pins when the sidebar floats; this pins what only a
 * DOM can get wrong about it once it does. Floating, the sidebar covers the
 * conversation, and a thing that covers another has four obligations the
 * column never had: what is underneath must not be reachable, focus has to go
 * into it and come back out, Escape has to put it away — but not when a menu
 * inside it already spent the key — and pressing what it covers has to put it
 * away too. A panel on the right has the matching obligation on its own side:
 * with no room beside the conversation, it takes the conversation's width.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The main area only needs to be something that can hold focus. */
vi.mock('../components/Panes', () => ({
  Panes: () => (
    <button type="button" data-testid="in-the-conversation">
      the conversation
    </button>
  ),
}))

const changes = views.get('changes')
if (!changes) throw new Error('changes is not registered')
views.register({ ...changes, component: () => <div data-testid="view-changes">changes</div> })
// The registry is the module's, so the real definition goes back when this file is done.
afterAll(() => views.register(changes))

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

const rig = (extra: Partial<AppSnapshot> = {}, workbench: Model = emptyWorkbench()) => {
  let snapshot = { ...emptySnapshot(), status: 'open', workbench, layout: workbench.main, ...extra } as AppSnapshot
  const listeners = new Set<() => void>()
  const patch = (next: Partial<AppSnapshot>): void => {
    snapshot = { ...snapshot, ...next }
    act(() => {
      for (const listener of listeners) listener()
    })
  }
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    closeFloatingSidebar: vi.fn(() => patch({ sidebarFloating: false })),
    toggleSidebar: vi.fn(),
    focusView: vi.fn(),
    activateView: vi.fn(),
  } as unknown as AppStore & { closeFloatingSidebar: ReturnType<typeof vi.fn> }
  return { store, patch }
}

/**
 * `beside` puts what the app puts beside the workbench next to it: the
 * standing notices float there, over the conversation, outside the shell —
 * and one more element that is already inert for reasons of its own.
 */
const render = (store: AppStore, beside = false): void => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Workbench
          sidebar={
            <div>
              <button type="button">A row in the sidebar</button>
            </div>
          }
        />
        {beside && (
          <div data-testid="notices">
            <button type="button">Review in Library</button>
          </div>
        )}
        {beside && <div data-testid="already-inert" inert />}
      </StoreProvider>,
    )
  })
}

const shell = (): HTMLElement => container.firstElementChild as HTMLElement
/** The shell's children by what they are, since the class names are hashed. */
const scrim = (): HTMLElement | null => shell().querySelector(':scope > [aria-hidden]')
const sidebar = (): HTMLElement => {
  const found = [...shell().children].find((child) => child.textContent?.includes('A row in the sidebar'))
  if (!found) throw new Error('no sidebar')
  return found as HTMLElement
}
const content = (): HTMLElement => {
  const found = [...shell().children].find((child) => child.textContent?.includes('the conversation'))
  if (!found) throw new Error('no content')
  return found as HTMLElement
}
const seam = (label: string): Element | null => container.querySelector(`[aria-label="${label}"]`)

it('a wide window keeps the column, with its seam, and nothing covering anything', () => {
  const { store } = rig()
  render(store)

  expect(shell().hasAttribute('data-narrow')).toBe(false)
  expect(seam('Resize the sidebar')).not.toBeNull()
  expect(scrim()).toBeNull()
  expect(sidebar().style.width).toBe('var(--panel-sidebar)')
})

it('a narrow window takes the sidebar out of the row: no column, no seam, nothing covered', () => {
  const { store } = rig({ narrowWindow: true })
  render(store)

  expect(shell().hasAttribute('data-narrow')).toBe(true)
  // Put away, and not by a width of nothing: it keeps its own and slides.
  expect(sidebar().hasAttribute('data-hidden')).toBe(true)
  expect(sidebar().style.width).toBe('var(--panel-sidebar)')
  expect(seam('Resize the sidebar')).toBeNull()
  expect(scrim()?.hasAttribute('data-open')).toBe(false)
  expect(content().hasAttribute('inert')).toBe(false)
})

it('floating, it covers the conversation: the dim is up, what is under it is out of reach, focus is in it', () => {
  const { store, patch } = rig({ narrowWindow: true })
  render(store)
  patch({ sidebarFloating: true })

  expect(sidebar().hasAttribute('data-floating')).toBe(true)
  expect(scrim()?.hasAttribute('data-open')).toBe(true)
  expect(content().hasAttribute('inert')).toBe(true)
  // The surface, not its first control: a stray Return must not open a row.
  expect(document.activeElement).toBe(sidebar())
})

it('what floats beside the workbench goes inert with the conversation, and only that comes back', () => {
  /* The standing notices are drawn under the dim but live outside the shell,
     so making the content inert left their buttons one Tab away from the
     floating sidebar: a control you can reach and cannot see. */
  const { store, patch } = rig({ narrowWindow: true })
  render(store, true)
  const notices = container.querySelector<HTMLElement>('[data-testid="notices"]')
  const already = container.querySelector<HTMLElement>('[data-testid="already-inert"]')

  patch({ sidebarFloating: true })
  expect(content().hasAttribute('inert')).toBe(true)
  expect(notices?.hasAttribute('inert')).toBe(true)

  patch({ sidebarFloating: false })
  expect(notices?.hasAttribute('inert')).toBe(false)
  // Something already inert for its own reasons is left as it was found.
  expect(already?.hasAttribute('inert')).toBe(true)
})

it('pressing the dim puts it away, and focus goes back to what opened it', () => {
  const { store, patch } = rig({ narrowWindow: true })
  render(store)
  const opener = container.querySelector<HTMLButtonElement>('[data-testid="in-the-conversation"]')
  opener?.focus()
  patch({ sidebarFloating: true })
  expect(document.activeElement).toBe(sidebar())

  act(() => {
    scrim()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  expect(store.closeFloatingSidebar).toHaveBeenCalledTimes(1)
  expect(content().hasAttribute('inert')).toBe(false)
  expect(document.activeElement).toBe(opener)
})

it('focus is given back even when the key was pressed on a control inside it', () => {
  /* React puts focus back on whatever held it before a commit's changes, after
     making them — so a focus() given back from the effect's cleanup was undone
     every time, as long as a control inside the sidebar was what had focus.
     Measured in a real engine before it was moved. */
  const { store, patch } = rig({ narrowWindow: true })
  render(store)
  const opener = container.querySelector<HTMLButtonElement>('[data-testid="in-the-conversation"]')
  opener?.focus()
  patch({ sidebarFloating: true })
  const row = [...sidebar().querySelectorAll('button')].find((b) => b.textContent === 'A row in the sidebar')
  row?.focus()
  expect(document.activeElement).toBe(row)

  patch({ sidebarFloating: false })

  expect(document.activeElement).toBe(opener)
})

it('Escape puts it away — unless something inside it spent the key first', () => {
  const { store, patch } = rig({ narrowWindow: true })
  render(store)
  patch({ sidebarFloating: true })

  // A menu, a filter field, a rename: each says it took the key.
  const row = sidebar().querySelector('button') as HTMLButtonElement
  const spend = (event: KeyboardEvent): void => event.preventDefault()
  row.addEventListener('keydown', spend)
  act(() => {
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  expect(store.closeFloatingSidebar).not.toHaveBeenCalled()
  row.removeEventListener('keydown', spend)

  act(() => {
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  expect(store.closeFloatingSidebar).toHaveBeenCalledTimes(1)
})

it('a panel on the right takes the conversation’s width in a narrow window, and has no seam', () => {
  const docked = dock(emptyWorkbench(), 'right', { kind: 'changes' })
  const wide = rig({}, docked)
  render(wide.store)
  const panel = container.querySelector('[data-testid="view-changes"]')?.closest('[style]') as HTMLElement | null
  // The control: beside the conversation, at its own width, with its seam.
  expect(seam('Resize the right panel')).not.toBeNull()
  expect(panel?.style.width).toBe('var(--panel-right)')

  const narrow = rig({ narrowWindow: true }, docked)
  render(narrow.store)
  expect(seam('Resize the right panel')).toBeNull()
  const boxes = [...container.querySelectorAll<HTMLElement>('[style]')].filter(
    (box) => box.style.width === 'var(--panel-right)',
  )
  expect(boxes).toEqual([])
})
