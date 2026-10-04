import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  runtimeId,
  approvalId,
  sessionId,
  sessionKey,
  wrapContext,
  type RuntimeInfo,
  type GoalView,
  type Session,
  type SessionSummary,
  type TeamState,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { SessionTree } from './SessionTree'

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

it('keeps Archive self-explanatory without a subtitle', () => {
  const runtime = {
    id: 'agent',
    name: 'Agent',
    capabilities: {},
    presentation: { name: 'Agent' },
  } as unknown as RuntimeInfo
  const summary = {
    id: 'session-1',
    runtime: runtime.id,
    title: 'Conversation one',
    preview: null,
    cwd: '/repo',
    status: { type: 'notLoaded' },
    createdAt: 1,
    updatedAt: 2,
    archived: false,
  } as unknown as SessionSummary
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    runtimes: [runtime],
    history: [summary],
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={3} />
      </StoreProvider>,
    )
  })

  const conversation = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Conversation one',
  )
  if (!conversation) throw new Error('conversation row did not render')
  act(() => {
    conversation.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
    )
  })

  const archive = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent?.startsWith('Archive'),
  )
  expect(archive?.textContent).toBe('Archive')
})

it('keeps one tab stop and moves row focus with arrows, Home, End, and type-ahead', () => {
  const runtime = { id: 'agent', name: 'Agent', capabilities: {}, presentation: { name: 'Agent' } } as unknown as RuntimeInfo
  const summary = (id: string, title: string): SessionSummary => ({
    id, runtime: runtime.id, title, preview: null, cwd: '/repo',
    status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2, archived: false,
  }) as unknown as SessionSummary
  const snapshot = { ...emptySnapshot(), status: 'open', activeRuntime: runtime.id,
    runtimes: [runtime], history: [summary('one', 'Alpha'), summary('two', 'Bravo'), summary('three', 'Charlie')] } as unknown as AppSnapshot
  const openSession = vi.fn()
  const toggleCollapsed = vi.fn()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, openSession, toggleCollapsed } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><SessionTree now={3} /></StoreProvider>))
  const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="sidebar-menu-button"]')]
  expect(rows[0]!.tabIndex).toBe(0)
  const alpha = rows.find((row) => row.textContent?.trim() === 'Alpha')!
  const bravo = rows.find((row) => row.textContent?.trim() === 'Bravo')!
  const charlie = rows.find((row) => row.textContent?.trim() === 'Charlie')!
  expect(bravo.tabIndex).toBe(-1)
  expect(container.querySelector('[data-slot="sidebar-menu-action"]')?.getAttribute('tabindex')).toBe('-1')

  act(() => rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
  expect(document.activeElement).toBe(alpha)
  act(() => alpha.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })))
  expect(document.activeElement).toBe(rows[0])

  act(() => alpha.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(document.activeElement).toBe(bravo)
  act(() => bravo.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true })))
  expect(document.activeElement).toBe(charlie)
  act(() => charlie.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
  expect(document.activeElement).toBe(rows[0])
  act(() => (document.activeElement as HTMLButtonElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
  expect(document.activeElement).toBe(charlie)
  act(() => charlie.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(openSession).toHaveBeenCalledWith('three', { runtime: runtime.id })
  act(() => rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })))
  expect(toggleCollapsed).toHaveBeenCalled()
})

it('keeps room opening separate from its disclosure in the tree keyboard model', () => {
  const member = summary({ id: 'room-member' })
  const key = String(sessionKey(member.runtime, member.id))
  const roomEntry = room({ id: 'room', name: 'Build', members: [key] })
  const { container: tree, store } = treeWith([roomEntry], [member], [], { collapsed: ['room'] })
  const opener = roomRow(tree, 'Build') as HTMLButtonElement
  const disclosure = [...tree.querySelectorAll<HTMLButtonElement>('[data-slot="sidebar-menu-action"]')].find((one) => one.getAttribute('aria-label')?.includes('agents in Build'))!
  expect(opener.hasAttribute('aria-expanded')).toBe(false)
  expect(disclosure.getAttribute('aria-expanded')).toBe('false')

  act(() => opener.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(store.openTeamRoom).toHaveBeenCalledWith('room')
  act(() => opener.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
  expect(store.openTeamRoom).toHaveBeenCalledTimes(1)
  expect(tree.querySelector('[aria-label*="agents in Build"]')?.getAttribute('aria-expanded')).toBe('true')
})

it('ArrowLeft collapses an expanded room from its opening row', () => {
  const member = summary({ id: 'room-member' })
  const key = String(sessionKey(member.runtime, member.id))
  const { container: tree, store } = treeWith([room({ id: 'room', name: 'Build', members: [key] })], [member])
  const opener = roomRow(tree, 'Build') as HTMLButtonElement
  act(() => opener.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })))
  expect(tree.querySelector('[aria-label*="agents in Build"]')?.getAttribute('aria-expanded')).toBe('false')
  expect(store.openTeamRoom).not.toHaveBeenCalled()
})

it('ArrowLeft from a room member focuses the room row before collapsing it', () => {
  const member = summary({ id: 'room-member' })
  const key = String(sessionKey(member.runtime, member.id))
  const { container: tree } = treeWith(
    [room({ id: 'room', name: 'Build', members: [key] })],
    [member],
    [],
    {},
    undefined,
    null,
    new Map(),
    {},
  )
  const opener = roomRow(tree, 'Build') as HTMLButtonElement
  const memberRow = [...tree.querySelectorAll<HTMLButtonElement>('[data-nested="true"] [data-slot="sidebar-menu-button"]')]
    .find((row) => row.textContent?.trim() === 'room-member')!
  memberRow.focus()
  expect(document.activeElement).toBe(memberRow)

  act(() => memberRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })))

  expect(document.activeElement).toBe(opener)
  expect(tree.querySelector('[data-nested="true"] [data-slot="sidebar-menu-button"]')).toBeNull()
  expect(tree.querySelector('[data-slot="sidebar-menu-action"][aria-label*="agents in Build"]')?.getAttribute('aria-expanded')).toBe('false')
})

it('uses each nested room member as its own navigation row inside a virtual project', () => {
  const first = summary({ id: 'first-member', updatedAt: 1000 })
  const second = summary({ id: 'second-member', updatedAt: 999 })
  const members = [String(sessionKey(first.runtime, first.id)), String(sessionKey(second.runtime, second.id))]
  const loose = Array.from({ length: 51 }, (_, index) => summary({ id: `loose-${index}`, updatedAt: 500 - index }))
  const { container: tree } = treeWith([room({ id: 'virtual-room', name: 'Virtual room', updatedAt: 2000, members })], [first, second, ...loose])
  for (let page = 0; page < 2; page += 1) {
    const more = [...tree.querySelectorAll<HTMLButtonElement>('[data-slot="sidebar-menu-button"]')].find((one) => /more$/.test(one.textContent?.trim() ?? ''))!
    act(() => more.click())
  }
  const mounted = tree.querySelector<HTMLButtonElement>('[data-virtual-index] [data-slot="sidebar-menu-button"]')!
  act(() => mounted.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })))
  const labels = [...tree.querySelectorAll<HTMLElement>('[data-slot="sidebar-menu-label"]')].map((one) => one.textContent?.trim())
  expect(labels).toContain('first-member')
  const firstButton = [...tree.querySelectorAll<HTMLButtonElement>('[data-slot="sidebar-menu-button"]')].find((one) => one.textContent?.trim() === 'first-member')!
  act(() => firstButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  expect(document.activeElement?.textContent?.trim()).toBe('second-member')
})

it('uses the rendered room and live session names for virtual type-ahead', () => {
  const renamed = summary({ id: 'renamed', title: 'Old title', updatedAt: 1000 })
  const rest = Array.from({ length: 51 }, (_, index) => summary({ id: `other-${index}`, updatedAt: 500 - index }))
  const board = room({ id: 'goal-room', name: 'Old room name', updatedAt: 2000 })
  const baseGoal = triggerGoalView(board)
  const goal: GoalView = { ...baseGoal, goal: { ...baseGoal.goal, sentence: 'Visible Goal Title' } }
  const snapshot = {
    ...emptySnapshot(), status: 'open', workspace: { path: '/repo', name: 'repo', lastOpenedAt: 1 },
    workspaces: [{ path: '/repo', name: 'repo', lastOpenedAt: 1 }], history: [renamed, ...rest],
    sessions: new Map([[sessionKey(renamed.runtime, renamed.id), { ...renamed, title: 'Live renamed title' }]]),
    teams: new Map([[board.id, board]]), goals: new Map([[board.id, goal]]),
  } as unknown as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><SessionTree now={3} /></StoreProvider>))
  for (let page = 0; page < 2; page += 1) {
    const more = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="sidebar-menu-button"]')].find((one) => /more$/.test(one.textContent?.trim() ?? ''))!
    act(() => more.click())
  }
  const project = container.querySelector<HTMLElement>('[data-virtual-project="true"][data-virtual-labels]')!
  const labels = JSON.parse(project.dataset.virtualLabels ?? '[]') as string[]
  expect(labels).toContain('Live renamed title')
  expect(labels).toContain('Visible Goal Title')
})

it('uses a plain fallback when a history row outlives its runtime', () => {
  const row = summary({ id: 'orphan', runtime: runtimeId('removed-runtime-id'), title: 'Orphan conversation' })
  const { container: tree } = treeWith([], [row])
  const button = [...tree.querySelectorAll<HTMLButtonElement>('[data-slot="sidebar-menu-button"]')].find((one) => one.textContent?.trim() === 'Orphan conversation')!
  expect(button.title).not.toContain('removed-runtime-id')
  act(() => button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })))
  const refusal = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((one) => one.textContent?.includes('Delete'))!
  expect(refusal.textContent).not.toContain('removed-runtime-id')
})

it('moves into an unmounted windowed conversation and mounts it before focusing', () => {
  const runtime = { id: 'agent', name: 'Agent', capabilities: {}, presentation: { name: 'Agent' } } as unknown as RuntimeInfo
  const summary = (index: number): SessionSummary => ({
    id: `session-${index}`, runtime: runtime.id, title: `Session${index}`, preview: null, cwd: '/repo',
    status: { type: 'notLoaded' }, createdAt: 1, updatedAt: index, archived: false,
  }) as unknown as SessionSummary
  const snapshot = { ...emptySnapshot(), status: 'open', activeRuntime: runtime.id,
    runtimes: [runtime], history: Array.from({ length: 60 }, (_, index) => summary(index)) } as unknown as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><SessionTree now={3} /></StoreProvider>))

  const more = () => [...container.querySelectorAll<HTMLButtonElement>('[data-slot="sidebar-menu-button"]')]
    .find((button) => /more$/.test(button.textContent?.trim() ?? ''))!
  for (let page = 0; page < 2; page += 1) {
    const button = more()
    act(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  }

  const target = container.querySelector<HTMLButtonElement>('[data-virtual-index="30"] [data-slot="sidebar-menu-button"]')
  expect(target).not.toBeNull()
  expect(target?.closest('[data-virtual-count]')?.getAttribute('data-virtual-count')).toBe('55')
  const windowed = container.querySelector('[data-virtual-project="true"]')!
  const focusRow = (key: string) => {
    const active = document.activeElement as HTMLButtonElement
    act(() => active.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
  }
  act(() => target!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })))
  expect((document.activeElement as HTMLElement).closest('[data-virtual-index]')?.getAttribute('data-virtual-index')).toBe('54')
  act(() => (document.activeElement as HTMLButtonElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })))
  expect((document.activeElement as HTMLElement).closest('[data-virtual-index]')?.getAttribute('data-virtual-index')).toBe('0')
  act(() => (document.activeElement as HTMLButtonElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })))
  for (const key of 'Session59') focusRow(key)
  expect((document.activeElement as HTMLElement).closest('[data-virtual-index]')?.getAttribute('data-virtual-index')).toBe('0')

  const mounted = [...windowed.querySelectorAll<HTMLElement>('[data-virtual-index]')]
  const lastIndex = Number(mounted.at(-1)?.dataset.virtualIndex)
  const next = lastIndex + 1
  expect(windowed.querySelector(`[data-virtual-index="${next}"]`)).toBeNull()
  const lastButton = mounted.at(-1)?.querySelector<HTMLButtonElement>('[data-slot="sidebar-menu-button"]')!
  act(() => lastButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  const focused = document.activeElement as HTMLElement
  expect(focused.closest('[data-virtual-index]')?.getAttribute('data-virtual-index')).toBe(String(next))
  expect(windowed.querySelector(`[data-virtual-index="${next}"]`)).not.toBeNull()
})

