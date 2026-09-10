import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sessionId, sessionKey, turnId, itemId, type Session } from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Conversation } from './Conversation'

/**
 * What a conversation says when it has nothing to show.
 *
 * There are three of these and they are not interchangeable: a session that
 * has never been used, one whose messages the agent could not restore, and no
 * session at all. The middle one used to answer for all three — start a
 * session and the first thing it told you was that the agent could not restore
 * its messages, of which there were none. Nothing had failed; nothing had
 * happened yet.
 *
 * This file exists because that fix shipped verified by hand and by nothing
 * else. The component is large and most of it wants a live host; the empty
 * states do not, and they are where it is most likely to say something untrue.
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

const KEY = sessionKey('codex', sessionId('s-1'))

const session = (over: Partial<Session> = {}): Session =>
  ({
    id: sessionId('s-1'),
    runtime: 'codex',
    cwd: '/repo',
    status: { type: 'idle' },
    createdAt: 1_000,
    updatedAt: 1_000,
    turns: [],
    itemsLoaded: true,
    ...over,
  }) as Session

const rig = (one: Session | null) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    workspace: { path: '/repo', name: 'repo', lastOpenedAt: 1 },
    runtimes: [
      {
        id: 'codex',
        // `name` is the registry's own; `presentation.name` is what the UI
        // shows. The composer reads the first and the transcript the second,
        // so a fixture with only one of them renders half the component.
        name: 'OpenAI Codex',
        presentation: { name: 'Codex' },
        capabilities: {},
      },
    ] as unknown as AppSnapshot['runtimes'],
    sessions: one ? new Map([[KEY, one]]) : new Map(),
    activeSessionKey: one ? KEY : null,
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    send: vi.fn(),
    setOption: vi.fn(),
    notice: vi.fn(),
    // The verbs the transcript reaches for on mount. Named rather than
    // proxied, so a new one shows up as a missing function here — which is
    // the component telling this fixture it has grown a dependency.
    refreshTasks: vi.fn(),
    loadHistory: vi.fn(),
    resumeSession: vi.fn(),
  } as unknown as AppStore
  return { store }
}

const render = (store: AppStore, key: string | null = KEY): void => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <PaneProvider
          scope={{
            paneId: 'p1',
            view: { kind: 'conversation', session: key as never },
            sessionKey: key as never,
          }}
        >
          <Conversation
            onChooseProject={() => undefined}
            onSignIn={() => undefined}
            onOpenUsage={() => undefined}
            onOpenAgents={() => undefined}
          />
        </PaneProvider>
      </StoreProvider>,
    )
  })
}

it('a session that has never been used is not reported as a broken one', () => {
  // `updatedAt === createdAt`: the host made it and nothing has happened since.
  render(rig(session()).store)

  expect(container.textContent).not.toContain('restore')
  expect(container.textContent).not.toContain('Nothing to show')
})

it('says plainly when an agent could not restore a conversation that was used', () => {
  // Used — `updatedAt` moved — and yet no turns came back. That is the case
  // the sentence was written for: an agent with no serving store, and no host
  // copy either.
  render(rig(session({ updatedAt: 9_000 })).store)

  expect(container.textContent).toContain('Nothing to show')
  expect(container.textContent).toContain('Codex')
  expect(container.textContent).toContain('restore')
})

it('shows the transcript once there is one, and neither empty state', () => {
  render(
    rig(
      session({
        updatedAt: 9_000,
        turns: [
          {
            id: turnId('t-1'),
            status: 'completed',
            items: [{ id: itemId('i-1'), type: 'assistantMessage', text: 'the refill is in ms' }],
          },
        ],
      }),
    ).store,
  )

  expect(container.textContent).toContain('the refill is in ms')
  expect(container.textContent).not.toContain('Nothing to show')
})

it('with no session at all, offers the opening pitch rather than a failure', () => {
  render(rig(null).store, null)

  expect(container.textContent).not.toContain('Nothing to show')
  expect(container.textContent).not.toContain('restore')
})

it('the empty pane’s Sign in names this pane’s agent, not the default', () => {
  // A member column for an agent that needs a sign-in, while the desk's
  // default is a different, signed-in agent: the button must open the
  // sign-in for *this* pane's agent.
  const onSignIn = vi.fn()
  const { store } = rig(session())
  const base = store.getSnapshot()
  const snapshot = {
    ...base,
    runtimes: [
      { ...(base.runtimes[0] as object), capabilities: { account: true } },
      { id: 'claude-code', name: 'Claude Code', presentation: { name: 'Claude' }, capabilities: { account: true } },
    ],
    activeRuntime: 'claude-code',
    accountsByRuntime: {
      codex: { accounts: [], signInMethods: [{ id: 'chatgpt', label: 'Sign in with ChatGPT', flow: 'browser' }] },
      'claude-code': { accounts: [{ kind: 'oauth', label: 'olivia@acme.dev' }], signInMethods: [] },
    },
    healthByRuntime: { codex: { state: 'ready' }, 'claude-code': { state: 'ready' } },
  } as unknown as AppSnapshot
  const scoped = { ...store, getSnapshot: () => snapshot } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={scoped}>
        <PaneProvider scope={{ paneId: 'p1', view: { kind: 'conversation', session: KEY as never }, sessionKey: KEY as never }}>
          <Conversation onChooseProject={() => undefined} onSignIn={onSignIn} onOpenUsage={() => undefined} onOpenAgents={() => undefined} />
        </PaneProvider>
      </StoreProvider>,
    )
  })
  expect(container.textContent).toContain('Sign in to Codex')
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Sign in')
  if (!button) throw new Error('no Sign in button')
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  expect(onSignIn).toHaveBeenCalledWith('codex')
})
