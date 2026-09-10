import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, type HostMethodName, type Session } from '@harnessdesk/protocol'

import { AppStore } from './store'
import { NARROW_WINDOW, sidebarPlacement } from './workbench'

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
  it('stands beside the conversation in a wide window, unless it has been put away', () => {
    expect(sidebarPlacement({ narrowWindow: false, sidebarCollapsed: false, sidebarFloating: false })).toBe('column')
    expect(sidebarPlacement({ narrowWindow: false, sidebarCollapsed: true, sidebarFloating: false })).toBe('away')
  })

  it('floats in a narrow window only when asked, however the column was left', () => {
    for (const sidebarCollapsed of [false, true]) {
      expect(sidebarPlacement({ narrowWindow: true, sidebarCollapsed, sidebarFloating: false })).toBe('away')
      expect(sidebarPlacement({ narrowWindow: true, sidebarCollapsed, sidebarFloating: true })).toBe('floating')
    }
  })

  it('never floats in a wide window, whatever the flag says', () => {
    expect(sidebarPlacement({ narrowWindow: false, sidebarCollapsed: false, sidebarFloating: true })).toBe('column')
    expect(sidebarPlacement({ narrowWindow: false, sidebarCollapsed: true, sidebarFloating: true })).toBe('away')
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

  it('is left open by a conversation read in for a room, which goes nowhere', async () => {
    answers['session/read'] = session()
    answers['session/resume'] = session()
    store.setNarrowWindow(true)
    store.toggleSidebar()
    await store.openSession(ID, { runtime: RUNTIME, reveal: false })
    expect(state().sidebarFloating).toBe(true)
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