it('uses one fixed trailing slot for conversation state and actions', () => {
  const runtime = { id: 'agent', name: 'Agent', capabilities: {}, presentation: { name: 'Agent' } } as unknown as RuntimeInfo
  const summary = (id: string, status: 'idle' | 'active'): SessionSummary => ({
    id, runtime: runtime.id, title: id, preview: null, cwd: '/repo',
    status: { type: status }, createdAt: 1, updatedAt: 2, archived: false,
  }) as unknown as SessionSummary
  const waiting = summary('waiting', 'idle')
  const waitingKey = sessionKey(runtime.id, sessionId('waiting'))
  const snapshot = { ...emptySnapshot(), status: 'open', activeRuntime: runtime.id,
    runtimes: [runtime], history: [summary('quiet', 'idle'), summary('busy', 'active'), waiting],
    sessions: new Map([[waitingKey, { ...waiting, turns: [] } as unknown as Session]]),
    approvals: [{ key: waitingKey, approval: {} }],
  } as unknown as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><SessionTree now={3} /></StoreProvider>))
  const rows = [...container.querySelectorAll<HTMLElement>('[data-slot="sidebar-menu-item"]')]
  const quiet = rows.find((row) => row.textContent?.includes('quiet'))!
  const busy = rows.find((row) => row.textContent?.includes('busy'))!
  const needsYou = rows.filter((row) => row.textContent?.includes('waiting'))
  expect(quiet.querySelector('[data-slot="sidebar-menu-badge"]')).toBeNull()
  expect(busy.querySelectorAll('[data-slot="sidebar-menu-badge"]')).toHaveLength(1)
  expect(needsYou.length).toBeGreaterThan(0)
  for (const row of needsYou) {
    expect(row.querySelectorAll('[data-slot="sidebar-menu-badge"]')).toHaveLength(0)
    expect(row.querySelector('[data-slot="sidebar-menu-state"]')?.getAttribute('aria-label')).toBe('Needs you')
  }
  const label = busy.querySelector('[data-slot="sidebar-menu-label"]')!
  const classes = label.className
  const action = busy.querySelector<HTMLElement>('[data-slot="sidebar-menu-action"]')!
  expect(action.parentElement).toBe(busy)
  action.focus()
  expect(busy.querySelector('[data-slot="sidebar-menu-label"]')).toBe(label)
  expect(label.className).toBe(classes)
})

it('a conversation with work still running in the background wears a quiet spinner, and says so on hover', () => {
  // The turn is over and the row would read idle, but the agent sent
  // something to the background and walked away. A person browsing other
  // conversations gets a spinner on this one, and the hover line names the door.
  const runtime = {
    id: 'agent',
    name: 'Agent',
    capabilities: { deleteHistory: true },
    presentation: { name: 'Agent' },
  } as unknown as RuntimeInfo
  const summary = (id: string, title: string): SessionSummary =>
    ({
      id,
      runtime: runtime.id,
      title,
      preview: null,
      cwd: '/repo',
      status: { type: 'idle' },
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    }) as unknown as SessionSummary
  const busy = sessionKey(runtime.id, sessionId('with-task'))
  const quiet = sessionKey(runtime.id, sessionId('without'))
  const task = (state: 'running' | 'completed') =>
    ({ id: `t-${state}`, label: 'Watch the tests', kind: 'command', state, stoppable: state === 'running' }) as const
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    runtimes: [runtime],
    history: [summary('with-task', 'Busy one'), summary('without', 'Quiet one')],
    tasks: new Map([
      [busy, [task('completed'), task('running')]],
      [quiet, [task('completed')]],
    ]),
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={3} />
      </StoreProvider>,
    )
  })

  const row = (title: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll('button')].find((button) => button.textContent === title)
    if (!found) throw new Error(`no row called ${title}`)
    return found as HTMLButtonElement
  }
  const glyph = (title: string): HTMLElement | null => row(title).parentElement?.querySelector('[data-slot="spinner"]') ?? null
  expect(glyph('Busy one')?.hasAttribute('data-tasks')).toBe(true)
  expect(row('Busy one').title).toContain('running in the background')
  // Finished work is not a reason to look: only running work earns the spinner.
  expect(glyph('Quiet one')).toBeNull()
  expect(row('Quiet one').title).not.toContain('background')
})

it('two flow seats of one role, on different runtimes, read apart on their own line at compact density (#uc3)', () => {
  // Measured on UC3's own review flow: three seats — Claude Code, DeepSeek,
  // Antigravity — all opened as "Code reviewer" (the role's own title, the
  // same for every seat of it), and at the app's default compact density the
  // sidebar drew three identical rows with nothing on any of them to tell a
  // person which vendor was which. The agent's name is a word, so it is a chip
  // on the title's own line (rule 9) — earned only where titles collide, and
  // costing no row height.
  const claude = {
    id: 'claude-code',
    name: 'Claude',
    capabilities: {},
    presentation: { name: 'Claude' },
  } as unknown as RuntimeInfo
  const dsh = {
    id: 'dsh',
    name: 'DeepSeek',
    capabilities: {},
    presentation: { name: 'DeepSeek' },
  } as unknown as RuntimeInfo
  const rowOf = (id: string, runtime: RuntimeInfo, title: string): SessionSummary =>
    ({
      id,
      runtime: runtime.id,
      title,
      preview: null,
      cwd: '/repo',
      status: { type: 'notLoaded' },
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    }) as unknown as SessionSummary
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: claude.id,
    runtimes: [claude, dsh],
    history: [
      rowOf('session-1', claude, 'Code reviewer'),
      rowOf('session-2', dsh, 'Code reviewer'),
      rowOf('session-3', dsh, 'Refill the cache'),
    ],
  } as AppSnapshot
  // The app's own default — nothing here picks "comfortable".
  expect(snapshot.listPrefs.density).toBe('compact')
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={3} />
      </StoreProvider>,
    )
  })

  const rows = [...container.querySelectorAll('button')].filter((button) =>
    button.textContent?.includes('Code reviewer'),
  )
  expect(rows).toHaveLength(2)
  expect(rows[0]!.querySelector('[aria-label="Claude"]')).not.toBeNull()
  expect(rows[1]!.querySelector('[aria-label="DeepSeek"]')).not.toBeNull()
  for (const row of rows) expect(row.querySelector('[class*="rowMeta"]')).toBeNull()

  // A title only one row wears already says which conversation it is: no
  // chip, and no second line either.
  const alone = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Refill the cache'),
  )!
  expect(alone.querySelector('[data-slot="chip"]')).toBeNull()
  expect(alone.querySelector('[class*="rowMeta"]')).toBeNull()
})

/**
 * Rooms in the tree.
 *
 * A project holds as many rooms as the work wants, the same way it holds
 * sessions, so a room is a row *under its project* and the conversations in it
 * are one level further in. This replaces a single line above the whole tree
 * that read "Room · 2 open · 1 claimed" for whichever folder happened to be
 * open: it stood over every project while naming one, it could only ever name
 * one, and the counts on it were a status readout in a place meant for
 * destinations.
 */
const summary = (over: { id: string } & Partial<Omit<SessionSummary, 'id'>>): SessionSummary =>
  ({
    runtime: 'codex',
    title: over.id,
    preview: null,
    cwd: '/repo',
    status: { type: 'notLoaded' },
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    // A live conversation always has these; the tree reads them to say what
    // an agent is doing, and a fixture without them crashes the row.
    turns: [],
    ...over,
  }) as unknown as SessionSummary

const room = (over: {
  id: string
  name: string
  updatedAt?: number
  members?: string[]
  root?: string
  realRoot?: string
  intents?: { state: string }[]
  channel?: { kind: string; state: string }[]
}) =>
  ({
    id: over.id,
    name: over.name,
    updatedAt: over.updatedAt ?? 1,
    root: over.root ?? '/repo',
    ...(over.realRoot ? { realRoot: over.realRoot } : {}),
    members: over.members ?? [],
    messaging: true,
    intents: over.intents ?? [],
    channel: over.channel ?? [],
  }) as unknown as TeamState

const treeWith = (
  rooms: readonly TeamState[],
  sessions: readonly SessionSummary[] = [],
  /** Live conversations the history has not caught up with yet. */
  live: readonly SessionSummary[] = [],
  prefs: Partial<AppSnapshot['listPrefs']> = {},
  /** The folder the desk has open, when it is not the plain repository root. */
  open: { path: string; name: string; lastOpenedAt: number; repo?: unknown; realPath?: string } = {
    path: '/repo',
    name: 'repo',
    lastOpenedAt: 1,
  },
  activeSessionKey: AppSnapshot['activeSessionKey'] = null,
  goals: ReadonlyMap<string, GoalView> = new Map(),
  /** Extra store methods a test needs answered — `RoomOrigin`'s `triggerGoal`, say. */
  storeOverrides: Partial<AppStore> = {},
  expandTeams = true,
): { container: HTMLElement; store: AppStore; update: (patch: Partial<AppSnapshot>) => void } => {
  let snapshot = {
    ...emptySnapshot(),
    status: 'open',
    workspace: open,
    workspaces: [open],
    history: sessions,
    activeSessionKey,
    sessions: new Map(live.map((one) => [sessionKey(one.runtime, one.id), one])),
    listPrefs: { ...emptySnapshot().listPrefs, ...prefs },
    teams: new Map(rooms.map((one) => [one.id, one])),
    goals,
  } as unknown as AppSnapshot
  const listeners = new Set<() => void>()
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    toggleCollapsed: vi.fn(),
    setOthersOpen: vi.fn(),
    openTeamRoom: vi.fn(),
    openSession: vi.fn(),
    triggerGoal: vi.fn(async () => null),
    ...storeOverrides,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={3} />
      </StoreProvider>,
    )
  })
  // Tests inspecting child behavior expand through the real disclosure first.
  if (expandTeams) {
    for (const disclosure of container.querySelectorAll<HTMLButtonElement>('[data-slot="sidebar-menu-action"][aria-label^="Show the agents in"]')) {
      const board = rooms.find(one => disclosure.getAttribute('aria-label') === `Show the agents in ${goals.get(one.id)?.goal ? goals.get(one.id)!.goal.sentence : one.name}`)
      if (!board || !prefs.collapsed?.includes(board.id)) act(() => disclosure.click())
    }
  }
  return {
    container,
    store,
    update: (patch: Partial<AppSnapshot>) => {
      snapshot = { ...snapshot, ...patch } as typeof snapshot
      act(() => listeners.forEach((listener) => listener()))
    },
  }
}

it('draws a Working conversation once inside its project and includes it in the count', () => {
  const active = summary({
    id: 'session-active',
    status: { type: 'active' },
  }) as SessionSummary & { turns: unknown[] }
  active.turns = [{ id: 't1', status: 'inProgress', items: [{ type: 'reasoning', text: 'working' }] }]
  const others = Array.from({ length: 5 }, (_, index) => summary({ id: `session-${index}` }))
  const { container: tree } = treeWith([], [active, ...others], [active], {}, undefined, sessionKey('codex', sessionId(active.id)))

  expect(rowTitles(tree).filter((title) => title === 'session-active')).toHaveLength(1)
  expect(tree.querySelector('[data-tone="working"]')).toBeNull()
  expect([...tree.querySelectorAll('button')].some((button) => button.textContent?.endsWith('more'))).toBe(true)
  expect(tree.querySelectorAll('[data-active="true"]')).toHaveLength(1)
})

it('keeps a working Seat under its Team', () => {
  const active = summary({
    id: 'session-room-member',
    status: { type: 'active' },
  }) as SessionSummary & { turns: unknown[] }
  active.turns = [{ id: 't1', status: 'inProgress', items: [{ type: 'reasoning', text: 'working' }] }]
  const { container: tree } = treeWith(
    [room({ id: 'r1', name: 'Release room', members: [sessionKey('codex', active.id)] })],
    [active],
    [active],
  )

  expect(rowTitles(tree).filter((title) => title === 'session-room-member')).toHaveLength(1)
  expect(roomRow(tree, 'Release room')).toBeTruthy()
})

