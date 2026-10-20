import { FRAME } from '../design/frame'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { wrapContext, reduceSession, runtimeId, sessionId, sessionKey, turnId, itemId, type AgentEntry, type GoalView, type Session } from '@harnessdesk/protocol'

import { seatAgentKey } from '../lib/agents'
import { PaneProvider, StoreProvider } from '../state/context'
import { AppStore, emptySnapshot, type AppSnapshot } from '../state/store'
import { Conversation } from './Conversation'
import styles from './Conversation.module.css'
import { TopBarProvider, TopBarOutlet, WorkDetailsOutlet } from '../panels/top-bar'
import * as harness from '../preview/harness'
import { FrameWall } from '../preview/frames-frame-wall'

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

// These body/data tests give their standalone bar enough measured title room.
// jsdom supplies neither flex geometry nor tokens; real fold widths are pinned
// by TopBar's measurement tests and frame-contract, not the body rig's viewport.
let restoreBarGeometry = () => {}
beforeEach(() => {
  const bounds = HTMLElement.prototype.getBoundingClientRect
  const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.matches('[data-topbar-title], [data-topbar="place"]') ? new DOMRect(0, 0, FRAME.bar.titleMin, FRAME.bar.height) : bounds.call(this)
  })
  const computed = getComputedStyle
  const token = vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((node, pseudo) => {
    const result = computed(node, pseudo)
    if (!node.matches('[data-slot="top-bar"]')) return result
    return new Proxy(result, { get(target, property) {
      if (property === 'getPropertyValue') return (name: string) => name === '--hd-bar-title-min'
        ? `${FRAME.bar.titleMin}px` : target.getPropertyValue(name)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  restoreBarGeometry = () => { token.mockRestore(); geometry.mockRestore() }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  try { act(() => root.unmount()); container.remove() }
  finally { restoreBarGeometry() }
})

// jsdom does not track keyboard/pointer modality across these rendered rigs.
const keyboardFocus = (element: HTMLElement) => {
  const matches = element.matches.bind(element)
  vi.spyOn(element, 'matches').mockImplementation((selector) => selector === ':focus-visible' ? true : matches(selector))
  act(() => element.focus())
}

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
    refreshWorkspaceGit: vi.fn(async () => {}),
    getSnapshot: () => snapshot,
    workSubject: () => one ? `session:${KEY}` : 'draft:p1',
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
    loadAccounts: vi.fn(),
    agentCatalog: vi.fn(async () => []),
    addAgent: vi.fn(async () => null),
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

const render = (store: AppStore, key: string | null = KEY, props: Partial<React.ComponentProps<typeof Conversation>> = {}): void => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <TopBarProvider><PaneProvider
          scope={{
            paneId: 'p1',
            view: { kind: 'conversation', session: key as never },
            sessionKey: key as never,
          }}
        >
          <TopBarOutlet owner="p1" fallback={{ place: 'New session', more: () => null }} /><WorkDetailsOutlet owner="p1" />
          <Conversation
            {...props}
            onChooseProject={() => undefined}
            onSignIn={() => undefined}
            onOpenUsage={() => undefined}
            onOpenRuntimes={() => undefined}
          />
        </PaneProvider></TopBarProvider>
      </StoreProvider>,
    )
  })
}

