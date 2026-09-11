import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The desktop shell's own source, read as text: its window's minimum width.
import electronMain from '../../../desktop/electron/main.mjs?raw'
// The panels the app registers, so the store lets one dock where the app does.
import '../panels/builtins'

import { runtimeId, sessionId, type HostMethodName, type Session } from '@harnessdesk/protocol'

import { AppStore } from './store'
import { NARROW_WINDOW, areaVisible, emptyWorkbench, sidebarPlacement, zoomArea, type Workbench } from './workbench'

/**
 * The sidebar, in two widths of window.
 *
 * A wide window stands it beside the conversation as a column, which a person
 * can put away and expects to find put away again. A window too narrow for the
 * column floats it over the conversation instead — closed until asked for, and
 * gone again the moment it has been used to go somewhere. The two are separate
 * pieces of state because they answer to separate questions, and the ways they
 * used to be one — a sidebar that never collapsed on its own, a phone left 135px
 * of conversation — are what these hold shut.
 */

const RUNTIME = runtimeId('codex')
const ID = sessionId('s-1')

const session = (overrides: Partial<Session> = {}): Session => ({
  id: ID,
  runtime: RUNTIME,
  cwd: '/w',
  status: { type: 'idle' },
  createdAt: 0,
  updatedAt: 0,
  turns: [],
  itemsLoaded: true,
  ...overrides,
})

describe('where the sidebar is drawn', () => {
  const at = (
    state: { narrowWindow: boolean; sidebarCollapsed: boolean; sidebarFloating: boolean },
    workbench: Workbench = emptyWorkbench(),
  ) => sidebarPlacement({ ...state, workbench })

  it('stands beside the conversation in a wide window, unless it has been put away', () => {
    expect(at({ narrowWindow: false, sidebarCollapsed: false, sidebarFloating: false })).toBe('column')
    expect(at({ narrowWindow: false, sidebarCollapsed: true, sidebarFloating: false })).toBe('away')
  })

  it('floats in a narrow window only when asked, however the column was left', () => {
    for (const sidebarCollapsed of [false, true]) {
      expect(at({ narrowWindow: true, sidebarCollapsed, sidebarFloating: false })).toBe('away')
      expect(at({ narrowWindow: true, sidebarCollapsed, sidebarFloating: true })).toBe('floating')
    }
  })

  it('never floats in a wide window, whatever the flag says', () => {
    expect(at({ narrowWindow: false, sidebarCollapsed: false, sidebarFloating: true })).toBe('column')
    expect(at({ narrowWindow: false, sidebarCollapsed: true, sidebarFloating: true })).toBe('away')
  })

  it('is away while a panel has the whole window, whatever its own state says', () => {
    const filling = zoomArea(emptyWorkbench(), 'main', 'window')
    for (const narrowWindow of [false, true]) {
      expect(at({ narrowWindow, sidebarCollapsed: false, sidebarFloating: true }, filling)).toBe('away')
    }
    // The content area's zoom leaves it standing, which is that scope's whole point.
    const content = zoomArea(emptyWorkbench(), 'main', 'content')
    expect(at({ narrowWindow: false, sidebarCollapsed: false, sidebarFloating: false }, content)).toBe('column')
  })
})

