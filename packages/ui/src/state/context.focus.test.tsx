import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runtimeId, sessionId, sessionKey } from '@harnessdesk/protocol'

import { KeyboardHereContext, PaneProvider, StoreProvider, useIsFocusedPane } from './context'
import { emptySnapshot, type AppSnapshot, type AppStore } from './store'
import type { PageDestination } from './destinations'
import type { PaneView } from './layout'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TEST_SESSION = sessionKey('codex' as never, sessionId('s-1'))

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

const FocusProbe = () => {
  const isFocused = useIsFocusedPane()
  return <span data-testid="focus-probe" data-focused={String(isFocused)} />
}

const render = (focusedPane: string, paneId?: string, keyboardHere: boolean | null = null, page?: PageDestination, view?: PaneView) => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeSessionKey: TEST_SESSION,
    workbench: {
      ...emptySnapshot().workbench,
      main: {
        ...emptySnapshot().workbench.main,
        focused: focusedPane as never,
      },
      focus: null,
      navigation: page ? { current: page, back: [], forward: [] } : emptySnapshot().workbench.navigation,
    },
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as AppStore

  const content = <KeyboardHereContext.Provider value={keyboardHere}><FocusProbe /></KeyboardHereContext.Provider>

  act(() => {
    root.render(
      <StoreProvider store={store}>
        {paneId ? (
          <PaneProvider
            scope={{
              paneId: paneId as never,
              view: view ?? { kind: 'conversation', session: TEST_SESSION },
              sessionKey: TEST_SESSION,
            }}
          >
            {content}
          </PaneProvider>
        ) : (
          content
        )}
      </StoreProvider>,
    )
  })
  return snapshot
}

const isFocused = (): boolean =>
  container.querySelector('[data-testid="focus-probe"]')?.getAttribute('data-focused') === 'true'

describe('useIsFocusedPane (#381)', () => {
  it('returns true for member conversation column when the parent team room mount is focused', () => {
    // TeamRoomPane synthesizes paneId as `${mount.id}:${key}` (e.g. 'p1:codex\x00s-1')
    render('p1', 'p1:codex\x00s-1')
    expect(isFocused()).toBe(true)
  })

  it('returns false for member conversation column when parent mount is not focused', () => {
    render('p2', 'p1:codex\x00s-1')
    expect(isFocused()).toBe(false)
  })

  it('returns true for standalone team room without parent mount', () => {
    render('p1', 'team-room:codex\x00s-1')
    expect(isFocused()).toBe(true)
  })

  it('returns true for standard pane when paneId matches focused mount directly', () => {
    render('p1', 'p1')
    expect(isFocused()).toBe(true)
  })

  it('returns false for standard pane when paneId does not match focused mount', () => {
    render('p2', 'p1')
    expect(isFocused()).toBe(false)
  })

  it('returns true when outside any pane', () => {
    render('p1')
    expect(isFocused()).toBe(true)
  })
})

describe('useIsFocusedPane inside a mount that holds several conversations', () => {
  it('is false for a part that says the keyboard is elsewhere, though its mount is focused', () => {
    render('p1', 'p1:codex\x00s-1', false)
    expect(isFocused()).toBe(false)
  })

  it('is unchanged where the part has the keyboard or says nothing', () => {
    render('p1', 'p1:codex\x00s-1', true)
    expect(isFocused()).toBe(true)
    render('p1', 'p1:codex\x00s-1', null)
    expect(isFocused()).toBe(true)
    render('p2', 'p1:codex\x00s-1', true)
    expect(isFocused()).toBe(false)
  })
})

const libraryPage = { kind: 'library', section: 'skill' } as const
it('a page relinquishes retained conversation keyboard focus without losing remembered work', () => {
  const snapshot = render('p1','p1',true,libraryPage)
  expect(isFocused()).toBe(false)
  expect(snapshot.activeSessionKey).toBe(TEST_SESSION)
})
it('a page relinquishes retained room keyboard focus', () => {
  render('p1','p1',true,libraryPage,{kind:'room',room:'fixture-team'})
  expect(isFocused()).toBe(false)
})
it('a page keeps the shared terminal and outside-pane keyboard scopes active', () => {
  render('p1','p1',true,libraryPage,{kind:'terminal',terminalId:'fixture-terminal',runtime:runtimeId('fixture'),cwd:'/synthetic/project'})
  expect(isFocused()).toBe(true)
  render('p1',undefined,null,libraryPage)
  expect(isFocused()).toBe(true)
})