it('keeps a conversation in its project when its turn ends', () => {
  const active = summary({
    id: 'session-active',
    status: { type: 'active' },
  }) as SessionSummary & { turns: unknown[] }
  active.turns = [{ id: 't1', status: 'inProgress', items: [{ type: 'reasoning', text: 'working' }] }]
  const view = treeWith([], [active], [active])
  expect(rowTitles(view.container).filter((title) => title === 'session-active')).toHaveLength(1)
  const completed = {
    ...active,
    status: { type: 'idle' },
    turns: [{ id: 't1', status: 'completed', items: [] }],
  } as unknown as SessionSummary
  view.update({
    sessions: new Map(),
    history: [completed],
  })
  const project = view.container.querySelector('[class*="nested"]')
  expect(project && rowTitles(project as HTMLElement)).toEqual(['session-active'])
  expect(view.container.querySelector('[data-tone="working"]')).toBeNull()
})

it('draws a pinned conversation once in Pinned, preserving pin order and hiding the empty group', () => {
  const first = summary({ id: 'session-first' })
  const second = summary({ id: 'session-second' })
  const working = summary({ id: 'session-working', status: { type: 'active' } }) as SessionSummary & { turns: unknown[] }
  working.turns = [{ id: 't1', status: 'inProgress', items: [{ type: 'reasoning', text: 'working' }] }]
  const empty = treeWith([], [first])
  expect(empty.container.querySelector('[data-sidebar-band="pinned"]')).toBeNull()

  const view = treeWith([], [first, second, working], [working], {
    pinnedSessions: [sessionKey('codex', second.id), sessionKey('codex', first.id)],
  })
  const pinned = view.container.querySelector('[data-sidebar-band="pinned"]')
  expect(pinned).toBeTruthy()
  expect(rowTitles(pinned as HTMLElement)).toEqual(['session-second', 'session-first'])
  const project = view.container.querySelector('[data-project-root]')!
  expect(Boolean(pinned!.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  expect(rowTitles(view.container).filter((title) => title === 'session-first')).toHaveLength(1)
  expect(rowTitles(view.container).filter((title) => title === 'session-second')).toHaveLength(1)
  expect(view.container.querySelectorAll('[data-active="true"]')).toHaveLength(0)
})

it('reveals the active session in a collapsed project', () => {
  const active = summary({ id: 'active' })
  const { store } = treeWith(
    [],
    [active],
    [],
    { collapsed: ['/repo'] },
    { path: '/other', name: 'other', lastOpenedAt: 1 },
    sessionKey('codex', sessionId('active')),
  )

  expect(store.toggleCollapsed).toHaveBeenCalledWith('/repo')
})

it('opens Other projects when the active session belongs to a far project', () => {
  const active = summary({ id: 'active', cwd: '/far' })
  const { store } = treeWith(
    [],
    [
      active,
      summary({ id: 'near-one', cwd: '/one' }),
      summary({ id: 'near-two', cwd: '/two' }),
      summary({ id: 'near-three', cwd: '/three' }),
    ],
    [],
    {},
    { path: '/current', name: 'current', lastOpenedAt: 1 },
    sessionKey('codex', sessionId('active')),
  )

  expect(store.setOthersOpen).toHaveBeenCalledWith(true)
  const fold = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.startsWith('Other projects'))
  expect(fold?.querySelector('[data-slot="sidebar-menu-icon"]')).not.toBeNull()
  expect(fold?.closest('[data-sidebar="group"]')).toBeNull()
  expect(fold?.parentElement?.querySelector('[data-slot="sidebar-menu-badge"]')?.textContent).toBe('4')
})

it('aligns the N more row with the project and conversation label column', () => {
  const sessions = Array.from({ length: 6 }, (_, index) => summary({ id: `session-${index + 1}`, updatedAt: index + 1 }))
  const { container: tree } = treeWith([], sessions)
  const more = [...tree.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '1 more')
  expect(more?.querySelector('[data-slot="sidebar-menu-icon"]')).not.toBeNull()
})

it('reveals 25 conversations at a time and reports how many remain', () => {
  const sessions = Array.from({ length: 40 }, (_, index) => summary({ id: `session-${index + 1}`, updatedAt: index + 1 }))
  const { container: tree } = treeWith([], sessions)
  const rows = () => tree.querySelectorAll('[data-region="session-row"]').length
  const more = () => [...tree.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '35 more')

  expect(rows()).toBe(5)
  expect(more()).toBeTruthy()
  act(() => more()!.click())
  expect(rows()).toBe(30)
  expect([...tree.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.trim() === '10 more')).toBe(true)
  act(() => [...tree.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '10 more')!.click())
  expect(rows()).toBe(40)
  expect([...tree.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.trim() === 'more')).toBe(false)
})

it('windows a project after the revealed list grows past 50 rows', () => {
  const sessions = Array.from({ length: 70 }, (_, index) => summary({ id: `session-${index + 1}`, updatedAt: index + 1 }))
  const { container: tree } = treeWith([], sessions)
  const clickMore = (label: string) => act(() => {
    [...tree.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === label)!.click()
  })

  clickMore('65 more')
  clickMore('40 more')
  expect([...tree.querySelectorAll('[data-region="session-row"]')].length).toBeLessThan(55)
  expect([...tree.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.trim() === '15 more')).toBe(true)
})

it('only mutates the row whose selected conversation slice changed', () => {
  const sessions = [summary({ id: 'changed' }), summary({ id: 'untouched' })]
  const { container: tree, update } = treeWith([], sessions)
  const changed = tree.querySelector<HTMLElement>('[data-region="session-row"] button')!
  const untouched = [...tree.querySelectorAll<HTMLElement>('[data-region="session-row"] button')][1]!
  const changedMutations: MutationRecord[] = []
  const untouchedMutations: MutationRecord[] = []
  const changedObserver = new MutationObserver((records) => changedMutations.push(...records))
  const untouchedObserver = new MutationObserver((records) => untouchedMutations.push(...records))
  changedObserver.observe(changed, { attributes: true, childList: true, characterData: true, subtree: true })
  untouchedObserver.observe(untouched, { attributes: true, childList: true, characterData: true, subtree: true })

  update({ activeSessionKey: sessionKey('codex', sessionId('changed')) })
  // The active row is selected and gains aria-current. The other row's DOM is
  // unchanged, proving the store event did not fan out through every row.
  return Promise.resolve().then(() => {
    expect(changed.getAttribute('aria-current')).toBe('page')
    expect(changedMutations.length).toBeGreaterThan(0)
    expect(untouchedMutations).toHaveLength(0)
    changedObserver.disconnect()
    untouchedObserver.disconnect()
  })
})

it('expands the active session beyond the five-row preview', () => {
  const active = summary({ id: 'active', updatedAt: 1 })
  const sessions = [
    active,
    ...Array.from({ length: 5 }, (_, index) =>
      summary({ id: `session-${index + 1}`, updatedAt: index + 2 }),
    ),
  ]
  const { container: tree } = treeWith(
    [],
    sessions,
    [],
    {},
    { path: '/other', name: 'other', lastOpenedAt: 1 },
    sessionKey('codex', sessionId('active')),
  )

  const row = [...tree.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'active',
  )
  expect(row?.hasAttribute('data-active')).toBe(true)
})

it('reveals and scrolls an active session beyond the next 25 rows', () => {
  const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  try {
    const active = summary({ id: 'active-far', updatedAt: 1 })
    const sessions = [
      ...Array.from({ length: 35 }, (_, index) => summary({ id: `session-${index + 1}`, updatedAt: index + 3 })),
      active,
    ]
    const { container: tree } = treeWith(
      [], sessions, [], {}, undefined,
      sessionKey('codex', sessionId('active-far')),
    )

    expect(tree.querySelectorAll('[data-region="session-row"]')).toHaveLength(36)
    expect(tree.querySelector('button[data-active]')?.textContent).toBe('active-far')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  } finally {
    scrollIntoView.mockRestore()
  }
})

it('scrolls the active session row into view', () => {
  const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  try {
    const active = summary({ id: 'active', updatedAt: 1 })
    const sessions = [
      active,
      ...Array.from({ length: 5 }, (_, index) =>
        summary({ id: `session-${index + 1}`, updatedAt: index + 2 }),
      ),
    ]
    const { container: tree } = treeWith(
      [],
      sessions,
      [],
      {},
      undefined,
      sessionKey('codex', sessionId('active')),
    )

    expect(tree.querySelector('button[data-active]')?.textContent).toBe('active')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  } finally {
    scrollIntoView.mockRestore()
  }
})

const roomRow = (where: HTMLElement, name: string): HTMLElement => {
  const found = [...where.querySelectorAll('[role="button"]')].find(
    (one) => one.getAttribute('aria-label') === `Room ${name}`,
  )
  if (!found) throw new Error(`no room row for ${name}`)
  return found as HTMLElement
}

const rowTitles = (where: HTMLElement): string[] =>
  [...where.querySelectorAll('button')]
    .map((one) => one.textContent?.trim() ?? '')
    .filter((text) => text.startsWith('session-'))

/** A trigger's Goal, as `snapshot.goals` holds it, for a room of the same id. */
const triggerGoalView = (board: TeamState, activity: GoalView['activity'] = 'working'): GoalView => ({
  goal: {
    id: board.id, root: '/repo', cwd: '/repo', sentence: board.name, state: 'open', revision: 1,
    checkout: 'shared', dependsOn: [], origin: { kind: 'trigger', trigger: 'triage-issue', event: 'e1' },
    createdAt: 1, updatedAt: 4, receipt: null,
  },
  activity, waitingOn: [], members: [], board, receipt: null, problem: null,
})

/** The Team header names the work; each folded Seat keeps its own conversation title. */
it('names waiting Teams by their Goal and keeps each Seat’s title on its own line', () => {
  const key1 = sessionKey('codex', sessionId('s1'))
  const key2 = sessionKey('codex', sessionId('s2'))
  const roomA = room({ id: 'g1', name: 'Issue #42, from trigger triage-issue', members: [key1] })
  const roomB = room({ id: 'g2', name: 'Issue #43, from trigger triage-issue', members: [key2] })
  const s1 = summary({ id: 's1', title: 'Triager' })
  const s2 = summary({ id: 's2', title: 'Triager' })
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    workspace: { path: '/repo', name: 'repo', lastOpenedAt: 1 },
    workspaces: [{ path: '/repo', name: 'repo', lastOpenedAt: 1 }],
    history: [s1, s2],
    sessions: new Map([[key1, s1], [key2, s2]]),
    teams: new Map([['g1', roomA], ['g2', roomB]]),
    goals: new Map([['g1', triggerGoalView(roomA, 'needs-you')], ['g2', triggerGoalView(roomB, 'needs-you')]]),
    approvals: [{ key: key1, approval: {} }, { key: key2, approval: {} }],
  } as unknown as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><SessionTree now={3} /></StoreProvider>))

  expect(container.querySelector('[data-tone="waiting"]')).toBeNull()
  for (const name of ['Issue #42', 'Issue #43']) {
    const row = roomRow(container, name)
    expect(row.textContent).toBe(`${name}Needs you`)
    expect(row.querySelectorAll('[data-slot="chip"]')).toHaveLength(1)
    expect(row.querySelector('[class*="rowMeta"]')).toBeNull()
    const disclosure = container.querySelector<HTMLButtonElement>(`[aria-label="Show the agents in ${name}"]`)!
    act(() => disclosure.click())
    const seat = row.closest('li')!.querySelector('[data-region="session-row"]')!
    expect(seat.textContent).toContain('TriagerNeeds you')
  }
})

/**
 * A Goal's row is one line: its name, one state chip, then its counts. The
 * origin used to take a second line ("from issue #43") under a name that
 * already said "Issue #43", and the trigger's own id sat in the name itself.
 * jsdom lays nothing out, so the overlap the floor caused is read from its
 * shape: the chip and the counts are never inside the name's line box, and
 * the name is the only thing given to fade.
 */
it('draws a trigger Goal’s row on one line: its subject and one running mark', async () => {
  const board = room({ id: 'g1', name: 'Issue #43, from trigger triage-issue', updatedAt: 4 })
  const triggerGoal = vi.fn(async () => ({
    goal: 'g1', trigger: 'triage-issue', source: 'issue' as const, label: 'from issue #43', url: null, budget: null, waits: [],
  }))
  const { container: tree } = treeWith([board], [], [], {}, undefined, null, new Map([['g1', triggerGoalView(board)]]), { triggerGoal })
  await act(async () => { await Promise.resolve() })

  const row = roomRow(tree, 'Issue #43')
  const head = row.querySelector('[data-slot="sidebar-menu-label"]')
  expect(head?.textContent).toBe('Issue #43')
  expect(row.querySelectorAll('[data-slot="chip"]')).toHaveLength(0)
  expect(row.closest('li')?.querySelector('[data-slot="spinner"]')).not.toBeNull()
  expect(row.querySelector('[class*="rowMeta"]')).toBeNull()
  expect(row.textContent).not.toContain('from issue')
  expect(row.textContent).not.toContain('triage-issue')
  // No second line competes with the name for the row's height.
  expect(row.querySelector('[class*="groupCount"], [class*="roomClaimed"]')).toBeNull()
  expect(triggerGoal).not.toHaveBeenCalled()
})

