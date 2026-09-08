import { beforeEach, expect, it, vi } from 'vitest'

import {
  runtimeId,
  sessionId,
  sessionKey,
  type HostMethodName,
  type Session,
} from '@harnessdesk/protocol'

import { AppStore } from './store'
import { panes } from './layout'
import { dockViews } from './workbench'
/* The real registry, so `defaultArea` answers the way it does in the app. */
import '../panels/builtins'

/**
 * Which room "the room" means, when nobody said.
 *
 * It used to be a folder question, and the answer was wrong in a way nothing
 * could see: `openTeamRoom()` preferred the active conversation's `cwd`, so
 * from a worktree the command palette opened an empty board keyed by the
 * worktree while every claim, post and referee verb went to the project's.
 *
 * A project holds as many rooms as the work wants now, so a folder cannot name
 * one at all and the guessing is gone. What is left is a room already on
 * screen, then the room the conversation you are reading belongs to, and then
 * nothing — because inventing a room to satisfy a menu item would open a board
 * nobody made.
 *
 * Git is the opposite case and stays a folder question: a worktree is a real
 * checkout with a history of its own, so `openGitHistory()` prefers it.
 */

const RUNTIME = runtimeId('codex')
const ID = sessionId('01a04ec8-90f2-70b0')
const KEY = sessionKey(RUNTIME, ID)

const PROJECT = '/repo'
const WORKTREE = '/repo/.harnessdesk/worktrees/feature'

const session = (): Session =>
  ({
    id: ID,
    runtime: RUNTIME,
    cwd: WORKTREE,
    status: { type: 'idle' },
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    itemsLoaded: true,
  }) as Session

let store: AppStore
let workspace: { path: string; name: string; lastOpenedAt: number } | null
let created: unknown = null

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  workspace = { path: PROJECT, name: 'repo', lastOpenedAt: 1 }
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'workspace/open') return workspace
    if (method === 'session/read') return session()
    if (method === 'workspace/recent') return []
    if (method === 'team/room/create') return created
    return null
  }) as never)
})

/**
 * A conversation living in a worktree, with the project open beside it —
 * built through the store's own doors, so the state under test is the state
 * the app actually reaches.
 */
const inAWorktree = async (): Promise<void> => {
  if (workspace) await store.openWorkspace(PROJECT)
  await store.openSession(ID, { runtime: RUNTIME })
  expect(store.getSnapshot().sessions.get(KEY)?.cwd).toBe(WORKTREE)
}

const ROOM = 'room-1'

const roomsOf = (kind: string): string[] =>
  panes(store.getSnapshot().layout.root)
    .filter((pane) => pane.view.kind === kind)
    .map((pane) => (pane.view as { room: string }).room)

/**
 * The same question asked of a docked panel.
 *
 * The board is not a pane: it declares the edges, and `openTeamBoard` sends it
 * to the one its definition names. It used to open in the middle, which the
 * middle refuses on the way back in — so a board opened as a pane was a board
 * that had gone by the next launch.
 */
const dockedRooms = (kind: string): string[] =>
  (['sidebar', 'right', 'bottom'] as const)
    .flatMap((area) => dockViews(store.getSnapshot().workbench[area]))
    .filter((mounted) => mounted.view.kind === kind)
    .map((mounted) => (mounted.view as { room: string }).room)

/** The host's answer to `team/room/create`, for the mock below. */
const roomState = (members: readonly string[] = []) => ({
  id: ROOM,
  name: 'Checkout rewrite',
  root: PROJECT,
  members,
  messaging: true,
  intents: [],
  channel: [],
})

/**
 * A room the store knows about but is not showing.
 *
 * Made through the store's own door and then navigated away from, so what is
 * under test is a room the app has actually created rather than a snapshot
 * arranged by hand.
 */
const knownRoom = async (members: readonly string[] = []): Promise<void> => {
  created = roomState(members)
  await store.createRoom(PROJECT, 'Checkout rewrite')
  await store.openSession(ID, { runtime: RUNTIME })
}

it('with nothing open and nothing to belong to, there is no room to mean', async () => {
  /* And nothing happens, rather than a board keyed by the folder appearing.
     That surface was never created, never listed, and gone by the next
     launch — a menu item that manufactured one was the whole defect. */
  await inAWorktree()
  store.openTeamRoom()
  expect(roomsOf('room')).toEqual([])
})

it('means the room the conversation you are reading is in', async () => {
  await inAWorktree()
  await knownRoom([KEY])
  expect(roomsOf('room')).toEqual([])

  store.openTeamRoom()
  expect(roomsOf('room')).toEqual([ROOM])
})

it('the board does the same, on the edge it declares', async () => {
  await inAWorktree()
  await knownRoom([KEY])
  store.openTeamBoard()
  expect(dockedRooms('board')).toEqual([ROOM])
  // And not in the middle, which holds a conversation or a room and nothing
  // else — a board put there is dropped when the layout is read back.
  expect(roomsOf('board')).toEqual([])
})

