import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, sessionKey, type RuntimeInfo, type Session, type SessionKey } from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Composer } from './Composer'

/**
 * A typed message is never lost.
 *
 * The composer comes and goes for reasons that have nothing to do with the
 * words in it — a Side by side tile returned to the grid takes its composer
 * away, and expanding it again draws a new one. The draft is the
 * conversation's, so the new composer finds it waiting.
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

const runtime = {
  id: runtimeId('claude-code'),
  name: 'Claude Code',
  capabilities: {} as RuntimeInfo['capabilities'],
  presentation: { name: 'Claude Code' },
} as RuntimeInfo

const one = sessionKey(runtime.id, sessionId('s-1'))
const two = sessionKey(runtime.id, sessionId('s-2'))
const session = (id: string): Session => ({
  id: sessionId(id),
  runtime: runtime.id,
  cwd: '/w',
  status: { type: 'idle' },
  createdAt: 1,
  updatedAt: 1,
  turns: [],
  itemsLoaded: true,
}) as unknown as Session

const snapshot: AppSnapshot = {
  ...emptySnapshot(),
  runtimes: [runtime],
  activeRuntime: runtime.id,
  health: { state: 'ready' } as AppSnapshot['health'],
  workspace: { path: '/w', name: 'w' } as AppSnapshot['workspace'],
  sessions: new Map([[one, session('s-1')], [two, session('s-2')]]),
}
/* A fresh store per test: the drafts are the store's, so one test's words
   can never be waiting in the next test's composer. */
let store: AppStore
beforeEach(() => {
  store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request: vi.fn() },
    notice: vi.fn(),
  } as unknown as AppStore
})

const draw = (key: SessionKey | null): void => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        {key ? (
          <PaneProvider scope={{ paneId: 'p1', view: { kind: 'conversation', session: key }, sessionKey: key }}>
            <Composer onChooseProject={() => {}} />
          </PaneProvider>
        ) : null}
      </StoreProvider>,
    )
  })
}

const textarea = (): HTMLTextAreaElement => {
  const element = container.querySelector('textarea')
  if (!element) throw new Error('no textarea')
  return element
}

const type = (value: string): void => {
  const element = textarea()
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('a draft belongs to its conversation, not to the composer drawing it', () => {
  it('is waiting when the composer is taken away and drawn again', () => {
    draw(one)
    type('keep me')
    draw(null)
    expect(container.querySelector('textarea')).toBeNull()
    draw(one)
    expect(textarea().value).toBe('keep me')
  })

  it('stays with its own conversation when the composer is moved to another', () => {
    draw(one)
    type('for the first')
    draw(two)
    expect(textarea().value).toBe('')
    type('for the second')
    draw(one)
    expect(textarea().value).toBe('for the first')
    draw(two)
    expect(textarea().value).toBe('for the second')
  })
})
