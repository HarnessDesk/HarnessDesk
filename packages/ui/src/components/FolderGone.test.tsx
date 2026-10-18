import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, sessionKey, type Session, type SessionSummary } from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { FolderGone } from './FolderGone'

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

const RUNTIME = runtimeId('codex')
const FOLDER = '/home/jane/project/.worktrees/agent-long-worktree-name-for-archive-1771'
const KEY = sessionKey(RUNTIME, sessionId('s-1'))

const mount = ({
  sessions = [],
  history = [],
}: {
  sessions?: readonly Session[]
  history?: readonly SessionSummary[]
}) => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeSessionKey: sessionKey(RUNTIME, sessionId('elsewhere')),
    sessions: new Map(sessions.map((s) => [sessionKey(s.runtime, s.id), s])),
    history,
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    openCopyElsewhere: vi.fn(),
    archiveSession: vi.fn(),
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <PaneProvider scope={{ paneId: 'p1', view: { kind: 'conversation', session: KEY as never }, sessionKey: KEY as never }}>
          <FolderGone folder={FOLDER} said={`The folder ${FOLDER} no longer exists.`} />
        </PaneProvider>
      </StoreProvider>,
    )
  })

  return { store }
}

describe('FolderGone (#387)', () => {
  it('counts other conversations from history when only one session is active in memory', () => {
    // Current session is loaded into snapshot.sessions
    const activeSession: Session = {
      id: sessionId('s-1'),
      runtime: RUNTIME,
      cwd: FOLDER,
      status: { type: 'idle' },
      createdAt: 1000,
      updatedAt: 1000,
      turns: [],
      itemsLoaded: true,
    }

    // Two other conversations exist in history for that folder, plus the active one
    const history: SessionSummary[] = [
      { id: sessionId('s-1'), runtime: RUNTIME, cwd: FOLDER, status: { type: 'idle' }, createdAt: 1000, updatedAt: 1000 },
      { id: sessionId('s-2'), runtime: RUNTIME, cwd: FOLDER, status: { type: 'idle' }, createdAt: 2000, updatedAt: 2000 },
      { id: sessionId('s-3'), runtime: RUNTIME, cwd: FOLDER, status: { type: 'idle' }, createdAt: 3000, updatedAt: 3000 },
      { id: sessionId('s-4'), runtime: RUNTIME, cwd: '/different/folder', status: { type: 'idle' }, createdAt: 4000, updatedAt: 4000 },
    ]

    mount({ sessions: [activeSession], history })

    expect(container.textContent).toContain('2 other conversations ran in the same folder.')
  })

  it('correctly says "One other conversation" when exactly one other conversation ran in the same folder', () => {
    const activeSession: Session = {
      id: sessionId('s-1'),
      runtime: RUNTIME,
      cwd: FOLDER,
      status: { type: 'idle' },
      createdAt: 1000,
      updatedAt: 1000,
      turns: [],
      itemsLoaded: true,
    }

    const history: SessionSummary[] = [
      { id: sessionId('s-1'), runtime: RUNTIME, cwd: FOLDER, status: { type: 'idle' }, createdAt: 1000, updatedAt: 1000 },
      { id: sessionId('s-2'), runtime: RUNTIME, cwd: FOLDER, status: { type: 'idle' }, createdAt: 2000, updatedAt: 2000 },
    ]

    mount({ sessions: [activeSession], history })

    expect(container.textContent).toContain('One other conversation ran in the same folder.')
  })

  it('omits note when no other conversations ran in the same folder', () => {
    const activeSession: Session = {
      id: sessionId('s-1'),
      runtime: RUNTIME,
      cwd: FOLDER,
      status: { type: 'idle' },
      createdAt: 1000,
      updatedAt: 1000,
      turns: [],
      itemsLoaded: true,
    }

    const history: SessionSummary[] = [
      { id: sessionId('s-1'), runtime: RUNTIME, cwd: FOLDER, status: { type: 'idle' }, createdAt: 1000, updatedAt: 1000 },
    ]

    mount({ sessions: [activeSession], history })

    expect(container.textContent).not.toContain('other conversation')
  })
})

describe('FolderGone (#1771)', () => {
  it('archives the pane conversation with the existing archive action, after the copy action', () => {
    const { store } = mount({})
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.map(button => button.textContent)).toEqual(['Open a copy in another folder', 'Archive'])
    act(() => buttons[1]!.click())
    expect(store.archiveSession).toHaveBeenCalledWith(sessionId('s-1'), RUNTIME)
  })

  it('names only the last folder segment and keeps the full path on hover', () => {
    mount({})
    expect(container.textContent).toContain('The folder ')
    expect(container.textContent).toContain(' no longer exists.')
    expect(container.textContent).not.toContain(FOLDER)
    const path = container.querySelector(`[title="${FOLDER}"]`)
    expect(path?.querySelector('.sr-only')?.textContent).toBe('agent-long-worktree-name-for-archive-1771')
    expect(path?.getAttribute('data-slot')).toBe('middle-truncate')
  })

  it('explains the copy and opens it from the pane conversation', () => {
    const { store } = mount({})
    const button = container.querySelector('button')!
    expect(button.title).toBe("Starts a new conversation with this one's summary; you choose the folder.")
    act(() => button.click())
    expect(store.openCopyElsewhere).toHaveBeenCalledWith(KEY)
  })
})
