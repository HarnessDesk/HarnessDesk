import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  runtimeId,
  sessionId,
  sessionKey,
  type HostMethodName,
  type Session,
  type WorkspaceEntry,
} from '@harnessdesk/protocol'

import { panes, sessionOf } from './layout'
import { mountedViews } from './workbench'
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
const TREE_WORKSPACE: WorkspaceEntry = { path: TREE, name: 'parser-fix', lastOpenedAt: 3, git: { branch: 'harnessdesk/parser-fix' } }
const LISTED = {
  main: { path: REPO.path, branch: 'main', head: 'a', isMain: true, managed: false },
  tree: { path: TREE, branch: 'harnessdesk/parser-fix', head: 'abc', isMain: false, managed: true },
}
const GONE = `repo could not switch to harnessdesk/parser-fix, and the worktree could not be put back at ${TREE}, so that folder is gone; the branch keeps every commit.`

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

  it('keeps a new worktree armed when the host could not make it, so the send can be tried again', async () => {
    refused['worktree/create'] = "fatal: a branch named 'harnessdesk/parser-fix' already exists"
    await store.armWorktree(REPO.path, 'parser fix')

    await store.send([{ type: 'text', text: 'Fix the parser' }])

    expect(calls('session/create')).toHaveLength(0)
    expect(store.getSnapshot().draftPlace).toMatchObject({ kind: 'worktree', root: REPO.path, name: 'parser fix' })
    expect(store.getSnapshot().notices.some((notice) => notice.message.includes('already exists'))).toBe(true)
  })

  it('starts a retry in the worktree the first send made, when the agent could not start there', async () => {
    // The worktree exists once `worktree/create` answers; an agent that then
    // fails to start must not leave the retry to cut a second one beside it.
    answers['worktree/create'] = { path: TREE, branch: 'harnessdesk/parser-fix', head: 'abc', isMain: false, managed: true }
    refused['session/create'] = 'the agent could not start'
    await store.armWorktree(REPO.path, 'parser fix')

    await store.send([{ type: 'text', text: 'Fix the parser' }])
    expect(calls('worktree/create')).toHaveLength(1)

    delete refused['session/create']
    answers['session/create'] = conversation('s-2', TREE)
    await store.send([{ type: 'text', text: 'Fix the parser' }])

    expect(calls('worktree/create')).toHaveLength(1)
    expect(calls('session/create').at(-1)).toMatchObject({ options: { cwd: TREE } })
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

  it('reads the worktree list again after a refusal, so a folder git could not put back is not offered', async () => {
    await openIn(TREE)
    answers['worktree/list'] = [{ path: TREE, branch: 'harnessdesk/parser-fix', head: 'abc', isMain: false, managed: true }]
    await store.loadWorktrees()
    expect(store.getSnapshot().worktrees.map((entry) => entry.path)).toContain(TREE)
    // Git refused the switch and would not re-add the worktree either, so the
    // host no longer lists it.
    answers['worktree/list'] = []
    refused['worktree/bringHome'] =
      `repo could not switch to harnessdesk/parser-fix, and the worktree could not be put back at ${TREE}, so that folder is gone; the branch keeps every commit.`

    expect(await store.bringWorktreeHome(TREE)).toContain('could not be put back')
    expect(store.getSnapshot().worktrees.map((entry) => entry.path)).not.toContain(TREE)
  })

  it('closes what lived in a folder git could not put back, and says why where it will stay', async () => {
    await openIn(TREE)
    answers['worktree/list'] = [LISTED.main, LISTED.tree]
    await store.loadWorktrees()
    answers['worktree/list'] = [LISTED.main]
    refused['worktree/bringHome'] = GONE

    expect(await store.bringWorktreeHome(TREE)).toBe(GONE)

    // The dialog that asked goes with the pane, so the words stay as a notice.
    expect(panes(store.getSnapshot().layout.root).map(sessionOf)).not.toContain(sessionKey(AGENT, sessionId('s-1')))
    expect(store.getSnapshot().notices.map((notice) => notice.message)).toContain(GONE)
  })

  it('opens the main checkout when the folder git could not put back was the one open', async () => {
    answers['workspace/open'] = (params: { path: string }) =>
      params.path === TREE ? TREE_WORKSPACE : params.path === OTHER.path ? OTHER : REPO
    answers['worktree/list'] = [LISTED.main, LISTED.tree]
    await store.openWorkspace(TREE)
    await store.loadWorktrees()
    // Its folder is gone; the main checkout, which the list is asked of, lists only itself.
    answers['worktree/list'] = [LISTED.main]
    refused['worktree/bringHome'] = GONE

    await store.bringWorktreeHome(TREE)

    expect(store.getSnapshot().workspace?.path).toBe(REPO.path)
  })

  it('opens the main checkout when the worktree it brought home was the folder open', async () => {
    answers['workspace/open'] = (params: { path: string }) =>
      params.path === TREE ? TREE_WORKSPACE : params.path === OTHER.path ? OTHER : REPO
    await store.openWorkspace(TREE)
    await openIn(TREE)
    answers['worktree/bringHome'] = { branch: 'harnessdesk/parser-fix', from: 'main', root: REPO.path }

    expect(await store.bringWorktreeHome(TREE)).toBeNull()

    expect(store.getSnapshot().workspace?.path).toBe(REPO.path)
  })

  it('says what git reported after a switch that did happen', async () => {
    await openIn(TREE)
    const warning = 'repo is on harnessdesk/parser-fix, but git reported a failure after switching: the hook says no'
    answers['worktree/bringHome'] = { branch: 'harnessdesk/parser-fix', from: 'main', root: REPO.path, warning }

    expect(await store.bringWorktreeHome(TREE)).toBeNull()

    expect(store.getSnapshot().notices.map((notice) => notice.message)).toContain(warning)
  })

  it('moves nothing after a refusal when the worktree list cannot be read again', async () => {
    await openIn(TREE)
    answers['worktree/list'] = [LISTED.main, LISTED.tree]
    await store.loadWorktrees()
    // The worktree was put back; it is the listing that fails, not the folder.
    const refusal = 'repo could not switch to harnessdesk/parser-fix, so the worktree was put back from its branch.'
    refused['worktree/list'] = 'fatal: unable to read the worktree list'
    refused['worktree/bringHome'] = refusal

    expect(await store.bringWorktreeHome(TREE)).toBe(refusal)

    expect(panes(store.getSnapshot().layout.root).map(sessionOf)).toContain(sessionKey(AGENT, sessionId('s-1')))
    expect(store.getSnapshot().workspace?.path).toBe(REPO.path)
    expect(store.getSnapshot().notices.map((notice) => notice.message)).not.toContain(refusal)
  })

  it('moves nothing after a refusal when the worktree list comes back empty, which a list that was read never is', async () => {
    await openIn(TREE)
    answers['worktree/list'] = [LISTED.main, LISTED.tree]
    await store.loadWorktrees()
    // A repository that was read lists its main checkout at least; an empty
    // answer is the host failing to resolve it, not the worktree gone.
    const refusal = 'repo could not switch to harnessdesk/parser-fix, so the worktree was put back from its branch.'
    answers['worktree/list'] = []
    refused['worktree/bringHome'] = refusal

    expect(await store.bringWorktreeHome(TREE)).toBe(refusal)

    expect(panes(store.getSnapshot().layout.root).map(sessionOf)).toContain(sessionKey(AGENT, sessionId('s-1')))
    expect(store.getSnapshot().notices.map((notice) => notice.message)).not.toContain(refusal)
  })

  it('says the main checkout is on the branch now when it was on none before', async () => {
    await openIn(TREE)
    answers['worktree/bringHome'] = { branch: 'harnessdesk/parser-fix', from: null, root: REPO.path }

    expect(await store.bringWorktreeHome(TREE)).toBeNull()

    expect(store.getSnapshot().notices.map((notice) => notice.message)).toContain(
      'repo is on harnessdesk/parser-fix now. The worktree folder is gone; the branch keeps every commit.',
    )
  })
})

