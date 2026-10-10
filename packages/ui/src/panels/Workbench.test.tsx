import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { CapabilityContribution } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { useSessionKey } from '../state/context'
import { Slot, publishComponent } from '../slots/registry'
import { MainWorkActions } from './MainWorkActions'
import { MountProvider, useMount } from './mount'
import { installPanelComponent } from '../slots/PanelBlocks'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { collapse as collapseIn, expand as expandIn } from '../state/layout'
import {
  activate,
  activeView,
  dock,
  dockViews,
  fixedSubject,
  MAX_RATIO,
  MIN_RATIO,
  moveView,
  normalizeFixedWorkbench,
  readWorkbench,
  resizeDock,
  resizeDockSplit,
  splitDock,
  toggleDock,
  undock,
  zoomArea,
  type Workbench as Model,
} from '../state/workbench'
import { toolOf } from '../state/frame-tools'
import { Workbench } from './Workbench'
import { permits, views } from './views'
import './builtins'

/**
 * The four areas, drawn.
 *
 * `state/workbench.test.ts` pins the model; this pins the things only a DOM
 * can be wrong about, and each of them was:
 *
 *   A panel with nothing in it draws nothing. Not a strip, a seam and a border
 *   around an empty box.
 *
 *   Every view in a panel stays mounted. Switching tabs must not tear down a
 *   diff's scroll position or a terminal's screen, so the ones off screen are
 *   hidden rather than unmounted — and a test is the only thing that will
 *   notice when somebody "simplifies" that to rendering the active one.
 *
 *   A zoom collapses what it replaces. The row holding the split tree and the
 *   right panel has to go as a unit, or a zoomed bottom panel sits under the
 *   empty space where they were and reads as a panel that failed to expand.
 *
 *   Docking is offered by the view's own declaration. The move menu lists what
 *   `mounts` allows and nothing else; a destination that is offered and then
 *   refused teaches the wrong rule.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The real features need a live host; what the workbench owes them is a place,
   so the doubles report the place. Registered over the built-ins, which have
   already been imported above — so the registry under test is the app's own,
   with only the drawing swapped. */
const seen: string[] = []
for (const kind of ['changes', 'activity', 'agents', 'terminal', 'git', 'conversation'] as const) {
  const definition = views.get(kind)
  if (!definition) throw new Error(`${kind} is not registered`)
  views.register({
    ...definition,
    component: () => {
      seen.push(kind)
      /* A view claiming `ownsChrome` promises to draw the panel's verbs in its
         own header, and the panel then draws no strip. A stub that skipped
         that would be testing a panel with no way to move, expand or close it
         — which is exactly the failure the flag has to be held to. */
      const owns = definition.ownsChrome === true && !useMount()?.fixed
      /* The scope a panel is drawn under is the thing worth reporting: it is
         how a docked transcript ends up about its own session while every
         other panel stays about whichever conversation is in front. */
      const key = useSessionKey()
      return (
        <div data-testid={`view-${kind}`}>
          {kind}
          <span data-testid="scope">{key ?? 'none'}</span>
          {owns && <MainWorkActions />}
        </div>
      )
    },
  })
}
/* The conversation pulls in the whole transcript; the main area only needs to
   be something with a size. */
vi.mock('../components/Panes', () => ({ Panes: () => <div data-testid="panes">panes</div> }))

/* `hd.panel` is the component a plugin's panel names, published at start-up
   the same way `main.tsx` publishes it. */
installPanelComponent()

let container: HTMLDivElement
let root: Root

/* jsdom has no media queries, and the block vocabulary reads the theme. */
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  seen.length = 0
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const rig = (build: (start: Model) => Model = (start) => start, extra: Partial<AppSnapshot> = {}) => {
  let snapshot = { ...emptySnapshot(), status: 'open', ...extra } as AppSnapshot
  // Raw compatibility fixtures retain payloads and original scopes. Right
  // and bottom now project the fixed shell; sidebar remains until Task 8.
  const compatibility = Object.keys(snapshot.workbench.frameTools).length === 0
  const apply = (next: Model): void => {
    const subject = fixedSubject(next.main)
    const views = dockViews(next.right)
    const last = activeView(next.right)
    const tool = last && toolOf(last.view.kind)
    if (compatibility && subject && tool) next = { ...next, frameTools: { ...next.frameTools,
      [subject]: { tool, mode: last!.view.kind, open: !next.right.collapsed } },
      toolOwners: { ...next.toolOwners, ...Object.fromEntries(views.map(one => [one.id, subject])) },
      frameSubjects: { ...next.frameSubjects, [subject]: { paneId: next.main.focused, view: next.main.root.kind === 'pane' ? next.main.root.view : { kind: 'conversation', session: null } } },
    }
    snapshot = { ...snapshot, workbench: next, layout: next.main }
  }
  apply(build(snapshot.workbench))
  const listeners = new Set<() => void>()
  const settle = (next: Model): void => {
    apply(next)
    for (const listener of listeners) listener()
  }
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    activateView: (area: never, id: string) => settle(activate(snapshot.workbench, area, id)),
    closeView: (id: string) => settle(undock(snapshot.workbench, id)),
    moveView: (id: string, to: never) => settle(moveView(snapshot.workbench, id, to, permits)),
    resizePanel: (area: never, size: number) => settle(resizeDock(snapshot.workbench, area, size)),
    resizePanelSplit: (area: never, id: string, ratio: number) =>
      settle(resizeDockSplit(snapshot.workbench, area, id, ratio)),
    togglePanel: (area: never) => settle(toggleDock(snapshot.workbench, area)),
    zoomPanel: (area: never, scope: never) => settle(zoomArea(snapshot.workbench, area, scope)),
    /* The main area's two halves of one press, in one write: the zoom hides
       the other *areas*, the expansion hides the other *panes*. A rig that
       implemented only the first would have passed through the bug where
       leaving a zoom never gave the split back. */
    zoomMainPane: (paneId: string, scope: never) => {
      const held = snapshot.workbench.zoom
      const leaving = held?.area === 'main' && held.scope === scope
      const main = leaving
        ? collapseIn(snapshot.workbench.main)
        : expandIn(snapshot.workbench.main, paneId as never)
      settle(zoomArea({ ...snapshot.workbench, main }, 'main', scope))
    },
    expandPane: (paneId: string) =>
      settle({ ...snapshot.workbench, main: expandIn(snapshot.workbench.main, paneId as never) }),
    collapsePane: () =>
      settle({ ...snapshot.workbench, main: collapseIn(snapshot.workbench.main) }),
    focusPane: vi.fn(),
    focusView: vi.fn(),
    workSubject: () => fixedSubject(snapshot.layout),
  } as unknown as AppStore
  return { store, get snapshot() { return snapshot } }
}

