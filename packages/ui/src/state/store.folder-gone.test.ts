import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  runtimeId,
  sessionId,
  sessionKey,
  type HostMethodName,
  type Session,
} from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * A conversation whose folder is no longer on the machine.
 *
 * A known, stable state rather than something that happened: the folder will
 * still be gone at the next launch, and every conversation that ran in it is
 * in the same state. It used to arrive as an error toast per open — and
 * because a review room's three members all ran in one worktree, opening them
 * one after another produced three word-for-word identical toasts over three
 * perfectly readable transcripts, each waiting for its own × (#127).
 *
 * So: no toast, one fact keyed on the folder, and the surfaces read it. The
 * last test here is the one that matters most — an unrelated reopen failure
 * must still toast, or this fix is "swallow all errors" wearing a better name.
 */

const RUNTIME = runtimeId('cursor')
const ID = sessionId('s-1')
const KEY = sessionKey(RUNTIME, ID)
const GONE = '/w/worktrees/open-source-release-plan'

/** What the adapter says, and what the host now passes through undoubled. */
const SAID = `Agent cannot open this conversation: its folder no longer exists (${GONE}).`

const folderGone = (message = SAID): Error =>
  Object.assign(new Error(message), { code: 'sessionFolderGone' })

const session = (id: string, cwd = GONE): Session =>
  ({
    id: sessionId(id),
    runtime: RUNTIME,
    cwd,
    status: { type: 'idle' },
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    itemsLoaded: true,
  }) as Session

let store: AppStore
let answers: Partial<Record<HostMethodName, unknown>>
let refusals: Partial<Record<HostMethodName, Error>>

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  answers = {}
  refusals = {}
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    const refusal = refusals[method]
    if (refusal) throw refusal
    return answers[method] ?? null
  }) as never)
})

describe('opening a conversation whose folder is gone', () => {
  beforeEach(() => {
    answers['session/read'] = session('s-1')
    refusals['session/resume'] = folderGone()
  })

  it('says nothing in a toast, because nothing just happened', async () => {
    await store.openSession(ID, { runtime: RUNTIME })
    expect(store.getSnapshot().notices).toEqual([])
  })

  it('records the folder, with the refusal in the agent’s own words', async () => {
    await store.openSession(ID, { runtime: RUNTIME })
    expect(store.getSnapshot().foldersGone.get(GONE)).toBe(SAID)
  })

  it('keeps the transcript it already painted', async () => {
    await store.openSession(ID, { runtime: RUNTIME })
    expect(store.getSnapshot().sessions.get(KEY)).toBeDefined()
  })

  it('keeps it on a layout restore too, rather than emptying the pane', async () => {
    // The pane is the only place this transcript still exists — the host read
    // it from its own store because the agent could not. Emptying it on every
    // launch would throw away the copy and say nothing about why.
    await store.openSession(ID, { runtime: RUNTIME, restoring: true })
    expect(store.getSnapshot().sessions.get(KEY)).toBeDefined()
    expect(store.getSnapshot().foldersGone.get(GONE)).toBe(SAID)
  })

  it('is one fact for a room of members that shared the worktree', async () => {
    // The measured case: three Cursor conversations, one deleted worktree,
    // opened one after another. Three toasts before; one entry and none now.
    for (const id of ['s-1', 's-2', 's-3']) {
      answers['session/read'] = session(id)
      await store.openSession(sessionId(id), { runtime: RUNTIME })
    }
    expect(store.getSnapshot().foldersGone.size).toBe(1)
    expect(store.getSnapshot().notices).toEqual([])
  })

  it('forgets the folder once a conversation in it reopens', async () => {
    await store.openSession(ID, { runtime: RUNTIME })
    expect(store.getSnapshot().foldersGone.has(GONE)).toBe(true)

    // A conversation that opened is the only evidence the folder is back.
    delete refusals['session/resume']
    answers['session/resume'] = session('s-1')
    await store.openSession(ID, { runtime: RUNTIME })
    expect(store.getSnapshot().foldersGone.has(GONE)).toBe(false)
  })
})

describe('every other reason a conversation will not reopen', () => {
  it('still says so, because that one is news', async () => {
    // The control on the change above. A reopen that failed for any other
    // reason is an occurrence, it may pass on a retry, and there is no state
    // on screen that explains it — so it keeps its toast.
    answers['session/read'] = session('s-1', '/w')
    refusals['session/resume'] = new Error('Cursor could not reopen this conversation: Session not found')

    await store.openSession(ID, { runtime: RUNTIME })

    expect(store.getSnapshot().notices.at(-1)?.message).toContain('Session not found')
    expect(store.getSnapshot().foldersGone.size).toBe(0)
  })

  it('is not silenced by a folder that went missing for some other conversation', async () => {
    answers['session/read'] = session('s-1')
    refusals['session/resume'] = folderGone()
    await store.openSession(ID, { runtime: RUNTIME })
    expect(store.getSnapshot().notices).toEqual([])

    // A different conversation, a folder that is fine, an unrelated failure.
    answers['session/read'] = session('s-9', '/w/live')
    refusals['session/resume'] = new Error('Cursor is not running.')
    await store.openSession(sessionId('s-9'), { runtime: RUNTIME })

    expect(store.getSnapshot().notices.at(-1)?.message).toContain('not running')
  })
})