it('a room is a row under its project, and its members hang off it', () => {
  const { container: tree } = treeWith(
    [room({ id: 'r1', name: 'Checkout rewrite', members: [sessionKey('codex', sessionId('session-1'))] })],
    [summary({ id: 'session-1' }), summary({ id: 'session-2' })],
  )

  const row = roomRow(tree, 'Checkout rewrite')
  expect(row.textContent).toContain('Checkout rewrite')
  expect(row.getAttribute('data-slot')).toBe('sidebar-menu-button')
  expect(row.tagName).toBe('BUTTON')
  // The member is inside the room's own block; the loose one is not.
  const nested = row.closest('[data-slot="sidebar-menu-item"]')?.querySelector('[data-slot="sidebar-menu"]')
  expect(nested?.textContent).toContain('session-1')
  expect(nested?.textContent).not.toContain('session-2')
})

it('shows Goal activity and keeps wrapped Goals on the Teams page', () => {
  const openBoard = room({ id: 'g1', name: 'Ship release', updatedAt: 4 })
  const wrappedBoard = room({ id: 'g2', name: 'Prepare release', updatedAt: 3 })
  const view = (board: TeamState, state: 'open' | 'wrapped', activity: GoalView['activity']): GoalView => ({
    goal: { id: board.id, root: '/repo', cwd: '/repo', sentence: board.name, state, revision: 1, checkout: 'shared', dependsOn: [], origin: { kind: 'person' }, createdAt: 1, updatedAt: board.updatedAt, receipt: state === 'wrapped' ? 'r1' : null },
    activity,
    waitingOn: [],
    members: [],
    board,
    receipt: null,
    problem: null,
  })
  const goals = new Map([
    ['g1', view(openBoard, 'open', 'needs-you')],
    ['g2', view(wrappedBoard, 'wrapped', null)],
  ])
  const { container: tree } = treeWith([openBoard, wrappedBoard], [], [], {}, undefined, null, goals)

  expect(roomRow(tree, 'Ship release').textContent).toContain('Needs you')
  expect(tree.textContent).not.toContain('Wrapped · 1')
  expect(tree.querySelector('[aria-label="Room Prepare release"]')).toBeNull()
})

it('keeps receipt conversations off the sidebar without live or legacy membership', () => {
  const board = room({ id: 'record-team', name: 'Read completed work' })
  const base = triggerGoalView(board)
  const view = { ...base, goal: { ...base.goal, state: 'wrapped' }, members: [], receipt: {
    seats: ['keeper', 'older', 'missing'],
    members: [
      { seat: 'keeper', agent: 'Keeper', seatLabel: 'Writer', session: { runtime: 'codex', sessionId: 'kept' } },
      { seat: 'older', agent: 'Reviewer', seatLabel: 'Reviewer' },
      { seat: 'missing', agent: 'Gamma', seatLabel: 'Reviewer' },
    ],
    answers: [{ seat: 'older', session: { runtime: 'codex', sessionId: 'older-answer' } }],
  } } as unknown as GoalView
  const { container: tree, store } = treeWith([board], [], [], {}, undefined, null, new Map([[board.id, view]]))
  expect(tree.textContent).not.toContain('Wrapped')
  expect(tree.querySelectorAll('[data-region="session-row"]')).toHaveLength(0)
  expect(store.openSession).not.toHaveBeenCalled()
})

/* A receipt can retain one conversation for several Seats; all remain off the sidebar after wrap. */
it('keeps repeated receipt Seats off the sidebar', () => {
  const board = room({ id: 'record-team', name: 'Read completed work' })
  const base = triggerGoalView(board)
  const view = { ...base, goal: { ...base.goal, state: 'wrapped' }, members: [], receipt: {
    seats: ['first', 'again'],
    members: [
      { seat: 'first', agent: 'Keeper', seatLabel: 'Writer', session: { runtime: 'codex', sessionId: 'kept' } },
      { seat: 'again', agent: 'Second', seatLabel: 'Reviewer', session: { runtime: 'codex', sessionId: 'kept' } },
    ],
    answers: [],
  } } as unknown as GoalView
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const { container: tree } = treeWith([board], [], [], {}, undefined, null, new Map([[board.id, view]]))
    expect(tree.textContent).not.toContain('Wrapped')
    expect(tree.querySelectorAll('[data-region="session-row"]')).toHaveLength(0)
    expect(errors.mock.calls.map(call => String(call[0])).filter(text => text.includes('same key'))).toEqual([])
  } finally { errors.mockRestore() }
})

/* Unlinked receipt Seats stay in the wrapped Team’s Agents list, outside the sidebar. */
it('keeps unlinked receipt Seats off the sidebar', () => {
  const board = room({ id: 'record-team', name: 'Read completed work' })
  const base = triggerGoalView(board)
  const view = { ...base, goal: { ...base.goal, state: 'wrapped' }, members: [], receipt: {
    seats: ['keeper', 'lost', 'lost-too'],
    members: [
      { seat: 'keeper', agent: 'Keeper', seatLabel: 'Writer', session: { runtime: 'codex', sessionId: 'kept' } },
      { seat: 'lost', agent: 'Gamma', seatLabel: 'Reviewer' },
      { seat: 'lost-too', agent: 'Delta', seatLabel: 'Reviewer' },
    ],
    answers: [],
  } } as unknown as GoalView
  const { container: tree } = treeWith([board], [], [], {}, undefined, null, new Map([[board.id, view]]))
  expect(tree.textContent).not.toContain('Wrapped')
  expect(tree.querySelectorAll('[data-nested="true"]')).toHaveLength(0)
  expect(tree.textContent).not.toMatch(/Gamma|Delta|Keeper/)
})

it('a conversation in a room is listed once, under the room', () => {
  // Two rows for one session — the room's copy and a loose copy — would make
  // the tree disagree with itself about how many conversations there are, and
  // leave no way to tell which of the two could be pinned or deleted.
  const { container: tree } = treeWith(
    [room({ id: 'r1', name: 'Checkout rewrite', members: [sessionKey('codex', sessionId('session-1'))] })],
    [summary({ id: 'session-1' }), summary({ id: 'session-2' })],
  )
  expect(rowTitles(tree).filter((title) => title === 'session-1')).toHaveLength(1)
  expect(rowTitles(tree)).toContain('session-2')
})

it('the twisty hides the members without opening the room', () => {
  // "Show me who is in here" and "take me in there" are different questions,
  // and a tree that answers the wrong one is a tree you stop expanding.
  const { container: tree, store } = treeWith(
    [room({ id: 'r1', name: 'Checkout rewrite', members: [sessionKey('codex', sessionId('session-1'))] })],
    [summary({ id: 'session-1' })],
  )
  const twisty = roomRow(tree, 'Checkout rewrite').parentElement?.querySelector('[data-slot="sidebar-menu-action"]')
  act(() => (twisty as HTMLButtonElement).click())

  expect(twisty?.getAttribute('aria-expanded')).toBe('false')
  expect(tree.querySelector('[data-nested="true"]')).toBeNull()
  expect(store.openTeamRoom).not.toHaveBeenCalled()
})

/* The row and the disclosure are sibling buttons; each answers its own keys. */
it('the room row answers its own keys and leaves the twisty theirs', () => {
  const { container: tree, store } = treeWith([room({ id: 'r1', name: 'Checkout rewrite' })])
  const row = roomRow(tree, 'Checkout rewrite')
  expect([...tree.querySelectorAll<HTMLButtonElement>('[data-slot="sidebar-menu-button"]')][0]!.tabIndex).toBe(0)
  expect(row.tabIndex).toBe(-1)

  // Enter and Space open the room, and Space does not also scroll the list.
  for (const key of ['Enter', ' ']) {
    const press = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    act(() => { row.dispatchEvent(press) })
    expect(press.defaultPrevented, key).toBe(true)
  }
  expect(store.openTeamRoom).toHaveBeenCalledTimes(2)
  expect(store.openTeamRoom).toHaveBeenLastCalledWith('r1')

  // The disclosure's keys must not open the room.
  const twisty = row.parentElement?.querySelector<HTMLButtonElement>('[data-slot="sidebar-menu-action"]')!
  for (const key of ['Enter', ' ']) {
    const press = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    act(() => { twisty.dispatchEvent(press) })
    expect(press.defaultPrevented, key).toBe(false)
  }
  expect(store.openTeamRoom).toHaveBeenCalledTimes(2)

  expect(row.querySelector('[aria-label^="Actions for"]')).toBeNull()
})