const render = (store: AppStore): void => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Workbench
          sidebar={
            <div data-testid="tree">
              sessions
              {/* The sidebar's docked panels render through the slot the real
                  `Sidebar` carries, between the session list and the account
                  row. A sidebar that omits it has nowhere to put them, which
                  is exactly the contract this stands in for. */}
              <Slot name="sidebar.panel" />
            </div>
          }
        />
      </StoreProvider>,
    )
  })
}

const panels = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-slot="dock-panel"]')]

const tabs = (): string[] =>
  [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent ?? '')

const control = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find(
    (entry) => entry.getAttribute('aria-label') === label,
  )
  if (!found) throw new Error(`no control labelled ${label}`)
  return found
}

const expectOnlyPanelActionAtEnd = (actions: HTMLButtonElement[], edgeButton: HTMLButtonElement): void => {
  for (const action of actions) {
    expect(action.className.includes('me-(--edge-pull)'), action.getAttribute('aria-label') ?? 'panel action edge treatment')
      .toBe(action === edgeButton)
  }
}

it('an area with nothing docked draws no panel at all', () => {
  const { store } = rig()
  render(store)
  expect(panels()).toHaveLength(0)
  expect(container.querySelector('[data-testid="panes"]')).not.toBeNull()
})

it('a fixed work tool has a retained body without a dock tab', () => {
  const { store } = rig(start => dock(start, 'right', { kind: 'changes' }))
  render(store)
  expect(tabs()).toEqual([])
  expect(container.querySelector('[data-testid="view-changes"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="dock-panel-tabs"]')).toBeNull()
  expect(container.querySelector('[aria-label^="Move or split"]')).toBeNull()
})

it('terminal process documents have no split action at any width', () => {
  const { store } = rig(start => dock(dock(start, 'bottom', { kind: 'terminal', terminalId: 't1', runtime: 'codex' as never, cwd: '/repo/api' }),
    'bottom', { kind: 'terminal', terminalId: 't2', runtime: 'codex' as never, cwd: '/repo/ui' }))
  render(store)
  expect(tabs()).toEqual(['api', 'ui'])
  expect(container.querySelectorAll('[data-terminal-mount]')).toHaveLength(2)
  expect(container.querySelector('[aria-label^="Move or split"]')).toBeNull()
  expect(container.querySelector('[aria-label="Resize these panels"]')).toBeNull()
})

it('every retained work tool stays mounted under its original scope', () => {
  const { store } = rig(start => dock(dock(start, 'right', { kind: 'changes' }), 'right', { kind: 'activity' }))
  render(store)
  expect(seen.sort()).toEqual(['activity', 'changes'])
  const layers = [...container.querySelectorAll('[data-tool-mount]')]
  expect(layers).toHaveLength(2)
  expect(layers.filter(layer => layer.hasAttribute('data-hidden'))).toHaveLength(1)
  expect(layers.filter(layer => layer.hasAttribute('inert'))).toHaveLength(1)
})

it('a terminal stays in its process frame without arrangement actions', () => {
  const { store } = rig(start => dock(start, 'bottom', { kind: 'terminal', terminalId: 't1', runtime: 'codex' as never, cwd: '/repo/api' }))
  render(store)
  expect(container.querySelector('[data-terminal-mount]')).not.toBeNull()
  expect(container.querySelector('[aria-label^="Move or split"]')).toBeNull()
  expect(dockViews(store.getSnapshot().workbench.bottom)[0]?.view.kind).toBe('terminal')
})

it('a terminal frame does not offer panel zoom', () => {
  const { store } = rig(start => dock(start, 'bottom', { kind: 'terminal', terminalId: 't1', runtime: 'codex' as never, cwd: '/repo/api' }))
  render(store)
  expect(container.querySelector('[aria-label="Give this panel the whole area"]')).toBeNull()
  expect(container.querySelector('[data-testid="panes"]')).not.toBeNull()
  expect(container.querySelector('[data-testid="tree"]')).not.toBeNull()
})

it('closing the right frame preserves its body and leaves the sidebar alone', () => {
  const right = rig(start => dock(start, 'right', { kind: 'changes' }))
  render(right.store)
  const node = container.querySelector('[data-testid="view-changes"]')
  act(() => right.store.togglePanel('right'))
  expect(container.querySelector('[data-testid="view-changes"]')).toBe(node)
  expect(node?.closest('[inert]')).not.toBeNull()
  expect(container.querySelector('[data-testid="tree"]')).not.toBeNull()
  act(() => right.store.togglePanel('right'))
  expect(container.querySelector('[data-testid="view-changes"]')).toBe(node)
  expect(node?.closest('[inert]')).toBeNull()
})

it('each seam reports the size it drives, in the units that area uses', () => {
  const { store } = rig((start) => dock(dock(start, 'right', { kind: 'changes' }), 'bottom', { kind: 'terminal', terminalId: 't1', runtime: 'codex' as never, cwd: '/repo' }))
  render(store)
  const seams = [...container.querySelectorAll('[data-slot="panel-seam"]')].map((seam) => ({
    label: seam.getAttribute('aria-label'),
    orientation: seam.getAttribute('aria-orientation'),
  }))
  expect(seams).toEqual([
    { label: 'Resize the sidebar', orientation: 'vertical' },
    { label: 'Resize the right panel', orientation: 'vertical' },
    { label: 'Resize the bottom panel', orientation: 'horizontal' },
  ])
})

/**
 * The drag itself, which is the half of a seam a `data-slot` cannot see.
 *
 * These pin the thing that actually broke: the live size has to reach the
 * panel *while the pointer is down*. It went through the store once, which
 * rebuilt the workbench on every frame; then through local state, which cost
 * nothing and moved nothing, because the panel being resized is the seam's
 * sibling and reads the store. Both times the seam passed every test there
 * was. So what is asserted here is the panel's own width, mid-gesture.
 */
