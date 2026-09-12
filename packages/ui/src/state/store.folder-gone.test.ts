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

/**
 * The colder case: a conversation this desk has never opened, whose folder has
 * also gone. The host has no stored transcript to fall back on, so the read
 * fails with the reopen and nothing is painted — there is no pane to carry the
 * state and no transcript to call read-only.
 *
 * The news has nowhere else to go, so it is still said. Once for the folder,
 * though, not once per conversation: one deleted worktree with three members
 * in it is one piece of news, which is the whole of the original complaint.
 */
describe('when the transcript could not be read either', () => {
  beforeEach(() => {
    refusals['session/resume'] = folderGone()
  })

  it('says it once for the folder, however many conversations it took', async () => {
    /* The sidebar row is where the folder is written down when nothing was
       painted — so the list is loaded the way the app loads it, and only then
       do the reads start failing. */
    answers['session/list'] = {
      data: ['s-1', 's-2', 's-3'].map((id) => ({
        id: sessionId(id),
        runtime: RUNTIME,
        cwd: GONE,
        status: { type: 'idle' },
        createdAt: 0,
        updatedAt: 0,
      })),
      cursor: null,
    }
    await store.selectRuntime(RUNTIME)
    await store.loadHistory({ reset: true })
    expect(store.getSnapshot().history).toHaveLength(3)

    refusals['session/read'] = folderGone()
    for (const id of ['s-1', 's-2', 's-3']) {
      await store.openSession(sessionId(id), { runtime: RUNTIME })
    }

    expect(store.getSnapshot().notices).toHaveLength(1)
    expect(store.getSnapshot().notices[0]?.message).toContain('folder no longer exists')
    // And every row that folder took is marked, from the one refusal.
    expect(store.getSnapshot().foldersGone.get(GONE)).toBe(SAID)
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

/**
 * The way out, and whether it actually leads anywhere.
 *
 * "Open a copy in another folder" promises the word *another*. It carried the
 * source conversation's folder onto the draft — correct for an ordinary
 * hand-off, where the packet names the folder as ground truth, and exactly
 * wrong here, because that folder is the one the app has just proved is gone.
 * Sending hit the same wall the banner exists to escape.
 */
describe('opening a copy of a conversation whose folder is gone', () => {
  const HOME = '/w/main'

  const openGone = async (workspace = HOME): Promise<void> => {
    answers['session/read'] = session('s-1')
    refusals['session/resume'] = folderGone()
    answers['workspace/recent'] = [{ path: workspace, name: 'main', lastOpenedAt: 1 }]
    answers['worktree/list'] = []
    await store.loadWorkspaces()
    await store.openSession(ID, { runtime: RUNTIME })
  }

  const created = (): unknown[] =>
    vi
      .mocked(store.transport.request)
      .mock.calls.filter(([method]) => method === 'session/create')
      .map(([, params]) => params)

  it('carries the conversation without carrying the folder it died in', async () => {
    await openGone()
    await store.openCopyElsewhere()

    const handoff = store.getSnapshot().draftHandoff
    expect(handoff).toMatchObject({ runtime: RUNTIME, sessionId: ID, carry: 'summary' })
    // Everything except the folder: the packet is the point, the folder is
    // the thing that is gone.
    expect(handoff?.cwd).toBeNull()
  })

  it('starts the copy in the open folder, which is what Work in already says', async () => {
    await openGone()
    await store.openCopyElsewhere()

    answers['session/create'] = session('s-2', HOME)
    await store.send([{ type: 'text', text: 'Pick this up here.' }])

    expect(created()).toHaveLength(1)
    expect(created()[0]).toMatchObject({ runtime: RUNTIME, options: { cwd: HOME } })
  })

  it('never sends the copy back into the folder that is gone', async () => {
    await openGone()
    await store.openCopyElsewhere()

    answers['session/create'] = session('s-2', HOME)
    await store.send([{ type: 'text', text: 'Pick this up here.' }])

    /* The whole point of the button, stated as the thing that must not
       happen — asserted on a session that was actually created, because a
       run that creates nothing would satisfy the negative for the wrong
       reason. */
    expect(created()).toHaveLength(1)
    expect(created()[0]).not.toMatchObject({ options: { cwd: GONE } })
  })

  it('refuses rather than starting in the open folder when that is the gone one', async () => {
    // The folder deleted was the project the window has open, so "the open
    // folder" is the same wall. Nothing is created; the person is asked for a
    // folder instead, which is the one thing that can actually help.
    await openGone(GONE)
    await store.openCopyElsewhere()

    await store.send([{ type: 'text', text: 'Pick this up here.' }])

    expect(created()).toHaveLength(0)
    expect(store.getSnapshot().notices.at(-1)?.message).toContain('Choose a project folder')
  })

  it('refuses a draft pointed at the gone folder by a place of its own', async () => {
    /* The other way a folder reaches `newSession`. The refusal above reads
       the *open* folder; the composer's Work in control can point a draft at
       a checkout by path instead — a worktree, or the main checkout (#255) —
       and that path arrives as an explicit `cwd`, past the open folder
       entirely. The open folder here is fine; only the chosen place is gone. */
    await openGone()
    await store.selectRuntime(RUNTIME)
    store.newDraft()
    store.startDraftIn({ kind: 'existing', path: GONE, branch: null })
    /* The shape under test, checked rather than assumed: a draft in front
       with that place on it. Without both, `send` never reaches
       `newSession` and the assertion below would hold for the wrong
       reason. And `session/create` is answered, so a run that got that far
       would succeed — the negative has something to catch. */
    expect(store.getSnapshot().activeRuntime).toBe(RUNTIME)
    expect(store.getSnapshot().activeSessionKey).toBeNull()
    expect(store.getSnapshot().draftPlace).toMatchObject({ kind: 'existing', path: GONE })
    answers['session/create'] = session('s-2', HOME)

    await store.send([{ type: 'text', text: 'Carry on over there.' }])

    expect(created()).toHaveLength(0)
    expect(store.getSnapshot().notices.at(-1)?.message).toContain('Choose a project folder')
  })
})