it('the twisty answers the keyboard too, and the row does not answer for it', () => {
  /* The disclosure is a sibling button, so its keys stay separate. */
  const { container: tree, store } = treeWith(
    [room({ id: 'r1', name: 'Checkout rewrite', members: [sessionKey('codex', sessionId('session-1'))] })],
    [summary({ id: 'session-1' })],
  )
  const twisty = roomRow(tree, 'Checkout rewrite').parentElement?.querySelector('[data-slot="sidebar-menu-action"]') as HTMLButtonElement

  for (const key of ['Enter', ' ']) {
    act(() => {
      twisty.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  }
  expect(store.openTeamRoom).not.toHaveBeenCalled()

  // And the row still answers for itself.
  act(() => {
    roomRow(tree, 'Checkout rewrite').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
  })
  expect(store.openTeamRoom).toHaveBeenCalledWith('r1')
})

it('the row itself opens the room', () => {
  const { container: tree, store } = treeWith([room({ id: 'r1', name: 'Checkout rewrite' })])
  act(() => roomRow(tree, 'Checkout rewrite').click())
  expect(store.openTeamRoom).toHaveBeenCalledWith('r1')
})

it('several rooms in one project are several rows', () => {
  const { container: tree } = treeWith([
    room({ id: 'r1', name: 'Checkout rewrite' }),
    room({ id: 'r2', name: 'Tax rounding' }),
  ])
  expect(roomRow(tree, 'Checkout rewrite')).toBeTruthy()
  expect(roomRow(tree, 'Tax rounding')).toBeTruthy()
})

it('orders rooms and loose conversations together by recency', () => {
  const { container: tree } = treeWith(
    [
      room({ id: 'r1', name: 'Zeta', updatedAt: 10 }),
      room({ id: 'r2', name: 'Alpha', updatedAt: 30 }),
    ],
    [summary({ id: 'Loose', updatedAt: 20 })],
  )

  const nested = tree.querySelector('[class*="nested"]')
  if (!nested) throw new Error('project rows did not render')
  const rows = [...nested.children].map((child) => {
    const roomRow = child.querySelector('[role="button"]')
    if (roomRow) return roomRow.getAttribute('aria-label')
    return child.querySelector('button')?.textContent?.trim() ?? null
  })
  expect(rows).toEqual(['Room Alpha', 'Loose', 'Room Zeta'])
})

it('moves pinned conversations out of the project while leaving the room row', () => {
  const first = summary({ id: 'Pinned first', updatedAt: 10 })
  const second = summary({ id: 'Pinned second', updatedAt: 100 })
  const { container: tree } = treeWith(
    [room({ id: 'r1', name: 'Recent room', updatedAt: 50 })],
    [first, second],
    [],
    { pinnedSessions: [sessionKey('codex', second.id), sessionKey('codex', first.id)] },
  )

  const nested = tree.querySelector('[class*="nested"]')
  if (!nested) throw new Error('project rows did not render')
  const rows = [...nested.children].map((child) => {
    const roomRow = child.querySelector('[role="button"]')
    if (roomRow) return roomRow.getAttribute('aria-label')
    return child.querySelector('button')?.textContent?.trim() ?? null
  })
  expect(rows).toEqual(['Room Recent room'])
})

it('a room in a project the tree was not already showing still gets a row', () => {
  /* A room is only ever drawn from inside a project group, and the groups are
     built from the *sessions* — so a room whose root no session in `history`
     resolved to had nowhere to be drawn and was dropped without a trace.
     Seen live: thirteen rooms in the store, one row in the tree, and the five
     for the folder being worked in were the missing ones while a room from
     another project stayed. The roots disagree for real reasons — a project
     no conversation has reached `history` from yet, a folder opened through a
     symlink, a parent folder standing in for the repository under it — and a
     room is a thing somebody made and named, so it is reached, not filtered. */
  const { container: tree } = treeWith([
    room({ id: 'r1', name: 'HarnessDesk' }),
    room({ id: 'r2', name: 'Checkout rewrite', root: '/checkout-api' }),
    room({ id: 'r3', name: 'Tax rounding', root: '/checkout-api' }),
  ])
  expect(roomRow(tree, 'HarnessDesk')).toBeTruthy()
  expect(roomRow(tree, 'Checkout rewrite')).toBeTruthy()
  expect(roomRow(tree, 'Tax rounding')).toBeTruthy()
  // The project it belongs to is named, rather than the rooms being orphaned
  // under whichever folder happened to have a row.
  expect(
    [...tree.querySelectorAll('button')].some((one) => one.textContent?.includes('checkout-api')),
  ).toBe(true)
})

/**
 * The workspace list keeps the folder at the spelling it was opened at
 * (never `realpath`'d), but its sessions are grouped by `repo.root`, which
 * git resolves through a link. A project opened at its own top through one —
 * macOS keeps its temporary folders behind `/var` → `/private/var` — used to
 * be homed at the raw spelling while its own sessions and rooms grouped under
 * the resolved one: the same folder, filed under two keys, showed up twice
 * in the sidebar, one of them empty (#898).
 */
it('a project opened through a symlink is one row, not two', () => {
  const real = '/private/var/folders/x/work/widgets'
  const link = '/var/folders/x/work/widgets'
  const { container: tree } = treeWith(
    [],
    [summary({ id: 'session-1', cwd: real, repo: { root: real, worktree: false } })],
    [],
    {},
    { path: link, name: 'widgets', lastOpenedAt: 1, repo: { root: real, worktree: false } },
  )
  const widgetsRows = [...tree.querySelectorAll('button')].filter(
    (one) => one.textContent?.includes('widgets'),
  )
  expect(widgetsRows).toHaveLength(1)
})

/**
 * A Goal started in that same project keeps the folder as it was opened —
 * the link's spelling, which is where its work is cut from — while the row
 * is homed at git's resolved one. Its room used to earn a second row of its
 * own under that spelling, filed with the projects you are not standing in:
 * the same folder twice, once open and once under "Other projects", and the
 * room missing from the row it belongs to.
 */
it('a room started in a project opened through a symlink is drawn in that project’s one row', () => {
  const real = '/private/var/folders/x/work/widgets'
  const link = '/var/folders/x/work/widgets'
  const { container: tree } = treeWith(
    [
      room({ id: 'goal-1', name: 'Fix the retry', root: link }),
      room({ id: 'other-1', name: 'Elsewhere', root: '/elsewhere' }),
      room({ id: 'other-2', name: 'Further', root: '/further' }),
    ],
    [summary({ id: 'session-1', cwd: real, repo: { root: real, worktree: false } })],
    [],
    { othersOpen: true },
    { path: link, name: 'widgets', lastOpenedAt: 1, repo: { root: real, worktree: false } },
  )
  const widgetsRows = [...tree.querySelectorAll('button')].filter((one) => one.textContent?.trim().startsWith('widgets'))
  expect(widgetsRows).toHaveLength(1)
  expect(tree.textContent).toContain('Fix the retry')
})

it('files a linked room under its resolved project when the folder is no longer open', () => {
  const real = '/private/var/folders/x/work/widgets'
  const link = '/var/folders/x/work/widgets'
  const { container: tree } = treeWith(
    [
      room({ id: 'goal-1', name: 'Fix the retry', root: link, realRoot: real }),
      room({ id: 'other-1', name: 'Elsewhere', root: '/elsewhere' }),
      room({ id: 'other-2', name: 'Further', root: '/further' }),
    ],
    [summary({ id: 'session-1', cwd: real, repo: { root: real, worktree: false } })],
    [],
    { othersOpen: true },
    { path: '/repo', name: 'repo', lastOpenedAt: 1 },
  )
  const widgetsRows = [...tree.querySelectorAll('button')].filter((one) => one.textContent?.trim().startsWith('widgets'))
  expect(widgetsRows).toHaveLength(1)
  expect(tree.textContent).toContain('Fix the retry')
})

/**
 * The public report (#907), for a folder no git repository names: opened
 * through the same kind of alias, a non-git project also showed up as two
 * rows, and folding it needed the host's own `realPath` (`WorkspaceEntry`
 * now carries one for exactly this). But `realPath` is a comparison key,
 * never something to act on — reopening at it instead of the spelling the
 * person actually opened would have undone the fold this same row proves,
 * the moment its own "+" ran (review of #931, round 3).
 */
it('starts a new session at the spelling the person opened, from a non-git alias row that folded to one (#907)', () => {
  const real = '/private/var/folders/x/work/scratch'
  const link = '/var/folders/x/work/scratch'
  const startSessionIn = vi.fn()
  const { container: tree } = treeWith(
    [],
    [summary({ id: 'session-1', cwd: real, repo: null })],
    [],
    {},
    { path: link, name: 'scratch', lastOpenedAt: 1, realPath: real },
    null,
    new Map(),
    { startSessionIn },
  )
  const scratchRows = [...tree.querySelectorAll('button')].filter((one) => one.textContent?.includes('scratch'))
  expect(scratchRows).toHaveLength(1)
  const plus = tree.querySelector('[aria-label^="New session in "]')
  if (!plus) throw new Error('no "New session in" button on the folded row')
  act(() => (plus as HTMLElement).click())
  expect(startSessionIn).toHaveBeenCalledWith(link)
})

it('two rooms of one name in a project outside the tree are two rows', () => {
  /* The five that went missing shared a name, so a single key collapsing them
     would have looked like the same defect. It is the id that keys the row —
     both are drawn, and both are reachable. */
  const { container: tree, store } = treeWith([
    room({ id: 'r1', name: 'Checkout rewrite', root: '/checkout-api' }),
    room({ id: 'r2', name: 'Checkout rewrite', root: '/checkout-api' }),
  ])
  const rows = [...tree.querySelectorAll('[role="button"]')].filter(
    (one) => one.getAttribute('aria-label') === 'Room Checkout rewrite',
  )
  expect(rows).toHaveLength(2)
  act(() => (rows[1] as HTMLElement).click())
  expect(store.openTeamRoom).toHaveBeenCalledWith('r2')
})

/** One per project row: the + button carries the project's name. */
const projectRows = (where: HTMLElement): string[] =>
  [...where.querySelectorAll('[aria-label^="New session in "]')].map(
    (one) => one.getAttribute('aria-label')?.replace('New session in ', '') ?? '',
  )

it('a room in a project the tree is already showing does not add a second row', () => {
  // The guard the two tests above lean on: the loop must be a no-op for the
  // ordinary case. Without it every project with a room would draw twice, and
  // a test that only ever asks about *absent* projects would not notice.
  const { container: tree } = treeWith(
    [room({ id: 'r1', name: 'Checkout rewrite' })],
    [summary({ id: 'session-1' })],
  )
  expect(projectRows(tree)).toEqual(['repo'])
  expect(roomRow(tree, 'Checkout rewrite')).toBeTruthy()
})

it('a room in a project the tree drew for its own sake keeps its members under an agent filter', () => {
  /* The member lookup used to be starved rather than filtered: it consulted
     the live session map only while no filter was set, which was the right
     rule by accident and only for as long as the room's own project carried
     its members. A project the tree draws *for the room's sake* has no
     sessions, so every member resolved to nothing and a full room read "No
     agents in here yet" under a filter its members matched. */
  const codex = summary({ id: 'session-1', runtime: runtimeId('codex'), cwd: '/checkout-api' })
  const claude = summary({ id: 'session-2', runtime: runtimeId('claude-code'), cwd: '/checkout-api' })
  const both = room({
    id: 'r1',
    name: 'Checkout rewrite',
    root: '/checkout-api',
    members: [
      sessionKey(runtimeId('codex'), sessionId('session-1')),
      sessionKey(runtimeId('claude-code'), sessionId('session-2')),
    ],
  })
  // No history at all, so this project is in the tree only because the room is.
  const { container: tree } = treeWith([both], [], [codex, claude], { agent: runtimeId('codex') })
  const row = roomRow(tree, 'Checkout rewrite')
  expect(row.closest('[data-slot="sidebar-menu-item"]')?.textContent).not.toContain('No agents in here yet')
  // The filter still decides *which* members: Codex's is kept, Claude's is not.
  expect(rowTitles(row.closest('[data-slot="sidebar-menu-item"]') as HTMLElement)).toEqual(['session-1'])
  const disclosure = row.parentElement?.querySelector('[data-slot="sidebar-menu-action"]')
  expect(disclosure?.getAttribute('title')).toBe(
    "1 of this room's conversations match the agent filter",
  )
})

it('a room-only project waits inside "Other projects" like any project you have not opened', () => {
  /* Where the extra folder ends up, said out loud. A pushed row is never the
     current one — the fallback above would have made that row already — and
     never pinned, so past two projects it folds away like every other project
     you are not standing in. Reachable, and not pretending to be where you
     are working. */
  const rooms = [room({ id: 'r1', name: 'Checkout rewrite', root: '/checkout-api' })]
  const elsewhere = [summary({ id: 'session-1' }), summary({ id: 'session-2', cwd: '/tax' })]
  const shut = treeWith(rooms, elsewhere)
  expect(projectRows(shut.container)).toEqual(['repo'])
  expect(() => roomRow(shut.container, 'Checkout rewrite')).toThrow()
  expect(shut.container.textContent).toContain('Other projects')

  const open = treeWith(rooms, elsewhere, [], { othersOpen: true })
  expect(projectRows(open.container)).toContain('checkout-api')
  expect(roomRow(open.container, 'Checkout rewrite')).toBeTruthy()
})

it('a room keyed at the repository belongs to the row homed at the subfolder you have open', () => {
  /* The seam between two deliberate rules, which nothing owned a test for.
     `homeOf` homes a project at the subfolder you have open — `projects.test.ts`
     pins that — while `Team.createRoom` overwrites whatever root it is handed
     with the *repository*. So opening `<repo>/packages/ui` and making a room
     there gives a room rooted at `<repo>` and a row homed at `packages/ui`.
     Compared as strings that drew the project twice: one folder holding the
     conversations, a second holding the room. */
  const sub = '/repo/packages/ui'
  const open = { path: sub, name: 'ui', lastOpenedAt: 1, repo: { root: '/repo', worktree: false } }
  const here = summary({ id: 'session-1', cwd: sub, repo: { root: '/repo', worktree: false } })
  const made = room({ id: 'r1', name: 'Checkout rewrite', root: '/repo' })

  const { container: tree } = treeWith([made], [here], [], {}, open)
  expect(projectRows(tree)).toEqual(['ui'])
  expect(roomRow(tree, 'Checkout rewrite')).toBeTruthy()
})

/**
 * A navigation tree never renders an empty-state sentence (taste survey G9):
 * several freshly opened Goals, none seated yet, used to repeat "No agents in
 * here yet — open it to add one." under every one of them, one Goal already
 * reading "Working" at the same time. The row's own trailing count already
 * says 0, which is what a tree shows for empty — nothing more.
 */
it('keeps an empty room quiet without a zero or empty-state sentence', () => {
  const { container: tree } = treeWith([room({ id: 'r1', name: 'Checkout rewrite' })])
  const row = roomRow(tree, 'Checkout rewrite')
  expect(row.parentElement?.textContent).not.toContain('No agents in here yet')
  expect(row.parentElement?.querySelector('[data-slot="sidebar-menu-badge"]')).toBeNull()
  expect(row.parentElement?.textContent).not.toContain('0')
})

it('lists a member the history has not caught up with', () => {
  /* Adding an agent from the room's own rail put it in the roster while the
     tree said "No agents in here yet" directly beneath it — a conversation
     reaches `sessions` a beat before it reaches `history`, and the room was
     drawn from `history` alone. */
  const fresh = summary({ id: 'session-9', title: 'Untitled session' })
  const { container: tree } = treeWith(
    [room({ id: 'r1', name: 'Checkout rewrite', members: [sessionKey('codex', sessionId('session-9'))] })],
    [],
    [fresh],
  )
  const block = roomRow(tree, 'Checkout rewrite').closest('[data-slot="sidebar-menu-item"]')
  expect(block?.textContent).not.toContain('No agents in here yet')
  expect(block?.textContent).toContain('Untitled session')
})

it('a filtered list does not smuggle a member back in through the live map', () => {
  // The filter applies to every other row; a room that ignored it would list
  // the conversation the person had just narrowed away.
  const fresh = summary({ id: 'session-9', runtime: runtimeId('cursor'), title: 'Filtered away' })
  const { container: tree } = treeWith(
    [room({ id: 'r1', name: 'Checkout rewrite', members: [sessionKey('cursor', sessionId('session-9'))] })],
    // One conversation that survives the filter, so the project has a row for
    // the room to sit under at all.
    [summary({ id: 'session-1' })],
    [fresh],
    { agent: runtimeId('codex') },
  )
  const row = roomRow(tree, 'Checkout rewrite')
  const block = row.closest('[data-slot="sidebar-menu-item"]')
  expect(block?.textContent).not.toContain('No agents in here yet')
  expect(block?.textContent).not.toContain('Filtered away')
  expect(row.parentElement?.querySelector('[data-slot="sidebar-menu-action"]')?.getAttribute('title')).toBe(
    "0 of this room's conversations match the agent filter",
  )
})

it('a room reserves its trailing badge for messages and explains other counts on hover', () => {
  const { container: tree } = treeWith([
    room({ id: 'r1', name: 'Checkout rewrite', intents: [{ state: 'claimed' }, { state: 'open' }], channel: [{ kind: 'message', state: 'held' }] }),
  ])
  const row = roomRow(tree, 'Checkout rewrite')
  expect(row.title).toContain('1 claimed job')
  const badge = row.parentElement?.querySelector('[data-slot="sidebar-menu-badge"]')
  expect(badge?.textContent).toBe('1')
  expect(badge?.getAttribute('title')).toContain('1 held message')
})

it('a filtered room row says the number is filtered', () => {
  /* `members` is resolved against what the tree is showing, so under an agent
     filter it is a subset. Stating it as "N conversations in this room" told
     the reader the room was smaller than it is — all three reviewers of
     PR #51 caught it independently. */
  const codex = summary({ id: 's1', runtime: runtimeId('codex') })
  const claude = summary({ id: 's2', runtime: runtimeId('claude-code') })
  const both = room({ id: 'r1', name: 'Checkout rewrite', members: [
    sessionKey(runtimeId('codex'), sessionId('s1')),
    sessionKey(runtimeId('claude-code'), sessionId('s2')),
  ] })

  const plain = treeWith([both], [codex, claude])
  const plainCount = roomRow(plain.container, 'Checkout rewrite').parentElement?.querySelector('[data-slot="sidebar-menu-action"]')
  expect(plainCount?.getAttribute('title')).toBe('2 conversations in this room')

  const filtered = treeWith([both], [codex], [], { agent: runtimeId('codex') })
  const filteredCount = roomRow(filtered.container, 'Checkout rewrite').parentElement?.querySelector('[data-slot="sidebar-menu-action"]')
  expect(filteredCount?.getAttribute('title')).toBe(
    "1 of this room's conversations match the agent filter",
  )
})

it('no board readout stands over the whole tree', () => {
  // The old line said "Room · 2 open · 1 claimed" above every project while
  // describing one of them. Counts belong on the room's own row and inside it.
  const { container: tree } = treeWith([
    room({ id: 'r1', name: 'Checkout rewrite' }),
    room({ id: 'r2', name: 'Tax rounding', root: '/other' }),
  ])
  expect(tree.textContent).not.toContain('claimed')
})

/*
 * The name the person just gave a conversation shows before the history list
 * has caught up. A rename patches the open session at once and re-reads the
 * history after it; 138 renames in a row left the sidebar reading "Untitled
 * session" down the whole list for the better part of a minute while the
 * room's rail — which reads the live sessions — already had every name.
 */
it('a row shows the live session\'s title before the history list has it', () => {
  const runtime = {
    id: 'agent',
    name: 'Agent',
    capabilities: { deleteHistory: true },
    presentation: { name: 'Agent' },
  } as unknown as RuntimeInfo
  const id = sessionId('renamed')
  const key = sessionKey(runtime.id, id)
  const summary = {
    id,
    runtime: runtime.id,
    title: null,
    preview: null,
    cwd: '/repo',
    status: { type: 'idle' },
    createdAt: 1,
    updatedAt: 2,
    archived: false,
  } as unknown as SessionSummary
  const live = { id, runtime: runtime.id, title: '/about', turns: [], status: { type: 'idle' }, cwd: '/repo' } as unknown as Session
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    runtimes: [runtime],
    history: [summary],
    sessions: new Map([[key, live]]),
  } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={3} />
      </StoreProvider>,
    )
  })
  expect(container.textContent).toContain('/about')
  expect(container.textContent).not.toContain('Untitled session')
})