describe('the store', () => {
  let store: AppStore
  let answers: Partial<Record<HostMethodName, unknown>>

  beforeEach(() => {
    store = new AppStore('ws://localhost:0/')
    answers = {}
    vi.spyOn(store.transport, 'request').mockImplementation(
      (async (method: HostMethodName) => answers[method] ?? null) as never,
    )
  })

  const state = () => {
    const { narrowWindow, sidebarCollapsed, sidebarFloating } = store.getSnapshot()
    return { narrowWindow, sidebarCollapsed, sidebarFloating }
  }

  it('one verb shows and hides it: the column in a wide window, the floating one in a narrow one', () => {
    store.toggleSidebar()
    expect(state()).toEqual({ narrowWindow: false, sidebarCollapsed: true, sidebarFloating: false })
    store.toggleSidebar()
    expect(state()).toEqual({ narrowWindow: false, sidebarCollapsed: false, sidebarFloating: false })

    store.setNarrowWindow(true)
    store.toggleSidebar()
    // The column's own choice is not what a narrow window flips.
    expect(state()).toEqual({ narrowWindow: true, sidebarCollapsed: false, sidebarFloating: true })
    store.toggleSidebar()
    expect(state()).toEqual({ narrowWindow: true, sidebarCollapsed: false, sidebarFloating: false })
  })

  it('does not open over the conversation because the window got narrow', () => {
    // The column was up, and the window narrowed under it.
    store.setNarrowWindow(true)
    expect(state().sidebarFloating).toBe(false)
  })

  it('crossing the line either way puts a floating sidebar away, and the column is as it was left', () => {
    store.toggleSidebar()
    store.setNarrowWindow(true)
    store.toggleSidebar()
    expect(state().sidebarFloating).toBe(true)

    store.setNarrowWindow(false)
    expect(state()).toEqual({ narrowWindow: false, sidebarCollapsed: true, sidebarFloating: false })

    store.setNarrowWindow(true)
    expect(state().sidebarFloating).toBe(false)
  })

  it('is put away by choosing where to go', async () => {
    store.setNarrowWindow(true)

    store.toggleSidebar()
    store.newDraft()
    expect(state().sidebarFloating).toBe(false)

    answers['session/read'] = session()
    answers['session/resume'] = session()
    store.toggleSidebar()
    await store.openSession(ID, { runtime: RUNTIME })
    expect(state().sidebarFloating).toBe(false)

    // The conversation already on screen too: pressing its row is still an
    // answer to "where to", though the middle has nothing to change.
    store.toggleSidebar()
    await store.openSession(ID, { runtime: RUNTIME })
    expect(state().sidebarFloating).toBe(false)
  })

  it('is put away by a panel given the whole window, rather than left open where nothing is drawn', () => {
    store.setNarrowWindow(true)
    store.toggleSidebar()
    expect(state().sidebarFloating).toBe(true)

    store.zoomPanel('main', 'window')
    expect(state().sidebarFloating).toBe(false)
  })

  it('asked for while a panel has the whole window, it comes back and the panel keeps the content area', () => {
    for (const narrow of [false, true]) {
      const desk = new AppStore('ws://localhost:0/')
      vi.spyOn(desk.transport, 'request').mockImplementation((async () => null) as never)
      desk.setNarrowWindow(narrow)
      desk.zoomPanel('main', 'window')
      expect(sidebarPlacement(desk.getSnapshot())).toBe('away')

      // One press, and it is on screen — not a flag flipped that a second
      // press has to flip back.
      desk.toggleSidebar()
      expect(desk.getSnapshot().workbench.zoom).toEqual({ area: 'main', scope: 'content' })
      expect(sidebarPlacement(desk.getSnapshot())).toBe(narrow ? 'floating' : 'column')
    }
  })

  it('takes back a panel it had expanded when it is put away, rather than leave a window with nothing on it', () => {
    /* A panel docked in the sidebar and expanded is the only area drawn; put
       the sidebar away with it — the dim, ⌘B — and nothing was left on screen,
       and no control. Found in review, and seen in a real engine: no button
       left in reach. */
    for (const narrow of [true, false]) {
      const desk = new AppStore('ws://localhost:0/')
      vi.spyOn(desk.transport, 'request').mockImplementation((async () => null) as never)
      desk.setNarrowWindow(narrow)
      desk.showViewIn('sidebar', { kind: 'tasks' })
      if (narrow) desk.toggleSidebar()
      desk.zoomPanel('sidebar', 'content')
      expect(desk.getSnapshot().workbench.zoom).toEqual({ area: 'sidebar', scope: 'content' })
      expect(areaVisible(desk.getSnapshot().workbench, 'main')).toBe(false)

      // The dim in a narrow window, ⌘B on the column in a wide one.
      if (narrow) desk.closeFloatingSidebar()
      else desk.toggleSidebar()

      expect(sidebarPlacement(desk.getSnapshot())).toBe('away')
      expect(desk.getSnapshot().workbench.zoom).toBeNull()
      expect(areaVisible(desk.getSnapshot().workbench, 'main')).toBe(true)
    }
  })

  it('is left open by a conversation read in for a room, which goes nowhere', async () => {
    answers['session/read'] = session()
    answers['session/resume'] = session()
    store.setNarrowWindow(true)
    store.toggleSidebar()
    await store.openSession(ID, { runtime: RUNTIME, reveal: false })
    expect(state().sidebarFloating).toBe(true)
  })
})

describe('the line', () => {
  it('is the desktop window’s own minimum width', () => {
    /* The whole case for 720 is that the desktop app, at its ordinary zoom, can
       never be narrower. Lower that minimum and the app would float its
       sidebar at an ordinary width, with nothing here going red. */
    expect(electronMain).toMatch(new RegExp(`minWidth:\\s*${NARROW_WINDOW}\\b`))
  })
})

describe('the width, from the first frame', () => {
  const original = window.matchMedia
  afterEach(() => {
    window.matchMedia = original
  })

  it('is known before anything is drawn, and followed as the window moves', () => {
    const asked: string[] = []
    const listeners: ((event: { matches: boolean }) => void)[] = []
    window.matchMedia = ((media: string) => {
      asked.push(media)
      return {
        media,
        matches: true,
        addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => listeners.push(listener),
        removeEventListener: () => undefined,
      }
    }) as unknown as typeof window.matchMedia

    const narrow = new AppStore('ws://localhost:0/')
    expect(asked).toContain(`(max-width: ${NARROW_WINDOW - 0.02}px)`)
    expect(narrow.getSnapshot().narrowWindow).toBe(true)

    for (const listener of listeners) listener({ matches: false })
    expect(narrow.getSnapshot().narrowWindow).toBe(false)
  })
})