/**
 * Reopening the app on a layout with a conversation docked.
 *
 * A saved layout is a place for each conversation, and restoring one is not
 * navigation: what was in front comes back in front, what was docked comes
 * back docked, and both are resumed. Resuming used to be the thing that moved
 * them — `openSession` reveals what it opens, main is a slot, and the docked
 * one is resumed last — so the person reopened the app to find a conversation
 * they had docked in the middle and the one they were reading gone from the
 * screen (#257).
 */
describe('restoring a layout with a conversation docked', () => {
  const inFront = sessionKey(AGENT, sessionId('s-1'))
  const docked = sessionKey(AGENT, sessionId('s-2'))
  const idOf = (params: unknown): string => {
    const fields = params as Record<string, unknown>
    return String(fields['sessionId'] ?? fields['id'] ?? '')
  }

  const restore = async (): Promise<void> => {
    const read = (params: unknown) => conversation(idOf(params), REPO.path)
    answers['session/read'] = read
    answers['session/resume'] = read
    answers['app/state/get'] = {
      layouts: {
        [REPO.path]: {
          main: { root: { kind: 'pane', id: 'p1', view: { kind: 'conversation', session: inFront } }, focused: 'p1' },
          right: { views: [{ id: 'v1', view: { kind: 'conversation', session: docked } }], active: 'v1', size: 400 },
        },
      },
    }
    await store.loadPreferences()
    // Both are resumed, the docked one last; the restore has settled when
    // nothing is still loading.
    await vi.waitFor(() => expect(store.getSnapshot().sessions.get(docked)).toBeDefined())
    await vi.waitFor(() => expect(store.getSnapshot().loadingSessions.size).toBe(0))
  }

  it('leaves the conversation that was in front in front', async () => {
    await restore()

    expect(panes(store.getSnapshot().layout.root).map(sessionOf)).toEqual([inFront])
    expect(store.getSnapshot().activeSessionKey).toBe(inFront)
  })

  it('resumes the docked one where it is, rather than not at all', async () => {
    // The other half of the same fix: a restore that simply skipped docked
    // conversations would leave the one in front alone and bring back a panel
    // with nothing in it, which is the blank docked transcript that made
    // `#resumeVisible` walk the panels in the first place.
    await restore()

    expect(
      mountedViews(store.getSnapshot().workbench).some(
        (entry) => entry.mounted.view.kind === 'conversation' && entry.mounted.view.session === docked,
      ),
    ).toBe(true)
    expect(store.getSnapshot().sessions.get(docked)).toBeDefined()
    expect(JSON.stringify(calls('session/resume'))).toContain('s-2')
  })
})