it('gives a conversation open in this window a row even when its agent lists no history', () => {
  const runtime = {
    id: 'agent',
    name: 'Agent',
    capabilities: {},
    presentation: { name: 'Agent' },
  } as unknown as RuntimeInfo
  const key = sessionKey(runtimeId('agent'), sessionId('live-1'))
  const live = {
    id: 'live-1',
    runtime: 'agent',
    title: null,
    preview: null,
    cwd: '/repo/.claude/worktrees/fix-107',
    status: { type: 'active' },
    createdAt: 1,
    updatedAt: 2,
    turns: [
      {
        id: 'turn-1',
        items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Fix the countdown roll-over' }] }],
      },
    ],
    itemsLoaded: true,
  } as unknown as Session
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    activeSessionKey: key,
    runtimes: [runtime],
    // The agent lists nothing: no `session/list`, so the history is empty.
    history: [],
    sessions: new Map([[key, live]]),
    // The checkout is open, which is what lets a worktree path name it: a
    // guess read off a path may name a project, never invent one.
    workspaces: [{ path: '/repo' }],
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={3} />
      </StoreProvider>,
    )
  })

  const row = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Fix the countdown roll-over'),
  )
  expect(row, 'the open conversation has a row, named by its first ask').toBeDefined()
  expect(row?.hasAttribute('data-active')).toBe(true)
  // A worktree conversation is filed under the checkout it belongs to.
  expect(container.textContent).toContain('repo')
})

it('names a live row after the person’s first ask as soon as it is typed', () => {
  const runtime = {
    id: 'agent',
    name: 'Agent',
    capabilities: {},
    presentation: { name: 'Agent' },
  } as unknown as RuntimeInfo
  const key = sessionKey(runtimeId('agent'), sessionId('live-2'))
  const empty = {
    id: 'live-2',
    runtime: 'agent',
    title: null,
    preview: null,
    cwd: '/repo',
    status: { type: 'idle' },
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    itemsLoaded: true,
  } as unknown as Session
  // The same conversation once the first message went out: the status is
  // back to idle — nothing but the transcript differs from the empty one.
  const asked = {
    ...empty,
    turns: [
      {
        id: 'turn-1',
        items: [
          {
            type: 'userMessage',
            content: [{ type: 'text', text: 'Rename the branch\n\n<context source="HarnessDesk">\nsign it\n</context>' }],
          },
        ],
      },
    ],
  } as unknown as Session
  let snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    activeSessionKey: key,
    runtimes: [runtime],
    history: [],
    sessions: new Map([[key, empty]]),
    workspaces: [{ path: '/repo' }],
  } as unknown as AppSnapshot
  const listeners = new Set<() => void>()
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={3} />
      </StoreProvider>,
    )
  })
  const rows = () => [...container.querySelectorAll('button[data-active]')].map((row) => row.textContent ?? '')
  expect(rows()[0]).toContain('Untitled session')

  act(() => {
    snapshot = { ...snapshot, sessions: new Map([[key, asked]]) } as unknown as AppSnapshot
    for (const listener of listeners) listener()
  })
  expect(rows()[0]).toContain('Rename the branch')
  expect(rows()[0]).not.toContain('sign it')
})

it('reads the ask past the context blocks the composer puts before it', () => {
  const runtime = {
    id: 'agent',
    name: 'Agent',
    capabilities: {},
    presentation: { name: 'Agent' },
  } as unknown as RuntimeInfo
  const key = sessionKey(runtimeId('agent'), sessionId('live-3'))
  // What the composer sends with a chip attached: the context in a text
  // block of its own, then the typed words in another.
  const live = {
    id: 'live-3',
    runtime: 'agent',
    title: null,
    preview: null,
    cwd: '/repo',
    status: { type: 'active' },
    createdAt: 1,
    updatedAt: 2,
    turns: [
      {
        id: 'turn-1',
        items: [
          {
            type: 'userMessage',
            content: [
              { type: 'text', text: wrapContext('Page', 'the page it was looking at') },
              { type: 'text', text: 'Make the header sticky' },
            ],
          },
        ],
      },
    ],
    itemsLoaded: true,
  } as unknown as Session
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    activeSessionKey: key,
    runtimes: [runtime],
    history: [],
    sessions: new Map([[key, live]]),
    workspaces: [{ path: '/repo' }],
  } as unknown as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={3} />
      </StoreProvider>,
    )
  })
  const row = container.querySelector('button[data-active]')
  expect(row?.textContent).toContain('Make the header sticky')
  expect(row?.textContent).not.toContain('Untitled session')
  expect(row?.textContent).not.toContain('the page it was looking at')
})

/**
 * The mark that says so before the click.
 *
 * A deleted worktree takes every conversation that ran in it, so one refusal
 * is enough to know about all of them — which is the case this came from: a
 * review room's three members in one worktree (#127). The mark is a glyph on
 * the same right rail as the worktree one, in the same ink, because both are
 * facts about *where* a row ran.
 */
it('marks a row whose folder is gone, and leaves the others unmarked', () => {
  const runtime = {
    id: 'agent',
    name: 'Agent',
    capabilities: {},
    presentation: { name: 'Agent' },
  } as unknown as RuntimeInfo
  const summary = (id: string, title: string, cwd: string): SessionSummary =>
    ({
      id,
      runtime: runtime.id,
      title,
      preview: null,
      cwd,
      status: { type: 'idle' },
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    }) as unknown as SessionSummary
  const said = 'Agent cannot open this conversation: its folder no longer exists (/repo/gone).'
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    runtimes: [runtime],
    history: [
      summary('s-gone', 'Ran in the worktree', '/repo/gone'),
      summary('s-here', 'Ran in the checkout', '/repo'),
    ],
    foldersGone: new Map([['/repo/gone', said]]),
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={3} />
      </StoreProvider>,
    )
  })

  const marks = [...container.querySelectorAll('[role="img"]')].filter((one) =>
    one.getAttribute('aria-label')?.startsWith('Folder is gone'),
  )
  expect(marks).toHaveLength(1)
  // The refusal is the hover line, so the row answers "why" without a click.
  expect(marks[0]?.getAttribute('title')).toContain('folder no longer exists')
})

it('shows the folder-gone mark before any click with the listing-sourced sentence', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const runtime = {
    id: 'agent',
    name: 'Agent',
    capabilities: {},
    presentation: { name: 'Agent' },
  } as unknown as RuntimeInfo
  const summary = (id: string, title: string, cwd: string): SessionSummary =>
    ({
      id,
      runtime: runtime.id,
      title,
      preview: null,
      cwd,
      status: { type: 'idle' },
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    }) as unknown as SessionSummary
  const listingSaid = "This conversation's folder no longer exists (/repo/gone)."
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    runtimes: [runtime],
    history: [
      summary('s-gone', 'Ran in the worktree', '/repo/gone'),
      summary('s-here', 'Ran in the checkout', '/repo'),
    ],
    foldersGone: new Map([['/repo/gone', listingSaid]]),
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={3} />
      </StoreProvider>,
    )
  })

  const marks = [...container.querySelectorAll('[role="img"]')].filter((one) =>
    one.getAttribute('aria-label')?.startsWith('Folder is gone'),
  )
  expect(marks).toHaveLength(1)
  expect(marks[0]?.getAttribute('title')).toContain("This conversation's folder no longer exists (/repo/gone).")
})