const seamAt = (label: string): HTMLElement => {
  const found = container.querySelector<HTMLElement>(`[data-slot="panel-seam"][aria-label="${label}"]`)
  if (!found) throw new Error(`no seam labelled ${label}`)
  return found
}

const point = (node: HTMLElement, type: string, clientX: number, clientY = 0): void => {
  act(() => {
    node.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX, clientY }),
    )
  })
}

it('the sidebar tracks its seam while the pointer is down, and the store hears it once', () => {
  const harness = rig()
  const resizePanel = vi.spyOn(harness.store as unknown as Record<string, never>, 'resizePanel')
  render(harness.store)

  const seam = seamAt('Resize the sidebar')
  const shell = seam.parentElement as HTMLElement
  const sidebar = seam.previousElementSibling as HTMLElement

  // The column's width is the variable, or none of the rest of this reaches it.
  expect(sidebar.style.width).toBe('var(--panel-sidebar)')
  expect(shell.style.getPropertyValue('--panel-sidebar-w')).toBe('240px')

  point(seam, 'pointerdown', 240)
  point(seam, 'pointermove', 300)

  // Mid-drag: the panel has moved and the store has not been told anything.
  expect(shell.style.getPropertyValue('--panel-sidebar-drag')).toBe('300px')
  expect(resizePanel).not.toHaveBeenCalled()
  // And the window is holding still — see lib/resizing.ts for what that buys.
  expect(document.documentElement.getAttribute('data-hd-resizing')).toBe('vertical')

  point(seam, 'pointerup', 300)

  expect(resizePanel).toHaveBeenCalledTimes(1)
  expect(resizePanel).toHaveBeenCalledWith('sidebar', 300)
  expect(harness.snapshot.workbench.sidebar.size).toBe(300)
  // The override is gone with the gesture: left behind it outranks every later
  // change, and the panel stops answering to anything but its own seam.
  expect(shell.style.getPropertyValue('--panel-sidebar-drag')).toBe('')
  expect(shell.style.getPropertyValue('--panel-sidebar-w')).toBe('300px')
  expect(document.documentElement.hasAttribute('data-hd-resizing')).toBe(false)
})

it('a seam dragged past its limit stops at the limit, and commits that', () => {
  const harness = rig()
  render(harness.store)
  const seam = seamAt('Resize the sidebar')
  const shell = seam.parentElement as HTMLElement

  point(seam, 'pointerdown', 240)
  point(seam, 'pointermove', 2000)
  expect(shell.style.getPropertyValue('--panel-sidebar-drag')).toBe('520px')
  point(seam, 'pointerup', 2000)
  expect(harness.snapshot.workbench.sidebar.size).toBe(520)
})

it('the bottom panel grows upward, and its seam commits a height', () => {
  const harness = rig((start) => dock(start, 'bottom', { kind: 'terminal', terminalId: 't1', runtime: 'codex' as never, cwd: '/repo' }))
  render(harness.store)
  const seam = seamAt('Resize the bottom panel')

  // Dragging up grows a panel anchored to the bottom edge — the direction the
  // seam is given, and the one thing about it a pointer test can get wrong.
  point(seam, 'pointerdown', 0, 400)
  point(seam, 'pointermove', 0, 340)
  point(seam, 'pointerup', 0, 340)
  expect(harness.snapshot.workbench.bottom.size).toBe(280)
})

it('an arrow key resizes a panel for good, not just for a frame', () => {
  const harness = rig()
  render(harness.store)
  const seam = seamAt('Resize the sidebar')

  // The keyboard used to reach `onResize` and nothing else: the nudge was
  // drawn and then forgotten, so the panel snapped back at the next render.
  act(() => {
    seam.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  })
  // The nudge is 2% of the resizable span, now 200–520 px.
  expect(harness.snapshot.workbench.sidebar.size).toBe(246)
})

/*
 * What a drag owes the window when it does not end the tidy way.
 *
 * These came out of review, and each is a state the app could not get out of:
 * the root keeps `data-hd-resizing` and the whole window loses its
 * transitions, its cursor and its text selection, with every guest frame
 * inert. Pointer up is the path that always worked; these are the other four.
 */
it('a drag that loses its pointer capture still gives the window back', () => {
  const harness = rig()
  render(harness.store)
  const seam = seamAt('Resize the sidebar')

  point(seam, 'pointerdown', 240)
  point(seam, 'pointermove', 300)
  expect(document.documentElement.getAttribute('data-hd-resizing')).toBe('vertical')

  // No pointerup: the browser takes the capture away, which it does whenever
  // the captured node is removed.
  act(() => {
    seam.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1 }))
  })
  expect(document.documentElement.hasAttribute('data-hd-resizing')).toBe(false)
  expect(harness.snapshot.workbench.sidebar.size).toBe(300)
})

it('a seam unmounted mid-drag gives the window back', () => {
  const harness = rig()
  render(harness.store)
  point(seamAt('Resize the sidebar'), 'pointerdown', 240)
  point(seamAt('Resize the sidebar'), 'pointermove', 320)
  expect(document.documentElement.getAttribute('data-hd-resizing')).toBe('vertical')

  // The pane goes while the pointer is still down — a shortcut, a zoom, a view
  // dragged to another edge. Nothing will ever deliver pointerup to it.
  act(() => root.unmount())
  expect(document.documentElement.hasAttribute('data-hd-resizing')).toBe(false)
  root = createRoot(container)
})

it('a drag that ends where it began leaves no override behind', () => {
  const harness = rig()
  render(harness.store)
  const seam = seamAt('Resize the sidebar')
  const shell = seam.parentElement as HTMLElement

  point(seam, 'pointerdown', 240)
  point(seam, 'pointermove', 300)
  point(seam, 'pointermove', 240) // all the way back
  point(seam, 'pointerup', 240)

  // The store never changed, so nothing re-rendered and the layout effect that
  // normally clears the override never ran. Left behind, it outranks every
  // later change and the panel stops answering to anything but its own seam.
  expect(shell.style.getPropertyValue('--panel-sidebar-drag')).toBe('')
  expect(harness.snapshot.workbench.sidebar.size).toBe(240)
})