const expectNoticeBelowEmptyState = () => {
  const transcript = container.querySelector('[data-live-transcript]')
  const empty = transcript?.querySelector('[data-slot="conversation-empty-state"]')
  const notice = transcript?.querySelector('[data-turn^="notice:"]')
  expect(empty).not.toBeNull()
  expect(empty?.getAttribute('data-height')).toBe('content')
  // Empty-state height belongs to the reading pane, not the measured turn body.
  expect(empty?.parentElement === transcript).toBe(true)
  expect(notice).not.toBeNull()
  expect(empty!.compareDocumentPosition(notice!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
}

it('a session that has never been used is not reported as a broken one', () => {
  // `updatedAt === createdAt`: the host made it and nothing has happened since.
  render(rig(session()).store)

  expect(container.textContent).not.toContain('restore')
  expect(container.textContent).not.toContain('Nothing to show')
})

it('loads in the same column as every other empty state, clear of the composer', () => {
  render(rig(session(), new Map(), { loadingSessions: new Set([KEY]) } as Partial<AppSnapshot>).store)

  const empty = container.querySelector<HTMLElement>('[data-slot="conversation-empty-state"]')
  expect(empty?.textContent).toContain('Loading transcript')
  expect(empty?.dataset.direction).toBe('row')
  expect(empty?.dataset.height).toBe('pane')
  // The loading row and the empty states it can give way to share one parent
  // shape. Pane-filling empty states keep the word in place; notice-only
  // restores move the explanation up beside their notice.
  const column = empty?.parentElement
  expect(column?.dataset.slot).toBe('pane-column')
  expect(column?.dataset.inset).toBe('reading')
  expect(column?.style.padding).toContain('--composer-h')
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

it('keeps the opening pitch above a notice-only conversation', () => {
  const id = sessionId('s-1')
  const withNotice = reduceSession(session(), { type: 'notice', sessionId: id, class: 'conversation', level: 'warning', message: 'No tools declared', id: 'tools-1' })
  render(rig(withNotice).store)

  expect(container.textContent).toContain('What should we build?')
  expect(container.textContent).toContain('No tools declared')
  expectNoticeBelowEmptyState()
})

it('keeps a saved conversation identity visible when its runtime is absent', () => {
  const runtime = runtimeId('synthetic-missing')
  const saved = session({
    runtime,
    title: 'Judge the storefront layout',
    turns: [],
    itemsLoaded: false,
  })
  const { store } = rig(null)
  const key = sessionKey(runtime, saved.id)
  Object.assign(store.getSnapshot(), {
    sessions: new Map([[key, saved]]),
    activeSessionKey: key,
  })

  render(store, key)

  expect(container.textContent).toContain('Judge the storefront layout')
  expect(container.textContent).toContain('Add it in Settings')
  expect(container.textContent).not.toContain('What should we build?')
  expect(container.textContent).not.toContain('Waiting for the runtime')
  expect(container.querySelector('textarea')).toBeNull()
})

it('keeps the restore explanation above a notice-only conversation', () => {
  const id = sessionId('s-1')
  const withNotice = reduceSession(session({ updatedAt: 9_000 }), { type: 'notice', sessionId: id, class: 'conversation', level: 'warning', message: 'No tools declared', id: 'tools-1' })
  render(rig(withNotice).store)

  expect(container.textContent).toContain('Nothing to show')
  expect(container.textContent).toContain('restore')
  expect(container.textContent).toContain('No tools declared')
  expectNoticeBelowEmptyState()
})

it.each([
  ['unavailable', 'The agent could not start. Check the runtime in Settings, then reopen this conversation.', {
    healthByRuntime: { codex: { state: 'unavailable', message: 'The agent could not start.' } },
  }],
  ['signed out', 'Sign in to Codex', {
    accountsByRuntime: { codex: { accounts: [], signInMethods: [] } },
  }],
  ['blocked', 'Usage limit reached', {
    limits: { reached: 'rate_limit_reached', windows: [] },
  }],
] as const)('keeps the %s explanation above a notice-only conversation', (_state, title, over) => {
  const withNotice = reduceSession(session(), {
    type: 'notice', sessionId: sessionId('s-1'), class: 'conversation',
    level: 'warning', message: 'No tools declared', id: 'tools-1',
  })
  const { store } = rig(withNotice)
  const base = store.getSnapshot()
  render(rig(withNotice, new Map(), {
    ...over,
    activeRuntime: base.runtimes[0]!.id,
    runtimes: [{
      ...base.runtimes[0]!,
      capabilities: { ...base.runtimes[0]!.capabilities, account: true, metered: true },
    }],
  } as Partial<AppSnapshot>).store)

  expect(container.textContent).toContain(title)
  expectNoticeBelowEmptyState()
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

it('keeps one short draft pitch with a chosen project', () => {
  const { store } = rig(null, new Map(), {
    workspace: { path: '/work/storefront', name: 'storefront', lastOpenedAt: 1 },
  })
  render(store, null)

  expect(container.textContent).toContain('Describe a task.')
  expect(container.textContent).not.toContain('Pick a project folder')
})

it('a ready, empty pane whose folder is known offers to start with a team there', async () => {
  const { store } = rig(session())
  render(store)

  const start = [...container.querySelectorAll('button')].find((one) => one.textContent?.trim().startsWith('Start with a team'))!
  await act(async () => start.click())

  expect(store.openFrontDoor).toHaveBeenCalledWith({ kind: 'project', root: '/repo' }, undefined)
})

it('uses the page role’s own weight for the empty conversation title', () => {
  render(rig(session()).store)
  const title = container.querySelector('[data-slot="conversation-empty-state"] [data-role="page"]')!
  expect(title.textContent).toBe('What should we build?')
  expect(title.classList.contains('font-semibold')).toBe(true)
  expect(title.hasAttribute('data-weight')).toBe(false)
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
          <TopBarProvider><TopBarOutlet owner={snapshot.layout.focused} fallback={{ place: 'New session', more: () => null }} /><PaneProvider
            scope={{ paneId: paneId as never, view: { kind: 'conversation', session: KEY as never }, sessionKey: KEY as never }}
          >
            <Conversation
              onChooseProject={() => undefined}
              onSignIn={() => undefined}
              onOpenUsage={() => undefined}
              onOpenRuntimes={() => undefined}
            />
          </PaneProvider></TopBarProvider>
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

it('draft and conversation keep the fixed browser door and More in the shell', () => {
  for (const one of [null, session()]) {
    render(rig(one).store, one ? KEY : null)
    expect(container.querySelector('header button[aria-label="Browser"]')).not.toBeNull()
    expect(container.querySelector('header button[aria-label="More"]')).not.toBeNull()
    expect(container.querySelector('header button[aria-label="Browser"]')?.hasAttribute('data-folds')).toBe(false)
  }
})

it('folder facts remain readable in Details when the shell title folds', () => {
  render(rig(session()).store)
  const facts = container.querySelector('[aria-label="Conversation facts"]')!
  const folder = [...facts.querySelectorAll('[data-slot="summary-item"]')].find(one => one.querySelector('dt')?.textContent === 'Folder')!
  const path = folder.querySelector('[data-slot="middle-truncate"]')!
  expect(path.querySelector('.sr-only')?.textContent).toBe('/repo')
  expect(path.querySelector('[data-part="tail"]')?.textContent).toBe('/repo')
  expect(path.className).toContain('whitespace-nowrap')
  expect(path.className).toContain('overflow-hidden')
  expect(container.querySelector('header [aria-label="Conversation status"]')).toBeNull()
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
  expect(button.getAttribute('data-variant')).toBe('default')
  expect(button.className).not.toContain('h-auto')
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
  expect(container.textContent).toContain('Codex cannot open this conversation: its folder no longer exists (')
  const refusal = [...container.querySelectorAll('[data-slot="alert-description"]')].find(one => one.textContent?.includes('folder no longer exists'))!
  expect(refusal.textContent).not.toContain('/repo')
  expect(refusal.querySelector('[title="/repo"] .sr-only')?.textContent).toBe('repo')
  const folderFact = [...container.querySelectorAll('[data-slot="summary-item"]')].find(one => one.querySelector('dt')?.textContent === 'Folder')!
  expect(folderFact.querySelector('.sr-only')?.textContent).toBe('/repo')
  expect(container.textContent).toContain('Open a copy in another folder')
  expect(container.textContent).toContain('Archive')
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

it('Details reports the recorded held or asked ceiling, and leaves unknown facts unknown', () => {
  render(rig(session({ settings: { cwd: '/repo', model: 'gpt-5.6', agent: 'reviewer', ceiling: { level: 'read', hold: 'held' }, ceilingNote: 'Read-only sandbox; anything past it asks you' } })).store)
  const facts = () => container.querySelector('[aria-label="Conversation facts"]')!
  const ceiling = () => [...facts().querySelectorAll('[data-slot="summary-item"]')].find(one => one.querySelector('dt')?.textContent === 'Ceiling')
  const details = () => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Conversation"] button')].find(one => one.textContent?.trim() === 'Details')!
  expect(ceiling()?.textContent).toContain('Read')
  expect(ceiling()?.textContent).toContain('Held')
  expect(ceiling()?.textContent).not.toContain('Asked')
  expect(ceiling()?.querySelector('[title*="Read-only sandbox"]')).not.toBeNull()
  expect(details().getAttribute('aria-expanded')).toBe('false')
  expect(container.textContent).not.toContain('Read-only sandbox')
  act(() => details().click())
  expect(container.textContent).toContain('Held: Read-only sandbox')
  expect(container.querySelector('header [data-ceiling]')).toBeNull()
  render(rig(session({ settings: { cwd: '/repo', model: 'gpt-5.6', agent: 'writer', ceiling: { level: 'edit', hold: 'asked' } } })).store)
  expect(ceiling()?.textContent).toContain('Edit')
  expect(ceiling()?.textContent).toContain('Asked, not held')
  expect(ceiling()?.querySelector('[title*="Asked, not held"]')).not.toBeNull()
  if (details().getAttribute('aria-expanded') === 'false') act(() => details().click())
  expect(container.textContent).toContain("The desk's own tools still refuse anything above it.")
  render(rig(session({ settings: { cwd: '/repo', model: 'gpt-5.6' } })).store)
  expect(ceiling()).toBeUndefined()
  expect(container.textContent).toContain('Permission level not reported for this conversation.')
})

it('the conversation’s menu offers Save as an Agent…', () => {
  render(rig(session()).store)
  act(() => container.querySelector<HTMLButtonElement>('header button[aria-label="More"]')?.click())
  const item = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((one) =>
    one.textContent?.startsWith('Save as an Agent…'),
  )
  if (!item) throw new Error('no Save as an Agent… in the menu')
  act(() => item.click())
  expect(document.body.querySelector('[role="dialog"][aria-label="Save as an Agent"]')).not.toBeNull()
})

/**
 * A wrapped Team's conversations are its record, and the host refuses to
 * compact one. The menu must not offer a row that can only fail: it says why,
 * in the reason every other refused control gives, and a conversation outside
 * the Team keeps it.
 */
const compacting = [
  { id: 'codex', name: 'OpenAI Codex', presentation: { name: 'Codex' }, capabilities: { compaction: true } },
] as unknown as AppSnapshot['runtimes']

/** One wrapped Team whose receipt kept these conversations. */
const wrappedTeam = (...kept: readonly string[]): ReadonlyMap<string, GoalView> =>
  new Map([['record', {
    goal: { state: 'wrapped' },
    members: [],
    receipt: { members: kept.map((id) => ({ session: { runtime: 'codex', sessionId: id } })), answers: [] },
  } as unknown as GoalView]])

const compactRow = (): HTMLButtonElement | undefined => {
  act(() => container.querySelector<HTMLButtonElement>('header button[aria-label="More"]')?.click())
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((one) =>
    one.textContent?.startsWith('Compact now'),
  )
}

it('the conversation’s menu cannot compact a wrapped Team’s conversation — it says why and sends nothing', () => {
  const compact = vi.fn(async () => {})
  const { store } = rig(session(), new Map(), { runtimes: compacting, goals: wrappedTeam('s-1') })
  Object.assign(store, { compact })
  render(store)

  const row = compactRow()
  if (!row) throw new Error('no Compact now in the menu')
  expect(row.getAttribute('aria-disabled')).toBe('true')
  expect(row.title).toBe('This Team is wrapped')
  expect(row.textContent).toContain('This Team is wrapped')
  expect(row.textContent).not.toContain('Summarise older turns')
  act(() => row.click())
  expect(compact).not.toHaveBeenCalled()
})

it('the conversation’s menu still compacts one outside a wrapped Team — the pane’s own, not the window’s focused one', () => {
  const compact = vi.fn(async () => {})
  // The window's focus is on a conversation a wrapped Team kept; this pane
  // shows another, which is nobody's record.
  const focused = sessionKey('codex', sessionId('s-2'))
  const { store } = rig(session(), new Map(), {
    runtimes: compacting,
    goals: wrappedTeam('s-2'),
    activeSessionKey: focused,
    sessions: new Map([[KEY, session()], [focused, session({ id: sessionId('s-2') })]]),
  })
  Object.assign(store, { compact })
  render(store)

  const row = compactRow()
  if (!row) throw new Error('no Compact now in the menu')
  expect(row.disabled).toBe(false)
  expect(row.title).toBe('Summarise older turns to free up context.')
  act(() => row.click())
  expect(compact).toHaveBeenCalledWith(KEY)
})

/**
 * Two of MessageScroller's rules this transcript adopted (see the PR notes):
 * a link's own click, and a selection landing inside the transcript, both
 * release the pin the same way scrolling away from the bottom already does
 * — so a streamed token cannot yank the reader off what they just clicked or
 * started reading. `scrollHeight`/`clientHeight` stay 0 in jsdom, so this
 * reaches the same "no distance to the bottom" branch `onScroll` does; only
 * the release itself, via `pinned`, is what these check, through whether
 * "Jump to latest" appears.
 */
const jumpToLatest = (): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Jump to latest')

const transcriptSession = (): Session =>
  session({
    updatedAt: 9_000,
    turns: [
      {
        id: turnId('t-1'),
        status: 'completed',
        items: [{ id: itemId('i-1'), type: 'assistantMessage', text: 'see the log for details' }],
      },
    ],
  })

it('follows transcript and dock geometry changes until the reader scrolls up', () => {
  const resize: (() => void)[] = []
  vi.stubGlobal('ResizeObserver', class {
    active = false
    constructor(callback: ResizeObserverCallback) { resize.push(() => {if (this.active) callback([], this as unknown as ResizeObserver)}) }
    observe() { this.active = true }
    disconnect() { this.active = false }
    unobserve() {}
  })
  try {
    render(rig(transcriptSession()).store)
    const scroll = container.querySelector<HTMLElement>('[data-live-transcript]')!
    let height = 800
    Object.defineProperties(scroll, {scrollHeight:{get:() => height}, clientHeight:{get:() => 400}})
    act(() => resize.forEach(callback => callback()))
    expect(scroll.scrollTop).toBe(800)
    height = 1000
    act(() => resize.forEach(callback => callback()))
    expect(scroll.scrollTop).toBe(1000)
    // A real reader scroll, rather than the delayed event from our own write.
    delete scroll.dataset.autoscrolling
    act(() => {scroll.scrollTop = 100; scroll.dispatchEvent(new Event('scroll', {bubbles:true}))})
    expect(jumpToLatest()).toBeDefined()
    height = 1200
    act(() => resize.forEach(callback => callback()))
    expect(scroll.scrollTop).toBe(100)
  } finally { vi.unstubAllGlobals() }
})

it('a click on a link inside the transcript releases the pin', () => {
  render(rig(transcriptSession()).store)
  expect(jumpToLatest()).toBeUndefined()

  const scrollEl = container.getElementsByClassName(styles.scroll!)[0]!
  const link = document.createElement('a')
  link.href = '#'
  link.textContent = 'the log'
  scrollEl.appendChild(link)
  act(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true })))

  expect(jumpToLatest()).not.toBeUndefined()
})

it('a selection landing inside the transcript releases the pin', () => {
  render(rig(transcriptSession()).store)
  expect(jumpToLatest()).toBeUndefined()

  const scrollEl = container.getElementsByClassName(styles.scroll!)[0]!
  const text = document.createTreeWalker(scrollEl, NodeFilter.SHOW_TEXT).nextNode()
  if (!text) throw new Error('no text node in the transcript to select')
  const range = document.createRange()
  range.selectNodeContents(text)
  const selection = window.getSelection()
  if (!selection) throw new Error('jsdom gave no Selection to work with')
  act(() => {
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })

  expect(jumpToLatest()).not.toBeUndefined()
})

it('a collapsed selection (a plain click) does not release the pin', () => {
  render(rig(transcriptSession()).store)
  const scrollEl = container.getElementsByClassName(styles.scroll!)[0]!
  const text = document.createTreeWalker(scrollEl, NodeFilter.SHOW_TEXT).nextNode()
  if (!text) throw new Error('no text node in the transcript to select')
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, 0)
  const selection = window.getSelection()
  if (!selection) throw new Error('jsdom gave no Selection to work with')
  act(() => {
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })

  expect(jumpToLatest()).toBeUndefined()
})

// Round 1 of review on #983: the release must stick (proved live in
// e2e/ui-system/transcript-follow.spec.ts, since jsdom never fires the real
// `scroll` event the auto-scroll's own `scrollTop` assignment causes) and
// must not fire for a selection anywhere but the transcript's own content.

it('a selection outside the transcript — in the dock area a composer shares — does not release the pin', () => {
  render(rig(transcriptSession()).store)
  const dock = container.getElementsByClassName(styles.dockArea!)[0]!
  const note = document.createElement('span')
  note.textContent = 'not the transcript'
  dock.appendChild(note)
  const text = note.firstChild!
  const range = document.createRange()
  range.selectNodeContents(text)
  const selection = window.getSelection()
  if (!selection) throw new Error('jsdom gave no Selection to work with')
  act(() => {
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })

  expect(jumpToLatest()).toBeUndefined()
})

it('a selection in a second conversation pane does not release the first pane’s pin', () => {
  const otherKey = sessionKey('codex', sessionId('s-2'))
  const otherSession = session({
    id: sessionId('s-2'),
    updatedAt: 9_000,
    turns: [
      {
        id: turnId('t-2'),
        status: 'completed',
        items: [{ id: itemId('i-2'), type: 'assistantMessage', text: 'a second pane entirely' }],
      },
    ],
  })
  const { store } = rig(transcriptSession())
  const shared = store.getSnapshot()
  const sessions = new Map(shared.sessions)
  sessions.set(otherKey, otherSession)
  const merged = { ...shared, sessions }
  const both = { ...store, getSnapshot: () => merged } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={both}>
        <div>
          <PaneProvider scope={{ paneId: 'p1' as never, view: { kind: 'conversation', session: KEY as never }, sessionKey: KEY as never }}>
            <Conversation onChooseProject={() => undefined} onSignIn={() => undefined} onOpenUsage={() => undefined} onOpenRuntimes={() => undefined} />
          </PaneProvider>
          <PaneProvider scope={{ paneId: 'p2' as never, view: { kind: 'conversation', session: otherKey as never }, sessionKey: otherKey as never }}>
            <Conversation onChooseProject={() => undefined} onSignIn={() => undefined} onOpenUsage={() => undefined} onOpenRuntimes={() => undefined} />
          </PaneProvider>
        </div>
      </StoreProvider>,
    )
  })

  const [firstPane, secondPane] = [...container.firstElementChild!.children]
  const [firstScroll, secondScroll] = [...container.getElementsByClassName(styles.scroll!)]
  expect(firstScroll).toBeDefined()
  expect(secondScroll).toBeDefined()

  const jumpIn = (pane: Element): HTMLButtonElement | undefined =>
    [...pane.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Jump to latest')

  const text = document.createTreeWalker(secondScroll!, NodeFilter.SHOW_TEXT).nextNode()
  if (!text) throw new Error('no text node in the second pane to select')
  const range = document.createRange()
  range.selectNodeContents(text)
  const selection = window.getSelection()
  if (!selection) throw new Error('jsdom gave no Selection to work with')
  act(() => {
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })

  // The selection landed in the second pane's own transcript, so its own
  // release is the point — proof this is not a vacuously passing check.
  expect(jumpIn(secondPane!)).not.toBeUndefined()
  expect(jumpIn(firstPane!)).toBeUndefined()
})

it('only the transcript’s own scroll container is marked as the live transcript', () => {
  // No turns: the "Nothing to show" pitch is what `.scroll` holds here, and
  // a selection landing in it must not be mistaken for one in the transcript.
  render(rig(session({ updatedAt: 9_000 })).store)
  const emptyScroll = container.getElementsByClassName(styles.scroll!)[0]!
  expect(emptyScroll.hasAttribute('data-live-transcript')).toBe(false)

  render(rig(transcriptSession()).store)
  const liveScroll = container.getElementsByClassName(styles.scroll!)[0]!
  expect(liveScroll.hasAttribute('data-live-transcript')).toBe(true)
})

it('a new turn re-engages follow, undoing an earlier release', () => {
  const first = { id: turnId('t-1'), status: 'completed' as const, items: [{ id: itemId('i-1'), type: 'assistantMessage' as const, text: 'first answer' }] }
  const { store } = rig(session({ updatedAt: 9_000, turns: [first] }))
  render(store)

  const scrollEl = container.getElementsByClassName(styles.scroll!)[0]!
  const link = document.createElement('a')
  link.href = '#'
  link.textContent = 'a link'
  scrollEl.appendChild(link)
  act(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(jumpToLatest()).not.toBeUndefined()

  // The reader sent the next message: a new turn lands.
  const second = { id: turnId('t-2'), status: 'inProgress' as const, items: [] as Session['turns'][number]['items'] }
  render(rig(session({ updatedAt: 9_500, turns: [first, second] })).store)

  expect(jumpToLatest()).toBeUndefined()
})


it('heads a recorded typed lookalike with its pasted first line', () => {
  const raw = `${wrapContext('Git', 'Pasted header words')}\n\nExplain it`
  render(rig(session({ turns: [{ id: turnId('typed'), status: 'completed', items: [
    { id: itemId('typed'), type: 'userMessage', content: [{ type: 'text', text: raw, deskContext: { prefixLength: 0 } }] },
  ] }] })).store)
  expect(container.querySelector('header')?.textContent).toContain('<context source="Git"')
})

it('Details names the conversation facts and keeps the fresh checkout branch', () => {
  render(rig(session({ git: { branch: 'main' } as Session['git'] })).store)
  const facts = container.querySelector('[aria-label="Conversation facts"]')!
  expect(facts).not.toBeNull()
  expect(facts.textContent).toContain('Branchmain')
  expect(container.querySelector('header [data-slot="dot"]')?.getAttribute('aria-label')).toBe('Idle')
})

it('the shell records running status in its one state slot', () => {
  render(rig(session({ turns: [{ id: turnId('running'), status: 'inProgress', items: [] }] })).store)
  expect(container.querySelector('[data-topbar="state"] [data-slot="dot"]')?.getAttribute('aria-label')).toBe('Working')
})

it('the conversation title opens Rename, Fork and Archive without worded bar actions', async () => {
  render(rig(session()).store)
  const title = container.querySelector<HTMLButtonElement>('[data-topbar-title] button')
  expect(title).not.toBeNull()
  await act(async () => title!.click())
  const menu = document.querySelector('[role="menu"]')!
  expect([...menu.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(['Rename', 'Fork', 'Archive'])
  expect(container.querySelector('[data-topbar="state"] [data-slot="dot"]')?.getAttribute('aria-label')).toBe('Idle')
})

it('Details renders the latest recorded plan states and respects an explicit clear', () => {
  const old = { id: turnId('older-plan'), status: 'completed' as const, items: [], plan: [{ step: 'Old plan', status: 'pending' as const }] }
  const latest = { id: turnId('latest-plan'), status: 'completed' as const, items: [], plan: [
    { step: 'Finished step', status: 'completed' as const },
    { step: 'Review \u001b[31m<script>unsafe()</script>\u001b[0m changes', status: 'inProgress' as const },
    { step: 'Next step', status: 'pending' as const },
  ] }
  render(rig(session({ turns: [old, latest] })).store)
  const plan = container.querySelector('[data-slot="tool-body"] [aria-label="Plan"]')!
  expect([...plan.querySelectorAll('[data-slot="checklist-item"]')].map(one => one.getAttribute('data-state'))).toEqual(['done', 'active', 'pending'])
  expect(plan.textContent).not.toContain('Old plan')
  expect(plan.querySelector('script')).toBeNull()
  expect(plan.textContent).toContain('Review <script>unsafe()</script> changes')
  expect(plan.textContent).not.toContain('\u001b')
  render(rig(session({ turns: [old, { ...latest, plan: [] }] })).store)
  const cleared = container.querySelector('[data-slot="tool-body"]')!
  expect(cleared.querySelector('[aria-label="Plan"]')).toBeNull()
  expect(cleared.querySelector('[data-slot="checklist"]')).toBeNull()
  expect(cleared.textContent).not.toContain('Old plan')
  expect(cleared.textContent).not.toContain('Finished step')
  expect(cleared.textContent).not.toContain('Next step')
})

it('leaves no ceiling wrapper on the plain conversation path', () => {
  render(rig(session()).store)
  expect(container.querySelector('header [data-slot="ceiling-wrap"]')).toBeNull()
})

it('a draft with no folder has a truthful Details fact and no folder action', () => {
  render(rig(null, new Map(), { workspace: null }).store, null)
  expect(container.querySelector('[aria-label="Conversation facts"]')?.textContent).toContain('Not chosen')
  expect(container.querySelector('button[aria-label="Folder actions"]')).toBeNull()
  expect(container.textContent).not.toContain('reported for this draft')
  expect(container.querySelector('[aria-label="Plan"]')).toBeNull()
})

it('shows one quiet copy notice using the agent presentation name', () => {
  const one = session({ turns: [{ id: turnId('copy-turn'), status: 'completed', items: [{ id: itemId('copy-answer'), type: 'assistantMessage', text: 'Kept answer' }] }], ...({ deskCopy: true } as Partial<Session>) })
  const { store } = rig(one, new Map(), { runtimes: [{ id: one.runtime, name: 'Internal registry name', presentation: { name: 'Demo Agent' }, capabilities: {} }] as unknown as AppSnapshot['runtimes'] })
  render(store)
  expect(container.textContent).toContain('HarnessDesk’s copy — Demo Agent’s own record is unavailable.')
  expect(container.textContent?.split('HarnessDesk’s copy').length).toBe(2)
  expect(container.querySelector('[data-live-transcript]')?.textContent).toContain('Kept answer')
})

it('Undo leaves the menu before asking, and Keep never rolls back', async () => {
  const store = harness.previewStore()
  const fixture = vi.spyOn(harness, 'previewStore').mockReturnValue(store)
  const previousURL = location.href
  history.replaceState(null, '', '/preview.html?frame-wall=conversation&frame-conversation-actions=1')
  const rollback = vi.fn()
  Object.defineProperty(store, 'rollback', { configurable: true, value: rollback })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const click = async (label: string, role?: string) => {
    const candidates = [...document.querySelectorAll<HTMLElement>(role ? `[role="${role}"]` : 'button')]
    const found = candidates.find(n => n.getAttribute('aria-label') === label || n.textContent?.trim() === label)
    expect(found, label).toBeTruthy()
    await act(async () => { found!.click() })
  }
  try {
    await act(async () => { root.render(<StoreProvider store={store}><FrameWall /></StoreProvider>) })
    await click('More')
    const memory = document.querySelector('[role="switch"]')
    expect(memory?.hasAttribute('data-menu-row')).toBe(true)
    expect(memory?.getAttribute('title')).toContain('carry what it learns here into new ones.')
    const undo = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(n => n.textContent?.startsWith('Undo the last turn'))
    expect(undo).toBeTruthy()
    await act(async () => { undo!.click() })
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(rollback).not.toHaveBeenCalled()
    await click('Keep')
    expect(rollback).not.toHaveBeenCalled()
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
    fixture.mockRestore()
    history.replaceState(null, '', previousURL)
  }
})

it.each(['starting', 'failed', 'ready'] as const)('a %s draft explains runtime readiness beside Send without replacing typing', (state) => {
  const health = state === 'failed'
    ? { state: 'unavailable' as const, reason: 'unreadable' as const, message: 'The agent failed its version check.', remediation: 'Choose a working installation in Settings.' }
    : { state: state === 'ready' ? 'ready' as const : 'starting' as const }
  const { store } = rig(null, new Map(), { health, healthByRuntime: { codex: health } })
  const settings = vi.fn()
  store.askSettings = settings
  render(store, null)
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
  expect(textarea.disabled).toBe(false)
  expect(textarea.placeholder).toBe('Describe a task to start a session — / for commands, @ for files')
  const send = container.querySelector<HTMLButtonElement>('[aria-label="Send"]')!
  const tools = container.querySelector('[data-slot="composer-tools"]')!
  if (state === 'ready') {
    expect(tools.textContent).not.toContain('Unavailable')
    expect(tools.textContent).not.toContain('Not answered yet')
    expect(send.title).toBe('')
  } else {
    expect(send.disabled).toBe(true)
    expect(tools.querySelector(`[data-slot="chip"][data-state="${state === 'failed' ? 'broken' : 'unknown'}"]`)?.textContent)
      .toBe(state === 'failed' ? 'Unavailable' : 'Not answered yet')
    expect(send.title).toBe(state === 'failed'
      ? 'The agent failed its version check. Choose a working installation in Settings.'
      : 'Waiting for the runtime to start')
    if (state === 'failed') {
      const link = [...tools.querySelectorAll('button')].find(button => button.textContent === 'Unavailable')!
      act(() => link.click())
      expect(settings).toHaveBeenCalledWith('runtimes', 'codex')
    }
  }
})

it('a failed runtime keeps the transcript and replaces the composer with one actionable reason', () => {
  const reason = 'The agent failed its version check.'
  const one = session({ turns: [{ id: turnId('kept-turn'), status: 'completed', items: [
    { id: itemId('kept-message'), type: 'assistantMessage', text: 'First kept message' },
  ] }] })
  render(rig(one, new Map(), { healthByRuntime: { [one.runtime]: {
    state: 'unavailable', reason: 'unreadable', message: reason, remediation: 'Choose a working installation in Settings.',
  } } }).store)
  expect(container.querySelector('[data-live-transcript]')?.textContent).toContain('First kept message')
  expect(container.querySelector('textarea')).toBeNull()
  expect(container.textContent?.split(reason).length).toBe(2)
  expect(container.textContent).toContain('Choose a working installation in Settings.')
})


it('member Memory and Undo target their scoped conversation when the main view is a Team', async () => {
  const one=session()
  const fixture=rig(one,new Map(),{activeSessionKey:null,runtimes:[{
    id:'codex',name:'Fixture',presentation:{name:'Fixture'},capabilities:{memory:true,undo:true,compaction:true},
  }] as unknown as AppSnapshot['runtimes']}).store
  const store=Object.assign(new AppStore('ws://localhost:0/'),fixture)
  const wire=vi.spyOn(store.transport,'request').mockResolvedValue(null as never)
  render(store)
  const click=async (label:string) => {
    const button=[...document.querySelectorAll<HTMLElement>('button,[role="menuitem"]')].find(node=>node.getAttribute('aria-label')===label || node.textContent?.trim().startsWith(label))
    expect(button,label).toBeTruthy()
    await act(async()=>button!.click())
  }
  await click('More')
  await act(async()=>document.querySelector<HTMLElement>('[role="switch"]')!.click())
  expect(wire).toHaveBeenCalledWith('session/memory',{runtime:'codex',sessionId:'s-1',enabled:true})
  await click('More'); await click('Undo the last turn'); await click('Undo turn')
  expect(wire).toHaveBeenCalledWith('session/rollback',{runtime:'codex',sessionId:'s-1',turns:1})
})

it('failed-runtime history refuses live agent verbs and keeps copy without edit or commit', async () => {
  const reason='The agent could not start.'
  const one=session({turns:[{id:turnId('kept'),status:'completed',items:[
    {id:itemId('question'),type:'userMessage',content:[{type:'text',text:'Kept question'}]},
    {id:itemId('answer'),type:'assistantMessage',text:'Kept answer'},
  ]}]})
  const {store}=rig(one,new Map(),{healthByRuntime:{codex:{state:'unavailable',reason:'unreadable',message:reason}},
    runtimes:[{id:'codex',name:'Fixture',presentation:{name:'Fixture'},capabilities:{memory:true,undo:true,compaction:true,review:true}}] as unknown as AppSnapshot['runtimes']})
  render(store)
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Ask the runtime to try again"]')?.disabled).toBe(true)
  expect(container.querySelector('[aria-label="Edit this message"]')).toBeNull()
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="More"]')!.click())
  for(const label of ['Compact now','Undo the last turn','Remember this conversation']) {
    const row=[...document.querySelectorAll<HTMLElement>('[data-menu-row]')].find(node=>node.textContent?.includes(label))
    expect(row,label).toBeTruthy()
    expect(row?.getAttribute('aria-disabled') === 'true' || row?.hasAttribute('disabled')).toBe(true)
    expect(row?.getAttribute('title')).toContain(reason)
  }
  expect([...document.querySelectorAll('[data-menu-row]')].some(node=>node.textContent?.includes('Commit the changes'))).toBe(false)
})


it('uses the conversation file crumb and replaces the transcript while retaining conversation tools', async () => {
  const { store } = rig(session({ title: 'Review checkout' }))
  const mode = vi.fn()
  Object.assign(store, { setWindowMode: mode })
  Object.assign(store.getSnapshot(), { editorState: [{ subject: `session:${KEY}`, state: { tabs: [{ path: '/repo/src/code.ts', view: 'source' }], active: '/repo/src/code.ts', preview: null, filter: null, expanded: [] } }] })
  await act(async () => render(store, KEY, { mainContent: <div data-testid="editor-main">File body</div> }))
  expect(container.querySelector('[data-testid="editor-main"]')).not.toBeNull()
  expect(container.querySelector('[data-live-transcript]')).toBeNull()
  expect(container.querySelector('textarea')).toBeNull()
  expect(container.querySelector('[data-topbar-title]')?.firstElementChild?.textContent).toBe('src/code.ts')
  await act(async () => container.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
  const crumb = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(one => one.textContent === 'Review checkout')!
  expect(crumb.textContent).toContain('Review checkout')
  await act(async () => crumb.click()); expect(mode).toHaveBeenCalledWith('conversation')
  expect(container.querySelector('[data-work-rail-toggle]')).not.toBeNull()
})

it('reattaches transcript follow after returning from editor main', async () => {
  const resize: (() => void)[] = []
  vi.stubGlobal('ResizeObserver', class {
    active = false
    constructor(callback: ResizeObserverCallback) { resize.push(() => { if (this.active) callback([], this as unknown as ResizeObserver) }) }
    observe() { this.active = true }
    disconnect() { this.active = false }
    unobserve() {}
  })
  try {
    const { store } = rig(session({ updatedAt: 9000, turns: [{ id: turnId('t-1'), status: 'completed', items: [{ id: itemId('i-1'), type: 'assistantMessage', text: 'see the log for details' }] }] }))
    await act(async () => render(store))
    const original = container.querySelector<HTMLElement>('[data-live-transcript]')!
    Object.defineProperties(original, { scrollHeight: { get: () => 800 }, clientHeight: { get: () => 400 } })
    act(() => resize.forEach(callback => callback()))
    expect(original.scrollTop).toBe(800)
    await act(async () => render(store, KEY, { mainContent: <div>Editor</div> }))
    await act(async () => render(store))
    const restored = container.querySelector<HTMLElement>('[data-live-transcript]')!
    expect(restored).not.toBe(original)
    Object.defineProperties(restored, { scrollHeight: { get: () => 800 }, clientHeight: { get: () => 400 } })
    act(() => resize.forEach(callback => callback()))
    expect(restored.scrollTop).toBe(800)
  } finally { vi.unstubAllGlobals() }
})

it('a transcript path:line targets its own conversation, while external and modified links retain navigation', async () => {
  const { store } = rig(session({ turns: [{ id: turnId('links'), status: 'completed', items: [{ id: itemId('links-message'), type: 'assistantMessage', text: '[notes](src/file.ts:2) [website](https://example.com)' }] }] }))
  const enter = vi.fn(() => true); store.enterEditorFile = enter
  render(store); await act(async () => {})
  const notes = [...container.querySelectorAll('a')].find(a => a.textContent === 'notes')!
  expect(notes.getAttribute('href')).toBe('src/file.ts:2')
  const click = new MouseEvent('click', { bubbles: true, cancelable: true })
  act(() => notes.dispatchEvent(click))
  expect(click.defaultPrevented).toBe(true)
  expect(enter).toHaveBeenCalledWith(KEY, '/repo/src/file.ts', { view: 'source', line: 2 })
  const modified = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })
  act(() => notes.dispatchEvent(modified))
  expect(modified.defaultPrevented).toBe(false)
  const website = [...container.querySelectorAll('a')].find(a => a.textContent === 'website')!
  act(() => website.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  expect(enter).toHaveBeenCalledTimes(1)
})

it('a refused local file entry consumes the link instead of falling through to browser navigation', () => {
  const { store } = rig(transcriptSession()); store.enterEditorFile = vi.fn(() => false)
  render(store)
  const link = document.createElement('a'); link.setAttribute('href', '/repo/file.ts:12')
  container.getElementsByClassName(styles.scroll!)[0]!.append(link)
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  act(() => link.dispatchEvent(event))
  expect(event.defaultPrevented).toBe(true)
})

const installedTemplate = (key: string, name: string) => ({
  key, name, available: true, registered: false,
  requires: { command: key, found: true },
})

it('offers two installed runtimes and registers each through the Add page path', async () => {
  const { store } = rig(null)
  vi.mocked(store.agentCatalog).mockResolvedValue([
    installedTemplate('beta', 'Beta'), installedTemplate('gamma', 'Gamma'),
  ])
  vi.mocked(store.addAgent).mockImplementation(async ({ template }) => runtimeId(template!))
  render(store, null)
  await act(async () => {})
  expect(store.agentCatalog).toHaveBeenCalledTimes(1)
  const offer = () => container.querySelector('[aria-label="Installed on this Mac"]')!
  expect(offer()?.textContent).toContain('Beta')
  expect(offer()?.textContent).toContain('Gamma')
  await act(async () => offer().querySelector<HTMLButtonElement>('button[aria-label="Add Beta"]')!.click())
  expect(store.addAgent).toHaveBeenCalledWith({ template: 'beta' })
  expect(offer().textContent).not.toContain('Beta')
  expect(offer().textContent).toContain('Gamma')
  render(store, null)
  expect(store.agentCatalog).toHaveBeenCalledTimes(1)
  await act(async () => offer().querySelector<HTMLButtonElement>('button[aria-label="Add Gamma"]')!.click())
  expect(store.addAgent).toHaveBeenCalledWith({ template: 'gamma' })
  expect(offer()).toBeNull()
})

it.each(['nothing installed', 'already added', 'bridge only'])('offers nothing when detection finds %s', async (kind) => {
  const { store } = rig(null)
  vi.mocked(store.agentCatalog).mockResolvedValue(kind === 'nothing installed' ? [] : [{
    ...installedTemplate('beta', 'Beta'),
    registered: kind === 'already added',
    requires: { command: 'beta', found: kind !== 'bridge only' },
  }])
  render(store, null)
  await act(async () => {})
  expect(store.agentCatalog).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[aria-label="Installed on this Mac"]')).toBeNull()
})

it('keeps other clients out of the draft pitch even with legacy history metadata', () => {
  const runtimes = ['Alpha', 'Beta', 'Gamma'].map((name) => ({
    ...harness.runtime(runtimeId(name.toLowerCase()), name),
    presentation: { name, ...(name === 'Gamma' ? {} : { historySource: `${name} CLI` }) },
  }))
  render(rig(null, new Map(), { runtimes, activeRuntime: runtimes[0]!.id }).store, null)
  const text = container.querySelector('[data-slot="conversation-empty-state"]')!.textContent
  expect(text).toContain('Describe a task.')
  expect(text).not.toContain('Sessions you start in')
  expect(text).not.toContain('Gamma CLI')
  expect(text).not.toContain('Codex')
  expect(text).not.toContain('only runtime')
})

it('omits history copy when no present runtime reads history through', () => {
  render(rig(null).store, null)
  expect(container.textContent).not.toContain('Sessions you start in')
})

it('draws before detection answers and ignores an answer after its deadline', async () => {
  vi.useFakeTimers()
  try {
    const { store } = rig(null)
    let finish!: (value: Awaited<ReturnType<AppStore['agentCatalog']>>) => void
    vi.mocked(store.agentCatalog).mockReturnValue(new Promise(resolve => { finish = resolve }))
    render(store, null)
    expect(container.textContent).toContain('What should we build?')
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000) })
    await act(async () => finish([installedTemplate('beta', 'Beta')]))
    expect(container.querySelector('[aria-label="Installed on this Mac"]')).toBeNull()
  } finally { vi.useRealTimers() }
})

it('keeps a refused add available for retry', async () => {
  const { store } = rig(null)
  vi.mocked(store.agentCatalog).mockResolvedValue([installedTemplate('beta', 'Beta')])
  render(store, null)
  await act(async () => {})
  const add = () => container.querySelector<HTMLButtonElement>('button[aria-label="Add Beta"]')!
  await act(async () => add().click())
  expect(add().disabled).toBe(false)
  expect(store.addAgent).toHaveBeenCalledTimes(1)
})

it('keeps a successful add hidden after the empty pane remounts without rescanning', async () => {
  const { store } = rig(null)
  vi.mocked(store.agentCatalog).mockResolvedValue([installedTemplate('beta', 'Beta')])
  vi.mocked(store.addAgent).mockResolvedValue(runtimeId('beta'))
  render(store, null)
  await act(async () => {})
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Add Beta"]')!.click())
  act(() => root.render(null))
  render(store, null)
  await act(async () => {})
  expect(store.agentCatalog).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[aria-label="Installed on this Mac"]')).toBeNull()
})

it('does not offer a registered runtime even when the scan has a stale unregistered row', async () => {
  const { store } = rig(null)
  vi.mocked(store.agentCatalog).mockResolvedValue([installedTemplate('codex', 'Alpha')])
  render(store, null)
  await act(async () => {})
  expect(container.querySelector('[aria-label="Installed on this Mac"]')).toBeNull()
})

it('offers installed alternatives even while the selected runtime needs sign-in', async () => {
  const info = harness.runtime('alpha', 'Alpha')
  const { store } = rig(null, new Map(), {
    runtimes: [{ ...info, capabilities: { ...info.capabilities, account: true } }],
    activeRuntime: info.id,
    accountsByRuntime: { [info.id]: { accounts: [], signInMethods: [{ id: 'browser', label: 'Sign in', flow: 'browser' }] } },
  })
  vi.mocked(store.agentCatalog).mockResolvedValue([installedTemplate('beta', 'Beta')])
  render(store, null)
  await act(async () => {})
  expect(container.textContent).toContain('Sign in to Alpha')
  expect(container.querySelector('button[aria-label="Add Beta"]')).not.toBeNull()
})

it('omits legacy history-source copy for multiple accounts', () => {
  const runtimes = ['one', 'two'].map(id => ({ ...harness.runtime(id, 'Alpha'), presentation: { name: 'Alpha', historySource: 'Alpha CLI' } }))
  render(rig(null, new Map(), { runtimes, activeRuntime: runtimes[0]!.id }).store, null)
  expect(container.querySelector('[data-slot="conversation-empty-state"]')!.textContent)
    .not.toContain('Sessions you start in')
})

it('draft Details names the folder with its full path on hover (#1720)', () => {
  render(rig(null, new Map(), { workspace: { path: '/work/long/project/first-run-1720', name: 'first-run-1720' } as AppSnapshot['workspace'] }).store, null)
  const facts = container.querySelector('[aria-label="Conversation facts"]')!
  const folder = [...facts.querySelectorAll('[data-slot="summary-item"]')].find(one => one.querySelector('dt')?.textContent === 'Folder')!
  const path = folder.querySelector<HTMLElement>('[data-slot="middle-truncate"]')!
  expect(path.querySelector('.sr-only')?.textContent).toBe('/work/long/project/first-run-1720')
  expect(path.querySelector('[data-part="tail"]')?.textContent).toBe('/first-run-1720')
  expect(path.querySelector('[data-part="head"]')?.className).toContain('truncate')
  expect(path.className).toContain('whitespace-nowrap')
  const head = path.querySelector('[data-part="head"]')!
  Object.defineProperties(head, { scrollWidth: { configurable: true, value: 300 }, clientWidth: { configurable: true, value: 120 } })
  act(() => path.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  expect(path.title).toBe('/work/long/project/first-run-1720')
  expect(container.textContent).not.toContain('reported for this draft')
  expect(container.querySelector('[aria-label="Plan"]')).toBeNull()
})