it('renames an inactive session without opening it or changing active session (#388)', async () => {
  const runtime = {
    id: 'agent',
    name: 'Agent',
    capabilities: {},
    presentation: { name: 'Agent' },
  } as unknown as RuntimeInfo
  const summaryA = {
    id: 'session-a',
    runtime: runtime.id,
    title: 'Active Conversation',
    preview: null,
    cwd: '/repo',
    status: { type: 'idle' },
    createdAt: 1,
    updatedAt: 2,
    archived: false,
  } as unknown as SessionSummary
  const summaryB = {
    id: 'session-b',
    runtime: runtime.id,
    title: 'Inactive Conversation',
    preview: null,
    cwd: '/repo',
    status: { type: 'idle' },
    createdAt: 1,
    updatedAt: 2,
    archived: false,
  } as unknown as SessionSummary

  const keyA = sessionKey(runtime.id, summaryA.id)
  const keyB = sessionKey(runtime.id, summaryB.id)

  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    activeSessionKey: keyA,
    runtimes: [runtime],
    history: [summaryA, summaryB],
  } as AppSnapshot

  const openSession = vi.fn()
  const renameSession = vi.fn()
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    openSession,
    renameSession,
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={3} />
      </StoreProvider>,
    )
  })

  // Find the menu button for session B
  const menuButtons = [...container.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')]
  expect(menuButtons.length).toBeGreaterThanOrEqual(2)
  const menuB = menuButtons.find((btn) => btn.getAttribute('aria-label')?.includes('Inactive Conversation'))
  expect(menuB).toBeDefined()

  act(() => {
    menuB!.click()
  })

  const menu = document.querySelector('[role="menu"]')!
  expect([...menu.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]')]
    .map((item) => item.querySelector('[class*="title"]')?.textContent?.trim()))
    .toEqual(['Rename', 'Pin', 'Open on the right', 'Branch from here', 'Copy', 'Archive', 'Delete…'])
  expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(2)
  const deleteOption = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((item) => item.textContent?.includes('Delete…'))!
  expect(deleteOption.getAttribute('aria-disabled')).toBe('true')
  expect(deleteOption.getAttribute('title')).toBe('Agent keeps no way to delete one.')

  // Click Rename in context menu
  const renameOption = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    item.textContent?.includes('Rename'),
  )
  expect(renameOption).toBeDefined()

  // The row as it stands, two lines tall (a comfortable row's second line):
  // the rename box must hold that height, or every row below moves up.
  const rowB = menuB!.closest('[class*="rowWrap"]')!.querySelector<HTMLButtonElement>('[data-slot="sidebar-menu-button"]')!
  rowB.getBoundingClientRect = () => ({ height: 55 }) as DOMRect

  act(() => {
    renameOption!.click()
  })

  // An input should appear for renaming
  const input = container.querySelector<HTMLInputElement>('input')
  expect(input).toBeDefined()
  expect(input?.value).toBe('Inactive Conversation')
  // It stands in for the row: the row's own box, at the height the row had.
  expect(input?.dataset.size).toBe('row')
  expect(input?.style.minHeight).toBe('55px')

  // Change input and press Enter
  act(() => {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    nativeInputValueSetter.call(input, 'Renamed Conversation')
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    input!.dispatchEvent(new Event('change', { bubbles: true }))
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })

  // Must not open session B
  expect(openSession).not.toHaveBeenCalled()
  // Must call renameSession with the title and keyB
  expect(renameSession).toHaveBeenCalledWith('Renamed Conversation', keyB)
})

it('keeps the folder and worktree marks beside Needs you without a duplicate activity mark', () => {
  const one = summary({ id: 'four-marks', cwd: '/repo/gone', repo: { root: '/repo', worktree: true }, git: { branch: 'fix/rail' }, status: { type: 'active' } })
  const { update } = treeWith([], [one], [one])
  update({
    foldersGone: new Map([[one.cwd, 'The folder no longer exists.']]),
    approvals: [{ key: sessionKey(one.runtime, one.id), approval: {
      id: approvalId('rail-approval'), sessionId: one.id, type: 'command', requestedAt: 1,
      command: 'pwd', cwd: one.cwd, actions: [], options: [],
    } }],
  })
  const row = container.querySelector('[data-region="session-row"] [data-slot="sidebar-menu-item"]')!
  expect(row.querySelectorAll('[data-slot="sidebar-menu-badge"]')).toHaveLength(2)
  expect(row.querySelector('[data-slot="sidebar-menu-state"]')).not.toBeNull()
  expect(row.querySelector('[data-slot="spinner"]')).toBeNull()
  expect(row.getAttribute('data-sidebar-trailing-marks')).toBe('3')
})

it.each([
  ['needs-you', 'Needs you', 'warning', 'limit'],
  ['working', 'Running', 'info', 'signin'],
  ['ready-to-wrap', 'Ready to wrap', 'brand', 'ready'],
] as const)('keeps a Goal’s %s signal in its compact state without a member approval', (activity, label, tone, state) => {
  const board = room({ id: 'goal-signal', name: 'Check the rail' })
  const { container: tree } = treeWith([board], [], [], {}, undefined, null,
    new Map([[board.id, triggerGoalView(board, activity)]]))
  if (activity === 'ready-to-wrap') {
    expect(tree.querySelector(`[aria-label="Room ${board.name}"]`)).toBeNull()
    return
  }
  if (activity === 'working') {
    expect(roomRow(tree, board.name).textContent).toBe(board.name)
    expect(roomRow(tree, board.name).closest('li')?.querySelector('[data-slot="spinner"]')).not.toBeNull()
    return
  }
  const mark = roomRow(tree, board.name).querySelector('[data-slot="sidebar-menu-state"]')!
  expect(mark.getAttribute('aria-label')).toBe(label)
  expect(mark.querySelector('[data-slot="chip"]')?.getAttribute('data-tone')).toBe(tone)
  expect(mark.querySelector('[data-sidebar-menu-state-compact] [data-slot="dot"]')?.getAttribute('data-state')).toBe(state)
})

it('nests both Goal Seats under their Team once when its older roster is empty', () => {
 const first=summary({id:'session-flow-writer'}),second=summary({id:'session-flow-reviewer'})
 const board=room({id:'flow-team',name:'Flow team',members:[]})
 const view={goal:{id:board.id,state:'open',sentence:'Flow team',origin:{kind:'person'}},board,members:[first,second].map((one,index)=>({id:`seat-${index}`,session:{runtime:one.runtime,sessionId:one.id},role:index?'reviewer':'writer',openedAt:1,closed:null,agent:{name:'Agent'}}))} as unknown as GoalView
 const {container:tree}=treeWith([board],[first,second],[],{},undefined,null,new Map([[board.id,view]]))
 expect(rowTitles(tree).filter(title=>title==='session-flow-writer')).toHaveLength(1)
 const opener=roomRow(tree,'Flow team')!
 expect(opener.closest('[data-slot="sidebar-menu-item"]')?.textContent).toContain('session-flow-writer')
 expect(opener.closest('[data-slot="sidebar-menu-item"]')?.textContent).toContain('session-flow-reviewer')
})

it('keeps a durable Seat in the Team tree when no live session or history is held', () => {
 const board=room({id:'rested-team',name:'Rested Team',members:[]})
 const view={...triggerGoalView(board),members:[{id:'rested-seat',session:{runtime:'codex',sessionId:'rested'},role:'reviewer',openedAt:1,closed:null,agent:{name:'Rested reviewer'}}]} as unknown as GoalView
 const {container:tree}=treeWith([board],[],[],{},undefined,null,new Map([[board.id,view]]))
 expect(tree.textContent).toContain('Rested reviewer')
})

it('keeps settled Teams and their Seats out of the sidebar, and brings attention back', () => {
 const seat=summary({id:'finished-seat'})
 const board=room({id:'settled-team',name:'Settled Team',members:[String(sessionKey(seat.runtime,seat.id))]})
 const view={...triggerGoalView(board),activity:'ready-to-wrap'} as GoalView
 const {container:tree,update}=treeWith([board],[seat],[],{},undefined,null,new Map([[board.id,view]]))
 expect(tree.querySelector('[aria-label="Room Settled Team"]')).toBeNull()
 expect(rowTitles(tree)).not.toContain('finished-seat')
 update({goals:new Map([[board.id,{...view,activity:'needs-you'}]])})
 expect(tree.querySelector('[aria-label="Room Settled Team"]')).not.toBeNull()
})

it('keeps working and waiting state on the conversation row inside its project', () => {
  const busy = { ...summary({ id: 'busy-row', status: { type: 'active' } }),
    turns: [{ id: 'busy-turn', status: 'inProgress', items: [] }] } as unknown as Session
  const waiting = summary({ id: 'waiting-row' }) as unknown as Session
  const view = treeWith([], [busy, waiting], [busy, waiting])
  view.update({ approvals: [{ key: sessionKey(waiting.runtime, waiting.id), approval: {} }] as unknown as AppSnapshot['approvals'] })
  expect(view.container.querySelector('[data-tone="working"], [data-tone="waiting"]')).toBeNull()
  const project = view.container.querySelector('[data-project-root="/repo"]')!
  const rows = project.querySelectorAll('[data-region="session-row"]')
  expect(rows).toHaveLength(2)
  expect(project.querySelector('[data-slot="sidebar-menu-state"]')?.getAttribute('aria-label')).toBe('Needs you')
  expect(project.querySelector('[data-slot="sidebar-menu-badge"][aria-label="Thinking"]')).not.toBeNull()
  expect([...project.querySelectorAll('[data-region="session-row"] [data-slot="sidebar-menu-label"]')].map(one => one.textContent)).toEqual(['busy-row', 'waiting-rowNeeds you'])
})

it('starts a Team folded and keeps every Seat under it even when pinned or needing you', () => {
  const seats = ['Writer', 'Reviewer', 'Tester'].map(id => summary({ id }))
  const board = room({ id: 'folded-team', name: 'Ship retry', members: seats.map(one => String(sessionKey(one.runtime, one.id))) })
  const view = treeWith([board], seats, [], { pinnedSessions: [sessionKey(seats[0]!.runtime, seats[0]!.id)] }, undefined, null, new Map(), {}, false)
  view.update({ approvals: [{ key: sessionKey(seats[1]!.runtime, seats[1]!.id), approval: {} }] as unknown as AppSnapshot['approvals'] })
  const disclosure = view.container.querySelector<HTMLButtonElement>('[aria-label="Show the agents in Ship retry"]')!
  expect(disclosure).not.toBeNull()
  expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  expect(view.container.querySelectorAll('[data-region="session-row"]')).toHaveLength(0)
  expect(roomRow(view.container, 'Ship retry').textContent).toContain('Needs you')
  act(() => disclosure.click())
  const nested = roomRow(view.container, 'Ship retry').closest('li')!.querySelector('[data-nested="true"]')!
  expect(nested.querySelectorAll('[data-region="session-row"]')).toHaveLength(3)
  expect(view.container.querySelector('[data-sidebar-band="pinned"]')).toBeNull()
  expect(view.container.querySelectorAll('[data-region="session-row"]')).toHaveLength(3)
})

it.each(['/repo', '/other-checkout'])('reveals an externally activated Seat from %s without undoing a deliberate fold', (cwd) => {
  const seat = summary({ id: 'activated-seat', title: 'Writer', cwd })
  const key = sessionKey(seat.runtime, seat.id)
  const board = room({ id: 'activate-team', name: 'Ship retry', members: [String(key)] })
  const view = treeWith([board], [seat], [], {}, undefined, null, new Map(), {}, false)
  expect(view.container.querySelector('[aria-current="page"]')).toBeNull()

  view.update({ activeSessionKey: key })

  const selected = view.container.querySelector<HTMLButtonElement>('[aria-current="page"]')
  expect(selected?.textContent).toBe('Writer')
  expect(selected?.closest('[data-project-root]')?.getAttribute('data-project-root')).toBe('/repo')
  expect(selected?.closest('[data-nested="true"]')).not.toBeNull()
  expect(selected?.tabIndex).toBe(0)
  expect(view.container.querySelectorAll('[aria-current="page"]')).toHaveLength(1)

  const disclosure = view.container.querySelector<HTMLButtonElement>('[aria-label="Hide the agents in Ship retry"]')!
  act(() => disclosure.click())
  view.update({ teams: new Map([[board.id, { ...board, updatedAt: 5 }]]) })
  expect(view.container.querySelector('[aria-current="page"]')).toBeNull()
  expect(view.container.querySelector('[aria-label="Show the agents in Ship retry"]')?.getAttribute('aria-expanded')).toBe('false')

  view.update({ activeSessionKey: null })
  view.update({ activeSessionKey: key })
  expect(view.container.querySelector('[aria-current="page"]')?.textContent).toBe('Writer')
})