it('a cancelled drag keeps the size it started with', () => {
  const harness = rig()
  render(harness.store)
  const seam = seamAt('Resize the sidebar')
  const shell = seam.parentElement as HTMLElement

  point(seam, 'pointerdown', 240)
  point(seam, 'pointermove', 400)
  act(() => {
    seam.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }))
  })

  // Cancel is not a quiet commit: the gesture was abandoned, so the panel goes
  // back to the size it had rather than keeping wherever the pointer got to.
  expect(harness.snapshot.workbench.sidebar.size).toBe(240)
  expect(shell.style.getPropertyValue('--panel-sidebar-drag')).toBe('')
  expect(document.documentElement.hasAttribute('data-hd-resizing')).toBe(false)
})

it('the arrow keys move a seam the way they point, on both edges', () => {
  const harness = rig((start) => dock(start, 'right', { kind: 'changes' }))
  render(harness.store)

  const press = (label: string, key: string): void => {
    act(() => {
      seamAt(label).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  }

  // The sidebar hugs the left edge: right is bigger.
  press('Resize the sidebar', 'ArrowRight')
  expect(harness.snapshot.workbench.sidebar.size).toBeGreaterThan(240)

  // The right panel hugs the other one, so a *larger* panel puts its seam
  // further left. ArrowRight walking the seam left is the arrow disagreeing
  // with the screen, which is the one thing the separator pattern forbids.
  const before = harness.snapshot.workbench.right.size
  press('Resize the right panel', 'ArrowRight')
  expect(harness.snapshot.workbench.right.size).toBeLessThan(before)
  press('Resize the right panel', 'ArrowLeft')
  expect(harness.snapshot.workbench.right.size).toBe(before)
})

it('one terminal process has no duplicate frame strip', () => {
  const { store } = rig(start => dock(start, 'bottom', { kind: 'terminal', terminalId: 't1', runtime: 'codex' as never, cwd: '/repo/api' }))
  render(store)
  expect(tabs()).toEqual([])
  expect(container.querySelectorAll('[data-terminal-mount]')).toHaveLength(1)
  expect(container.querySelector('[data-slot="dock-panel-bar"]')).toBeNull()
})

it('the main area gives its edge to zoom when it cannot close', () => {
  const { store } = rig((start) => ({
    ...start,
    main: {
      ...start.main,
      root: { ...start.main.root, view: { kind: 'git' as const, root: '/repo' } },
    },
  }))
  const pane = store.getSnapshot().layout.root
  if (pane.kind !== 'pane') throw new Error('the initial main area is a single pane')
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <MountProvider scope={{ area: 'main', id: pane.id, view: pane.view }}>
          <MainWorkActions />
        </MountProvider>
      </StoreProvider>,
    )
  })
  expect(container.querySelectorAll('[aria-label^="Close "]')).toHaveLength(0)
  const zoom = control('Fill the window')
  expectOnlyPanelActionAtEnd([zoom], zoom)
})





it('bottom renders only terminal documents while retaining unsupported payloads', () => {
  const { store } = rig(start => dock(dock(start, 'bottom', { kind: 'terminal', terminalId: 't1', runtime: 'codex' as never, cwd: '/repo/api' }), 'bottom', { kind: 'changes' }))
  render(store)
  expect(container.querySelector('[data-testid="view-terminal"]')).not.toBeNull()
  expect(container.querySelector('[data-testid="view-changes"]')).toBeNull()
  expect(dockViews(store.getSnapshot().workbench.bottom).map(entry => entry.view.kind)).toEqual(['terminal', 'changes'])
})

it('main holds exactly two things, and the registry is where that is true', () => {
  // The rule the whole layout rests on, asserted over the *whole* registry
  // rather than the two kinds someone remembered. A new view that declares
  // main fails here, which is the only place it can be caught before it ships:
  // once a feature can be in the middle, the middle stops being a fixed point
  // and becomes wherever the last click landed.
  const inMain = views
    .all()
    .filter((definition) => definition.mounts.includes('main'))
    .map((definition) => definition.kind)
    .sort()
  expect(inMain).toEqual(['conversation', 'room'])

  // And they are main-*only*: a conversation that could be docked is a
  // conversation that moves, and then main is no longer a fixed point either.
  expect(views.get('conversation')?.mounts).toEqual(['main'])
  expect(views.get('room')?.mounts).toEqual(['main'])
})

it('a panel that only works at one edge declares only that edge', () => {
  // The browser is the first entry to constrain by *shape* rather than by
  // preference: the bottom dock trades height for width, and a page a few rows
  // tall is not a page. Because the move menu reads this list, the constraint
  // reaches the person as an item that is not offered rather than one that is
  // offered and then refused.
  expect(views.get('browser')?.mounts).toEqual(['right'])
  // A terminal is the same argument inverted, which is why it leads with bottom.
  expect(views.get('terminal')?.mounts[0]).toBe('bottom')
  expect(views.get('git')?.mounts[0]).toBe('right')
})

it('a plugin panel cannot ask for the main area', () => {
  // Enforced by the type (`UiDock` excludes main) so it cannot be written; this
  // pins the registry's own superset too, because that list is what a
  // restored layout is checked against before the plugin host is back up.
  expect(views.get('plugin')?.mounts).not.toContain('main')
})

it('a retained docked conversation does not draw a second subject, and Changes reads the current subject', () => {
  const docked = 'codex\u0000docked'
  const inFront = 'codex\u0000in-front'
  const { store } = rig(
    (start) => {
      const main = { ...start.main, root: { kind: 'pane' as const, id: start.main.focused, view: { kind: 'conversation' as const, session: inFront as never } } }
      return dock(dock({ ...start, main }, 'right', { kind: 'conversation', session: docked } as never), 'right', { kind: 'changes' })
    },
    { activeSessionKey: inFront } as Partial<AppSnapshot>,
  )
  render(store)

  const scopes = [...container.querySelectorAll('[data-testid="scope"]')].map((s) => s.textContent)
  // The old transcript remains available for lifecycle operations, without
  // drawing another work subject. Changes still reads the current conversation.
  expect(scopes).toEqual([inFront])
  expect(dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'conversation')?.view)
    .toEqual({ kind: 'conversation', session: docked })
})