it('a board already on screen is the room a bare "show me" means', async () => {
  /*
   * The board moved to a dock in this same change, and `#roomToShow` was
   * reading `panes(layout.root)` only — so the one surface that names a room
   * became invisible to the question "which room do you mean". A person with
   * that board open, in a conversation that belongs to no room, asked for the
   * room and got silence with the answer on screen beside them.
   *
   * `#closeViewsOf` two methods away already reads both places. This is the
   * same read, and the membership fallback below it is unchanged.
   */
  await inAWorktree()
  await knownRoom([])           // a room this conversation is NOT a member of
  store.openTeamBoard(ROOM)     // opened explicitly, so it docks
  expect(dockedRooms('board')).toEqual([ROOM])

  store.openTeamRoom()          // and now asked with no argument
  expect(roomsOf('room')).toEqual([ROOM])
})

it('a room the conversation is not in is not the room it means', async () => {
  // Membership is the whole rule. A room in the same project that this
  // conversation never joined is somebody else's board.
  await inAWorktree()
  await knownRoom([])
  store.openTeamRoom()
  expect(roomsOf('room')).toEqual([])
})

it('an explicit room still wins over both', async () => {
  await inAWorktree()
  await knownRoom([KEY])
  store.openTeamRoom('room-2')
  expect(roomsOf('room')).toEqual(['room-2'])
})

it('creating a room shows it', async () => {
  await inAWorktree()
  created = roomState([])
  await store.createRoom(PROJECT, 'Checkout rewrite')
  expect(roomsOf('room')).toEqual([ROOM])
})

it('a deleted room leaves the snapshot, and takes its pane with it', async () => {
  /* `team/changed` can only ever say what a room *is*, so without a word of
     its own a deleted room stayed in the sidebar until the next launch —
     present, openable, and backed by nothing. A pane still pointed at it would
     draw the empty board rather than say why. */
  await inAWorktree()
  created = roomState([])
  await store.createRoom(PROJECT, 'Checkout rewrite')
  expect(roomsOf('room')).toEqual([ROOM])

  // As the host pushes it. Nothing is connected; nothing reaches a wire.
  ;(
    store.transport as unknown as {
      handlers: { onNotification(notification: unknown): void }
    }
  ).handlers.onNotification({ method: 'team/removed', params: { room: ROOM } })

  expect(store.getSnapshot().teams.has(ROOM)).toBe(false)
  expect(roomsOf('room')).toEqual([])
  expect(panes(store.getSnapshot().layout.root)).toHaveLength(1)
})

/**
 * The middle holds one thing, through the store's own doors.
 *
 * Reported from the running app: opening the Room drew it beside the
 * conversation, so the middle held both. `layout.test.ts` pins the primitive;
 * this pins the *journey*, because the defect was never in the primitive — it
 * was that `openTeamRoom` reached the middle through a path that split.
 */
it('opening the Room replaces the conversation, and opening a session replaces the Room', async () => {
  await inAWorktree()

  store.openTeamRoom(ROOM)
  const roomOnly = panes(store.getSnapshot().layout.root)
  expect(roomOnly).toHaveLength(1)
  expect(roomOnly[0]?.view).toEqual({ kind: 'room', room: ROOM })

  // Back to a conversation: a jump, not an accumulation.
  await store.openSession(ID, { runtime: RUNTIME })
  const chatOnly = panes(store.getSnapshot().layout.root)
  expect(chatOnly).toHaveLength(1)
  expect(chatOnly[0]?.view.kind).toBe('conversation')

  // And back again, any number of times.
  store.openTeamRoom(ROOM)
  await store.openSession(ID, { runtime: RUNTIME })
  store.openTeamRoom(ROOM)
  expect(panes(store.getSnapshot().layout.root)).toHaveLength(1)
  expect(store.getSnapshot().layout.expanded).toBeNull()
})

/**
 * Back reaches a room, not only a conversation.
 *
 * The history held session keys, which was right while a room lived *beside*
 * the conversation — you never navigated away from one, so there was nothing to
 * return to. Making main a slot changed that, and this test exists because I
 * shipped the slot without changing the history: opening a session replaced the
 * room, and the only way back was to find it in the tree again.
 */
it('steps back to the room it replaced, and forward again', async () => {
  await inAWorktree()

  store.openTeamRoom(ROOM)
  expect(roomsOf('room')).toEqual([ROOM])

  await store.openSession(ID, { runtime: RUNTIME })
  expect(roomsOf('room')).toEqual([])
  expect(store.getSnapshot().navCanBack).toBe(true)

  await store.navigateBack()
  expect(roomsOf('room')).toEqual([ROOM])

  await store.navigateForward()
  expect(roomsOf('room')).toEqual([])
  expect(panes(store.getSnapshot().layout.root)[0]?.view.kind).toBe('conversation')
})

/**
 * And back to the room as it *was*, not merely a room with the same root.
 *
 * A room view carries the members it has up as columns. Back rebuilt one from
 * `target.root` alone, so an arrangement of two transcripts came back as an
 * empty room — the same lost place Back exists to prevent, one level down.
 */
it('brings the room back still watching what it was watching', async () => {
  await inAWorktree()

  store.openTeamRoom(ROOM)
  const pane = panes(store.getSnapshot().layout.root)[0]
  if (!pane) throw new Error('the room did not open')
  const watching = [sessionKey(RUNTIME, sessionId('m-1'))]
  store.setRoomWatching(pane.id, watching)

  await store.openSession(ID, { runtime: RUNTIME })
  await store.navigateBack()

  const back = panes(store.getSnapshot().layout.root)[0]?.view
  expect(back?.kind).toBe('room')
  expect(back?.kind === 'room' ? back.watching : null).toEqual(watching)
})

