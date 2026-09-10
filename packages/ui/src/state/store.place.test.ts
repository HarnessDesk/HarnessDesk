import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  runtimeId,
  sessionId,
  sessionKey,
  type HostMethodName,
  type Session,
  type WorkspaceEntry,
} from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * Where a draft starts, and the way back from a worktree.
 *
 * The property that matters most is the one nobody would notice breaking:
 * choosing a worktree makes nothing. The host cuts it when the first message
 * goes, so a draft pointed at one and then abandoned leaves no branch and no
 * folder behind — and a choice made for one repository never follows the
 * window into another.
 */

const AGENT = runtimeId('codex')
const REPO: WorkspaceEntry = { path: '/repo', name: 'repo', lastOpenedAt: 1, git: { branch: 'main' } }
const OTHER: WorkspaceEntry = { path: '/other', name: 'other', lastOpenedAt: 2, git: { branch: 'main' } }
const TREE = '/state/worktrees/repo-1a2b/parser-fix'

const conversation = (id: string, cwd: string): Session =>
  ({
    id: sessionId(id),
    runtime: AGENT,
    cwd,
    status: { type: 'idle' },
    createdAt: 0,
    updatedAt: 0,
    itemsLoaded: true,
    turns: [],
  }) as unknown as Session

type Answer = unknown | ((params: never) => unknown)

let store: AppStore
let answers: Partial<Record<HostMethodName, Answer>>
let refused: Partial<Record<HostMethodName, string>>

const calls = (method: HostMethodName): unknown[] =>
  vi
    .mocked(store.transport.request)
    .mock.calls.filter(([name]) => name === method)
    .map(([, params]) => params)

beforeEach(async () => {
  store = new AppStore('ws://localhost:0/')
  answers = {
    'workspace/open': (params: { path: string }) => (params.path === OTHER.path ? OTHER : REPO),
    'workspace/recent': [REPO, OTHER],
    'worktree/list': [],
  }
  refused = {}
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: never) => {
    if (refused[method]) throw new Error(refused[method])
    const answer = answers[method]
    return typeof answer === 'function' ? (answer as (params: never) => unknown)(params) : (answer ?? null)
  }) as never)
  await store.selectRuntime(AGENT)
  await store.openWorkspace(REPO.path)
})

describe('where a draft starts', () => {
  it('cuts the worktree when the first message goes, and starts the conversation in it', async () => {
    answers['worktree/create'] = { path: TREE, branch: 'harnessdesk/parser-fix', head: 'abc', isMain: false, managed: true }
    answers['session/create'] = conversation('s-2', TREE)

    expect(await store.armWorktree(REPO.path, 'parser fix', 'main')).toBe(true)
    expect(store.getSnapshot().draftPlace).toEqual({ kind: 'worktree', root: REPO.path, name: 'parser fix', base: 'main' })
    expect(calls('worktree/create')).toHaveLength(0)

    await store.send([{ type: 'text', text: 'Fix the parser' }])

    expect(calls('worktree/create')).toEqual([{ root: REPO.path, name: 'parser fix', base: 'main' }])
    expect(calls('session/create')[0]).toMatchObject({ runtime: AGENT, options: { cwd: TREE } })
    // The session holds the fact now, and the header says it.
    expect(store.getSnapshot().draftPlace).toBeNull()
  })

  it('leaves nothing behind when the draft is abandoned', async () => {
    await store.armWorktree(REPO.path, 'parser fix')
    store.newDraft()
    expect(store.getSnapshot().draftPlace).toBeNull()

    answers['session/create'] = conversation('s-2', REPO.path)
    await store.send([{ type: 'text', text: 'Something else entirely' }])

    expect(calls('worktree/create')).toHaveLength(0)
    expect(calls('session/create')[0]).toMatchObject({ options: { cwd: REPO.path } })
  })

  it('starts in a worktree that already exists without making another', async () => {
    answers['session/create'] = conversation('s-2', TREE)
    store.startDraftIn({ kind: 'existing', path: TREE, branch: 'harnessdesk/parser-fix' })

    await store.send([{ type: 'text', text: 'Carry on' }])

    expect(calls('worktree/create')).toHaveLength(0)
    expect(calls('session/create')[0]).toMatchObject({ options: { cwd: TREE } })
  })

  it('points the draft in front rather than replacing it', () => {
    // Choosing a place is a decision about the message already being typed;
    // a fresh pane would put the choice on an empty one.
    store.newDraft()
    const before = store.getSnapshot().layout

    store.startDraftIn({ kind: 'existing', path: TREE, branch: null })

    expect(store.getSnapshot().layout).toBe(before)
    expect(store.getSnapshot().draftPlace?.kind).toBe('existing')
  })

  it('forgets a worktree armed for a repository the window has left', async () => {
    await store.armWorktree(REPO.path, 'parser fix')

    await store.openWorkspace(OTHER.path)

    expect(store.getSnapshot().draftPlace).toBeNull()
  })

  it('switches to the project a worktree is armed for, first', async () => {
    expect(await store.armWorktree(OTHER.path, 'spike')).toBe(true)

    expect(store.getSnapshot().workspace?.path).toBe(OTHER.path)
    expect(store.getSnapshot().draftPlace).toMatchObject({ kind: 'worktree', root: OTHER.path, name: 'spike' })
  })

  it('arms nothing when the project could not be opened', async () => {
    refused['workspace/open'] = 'no such folder'

    expect(await store.armWorktree('/gone', 'spike')).toBe(false)

    expect(store.getSnapshot().draftPlace).toBeNull()
  })
})

describe('bringing a worktree back', () => {
  const openIn = async (cwd: string): Promise<void> => {
    answers['session/read'] = conversation('s-1', cwd)
    answers['session/resume'] = conversation('s-1', cwd)
    await store.openSession(sessionId('s-1'), { runtime: AGENT })
  }

  it('hands the conversation to a draft in the main checkout, and says what moved', async () => {
    await openIn(TREE)
    answers['worktree/bringHome'] = { branch: 'harnessdesk/parser-fix', from: 'main', root: REPO.path }

    expect(await store.bringWorktreeHome(TREE)).toBeNull()

    const snapshot = store.getSnapshot()
    // Its folder is gone, so it cannot go on where it was: the same agent
    // picks it up in the folder the work now lives in.
    expect(snapshot.activeSessionKey).toBeNull()
    expect(snapshot.draftHandoff).toMatchObject({ runtime: AGENT, sessionId: 's-1', cwd: REPO.path })
    expect(snapshot.notices.at(-1)?.message).toBe(
      'repo switched from main to harnessdesk/parser-fix. The worktree folder is gone; the branch keeps every commit.',
    )
  })

  it("returns git's refusal to the dialog that asked, and moves nothing", async () => {
    await openIn(TREE)
    refused['worktree/bringHome'] = 'repo could not switch to harnessdesk/parser-fix, so the worktree was left where it was.'

    const problem = await store.bringWorktreeHome(TREE)

    expect(problem).toContain('could not switch to harnessdesk/parser-fix')
    expect(store.getSnapshot().activeSessionKey).toBe(sessionKey(AGENT, sessionId('s-1')))
    expect(store.getSnapshot().draftHandoff).toBeNull()
  })
})