it('a tool dropped into the main area keeps its verbs', () => {
  /*
   * Reported from the running app: drag a panel to the middle and there is no
   * way to close it. The main area draws no strip, so a view that owns its
   * header has to draw the verbs there — and `chrome` was excluding `main`
   * outright, which is precisely where the strip never exists.
   */
  const { store } = rig()
  /* A split, because that is the shape a drag into the middle produces — and
     because `layout.ts` refuses to close the last pane, so a lone one is
     correctly not closable and would prove nothing here. */
  const main = {
    ...store.getSnapshot().workbench.main,
    root: {
      kind: 'split' as const,
      id: 's1',
      direction: 'row' as const,
      ratio: 0.5,
      first: { kind: 'pane' as const, id: 'p0', view: { kind: 'conversation' as const, session: null } },
      second: { kind: 'pane' as const, id: 'p1', view: { kind: 'git' as const, root: '/repo' } },
    },
    focused: 'p1',
  }
  /* One object, returned by identity. `useSyncExternalStore` compares
     snapshots by reference, so a getter that builds a fresh one each call
     re-renders forever. */
  const snapshot = {
    ...store.getSnapshot(),
    workbench: { ...store.getSnapshot().workbench, main },
    layout: main,
  } as AppSnapshot
  const single = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    focusPane: vi.fn(),
    focusView: vi.fn(),
    workSubject: () => fixedSubject(snapshot.layout),
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={single}>
        <MountProvider scope={{ area: 'main', id: 'p1', view: { kind: 'git', root: '/repo' } }}>
          <MainWorkActions />
        </MountProvider>
      </StoreProvider>,
    )
  })
  // "Fill the window", not "the whole area": in the middle the whole area is
  // what this already has, and asking for it moved nothing. The label says
  // which of the two zooms the press will actually perform.
  expect(container.querySelectorAll('[aria-label="Fill the window"]')).toHaveLength(1)
  expect(container.querySelectorAll('[aria-label="Give this panel the whole area"]')).toHaveLength(0)
  expect(container.querySelectorAll('[aria-label^="Move or split"]')).toHaveLength(0)
  // And a close, because the main area has no tab carrying one. Without this
  // the panel could be dragged to the middle and never got rid of.
  expect(container.querySelectorAll('[aria-label^="Close "]')).toHaveLength(1)
  const zoom = control('Fill the window')
  const close = container.querySelector<HTMLButtonElement>('button[aria-label^="Close "]')
  if (!close) throw new Error('no close action in the main area')
  expectOnlyPanelActionAtEnd([zoom, close], close)
})





it('a plugin panel says so when its plugin is not running', () => {
  const view = {
    kind: 'plugin' as const,
    contribution: 'c1',
    label: 'Coverage',
    mounts: ['right', 'bottom'] as const,
  }
  const { store } = rig((start) => dock(start, 'right', view))
  render(store)

  // The tab is the plugin's own label, carried on the view — so a restored
  // layout names its panels before the plugin host has come back up.
  expect(tabs()).toEqual([])
  expect(container.querySelector('[data-tool-mount]')).not.toBeNull()
  expect(container.textContent).toContain('not running')
})

it('and draws the published component once the contribution is there', () => {
  const contribution = {
    kind: 'ui',
    id: 'c1',
    owner: 'p1',
    slot: 'sidebar.panel',
    label: 'Coverage',
    order: 100,
    component: 'hd.panel',
    mounts: ['right'],
    data: { blocks: [{ type: 'markdown', text: 'Lines covered: 91%' }] },
  } as unknown as CapabilityContribution

  const view = { kind: 'plugin' as const, contribution: 'c1', label: 'Coverage', mounts: ['right'] as const }
  let snapshot = {
    ...emptySnapshot(),
    status: 'open',
    contributions: [contribution],
  } as AppSnapshot
  const admitted = dock(snapshot.workbench, 'right', view)
  const subject = fixedSubject(admitted.main)!
  const id = dockViews(admitted.right)[0]!.id
  snapshot = { ...snapshot, workbench: { ...admitted,
    frameTools: { [subject]: { tool: 'details', mode: 'plugin', open: true } },
    toolOwners: { [id]: subject },
    frameSubjects: { [subject]: { paneId: admitted.main.focused, view: admitted.main.root.kind === 'pane' ? admitted.main.root.view : { kind: 'conversation', session: null } } },
  } }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    focusPane: vi.fn(),
    focusView: vi.fn(),
    workSubject: () => fixedSubject(snapshot.layout),
  } as unknown as AppStore

  render(store)
  // No plugin code runs in the window: the contribution names a component the
  // renderer publishes, and the renderer draws its data.
  expect(container.textContent).toContain('Lines covered: 91%')
})

/**
 * The placement law, walked end to end.
 *
 * The rules above are each pinned in isolation; this is the journey a person
 * actually takes — open a panel, switch to it, move it, expand it, put it back,
 * close it — because every one of those steps has to leave the *middle* alone,
 * and nothing that checks one step at a time can notice that it did not.
 */
it('fixed tool selection and explicit resource close leave main intact', () => {
  const r = rig(start => dock(dock(start, 'right', { kind: 'changes' }), 'right', { kind: 'activity' }))
  render(r.store)
  const main = r.snapshot.workbench.main
  const entries = dockViews(r.snapshot.workbench.right)
  const original = container.querySelector('[data-testid="view-changes"]')
  act(() => r.store.activateView('right', entries[0]!.id))
  expect(container.querySelector('[data-testid="view-changes"]')).toBe(original)
  expect(r.snapshot.workbench.main).toBe(main)
  act(() => r.store.closeView(entries[1]!.id))
  expect(dockViews(r.snapshot.workbench.right).map(entry => entry.id)).toEqual([entries[0]!.id])
  expect(r.snapshot.workbench.main).toBe(main)
  expect(container.querySelector('[data-testid="panes"]')).not.toBeNull()
})

it('fixed tools expose no free move menu and the model refuses main', () => {
  const r = rig(start => dock(start, 'right', { kind: 'changes' }))
  render(r.store)
  expect(container.querySelector('[aria-label^="Move or split"]')).toBeNull()
  const before = r.snapshot.workbench
  const id = dockViews(before.right)[0]!.id
  expect(moveView(before, id, 'main', permits)).toBe(before)
})

