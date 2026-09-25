import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sessionId, sessionKey, turnId, itemId, type AgentEntry, type Session } from '@harnessdesk/protocol'

import { seatAgentKey } from '../lib/agents'
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

const rig = (
  one: Session | null,
  foldersGone: ReadonlyMap<string, string> = new Map(),
  over: Partial<AppSnapshot> = {},
) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    foldersGone,
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
    ...over,
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
    readSeatAgent: vi.fn(),
    // Not recorded — these fixtures never made any Agent declare an attachment.
    seatRecord: vi.fn(async () => null),
    readSeatAttachments: vi.fn(async () => null),
    // The front door the ready empty pane opens, once its own project (this
    // session's folder) is known — an empty catalogue is enough to mount it.
    openFrontDoor: vi.fn(),
    closeFrontDoor: vi.fn(),
    flowCatalog: vi.fn(async () => []),
    agentsIn: vi.fn(async () => []),
    openGoal: vi.fn(),
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
            onOpenRuntimes={() => undefined}
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

it('a ready, empty pane whose folder is known offers to start with a team there', async () => {
  const { store } = rig(session())
  render(store)

  const start = [...container.querySelectorAll('button')].find((one) => one.textContent?.trim().startsWith('Start with a team'))!
  await act(async () => start.click())

  expect(store.openFrontDoor).toHaveBeenCalledWith({ kind: 'project', root: '/repo' }, undefined)
})

it('with no session at all — no folder to read a catalogue from — offers no team action', () => {
  render(rig(null).store, null)
  expect([...container.querySelectorAll('button')].some((one) => one.textContent?.trim().startsWith('Start with a team'))).toBe(false)
})

it('carries the window’s own controls whenever the sidebar is not standing beside it', () => {
  const { store } = rig(session())
  const base = store.getSnapshot()
  const toggle = (): Element | null => container.querySelector('header button[aria-label="Show sidebar"]')
  const draw = (snapshot: AppSnapshot, paneId: string): void => {
    act(() => {
      root.render(
        <StoreProvider store={{ ...store, getSnapshot: () => snapshot } as unknown as AppStore}>
          <PaneProvider
            scope={{ paneId: paneId as never, view: { kind: 'conversation', session: KEY as never }, sessionKey: KEY as never }}
          >
            <Conversation
              onChooseProject={() => undefined}
              onSignIn={() => undefined}
              onOpenUsage={() => undefined}
              onOpenRuntimes={() => undefined}
            />
          </PaneProvider>
        </StoreProvider>,
      )
    })
  }
  const middle = base.layout.focused

  // A column beside the header carries them itself.
  draw(base, middle)
  expect(toggle()).toBeNull()

  /* A narrow window never gives the sidebar a column: it floats, and closed it
     is reached from here or not at all — however the column was last left. */
  const narrow = { ...base, narrowWindow: true }
  draw(narrow, middle)
  expect(toggle()).not.toBeNull()

  // The middle's own header only: a member's column in a room, or a
  // conversation docked beside the middle, is not the window's top row.
  draw(narrow, `${middle}:${KEY}`)
  expect(toggle()).toBeNull()
})

it('marks a door to fold into ⋯ only where there is a ⋯ to fold it into', () => {
  const browser = (): Element | null => container.querySelector('header button[aria-label="Open browser"]')
  const menu = (): Element | null => container.querySelector('header button[aria-label="Conversation"]')

  // A draft has no conversation menu, so its browser button must stay put: a
  // narrow header that folded it left the draft with no way to the browser.
  render(rig(null).store, null)
  expect(menu()).toBeNull()
  expect(browser()).not.toBeNull()
  expect(browser()?.hasAttribute('data-folds')).toBe(false)

  // With a conversation the ⋯ is there, and both doors fold into its View group.
  render(rig(session()).store)
  expect(menu()).not.toBeNull()
  expect(browser()?.hasAttribute('data-folds')).toBe(true)
  expect(container.querySelector('header button[aria-label="Open terminal"]')?.hasAttribute('data-folds')).toBe(true)
})