/**
 * A conversation docked to a panel is a stored shape the store still restores
 * and resumes, so it goes with its worktree's folder like one in the main
 * area — on a bring-back, and on a refusal that took the folder with it.
 */
describe('a conversation docked from a worktree', () => {
  const inFront = sessionKey(AGENT, sessionId('s-1'))
  const docked = sessionKey(AGENT, sessionId('s-2'))
  const idOf = (params: unknown): string => {
    const fields = params as Record<string, unknown>
    return String(fields['sessionId'] ?? fields['id'] ?? '')
  }
  const seed = async (): Promise<void> => {
    const read = (params: unknown) => conversation(idOf(params), idOf(params) === 's-2' ? TREE : REPO.path)
    answers['session/read'] = read
    answers['session/resume'] = read
    answers['app/state/get'] = {
      layouts: {
        [REPO.path]: {
          main: { root: { kind: 'pane', id: 'p1', view: { kind: 'conversation', session: inFront } }, focused: 'p1' },
          right: { views: [{ id: 'v1', view: { kind: 'conversation', session: docked } }], active: 'v1', size: 400 },
        },
      },
    }
    answers['worktree/list'] = [LISTED.main, LISTED.tree]
    await store.loadPreferences()
    await store.loadWorktrees()
    await vi.waitFor(() => expect(store.getSnapshot().sessions.get(docked)?.cwd).toBe(TREE))
    // The restore resumes each conversation where the layout has it (#257), so
    // the docked one is docked and nowhere else without anything here putting
    // it back: the shape under test, checked rather than assumed.
    expect(panes(store.getSnapshot().layout.root).map(sessionOf)).toEqual([inFront])
  }
  const stillDocked = (): boolean =>
    mountedViews(store.getSnapshot().workbench).some(
      (entry) => entry.mounted.view.kind === 'conversation' && entry.mounted.view.session === docked,
    )

  it('closes it when its worktree is brought home', async () => {
    await seed()
    expect(stillDocked()).toBe(true)
    answers['worktree/bringHome'] = { branch: 'harnessdesk/parser-fix', from: 'main', root: REPO.path }

    expect(await store.bringWorktreeHome(TREE)).toBeNull()

    expect(stillDocked()).toBe(false)
    expect(JSON.stringify(calls('session/close'))).toContain('s-2')
  })

  it('closes it when git could not put its worktree back', async () => {
    await seed()
    expect(stillDocked()).toBe(true)
    answers['worktree/list'] = [LISTED.main]
    refused['worktree/bringHome'] = GONE

    await store.bringWorktreeHome(TREE)

    expect(stillDocked()).toBe(false)
    expect(JSON.stringify(calls('session/close'))).toContain('s-2')
  })
})

/**
 * A draft's choices belong to the draft — the main area's conversation pane —
 * and not to whichever conversation holds the focus. A docked one taking it
 * is not the draft being sent, so an unrelated patch must clear neither the
 * worktree it is armed with nor the hand-off it carries.
 */