/**
 * The verb in the corner of the middle, which used to be a press that changed
 * nothing.
 *
 * A room or a board fills the main area with no dock open, and the button
 * asked for the *content* scope — which hides the right panel, the bottom
 * panel, and nothing else. With neither of those open the screen did not move
 * and only the icon changed, so the control read as broken. Reported from the
 * running app in exactly those words.
 *
 * The main area is the content area, so the only zoom it can ask for is the
 * window's — and the way back has to undo both halves of the press, which it
 * did not: the zoom cleared and the expansion did not, so a pane that had
 * shared a split never came back.
 */
it('the middle expands to the window, and the way back undoes both halves', () => {
  /* A split, because the second half of the press is the *expansion* — what
     hides the pane beside this one — and a lone pane has nothing to hide. */
  const r = rig((start) => ({
    ...start,
    main: {
      ...start.main,
      root: {
        kind: 'split' as const,
        id: 's1',
        direction: 'row' as const,
        ratio: 0.5,
        first: { kind: 'pane' as const, id: 'p-room', view: { kind: 'room' as const, room: 'room-1' } },
        second: { kind: 'pane' as const, id: 'p1', view: { kind: 'git' as const, root: '/repo' } },
      },
      focused: 'p-room',
    },
  }))
  act(() => {
    root.render(
      <StoreProvider store={r.store}>
        <Workbench sidebar={<div data-testid="tree">sessions</div>} />
        <MountProvider scope={{ area: 'main', id: 'p-room', view: { kind: 'room', room: 'room-1' } }}>
          <MainWorkActions />
        </MountProvider>
      </StoreProvider>,
    )
  })

  const sidebarHidden = (): boolean =>
    container.querySelector('[data-testid="tree"]')?.parentElement?.hasAttribute('data-hidden') ?? false
  expect(sidebarHidden()).toBe(false)

  act(() => control('Fill the window').click())
  // The whole window, so the sidebar goes too — that is the difference between
  // `window` and `content`, and the only one of the two that moves anything
  // when the thing being expanded is already the middle.
  expect(r.snapshot.workbench.zoom).toEqual({ area: 'main', scope: 'window' })
  expect(sidebarHidden()).toBe(true)
  // And the other half of the same press: the pane beside it in the split.
  expect(r.snapshot.workbench.main.expanded).toBe('p-room')

  act(() => control('Back to the layout').click())
  expect(r.snapshot.workbench.zoom).toBeNull()
  expect(sidebarHidden()).toBe(false)
  // The half that used to be left behind: the layout stayed expanded, so the
  // pane beside it was gone for good and no further press could bring it back.
  expect(r.snapshot.workbench.main.expanded).toBeNull()
})

/**
 * The upgrade path, which is the one every existing user takes exactly once.
 *
 * `readZoom` restores `scope: 'content'` for anything a previous version
 * saved, and the middle can no longer *ask* for that scope. `zoomArea` reads a
 * press as "leave" only when the scope matches what it is holding, so pressing
 * the mount's own scope widened `content` to `window` and stayed zoomed —
 * under a button whose label said "Back to the layout". Two presses to leave,
 * and only for people who already had the app open.
 */
it('leaves a zoom this build would no longer have asked for, in one press', () => {
  const r = rig((start) => ({
    ...start,
    // What a layout saved before `zoomScope` existed restores as.
    zoom: { area: 'main' as const, scope: 'content' as const },
    main: {
      ...start.main,
      root: {
        kind: 'split' as const,
        id: 's1',
        direction: 'row' as const,
        ratio: 0.5,
        first: { kind: 'pane' as const, id: 'p-room', view: { kind: 'room' as const, room: 'room-1' } },
        second: { kind: 'pane' as const, id: 'p1', view: { kind: 'git' as const, root: '/repo' } },
      },
      focused: 'p-room',
      expanded: 'p-room',
    },
  }))
  act(() => {
    root.render(
      <StoreProvider store={r.store}>
        <Workbench sidebar={<div data-testid="tree">sessions</div>} />
        <MountProvider scope={{ area: 'main', id: 'p-room', view: { kind: 'room', room: 'room-1' } }}>
          <MainWorkActions />
        </MountProvider>
      </StoreProvider>,
    )
  })

  // The button says the press will leave, so the press must leave.
  act(() => control('Back to the layout').click())
  expect(r.snapshot.workbench.zoom, 'one press of "Back to the layout" leaves').toBeNull()
  expect(r.snapshot.workbench.main.expanded).toBeNull()
})

/**
 * A strip is a handle for the window, and its controls are not.
 *
 * `DockPanelBar` was the one piece of chrome in the app that was not a drag
 * region, so a room or a board in the middle drew a full-width bar under the
 * traffic lights that could not be dragged. Asserted on the rendered DOM
 * rather than the source, because what matters is which boxes carry the
 * classes once the components have composed.
 */
it('a work tool has no second draggable panel strip', () => {
  const { store } = rig(start => dock(dock(start, 'right', { kind: 'changes' }), 'right', { kind: 'activity' }))
  render(store)
  expect(container.querySelector('[data-slot="dock-panel-bar"]')).toBeNull()
  expect(container.querySelector('[data-slot="dock-panel-tabs"]')).toBeNull()
  expect(container.querySelector('[draggable="true"][data-tool-mount]')).toBeNull()
})

/**
 * The seam between two halves of a docked panel, `DockSplit`, which the panel
 * playground's split copies. Tested here as well as there, or a break in the
 * workbench's own handlers leaves the copy green (#230).
 */
const splitRig = (direction: 'row' | 'column') => {
  const harness = rig((start) => {
    const both = dock(dock(start, 'sidebar', { kind: 'changes' }), 'sidebar', { kind: 'activity' })
    return splitDock(both, dockViews(both.sidebar)[1]!.id, direction)
  })
  const resizePanelSplit = vi.spyOn(harness.store as unknown as Record<string, never>, 'resizePanelSplit')
  render(harness.store)
  const seam = container.querySelector<HTMLElement>('[aria-label="Resize these panels"]')
  expect(seam, 'the transitional sidebar panel is split').toBeTruthy()
  const box = seam!.parentElement as HTMLElement
  box.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON: () => ({}) }) as DOMRect
  return { seam: seam!, box, resizePanelSplit }
}