it('the chips a narrow header folds still say their words on hover', () => {
  const { store } = rig(session())
  const snapshot = {
    ...store.getSnapshot(),
    tasks: new Map([[KEY, [{ id: 't1', label: 'npm run dev', kind: 'command', state: 'running' }]]]),
  } as unknown as AppSnapshot
  render({ ...store, getSnapshot: () => snapshot } as unknown as AppStore)

  // The branch chip: the name it shows (here the folder, there being no
  // branch), then where it is — the path alone was not the word that folded.
  const git = [...container.querySelectorAll<HTMLButtonElement>('header button')].find((button) =>
    button.title.endsWith('/repo'),
  )
  expect(git?.title).toBe('repo — /repo')
  // The tasks chip leads with its own words.
  const tasks = container.querySelector<HTMLButtonElement>('[data-testid="tasks-chip"]')
  expect(tasks?.title.startsWith('1 running in the background. ')).toBe(true)
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
          <Conversation onChooseProject={() => undefined} onSignIn={onSignIn} onOpenUsage={() => undefined} onOpenRuntimes={() => undefined} />
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

/**
 * The folder a conversation ran in has been deleted.
 *
 * The transcript is whole — the host serves its own copy when the agent
 * cannot — so the pane is not broken, it is read-only, and the composer is
 * the thing that has to go: a box that invites a message nothing can deliver
 * is the lie this replaces (#127).
 */
it('puts the reason where the composer would be, in the agent’s own words', () => {
  const said = 'Codex cannot open this conversation: its folder no longer exists (/repo).'
  render(rig(session({ updatedAt: 9_000 }), new Map([['/repo', said]])).store)

  expect(container.textContent).toContain('folder is gone')
  expect(container.textContent).toContain(said)
  expect(container.textContent).toContain('Open a copy in another folder')
  // Nothing to type into: there is nowhere for it to go.
  expect(container.querySelector('textarea')).toBeNull()
})

it('leaves the composer alone when the folder is where it always was', () => {
  render(rig(session({ updatedAt: 9_000 })).store)

  expect(container.textContent).not.toContain('folder is gone')
  expect(container.querySelector('textarea')).not.toBeNull()
})

it('a conversation seated as an Agent is headed by it — once, while its title is the Agent’s name', () => {
  const settings = { cwd: '/repo', model: 'gpt-5.6-sol', agent: 'code-reviewer', briefDigest: 'd', ceiling: { level: 'edit' as const, hold: 'asked' as const }, seatLabel: 'Codex', passedOver: [] }
  const entry = { id: 'code-reviewer', origin: 'builtin', path: '/app/agents/code-reviewer/AGENT.md', digest: 'd', shadows: [], problems: [], definition: { id: 'code-reviewer', name: 'Code reviewer', ceiling: 'edit', ceilingFrom: 'permission', answers: [], produces: [], skills: [], mcp: [], prefer: [], brief: '' } } as AgentEntry
  const over = { seatAgents: new Map([[seatAgentKey('/repo', 'code-reviewer'), entry]]) }
  const header = (): string => container.querySelector('header')?.textContent ?? ''

  render(rig(session({ title: 'Checkout review', settings }), new Map(), over).store)
  expect(header()).toContain('Code reviewer · Checkout review')

  render(rig(session({ title: 'Code reviewer', settings }), new Map(), over).store)
  expect(header()).toContain('Code reviewer')
  expect(header()).not.toContain('Code reviewer · Code reviewer')
})

it('a plain conversation’s header is unchanged, and asks nothing about an Agent', () => {
  const { store } = rig(session({ title: 'Checkout review' }))
  render(store)
  expect(container.querySelector('header')?.textContent).toContain('Checkout review')
  expect(store.readSeatAgent).not.toHaveBeenCalled()
})

it('a conversation seated as an Agent carries its ceiling beside its title — held or asked — and a plain one carries none', () => {
  render(
    rig(
      session({
        settings: { cwd: '/repo', model: 'gpt-5.6', agent: 'reviewer', ceiling: { level: 'read', hold: 'held' }, ceilingNote: 'Read-only sandbox; anything past it asks you' },
      }),
    ).store,
  )
  const chip = container.querySelector('header [data-ceiling]') as HTMLElement | null
  expect(chip?.textContent).toBe('Read · held')
  expect(chip?.title).toMatch(/Held: Read-only sandbox/)

  render(rig(session({ settings: { cwd: '/repo', model: 'gpt-5.6', agent: 'writer', ceiling: { level: 'edit', hold: 'asked' } } })).store)
  expect(container.querySelector('header [data-ceiling]')?.getAttribute('data-hold')).toBe('asked')

  render(rig(session({ settings: { cwd: '/repo', model: 'gpt-5.6' } })).store)
  expect(container.querySelector('[data-ceiling]')).toBeNull()
})

it('the conversation’s menu offers Save as an Agent…', () => {
  render(rig(session()).store)
  act(() => container.querySelector<HTMLButtonElement>('header button[aria-label="Conversation"]')?.click())
  const item = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((one) =>
    one.textContent?.startsWith('Save as an Agent…'),
  )
  if (!item) throw new Error('no Save as an Agent… in the menu')
  act(() => item.click())
  expect(document.body.querySelector('[role="dialog"][aria-label="Save as an Agent"]')).not.toBeNull()
})