it('reveals an activated cross-checkout Seat in its owning far project, keeping later folds', () => {
  const seat = summary({ id: 'far-seat', cwd: '/other-checkout' })
  const key = sessionKey(seat.runtime, seat.id)
  const board = room({ id: 'far-team', name: 'Far Team', root: '/far', members: [String(key)] })
  const view = treeWith([board], [seat, summary({ id: 'near-one' })], [],
    { collapsed: ['/far'] }, undefined, null, new Map(), {}, false)
  view.update({ activeSessionKey: key })
  expect(view.store.toggleCollapsed).toHaveBeenCalledWith('/far')
  expect(view.store.setOthersOpen).toHaveBeenCalledWith(true)
  view.update({ listPrefs: { ...view.store.getSnapshot().listPrefs, collapsed: [], othersOpen: true } })
  expect(view.container.querySelector('[aria-current="page"]')?.closest('[data-project-root]')?.getAttribute('data-project-root')).toBe('/far')

  vi.mocked(view.store.toggleCollapsed).mockClear()
  vi.mocked(view.store.setOthersOpen).mockClear()
  view.update({ listPrefs: { ...view.store.getSnapshot().listPrefs, collapsed: ['/far'], othersOpen: false } })
  expect(view.store.toggleCollapsed).not.toHaveBeenCalled()
  expect(view.store.setOthersOpen).not.toHaveBeenCalled()
})

it('reveals the owning Team when its roster arrives after activation', () => {
  const seat = summary({ id: 'late-seat' })
  const key = sessionKey(seat.runtime, seat.id)
  const board = room({ id: 'late-team', name: 'Late Team', members: [String(key)] })
  const view = treeWith([], [seat], [], {}, undefined, key, new Map(), {}, false)
  view.update({ teams: new Map([[board.id, board]]) })
  const selected = view.container.querySelector('[aria-current="page"]')!
  expect(selected.closest('[data-nested="true"]')).not.toBeNull()
  expect(view.container.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
})

it('reveals an activated durable Seat with no live session or history', () => {
  const board = room({ id: 'rested-active-team', name: 'Rested Team' })
  const goal = { ...triggerGoalView(board), members: [{ id: 'rested-seat', session: { runtime: 'codex', sessionId: 'rested' },
    role: 'reviewer', openedAt: 1, closed: null, agent: { name: 'Rested reviewer' } }] } as unknown as GoalView
  const view = treeWith([board], [], [], {}, undefined, null, new Map([[board.id, goal]]), {}, false)
  view.update({ activeSessionKey: sessionKey('codex', sessionId('rested')) })
  expect(view.container.querySelector('[aria-current="page"]')?.textContent).toBe('Rested reviewer')
})

it('mounts the owning Team for an activated Seat beyond the virtual project window', () => {
  const seat = summary({ id: 'windowed-seat' })
  const active = room({ id: 'last-team', name: 'Last Team', updatedAt: 1, members: [String(sessionKey(seat.runtime, seat.id))] })
  const boards = [...Array.from({ length: 55 }, (_, index) => room({ id: `window-team-${index}`, name: `Team ${index}`, updatedAt: 100 - index })), active]
  // jsdom has no layout: give the real virtualizer a scroller whose root moves with scrollTop.
  container.style.overflowY = 'auto'
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this === container ? 0 : -container.scrollTop
    return { x: 0, y: top, top, left: 0, bottom: top + 100, right: 320, width: 320, height: 100, toJSON: () => ({}) }
  })
  try {
    const view = treeWith(boards, [seat], [], {}, undefined, null, new Map(), {}, false)
    expect(view.container.querySelector('[aria-label="Room Last Team"]')).toBeNull()
    const first = roomRow(view.container, 'Team 0')
    act(() => first.focus())
    first.blur()
    view.update({ activeSessionKey: sessionKey(seat.runtime, seat.id) })
    expect(view.container.querySelector('[aria-current="page"]')?.textContent).toBe('windowed-seat')
  } finally { rect.mockRestore() }
})

it.each([false, true])('keeps a folded Team running with unread output (same Seat: %s)', (sameSeat) => {
  const unread = summary({ id: 'unread-seat' })
  const busy = { ...summary({ id: 'busy-seat', status: { type: 'active' } }),
    turns: [{ id: 'busy-turn', status: 'inProgress', items: [] }] } as unknown as Session
  const unreadKey = sessionKey((sameSeat ? busy : unread).runtime, (sameSeat ? busy : unread).id)
  const board = room({ id: 'mixed-team', name: 'Mixed Team', members: [unread, busy].map(one => String(sessionKey(one.runtime, one.id))) })
  const view = treeWith([board], [unread, busy], [busy], {}, undefined, null, new Map(), {}, false)
  view.update({ inbox: [{ id: 'unread-output', read: false, at: 2, tone: 'neutral', title: 'Review ready',
    from: { runtime: busy.runtime, sessionId: sameSeat ? busy.id : unread.id, name: 'Reviewer' } }] })
  const item = roomRow(view.container, board.name).closest('li')!
  expect(view.container.querySelectorAll('[data-region="session-row"]')).toHaveLength(0)
  expect(item.querySelector('[data-slot="spinner"]')).not.toBeNull()
  expect(item.textContent).not.toContain('Working')
  view.update({ approvals: [{ key: unreadKey, approval: {} }] as unknown as AppSnapshot['approvals'] })
  expect(item.querySelector('[data-slot="spinner"]')).toBeNull()
  expect(item.querySelector('[aria-label="Needs you"]')).not.toBeNull()
  view.update({ approvals: [], sessions: new Map([[sessionKey(busy.runtime, busy.id), { ...busy, status: { type: 'idle' }, turns: [] }]]) })
  expect(item.querySelector('[data-slot="spinner"]')).toBeNull()
})

it('indents project children once and a Team’s Seats a second time', () => {
  const seat = summary({ id: 'indent-seat' })
  const loose = summary({ id: 'indent-loose' })
  const board = room({ id: 'indent-team', name: 'Indent Team', members: [String(sessionKey(seat.runtime, seat.id))] })
  const view = treeWith([board], [seat, loose])
  const projectRows = view.container.querySelector('[data-virtual-project="true"]')!
  expect(projectRows.getAttribute('data-sidebar-indent')).toBe('true')
  const disclosure = view.container.querySelector<HTMLButtonElement>('[aria-label*="agents in Indent Team"]')!
  if (disclosure.getAttribute('aria-expanded') !== 'true') act(() => disclosure.click())
  const nested = projectRows.querySelector('[data-nested="true"]')!
  expect(nested).not.toBeNull()
  expect(nested.querySelector('[data-region="session-row"]')?.textContent).toContain('indent-seat')
  expect([...projectRows.children].find(one => one.textContent?.includes('indent-loose'))?.querySelector('[data-nested]')).toBeNull()
})

it('removes a wrapped Team and its pinned receipt conversations from the sidebar', () => {
  const seat = summary({ id: 'wrapped-seat' })
  const board = room({ id: 'wrapped-team', name: 'Wrapped Team', members: [String(sessionKey(seat.runtime, seat.id))] })
  const base = triggerGoalView(board)
  const goal = { ...base, goal: { ...base.goal, state: 'wrapped' }, receipt: {
    seats: ['seat'], members: [{ seat: 'seat', agent: 'Writer', session: { runtime: seat.runtime, sessionId: seat.id } }], answers: [],
  } } as unknown as GoalView
  const view = treeWith([board], [seat], [], { pinnedSessions: [sessionKey(seat.runtime, seat.id)] }, undefined, null, new Map([[board.id, goal]]))
  expect(view.container.textContent).not.toContain('Wrapped')
  expect(view.container.querySelectorAll('[data-region="session-row"]')).toHaveLength(0)
})

it('keeps a running pinned conversation in Pinned and updates its wait there', () => {
  const summaryRow = summary({ id: 'session-pinned-running', status: { type: 'active' } })
  const live = { ...summaryRow, turns: [{ id: 'running', status: 'inProgress', items: [] }] } as unknown as Session
  const view = treeWith([], [summaryRow], [live], { pinnedSessions: [sessionKey(live.runtime, live.id)] })
  const pinned = view.container.querySelector('[data-sidebar-band="pinned"]')!
  expect(rowTitles(pinned as HTMLElement)).toEqual(['session-pinned-running'])
  view.update({ approvals: [{ key: sessionKey(live.runtime, live.id), approval: {} }] as unknown as AppSnapshot['approvals'] })
  expect(pinned.querySelector('[data-slot="sidebar-menu-state"]')?.getAttribute('aria-label')).toBe('Needs you')
  expect(view.container.querySelectorAll('[data-region="session-row"]')).toHaveLength(1)
})

it('keeps a Seat with another checkout out of that project’s loose rows', () => {
  const seat = summary({ id: 'session-cross-checkout', cwd: '/other-checkout' })
  const board = room({ id: 'checkout-team', name: 'Checkout Team', members: [String(sessionKey(seat.runtime, seat.id))] })
  const view = treeWith([board], [seat], [seat as unknown as Session])
  expect(view.container.querySelector('[data-project-root="/other-checkout"] [data-region="session-row"]')).toBeNull()
  expect(rowTitles(view.container).filter(one => one === 'session-cross-checkout')).toHaveLength(1)
})

it('uses a quiet project header without a leading icon, including Other projects', () => {
  const view = treeWith([], [summary({ id: 'session-near' }), summary({ id: 'session-far', cwd: '/other' })], [], { othersOpen: true })
  const headers = view.container.querySelectorAll('[data-draggable]')
  expect(headers).toHaveLength(2)
  for (const header of headers) {
    expect(header.querySelector('[data-slot="sidebar-menu-icon"]')).toBeNull()
    const name = header.querySelector('[data-slot="text"]')!
    expect(name.getAttribute('data-role')).toBe('prose')
    expect(name.className).toContain('text-(--hd-secondary-foreground)')
    expect(name.nextElementSibling?.getAttribute('data-slot')).toBe('disclosure-chevron')
  }
  act(() => (headers[0] as HTMLButtonElement).click())
  expect(view.store.toggleCollapsed).toHaveBeenCalledWith('/repo')
})

it('indents Pinned conversations by the shared project child step', () => {
  const one = summary({ id: 'session-pin-indent' })
  const view = treeWith([], [one], [], { pinnedSessions: [sessionKey(one.runtime, one.id)] })
  expect(view.container.querySelector('[data-sidebar-band="pinned"] [data-slot="sidebar-group-content"]')?.getAttribute('data-sidebar-indent')).toBe('true')
})

it('uses a quiet spinner for running conversations and Teams without a Working word', () => {
  const one = summary({ id: 'session-spin', status: { type: 'active' } })
  const live = { ...one, turns: [{ id: 'spin-turn', status: 'inProgress', items: [] }] } as unknown as Session
  const board = room({ id: 'spin-team', name: 'Running Team', members: [String(sessionKey(one.runtime, one.id))] })
  const view = treeWith([board], [one], [live])
  expect(view.container.querySelectorAll('[data-slot="spinner"][data-tone="neutral"][data-size="sm"]')).toHaveLength(2)
  expect(view.container.textContent).not.toContain('Working')
  expect(roomRow(view.container, board.name).querySelector('[data-slot="sidebar-menu-state"]')).toBeNull()
  view.update({ approvals: [{ key: sessionKey(one.runtime, one.id), approval: {} }] as unknown as AppSnapshot['approvals'] })
  expect(roomRow(view.container, board.name).querySelector('[data-slot="sidebar-menu-state"]')?.getAttribute('aria-label')).toBe('Needs you')
  expect(view.container.querySelectorAll('[data-slot="spinner"]')).toHaveLength(0)
})

// After a restart the Seat can exist only in history, in another checkout.
it('keeps a history-only legacy Seat under its Team across checkouts', () => {
  const seat = summary({ id: 'session-stored-seat', cwd: '/other-checkout' })
  const board = room({ id: 'stored-team', name: 'Stored Team', members: [String(sessionKey(seat.runtime, seat.id))] })
  const view = treeWith([board], [seat], [], { pinnedSessions: [sessionKey(seat.runtime, seat.id)] })
  const nested = roomRow(view.container, board.name).closest('li')!.querySelector('[data-nested="true"]')!
  expect(nested).not.toBeNull()
  expect(rowTitles(nested as HTMLElement)).toEqual(['session-stored-seat'])
  expect(rowTitles(view.container)).toEqual(['session-stored-seat'])
  expect(view.container.querySelector('[data-sidebar-band="pinned"]')).toBeNull()
  expect(view.container.querySelector('[data-project-root="/other-checkout"] [data-region="session-row"]')).toBeNull()
  act(() => nested.querySelector<HTMLButtonElement>('[data-slot="sidebar-menu-button"]')!.click())
  expect(view.store.openSession).toHaveBeenCalledWith(seat.id, { runtime: seat.runtime })
})
