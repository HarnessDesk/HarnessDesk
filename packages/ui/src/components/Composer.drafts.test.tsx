import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, sessionKey, type RuntimeInfo, type Session, type SessionKey } from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider } from '../state/context'
import { draftsOf } from '../state/drafts'
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
  sessionStorage.clear()
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
let currentSnapshot: AppSnapshot
/** The send in flight: settled by the test, so a switch or an unmount can land first. */
let settle: (delivered: boolean) => void
beforeEach(() => {
  currentSnapshot = snapshot
  store = {
    subscribe: () => () => {},
    getSnapshot: () => currentSnapshot,
    transport: { request: vi.fn() },
    notice: vi.fn(),
    queue: vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve })),
    addRecoverableDraft: (key: SessionKey, draft: Parameters<AppStore['addRecoverableDraft']>[1]) => {
      draftsOf(store).addRecoverable(key, draft)
      currentSnapshot = { ...currentSnapshot, recoverableDrafts: draftsOf(store).recoverableSnapshot() }
    },
    restoreRecoverableDraft: (key: SessionKey, id: number) => {
      const restored = draftsOf(store).restore(key, id)
      currentSnapshot = { ...currentSnapshot, recoverableDrafts: draftsOf(store).recoverableSnapshot() }
      return restored
    },
  } as unknown as AppStore
})

let strict = false
afterEach(() => { strict = false })
// One stable wrapper: a new component per draw would remount the composer on
// every draw, and a switch would no longer be a switch.
const Plain = ({ children }: { children: React.ReactNode }) => <>{children}</>
const draw = (key: SessionKey | null): void => {
  const Wrap = strict ? StrictMode : Plain
  act(() => {
    root.render(
      <Wrap><StoreProvider store={store}>
        {key ? (
          <PaneProvider scope={{ paneId: 'p1', view: { kind: 'conversation', session: key }, sessionKey: key }}>
            <Composer onChooseProject={() => {}} />
          </PaneProvider>
        ) : null}
      </StoreProvider></Wrap>,
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

const restoreMessage = (text: string): void => {
  const restore = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Restore')
  if (!restore) throw new Error('no Restore action')
  act(() => restore.click())
  expect(textarea().value).toBe(text)
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

describe('a message whose send fails goes back to the conversation it was written for', () => {
  const send = (): void => {
    act(() => {
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
  }

  it('when the composer has moved to another conversation meanwhile', async () => {
    draw(one)
    type('meant for the first')
    send()
    await act(async () => {})
    expect(store.queue).toHaveBeenCalledTimes(1)
    draw(two)
    await act(async () => { settle(false) })
    // Not into the conversation now showing…
    expect(textarea().value).toBe('')
    // …but back where it was written.
    draw(one)
    expect(textarea().value).toBe('')
    restoreMessage('meant for the first')
  })

  it('when the composer was taken away meanwhile', async () => {
    draw(one)
    type('still mine')
    send()
    await act(async () => {})
    draw(null)
    await act(async () => { settle(false) })
    draw(one)
    expect(textarea().value).toBe('')
    restoreMessage('still mine')
  })

  it('into the composer again when it has come back to that conversation', async () => {
    draw(one)
    type('round trip')
    send()
    await act(async () => {})
    draw(two)
    draw(one)
    await act(async () => { settle(false) })
    draw(one)
    expect(textarea().value).toBe('')
    restoreMessage('round trip')
    draw(two)
    expect(textarea().value).toBe('')
  })

  it('the same way under StrictMode, whose replayed effects must not reset where it belongs', async () => {
    strict = true
    draw(one)
    type('strict')
    send()
    await act(async () => {})
    draw(two)
    await act(async () => { settle(false) })
    expect(textarea().value).toBe('')
    draw(one)
    expect(textarea().value).toBe('')
    restoreMessage('strict')
  })

  it('into a new composer already showing that conversation, which must not overwrite it', async () => {
    draw(one)
    type('sent from the old one')
    send()
    await act(async () => {})
    draw(null)
    draw(one)
    expect(textarea().value).toBe('')
    await act(async () => { settle(false) })
    draw(one)
    expect(textarea().value).toBe('')
    restoreMessage('sent from the old one')
  })

  it('back into the same composer when it is still showing that conversation', async () => {
    draw(one)
    type('try again')
    send()
    await act(async () => {})
    expect(textarea().value).toBe('')
    await act(async () => { settle(false) })
    draw(one)
    expect(textarea().value).toBe('')
    restoreMessage('try again')
  })
})
