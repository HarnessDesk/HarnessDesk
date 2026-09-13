import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sessionId, sessionKey } from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider, useIsFocusedPane } from './context'
import { emptySnapshot, type AppSnapshot, type AppStore } from './store'

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

const FocusProbe = () => {
  const isFocused = useIsFocusedPane()
  return <span data-testid="focus-probe" data-focused={String(isFocused)} />
}

const render = (focusedPane: string, paneId?: string) => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    workbench: {
      ...emptySnapshot().workbench,
      main: {
        ...emptySnapshot().workbench.main,
        focused: focusedPane as never,
      },
      focus: null,
    },
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as AppStore

  const content = <FocusProbe />

  act(() => {
    root.render(
      <StoreProvider store={store}>
        {paneId ? (
          <PaneProvider
            scope={{
              paneId: paneId as never,
              view: { kind: 'conversation', session: sessionKey('codex' as never, sessionId('s-1')) },
              sessionKey: sessionKey('codex' as never, sessionId('s-1')),
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