/** The ratio a drag is showing, or '' when none is. */
const splitShown = (box: HTMLElement): string => box.style.getPropertyValue('--split-drag')
/** The ratio the store holds. */
const splitRatio = (box: HTMLElement): number => parseFloat(box.style.getPropertyValue('--split-ratio'))
const windowResizing = (): string | null => document.documentElement.getAttribute('data-hd-resizing')

it('a split seam tracks the pointer while it is down, and the store hears it once (#230)', () => {
  const { seam, box, resizePanelSplit } = splitRig('row')
  point(seam, 'pointerdown', 500)
  point(seam, 'pointermove', 600)
  // A hundred pixels of a thousand is a tenth of the split: shown, and nothing told yet.
  expect(parseFloat(splitShown(box))).toBeCloseTo(0.6, 5)
  expect(resizePanelSplit).not.toHaveBeenCalled()
  point(seam, 'pointerup', 600)
  expect(resizePanelSplit).toHaveBeenCalledTimes(1)
  expect(splitRatio(box)).toBeCloseTo(0.6, 5)
  expect(splitShown(box)).toBe('')
})

it('a cancelled split drag keeps the ratio it started with (#230)', () => {
  const { seam, box, resizePanelSplit } = splitRig('row')
  point(seam, 'pointerdown', 500)
  point(seam, 'pointermove', 600)
  point(seam, 'pointercancel', 600)
  expect(splitShown(box)).toBe('')
  expect(splitRatio(box)).toBeCloseTo(0.5, 5)
  expect(resizePanelSplit).not.toHaveBeenCalled()
})

it('a split drag that loses its pointer capture ends there, and keeps where it got to (#230)', () => {
  const { seam, box } = splitRig('row')
  point(seam, 'pointerdown', 500)
  point(seam, 'pointermove', 600)
  point(seam, 'lostpointercapture', 600)
  expect(splitRatio(box)).toBeCloseTo(0.6, 5)
  // Ended, not merely paused: a later move is not a drag.
  point(seam, 'pointermove', 800)
  expect(splitShown(box)).toBe('')
  expect(windowResizing()).toBeNull()
})

it('a split one above the other drags along its height (#230)', () => {
  const { seam, box } = splitRig('column')
  point(seam, 'pointerdown', 500, 300)
  // Sixty pixels of six hundred is a tenth; the four hundred across are not its axis.
  point(seam, 'pointermove', 900, 360)
  expect(parseFloat(splitShown(box))).toBeCloseTo(0.6, 5)
})

it('a split drag marks the window as resizing for as long as it lasts, however it ends (#230)', () => {
  const { seam } = splitRig('row')
  point(seam, 'pointerdown', 500)
  expect(windowResizing()).toBe('vertical')
  point(seam, 'pointerup', 500)
  expect(windowResizing()).toBeNull()
  point(seam, 'pointerdown', 500)
  point(seam, 'pointercancel', 500)
  expect(windowResizing()).toBeNull()
  point(seam, 'pointerdown', 500)
  // The split goes away under the pointer.
  act(() => root.unmount())
  expect(windowResizing()).toBeNull()
  root = createRoot(container)
})

it('a split in a dock dragged past either end stops where the store stops it, and commits that (review of #183, round 7)', () => {
  // The preview clamps the ratio itself and the store clamps it again on release. Two copies of the limits
  // would stop the drag in one place and commit it in another: a jump as the pointer lets go.
  const { seam, box } = splitRig('row')
  // The handle states the same range, for its keys and for a screen reader.
  expect(seam.getAttribute('aria-valuemin')).toBe(String(Math.round(MIN_RATIO * 100)))
  expect(seam.getAttribute('aria-valuemax')).toBe(String(Math.round(MAX_RATIO * 100)))
  for (const [to, limit] of [[5000, MAX_RATIO], [-5000, MIN_RATIO]] as const) {
    point(seam, 'pointerdown', 500)
    point(seam, 'pointermove', to)
    expect(splitShown(box)).toBe(limit.toFixed(4))
    point(seam, 'pointerup', to)
    expect(splitRatio(box)).toBe(limit)
    expect(splitShown(box)).toBe('')
  }
})

it('a docked sidebar panel is a child of the sidebar column itself (review of #183, round 7)', () => {
  // `.sidebar .panel[data-collapsed] { flex: none }` gives the height back only to a direct flex child of the
  // column, and it is one because the slot the panel renders through adds no element of its own. A wrapper
  // would stop the rule without a word, and the stylesheet test, which compares selectors, would stay green.
  const { store } = rig((start) => dock(start, 'sidebar', { kind: 'activity' }))
  render(store)
  expect(panels()).toHaveLength(1)
  expect(panels()[0]!.parentElement).toBe(container.querySelector('[data-testid="tree"]'))
})

/** Every control wearing this label — two of them is the bug, not a choice. */
const labelled = (label: string): HTMLButtonElement[] =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
    (entry) => entry.getAttribute('aria-label') === label,
  )

/**
 * A panel you can collapse has to be a panel you can open again (#232).
 *
 * `docs/interface.md` promises it in one line — "collapsing keeps the views and
 * shows the tab strip, which is the way back" — and one arrangement did not
 * keep it: a stack holding a single view that draws its own header drew no
 * strip, because the view's header *was* the panel's chrome. Collapsing then
 * hid the layer that header was in and left the section empty, measured at
 * 1199 × 1 px with one file docked at the bottom, with nothing in the dock to
 * bring it back.
 */
it('a collapsed terminal frame can return the same process document', () => {
  const harness = rig(start => dock(start, 'bottom', { kind: 'terminal', terminalId: 't1', runtime: 'codex' as never, cwd: '/repo' }))
  render(harness.store)
  const node = container.querySelector('[data-testid="view-terminal"]')
  expect(node).not.toBeNull()
  act(() => harness.store.togglePanel('bottom'))
  expect(harness.snapshot.workbench.bottom.collapsed).toBe(true)
  expect(container.querySelector('[data-testid="view-terminal"]')).toBe(node)
  expect(node?.closest('[inert]')).not.toBeNull()
  act(() => harness.store.togglePanel('bottom'))
  expect(container.querySelector('[data-testid="view-terminal"]')).toBe(node)
  expect(node?.closest('[inert]')).toBeNull()
})