describe('a draft beside a docked conversation', () => {
  const docked = sessionKey(AGENT, sessionId('s-2'))

  it('keeps its armed worktree and its hand-off while the docked conversation holds the focus', async () => {
    answers['session/read'] = conversation('s-2', TREE)
    answers['session/resume'] = conversation('s-2', TREE)
    answers['app/state/get'] = {
      layouts: {
        [REPO.path]: {
          main: { root: { kind: 'pane', id: 'p1', view: { kind: 'conversation', session: null } }, focused: 'p1' },
          right: { views: [{ id: 'v1', view: { kind: 'conversation', session: docked } }], active: 'v1', size: 400 },
        },
      },
    }
    await store.loadPreferences()
    await vi.waitFor(() => expect(store.getSnapshot().sessions.get(docked)).toBeDefined())
    await store.handOff(AGENT, 'summary', docked, { cwd: REPO.path })
    expect(await store.armWorktree(REPO.path, 'parser fix')).toBe(true)
    const id = mountedViews(store.getSnapshot().workbench).find(
      (entry) => entry.mounted.view.kind === 'conversation' && entry.mounted.view.session === docked,
    )?.mounted.id
    expect(id).toBeDefined()

    store.focusView(id!)
    expect(store.getSnapshot().activeSessionKey).toBe(docked)
    // The New worktree dialog's own close: a patch that carries neither.
    store.askNewWorktree(null)

    expect(store.getSnapshot().draftPlace).toMatchObject({ kind: 'worktree', root: REPO.path, name: 'parser fix' })
    expect(store.getSnapshot().draftHandoff).toMatchObject({ runtime: AGENT, sessionId: 's-2' })
  })
})

/**
 * Choosing where the draft starts is a decision about the draft — the main
 * area's conversation pane — however the focus sits. A tool pane beside it
 * holding the focus must not turn the choice into a fresh draft, which would
 * throw away the hand-off the draft carries.
 */
describe('a place chosen beside another pane', () => {
  it("keeps the draft's hand-off when a tool pane holds the focus", async () => {
    answers['session/read'] = conversation('s-1', REPO.path)
    answers['session/resume'] = conversation('s-1', REPO.path)
    await store.openSession(sessionId('s-1'), { runtime: AGENT })
    await store.handOff(AGENT, 'summary', sessionKey(AGENT, sessionId('s-1')), { cwd: REPO.path })
    expect(store.getSnapshot().draftHandoff).toMatchObject({ sessionId: 's-1' })
    // Beside the draft, not over it: a file opened into an empty draft pane
    // takes it, and then there is no draft left to keep a hand-off on.
    store.openFile(`${REPO.path}/README.md`, { split: 'row' })
    const kinds = panes(store.getSnapshot().layout.root).map((pane) => pane.view.kind)
    expect(kinds).toContain('file')
    expect(panes(store.getSnapshot().layout.root).filter((pane) => pane.view.kind === 'conversation').map(sessionOf)).toEqual([null])
    const file = panes(store.getSnapshot().layout.root).find((pane) => pane.view.kind === 'file')
    expect(file).toBeDefined()
    store.focusPane(file!.id)
    expect(store.getSnapshot().layout.focused).toBe(file!.id)

    store.startDraftIn({ kind: 'existing', path: TREE, branch: 'harnessdesk/parser-fix' })

    expect(store.getSnapshot().draftHandoff).toMatchObject({ sessionId: 's-1' })
    expect(store.getSnapshot().draftPlace).toMatchObject({ kind: 'existing', path: TREE })
  })
})

/**
 * A bring-back reopens the main checkout, which restores that project's saved
 * layout — and a saved layout can show a room in the middle rather than a
 * conversation. The hand-off needs a draft to land on either way.
 */
describe('a bring-back into a main checkout whose saved layout shows a room', () => {
  it('opens a draft for the hand-off to land on', async () => {
    answers['workspace/open'] = (params: { path: string }) =>
      params.path === TREE ? TREE_WORKSPACE : params.path === OTHER.path ? OTHER : REPO
    answers['app/state/get'] = {
      layouts: { [REPO.path]: { main: { root: { kind: 'pane', id: 'p1', view: { kind: 'room', room: 'r1' } }, focused: 'p1' } } },
    }
    await store.loadPreferences()
    await store.openWorkspace(TREE)
    answers['session/read'] = conversation('s-1', TREE)
    answers['session/resume'] = conversation('s-1', TREE)
    await store.openSession(sessionId('s-1'), { runtime: AGENT })
    expect(store.getSnapshot().activeSessionKey).toBe(sessionKey(AGENT, sessionId('s-1')))
    answers['worktree/bringHome'] = { branch: 'harnessdesk/parser-fix', from: 'main', root: REPO.path }

    expect(await store.bringWorktreeHome(TREE)).toBeNull()

    expect(store.getSnapshot().workspace?.path).toBe(REPO.path)
    const draft = panes(store.getSnapshot().layout.root).find(
      (pane) => pane.view.kind === 'conversation' && pane.view.session === null,
    )
    expect(draft).toBeDefined()
    expect(store.getSnapshot().draftHandoff).toMatchObject({ runtime: AGENT, sessionId: 's-1' })
  })
})
