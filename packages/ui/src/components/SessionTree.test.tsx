import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  runtimeId,
  sessionId,
  sessionKey,
  type RuntimeInfo,
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
    capabilities: { deleteHistory: true },
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

it('a conversation with work still running in the background wears a green glyph, and says so on hover', () => {
  // The turn is over and the row would read idle, but the agent sent
  // something to the background and walked away. A person browsing other
  // conversations gets a dot on this one, and the hover line names the door.
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
  const glyph = (title: string): HTMLElement | null => row(title).querySelector('[class*="statusGlyph"]')
  expect(glyph('Busy one')?.hasAttribute('data-tasks')).toBe(true)
  expect(row('Busy one').title).toContain('running in the background')
  // Finished work is not a reason to look: only running work earns the dot.
  expect(glyph('Quiet one')?.hasAttribute('data-tasks')).toBe(false)
  expect(row('Quiet one').title).not.toContain('background')
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
  members?: string[]
  root?: string
  intents?: { state: string }[]
}) =>
  ({
    id: over.id,
    name: over.name,
    root: over.root ?? '/repo',
    members: over.members ?? [],
    messaging: true,
    intents: over.intents ?? [],
    channel: [],
  }) as unknown as TeamState

const treeWith = (
  rooms: readonly TeamState[],
  sessions: readonly SessionSummary[] = [],
  /** Live conversations the history has not caught up with yet. */
  live: readonly SessionSummary[] = [],
  prefs: Partial<AppSnapshot['listPrefs']> = {},
  /** The folder the desk has open, when it is not the plain repository root. */
  open: { path: string; name: string; lastOpenedAt: number; repo?: unknown } = {
    path: '/repo',
    name: 'repo',
    lastOpenedAt: 1,
  },
): { container: HTMLElement; store: AppStore } => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    workspace: open,
    workspaces: [open],
    history: sessions,
    sessions: new Map(live.map((one) => [sessionKey(one.runtime, one.id), one])),
    listPrefs: { ...emptySnapshot().listPrefs, ...prefs },
    teams: new Map(rooms.map((one) => [one.id, one])),
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    toggleCollapsed: vi.fn(),
    openTeamRoom: vi.fn(),
    openSession: vi.fn(),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={3} />
      </StoreProvider>,
    )
  })
  return { container, store }
}

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

it('a room is a row under its project, and its members hang off it', () => {
  const { container: tree } = treeWith(
    [room({ id: 'r1', name: 'Checkout rewrite', members: [sessionKey('codex', sessionId('session-1'))] })],
    [summary({ id: 'session-1' }), summary({ id: 'session-2' })],
  )

  const row = roomRow(tree, 'Checkout rewrite')
  expect(row.textContent).toContain('Checkout rewrite')
  // The member is inside the room's own block; the loose one is not.
  const nested = row.parentElement?.querySelector('[class*="nested"]')
  expect(nested?.textContent).toContain('session-1')
  expect(nested?.textContent).not.toContain('session-2')
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
  const twisty = roomRow(tree, 'Checkout rewrite').querySelector('button')
  act(() => (twisty as HTMLButtonElement).click())

  expect(store.toggleCollapsed).toHaveBeenCalledWith('r1')
  expect(store.openTeamRoom).not.toHaveBeenCalled()
})