/**
 * Two pointers on one seam (#252).
 *
 * A mouse cannot do it — one pointer cannot press twice without lifting — but a
 * second finger on a touch screen can, and so can a pen beside a mouse. Each
 * seam called `beginResize` unconditionally and overwrote the grab it held,
 * while only one `endResize` ever arrived: the document kept `data-hd-resizing`
 * for the rest of the session, which turns off every transition in the window,
 * the text caret and every guest frame. What is asserted is the state left
 * *after* both pointers are gone.
 */
const pointFrom = (
  node: HTMLElement,
  type: string,
  pointerId: number,
  clientX: number,
  clientY = 0,
): void => {
  act(() => {
    node.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, clientX, clientY }),
    )
  })
}

it('a second pointer on a split seam does not take the drag, and the window is given back (#252)', () => {
  const { seam, box, resizePanelSplit } = splitRig('row')
  pointFrom(seam, 'pointerdown', 1, 500)
  // The control: a drag in flight suppresses the window, before and after.
  expect(windowResizing()).toBe('vertical')

  // A second finger lands on the seam the first is still holding.
  pointFrom(seam, 'pointerdown', 2, 600)
  pointFrom(seam, 'pointermove', 1, 600)
  /* The delta is still the first pointer's — 500 to 600 of a thousand is a
     tenth. Taken by the second, the drag would measure from 600 and show the
     ratio it started at, which is the seam jumping out from under the finger
     holding it. */
  expect(parseFloat(splitShown(box))).toBeCloseTo(0.6, 5)

  pointFrom(seam, 'pointerup', 2, 600)
  pointFrom(seam, 'pointerup', 1, 600)
  expect(windowResizing()).toBeNull()
  expect(resizePanelSplit).toHaveBeenCalledTimes(1)
})

it('a second pointer on an area seam leaves no suppression behind (#252)', () => {
  const harness = rig((start) => dock(start, 'bottom', { kind: 'terminal', terminalId: 't1', runtime: 'codex' as never, cwd: '/repo' }))
  render(harness.store)
  const seam = seamAt('Resize the bottom panel')

  // The control again, on this seam: one pointer, marked for the drag and
  // given back at the end of it.
  pointFrom(seam, 'pointerdown', 1, 0, 400)
  expect(windowResizing()).toBe('horizontal')
  pointFrom(seam, 'pointerup', 1, 0, 400)
  expect(windowResizing()).toBeNull()

  /* Now two. This seam is the shared one in `design/patterns/DockPanel.tsx`,
     which still begins a resize per pointer, so what gives the window back
     here is the net in `lib/resizing.ts`: when the last pointer lifts and
     nothing in the document is marked as being dragged, a count left standing
     is owed to nobody. */
  pointFrom(seam, 'pointerdown', 1, 0, 400)
  pointFrom(seam, 'pointerdown', 2, 0, 420)
  pointFrom(seam, 'pointerup', 2, 0, 420)
  pointFrom(seam, 'pointerup', 1, 0, 400)
  expect(windowResizing()).toBeNull()
})


it.each([
  ['sidebar-only', 'sidebar', ['sidebar']],
  ['bottom-only', 'bottom', ['bottom']],
  ['main-only', 'right', ['main']],
  ['empty', 'right', []],
  ['invalid-only', 'right', ['unknown']],
  ['missing', 'right', undefined],
] as const)('retains a restored %s plugin without instantiating its published component', (_label, area, mounts) => {
  const component = vi.fn(() => <div>Undeclared plugin body</div>)
  publishComponent('fixture.hidden-plugin', component)
  const view = { kind: 'plugin' as const, contribution: 'fixture-hidden', label: 'Legacy panel', ...(mounts === undefined ? {} : { mounts }) }
  const contribution = { kind: 'ui', id: view.contribution, owner: 'fixture', slot: 'session.header',
    label: view.label, component: 'fixture.hidden-plugin', mounts: [area] } as unknown as CapabilityContribution
  const { store } = rig(start => {
    const saved = dock(dock(start, area, view as unknown as import('../state/layout').PaneView), 'right', { kind: 'changes' })
    const subject = `draft:${saved.main.focused}`
    return normalizeFixedWorkbench(readWorkbench(JSON.parse(JSON.stringify({ ...saved,
      frameTools: { [subject]: { tool: 'details', mode: 'plugin', open: true } },
    })))!).workbench
  }, { contributions: [contribution] })
  const retained = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'plugin')!
  render(store)
  expect(component).not.toHaveBeenCalled()
  expect(container.textContent).not.toContain('Undeclared plugin body')
  expect(dockViews(store.getSnapshot().workbench.right).find(one => one.id === retained.id)).toEqual(retained)
  expect(container.querySelector('[data-testid="view-changes"]')).not.toBeNull()
})


it.each([[['sidebar']], [['bottom']], [undefined]] as const)('never instantiates a saved right panel after its current manifest becomes %s', mounts => {
  const component = vi.fn(() => <div>Revised unsupported body</div>)
  publishComponent('fixture.revision-plugin', component)
  const view = { kind: 'plugin' as const, contribution: 'fixture-revision', label: 'Saved panel', mounts: ['right'] as const }
  const contribution = { kind: 'ui', id: view.contribution, owner: 'fixture', slot: 'session.header',
    label: view.label, component: 'fixture.revision-plugin', ...(mounts === undefined ? {} : { mounts }) } as unknown as CapabilityContribution
  const { store } = rig(start => normalizeFixedWorkbench(readWorkbench(JSON.parse(JSON.stringify(
    dock(dock(start, 'right', view), 'right', { kind: 'changes' }),
  )))!).workbench, { contributions: [contribution] })
  const retained = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'plugin')!
  render(store)
  expect(component).not.toHaveBeenCalled()
  expect(container.querySelector('[data-testid="view-changes"]')).not.toBeNull()
  expect(dockViews(store.getSnapshot().workbench.right)).toContainEqual(retained)
})
