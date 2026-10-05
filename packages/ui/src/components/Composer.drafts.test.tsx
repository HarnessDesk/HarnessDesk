import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, sessionKey, type RuntimeInfo, type Session, type SessionKey } from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider, useSnapshot } from '../state/context'
import { draftsOf, UNSCOPED_RECOVERY_KEY } from '../state/drafts'
import { panes, sessionOf } from '../state/layout'
import { AppStore, emptySnapshot, type AppSnapshot } from '../state/store'
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
    restoreRecoverableDraft: (key: SessionKey, id: number, destination: Parameters<AppStore['restoreRecoverableDraft']>[2]) => {
      const restored = draftsOf(store).restore(key, id, destination)
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

describe('a failed conversation read preserves typing in the fresh composer (#800)', () => {
  const mountPendingRead = async (lateSendRefusal = false) => {
    store = new AppStore('ws://localhost:0/')
    let refuse!: (error: Error) => void
    let accept!: (value: Session) => void
    let readAccepted = false
    let refuseSend: (() => void) | undefined
    const read = new Promise<Session>((resolve, reject) => { accept = resolve; refuse = reject })
    const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params?: { sessionId?: string }) => {
      if (method === 'session/read') return read
      if (method === 'session/resume') return session('missing')
      if (method === 'runtime/health') return { state: 'ready' }
      if (method === 'workspace/recent') return [{ path: '/w', name: 'project', lastOpenedAt: 0 }]
      if (method === 'session/create') return session('fresh')
      if (method === 'session/list') return { data: [], cursor: null }
      if (method === 'turn/queue' && params?.sessionId === 'missing' && !readAccepted) {
        return new Promise((_, reject) => {
          refuseSend = () => reject(new Error('No conversation missing is open.'))
          if (!lateSendRefusal) refuseSend()
        })
      }
      return []
    }) as never)
    await store.selectRuntime(runtime.id)
    await store.loadWorkspaces()
    const pending = store.openSession(sessionId('missing'), { runtime: runtime.id })
    const LiveComposer = () => {
      const state = useSnapshot()
      const pane = panes(state.layout.root)[0]!
      return <PaneProvider scope={{ paneId: pane.id, view: pane.view, sessionKey: sessionOf(pane) }}>
        <Composer onChooseProject={() => {}} />
      </PaneProvider>
    }
    act(() => root.render(<StoreProvider store={store}><LiveComposer /></StoreProvider>))
    return { request, pending, refuse, refuseSend: () => refuseSend?.(), accept: (value: Session) => {
      readAccepted = true
      accept(value)
    } }
  }

  const attachFile = (name: string) => act(() => window.dispatchEvent(new CustomEvent('harnessdesk:compose', {
    detail: { text: '', attachments: [{ name, path: `/w/${name}`, kind: 'file' }] },
  })))
  const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const enter = async (metaKey = false) => act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey, bubbles: true, cancelable: true }))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  it.each(['fresh draft', 'another conversation'])('Restore keeps newer input in %s available to swap back', async (destination) => {
    const { pending, refuse } = await mountPendingRead()
    type('Typed while opening.')
    attachFile('old.md')
    await act(async () => { refuse(new Error('No stored conversation missing.')); await pending; await painted() })
    if (destination === 'another conversation') {
      await act(async () => { await store.newSession(); await painted() })
    }
    type('Newer input.')
    attachFile('new.md')

    restoreMessage('Typed while opening.')
    expect(container.textContent).toContain('old.md')
    expect([...store.getSnapshot().recoverableDrafts.values()].flat().map((draft) => draft.text)).toEqual(['Newer input.'])
    restoreMessage('Newer input.')
    expect(container.textContent).toContain('new.md')
    expect([...store.getSnapshot().recoverableDrafts.values()].flat().map((draft) => draft.text)).toEqual(['Typed while opening.'])
    restoreMessage('Typed while opening.')
    expect(container.textContent).toContain('old.md')
    // An unscoped recovery must not keep a phantom live draft that a later
    // Restore swaps instead of the text actually in the destination.
    expect(store.drafts.live(UNSCOPED_RECOVERY_KEY)).toBeNull()
  })

  it.each([
    { meta: false, lateRefusal: false }, { meta: true, lateRefusal: false },
    { meta: false, lateRefusal: true }, { meta: true, lateRefusal: true },
  ])('keeps pending input with meta=$meta and refusal after cleanup=$lateRefusal', async ({ meta, lateRefusal }) => {
    const { request, pending, refuse, refuseSend } = await mountPendingRead(lateRefusal)
    type('Keep this pending message.')
    attachFile('pending.md')
    await enter(meta)
    expect(textarea().value).toBe('Keep this pending message.')
    expect(request.mock.calls.filter(([method]) => method === 'turn/queue')).toEqual([])
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
    expect(send.disabled).toBe(true)
    expect(send.title).toBe('Waiting for the conversation to open')
    await act(async () => { refuse(new Error('No stored conversation missing.')); await pending; await painted() })
    await act(async () => { refuseSend(); await painted() })
    expect(store.drafts.recoverable(sessionKey(runtime.id, sessionId('missing')))).toEqual([])
    restoreMessage('Keep this pending message.')
    expect(container.textContent).toContain('pending.md')
    await enter()
    expect(request.mock.calls.filter(([method]) => method === 'turn/queue').map(([, params]) => params))
      .toEqual([expect.objectContaining({ sessionId: sessionId('fresh') })])
  })

  it('enables sending the waiting draft once the conversation loads', async () => {
    const { request, pending, accept } = await mountPendingRead()
    type('Send after opening.')
    attachFile('pending.md')
    await enter()
    expect(request.mock.calls.filter(([method]) => method === 'turn/queue')).toEqual([])
    await act(async () => { accept(session('missing')); await pending; await painted() })
    expect(textarea().value).toBe('Send after opening.')
    await enter()
    expect(request.mock.calls.filter(([method]) => method === 'turn/queue').map(([, params]) => params))
      .toEqual([expect.objectContaining({ sessionId: sessionId('missing'), input: [
        { type: 'mention', name: 'pending.md', path: '/w/pending.md' },
        { type: 'text', text: 'Send after opening.' },
      ] })])
  })

  it('restores text and a file typed during the read, then sends to a new conversation', async () => {
    store = new AppStore('ws://localhost:0/')
    let refuse!: (error: Error) => void
    const read = new Promise((_, reject) => { refuse = reject })
    const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
      if (method === 'session/read') return read
      if (method === 'runtime/health') return { state: 'ready' }
      if (method === 'workspace/recent') return [{ path: '/w', name: 'project', lastOpenedAt: 0 }]
      if (method === 'session/create') return session('fresh')
      if (method === 'session/list') return { data: [], cursor: null }
      return []
    }) as never)
    await store.selectRuntime(runtime.id)
    await store.loadWorkspaces()
    const pending = store.openSession(sessionId('missing'), { runtime: runtime.id })
    const LiveComposer = () => {
      const state = useSnapshot()
      const pane = panes(state.layout.root)[0]!
      return <PaneProvider scope={{ paneId: pane.id, view: pane.view, sessionKey: sessionOf(pane) }}>
        <Composer onChooseProject={() => {}} />
      </PaneProvider>
    }
    act(() => root.render(<StoreProvider store={store}><LiveComposer /></StoreProvider>))
    type('Keep the message I am writing.')
    act(() => window.dispatchEvent(new CustomEvent('harnessdesk:compose', {
      detail: { text: '', attachments: [{ name: 'plan.md', path: '/w/plan.md', kind: 'file' }] },
    })))
    expect(container.textContent).toContain('plan.md')
    expect(store.drafts.live(sessionKey(runtime.id, sessionId('missing')))?.text).toBe('Keep the message I am writing.')

    await act(async () => {
      refuse(new Error('No stored conversation missing.'))
      await pending
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    expect(sessionOf(panes(store.getSnapshot().layout.root)[0]!)).toBeNull()
    expect([...store.getSnapshot().recoverableDrafts.values()].flat().map((draft) => draft.text)).toContain('Keep the message I am writing.')
    restoreMessage('Keep the message I am writing.')
    expect(container.textContent).toContain('plan.md')
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    expect(request.mock.calls.filter(([method]) => method === 'session/create')).toHaveLength(1)
    expect(request.mock.calls.filter(([method]) => method === 'turn/queue').map(([, params]) => params))
      .toEqual([expect.objectContaining({
        runtime: runtime.id, sessionId: sessionId('fresh'),
        input: [
          { type: 'mention', name: 'plan.md', path: '/w/plan.md' },
          { type: 'text', text: 'Keep the message I am writing.' },
        ],
      })])
  })
})

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

  it('warns that a restored image stays only in this window', () => {
    draftsOf(store).addRecoverable(one, {
      text: 'restore the image edit',
      attachments: [{ name: 'paste.png', path: 'data:image/png;base64,abc123', kind: 'image' }],
      detail: 'Restore the refused edit.',
      reason: 'edit',
    })
    currentSnapshot = { ...snapshot, recoverableDrafts: draftsOf(store).recoverableSnapshot() }
    draw(one)

    restoreMessage('restore the image edit')

    expect(container.textContent).toContain('Image not saved for reload.')
    expect(container.textContent).toContain('Attach it again after reopening HarnessDesk.')
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