it('the twisty answers the keyboard too, and the row does not answer for it', () => {
  /* The chevron is a nested button, so its Enter or Space keydown bubbles to
     the row — focusing it and pressing either opened the room, and Space's
     `preventDefault` on the row also swallowed the click that would have
     toggled. The earlier test only sent `.click()` and missed all of it. */
  const { container: tree, store } = treeWith(
    [room({ id: 'r1', name: 'Checkout rewrite', members: [sessionKey('codex', sessionId('session-1'))] })],
    [summary({ id: 'session-1' })],
  )
  const twisty = roomRow(tree, 'Checkout rewrite').querySelector('button') as HTMLButtonElement

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
  expect(row.parentElement?.textContent).not.toContain('No agents in here yet')
  // The filter still decides *which* members: Codex's is kept, Claude's is not.
  expect(rowTitles(row.parentElement as HTMLElement)).toEqual(['session-1'])
  const count = [...tree.querySelectorAll('[class*="groupCount"]')].find(
    (one) => one.closest('[class*="roomRow"]') !== null,
  )
  expect(count?.textContent).toBe('1')
  expect(count?.getAttribute('title')).toBe(
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

it('says a room is empty rather than looking broken', () => {
  const { container: tree } = treeWith([room({ id: 'r1', name: 'Checkout rewrite' })])
  expect(roomRow(tree, 'Checkout rewrite').parentElement?.textContent).toContain(
    'No agents in here yet',
  )
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
  const block = roomRow(tree, 'Checkout rewrite').parentElement
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
  const block = roomRow(tree, 'Checkout rewrite').parentElement
  expect(block?.textContent).toContain('No agents in here yet')
  expect(block?.textContent).not.toContain('Filtered away')
})

it('a room row offers rename and delete, and the row itself still opens', () => {
  /* Both were wire verbs with no door: a name typed in a hurry was permanent
     and an abandoned room stayed in the tree for good. The ⋯ is the same one a
     conversation row has, in the same place, so the two rows do not teach
     different habits — and pressing it must not also open the room. */
  const { container: tree, store } = treeWith([room({ id: 'r1', name: 'Checkout rewrite' })])
  const more = tree.querySelector<HTMLButtonElement>('[aria-label="Actions for Checkout rewrite"]')
  if (!more) throw new Error('the room row has no menu')
  act(() => more.click())
  expect(store.openTeamRoom).not.toHaveBeenCalled()

  const items = [...document.querySelectorAll('[role="menuitem"]')].map((one) => one.textContent)
  expect(items.some((text) => text?.startsWith('Rename'))).toBe(true)
  expect(items.some((text) => text?.startsWith('Delete room'))).toBe(true)
})

it('the delete dialog keeps reading the live room, not a photograph of it', () => {
  /* The dialog was handed a captured `TeamState`. Later pushes replaced the
     room in the snapshot and never touched what it was reading, so a Delete
     opened on an empty room went on saying "there is nothing on its board"
     while a job was added — and pressing it would have taken that job with no
     warning. */
  const empty = room({ id: 'r1', name: 'Checkout rewrite' })
  const { container: tree, store } = treeWith([empty])
  const snapshot = store.getSnapshot()

  const more = tree.querySelector<HTMLButtonElement>('[aria-label="Actions for Checkout rewrite"]')!
  act(() => more.click())
  const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((one) =>
    one.textContent?.startsWith('Delete room'),
  )!
  act(() => remove.click())
  expect(document.body.textContent).toContain('nothing on its board')

  // The host says a job was added while the dialog is open.
  ;(snapshot as { teams: unknown }).teams = new Map([
    ['r1', { ...empty, intents: [{ id: 1, title: 'Round the refund' }] }],
  ])
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={3} />
      </StoreProvider>,
    )
  })

  expect(document.body.textContent).not.toContain('nothing on its board')
  expect(document.body.textContent).toContain('1 job')
})

it('the delete dialog closes itself if the room goes', () => {
  // Deleted from another window: a dialog about a room that no longer exists
  // has nothing true left to say, and its button would act on nothing.
  const { container: tree, store } = treeWith([room({ id: 'r1', name: 'Checkout rewrite' })])
  const snapshot = store.getSnapshot()
  const more = tree.querySelector<HTMLButtonElement>('[aria-label="Actions for Checkout rewrite"]')!
  act(() => more.click())
  act(() =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((one) => one.textContent?.startsWith('Delete room'))!
      .click(),
  )
  expect(document.body.textContent).toContain('Delete “Checkout rewrite”?')

  ;(snapshot as { teams: unknown }).teams = new Map()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={3} />
      </StoreProvider>,
    )
  })
  expect(document.body.textContent).not.toContain('Delete “Checkout rewrite”?')
})

it('a room says what each of its numbers counts', () => {
  /* The row carries a state and a size. Drawn as two bare counts it read
     "1 0" — the same grey, the same size, a gap apart, and the member count
     with nothing on it at all to say what it was. Whatever the row shows, a
     reader must be able to find out what it means without leaving the row. */
  const { container: tree } = treeWith([
    room({ id: 'r1', name: 'Checkout rewrite', intents: [{ state: 'claimed' }, { state: 'open' }] }),
  ])
  const counts = [...tree.querySelectorAll('[class*="roomClaimed"], [class*="groupCount"]')].filter(
    (el) => el.closest('[class*="roomRow"]') !== null,
  )
  expect(counts.length).toBeGreaterThan(0)
  for (const count of counts) expect(count.getAttribute('title')).toBeTruthy()

  // And the state is not another plain number beside the size: it is drawn
  // with the glyph the board gives that column.
  const claimed = tree.querySelector('[class*="roomClaimed"]')
  expect(claimed?.textContent).toBe('1')
  expect(claimed?.querySelector('svg')).not.toBeNull()
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
  const plainCount = [...plain.container.querySelectorAll('[class*="groupCount"]')]
    .find((el) => el.closest('[class*="roomRow"]') !== null)
  expect(plainCount?.textContent).toBe('2')
  expect(plainCount?.getAttribute('title')).toBe('2 conversations in this room')

  const filtered = treeWith([both], [codex], [], { agent: runtimeId('codex') })
  const filteredCount = [...filtered.container.querySelectorAll('[class*="groupCount"]')]
    .find((el) => el.closest('[class*="roomRow"]') !== null)
  expect(filteredCount?.textContent).toBe('1')
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
