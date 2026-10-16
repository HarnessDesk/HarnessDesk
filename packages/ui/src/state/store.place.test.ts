import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  runtimeId,
  sessionId,
  sessionKey,
  type HostMethodName,
  type Session,
  type WorkspaceEntry,
} from '@harnessdesk/protocol'

import { panes, sessionOf, browserView, type PaneView } from './layout'
import { toolOf } from './frame-tools'
import { mountedViews, dockViews, emptyWorkbench, navigationFor } from './workbench'
import { AppStore } from './store'
import type { TransportEvents } from '../lib/transport'

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

it.each(['panel toggle', 'lit tool'] as const)('Activity tasks can be closed by the %s', async (closer) => {
  answers['session/read'] = conversation('status-work', REPO.path)
  await store.openSession(sessionId('status-work'), { runtime: AGENT })
  store.openDetailsTab('tasks')
  const subject = store.workSubject()!
  const before = store.getSnapshot().workbench
  expect(before.frameTools[subject]?.open).toBe(true)
  if (closer === 'panel toggle') store.toggleWorkPanel()
  else {
    const current = before.frameTools[subject]!
    store.chooseWorkTool(current.tool, current.mode, true)
  }
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(false)
  expect(store.getSnapshot().workbench.right.collapsed).toBe(true)
  expect(dockViews(store.getSnapshot().workbench.right)).toEqual(dockViews(before.right))
})

describe.each(['panel toggle', 'lit tool'] as const)('right panel closure through the %s', (closer) => {
  const views: readonly PaneView[] = [
    { kind: 'run-details' }, { kind: 'agents' },
    { kind: 'changes' }, { kind: 'file', path: '/repo/README.md', runtime: AGENT },
    { kind: 'preview', path: '/repo/preview.html', runtime: AGENT },
    { kind: 'activity' }, { kind: 'trajectory' }, { kind: 'tasks' },
    { kind: 'git', root: REPO.path }, browserView('https://example.com/'),
    { kind: 'plugin', contribution: 'fixture-panel', label: 'Fixture facts', mounts: ['right'] },
  ]
  const close = () => {
    if (closer === 'panel toggle') store.toggleWorkPanel()
    else {
      const current = store.getSnapshot().workbench.frameTools[store.workSubject()!]!
      store.chooseWorkTool(current.tool, current.mode, true)
    }
  }
  const check = () => {
    const subject = store.workSubject()!, before = store.getSnapshot().workbench
    expect(before.frameTools[subject]?.open).toBe(true)
    close()
    expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(false)
    expect(store.getSnapshot().workbench.right.collapsed).toBe(true)
    expect(dockViews(store.getSnapshot().workbench.right)).toEqual(dockViews(before.right))
    store.toggleWorkPanel()
    expect(store.getSnapshot().workbench.frameTools[subject]).toEqual(before.frameTools[subject])
  }
  it.each(['changes', 'activity', 'trajectory', 'agents', 'tasks'] as const)('closes openDetailsTab(%s)', async (kind) => {
    answers['session/read'] = conversation('status-work', REPO.path)
    await store.openSession(sessionId('status-work'), { runtime: AGENT })
    store.openDetailsTab(kind)
    check()
  })
  it.each(views.map(view => [view.kind, view] as const))('closes showViewIn(right, %s)', async (_kind, view) => {
    answers['session/read'] = conversation('status-work', REPO.path)
    await store.openSession(sessionId('status-work'), { runtime: AGENT })
    store.showViewIn('right', view)
    expect(store.getSnapshot().workbench.frameTools[store.workSubject()!]?.tool).toBe(toolOf(view.kind))
    check()
  })
  it('keeps the More terminal independent of the tasks panel', async () => {
    answers['session/read'] = conversation('status-work', REPO.path)
    answers['terminal/open'] = { terminalId: 'status-terminal', runtime: AGENT }
    await store.openSession(sessionId('status-work'), { runtime: AGENT })
    store.openDetailsTab('tasks')
    await store.openTerminal()
    const bottom = dockViews(store.getSnapshot().workbench.bottom)
    expect(bottom).toHaveLength(1)
    check()
    expect(dockViews(store.getSnapshot().workbench.bottom)).toEqual(bottom)
  })
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

  it('loads a visible idle transcript that sync supplied as unloaded metadata', async () => {
    const transport = store.transport as unknown as { handlers: TransportEvents }
    transport.handlers.onEvent(AGENT, { type: 'session/started', session: {
      ...conversation('s-1', REPO.path), itemsLoaded: false,
    } })
    await restore()
    expect(calls('session/read')).toContainEqual({ runtime: AGENT, sessionId: sessionId('s-1') })
    expect(store.getSnapshot().sessions.get(inFront)?.itemsLoaded).toBe(true)
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

  it('keeps a restored docked transcript when its read succeeds but resume is refused', async () => {
    await restore()
    const mounted = mountedViews(store.getSnapshot().workbench)
    vi.mocked(store.transport.request).mockImplementation((async (method: HostMethodName, params: never) => {
      if (method === 'session/resume') throw Object.assign(new Error('The agent is unavailable.'), { code: 'runtimeUnavailable' })
      return method === 'session/read' ? conversation(idOf(params), REPO.path) : null
    }) as never)

    await store.openSession(sessionId('s-2'), { runtime: AGENT, restoring: true, reveal: false })

    expect(mountedViews(store.getSnapshot().workbench)).toEqual(mounted)
    expect(store.getSnapshot().activeSessionKey).toBe(inFront)
    expect(store.getSnapshot().sessions.get(docked)?.itemsLoaded).toBe(true)
  })

  it('takes the panel down when the host removes the docked one, and leaves the one in front', async () => {
    await restore()
    const transport = store.transport as unknown as {
      handlers: { onNotification(notification: unknown): void }
    }

    transport.handlers.onNotification({ method: 'session/removed', params: { runtime: AGENT, sessionId: sessionId('s-2'), deleted: true } })

    expect(
      mountedViews(store.getSnapshot().workbench).some(
        (entry) => entry.mounted.view.kind === 'conversation' && entry.mounted.view.session === docked,
      ),
    ).toBe(false)
    expect(store.getSnapshot().sessions.has(docked)).toBe(false)
    expect(panes(store.getSnapshot().layout.root).map(sessionOf)).toEqual([inFront])
    expect(store.getSnapshot().activeSessionKey).toBe(inFront)
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
    expect(kinds).toEqual(['conversation'])
    expect(panes(store.getSnapshot().layout.root).filter((pane) => pane.view.kind === 'conversation').map(sessionOf)).toEqual([null])
    const file = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'file')
    expect(file).toBeDefined()
    store.focusView(file!.id)
    expect(store.getSnapshot().workbench.focus).toBe(file!.id)

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

it('persisted tool migration retains terminal and browser ids without closing resources', async () => {
  answers['app/state/get'] = { layouts: { [REPO.path]: {
    main: { root: { kind: 'pane', id: 'fixture-main', view: { kind: 'room', room: 'fixture-team' } }, focused: 'fixture-main' },
    sidebar: { views: [{ id: 'fixture-browser', view: { kind: 'browser', profile: 'lane-fixture', tabs: [{ id: 'fixture-tab', url: 'about:blank' }], active: 'fixture-tab', driven: 'fixture-tab' } }], active: 'fixture-browser' },
    right: { views: [{ id: 'fixture-terminal', view: { kind: 'terminal', terminalId: 'fixture-pty', runtime: AGENT, cwd: '/repo' } }], active: 'fixture-terminal' },
  } } }
  await store.loadPreferences()
  const { workbench } = store.getSnapshot()
  expect(dockViews(workbench.right).map(one => one.id)).toEqual(['fixture-browser'])
  expect(dockViews(workbench.bottom).map(one => one.id)).toEqual(['fixture-terminal'])
  expect(workbench.toolOwners['fixture-browser']).toBe('team:fixture-team')
  expect(calls('terminal/close')).toEqual([])
  expect(calls('session/close')).toEqual([])
})


it.each(['sidebar', 'bottom'] as const)('refuses all explicit routes to a restored %s-only plugin while retaining it', async (area) => {
  const view = { kind: 'plugin' as const, contribution: 'fixture-hidden', label: 'Legacy panel', mounts: [area] }
  answers['app/state/get'] = { layouts: { [REPO.path]: {
    main: { root: { kind: 'pane', id: 'plugin-draft', view: { kind: 'conversation', session: null } }, focused: 'plugin-draft' },
    [area]: { views: [{ id: 'hidden-plugin', view }], active: 'hidden-plugin', size: 240 },
  } } }
  await store.loadPreferences()
  const restored = store.getSnapshot().workbench
  expect(dockViews(restored.right).find(one => one.id === 'hidden-plugin')?.view).toEqual(view)
  expect(restored.frameTools['draft:plugin-draft']?.mode).not.toBe('plugin')
  for (const reveal of [() => store.showViewIn('right', view), () => store.revealView('hidden-plugin'),
    () => store.chooseWorkTool('details', 'plugin')]) {
    const before = store.getSnapshot().workbench
    reveal()
    expect(store.getSnapshot().workbench).toBe(before)
    expect(store.getSnapshot().notices.at(-1)?.message).toContain('does not support the fixed right panel')
  }
  expect(calls('session/close')).toEqual([])
})


it('a confirmed removal invalidates a cold hidden subject without relabelling its file cache', async () => {
  const key = sessionKey(AGENT, sessionId('cold-owner'))
  const owner = `session:${key}`
  const file = { kind: 'file' as const, path: '/repo/README.md', runtime: AGENT }
  answers['app/state/get'] = { layouts: { [REPO.path]: {
    main: { root: { kind: 'pane', id: 'current-draft', view: { kind: 'conversation', session: null } }, focused: 'current-draft' },
    right: { views: [{ id: 'cold-file', view: file }], active: 'cold-file', size: 400 },
    toolOwners: { 'cold-file': owner },
    frameSubjects: { [owner]: { paneId: 'cold-main', view: { kind: 'conversation', session: key } } },
    frameTools: { [owner]: { tool: 'files', mode: 'file', open: true } },
  } } }
  await store.loadPreferences()
  expect(store.getSnapshot().sessions.has(key)).toBe(false)
  expect(store.getSnapshot().workbench.frameSubjects[owner]).toBeDefined()
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onNotification({ method: 'session/removed', params: { runtime: AGENT, sessionId: sessionId('cold-owner'), deleted: false } })
  const removed = store.getSnapshot().workbench
  expect(removed.frameSubjects[owner]).toBeUndefined()
  expect(removed.frameTools[owner]).toBeUndefined()
  store.revealView('cold-file')
  expect(store.getSnapshot().workbench).toBe(removed)
  expect(panes(store.getSnapshot().workbench.main.root).map(sessionOf)).toEqual([null])
  expect(store.getSnapshot().workbench.toolOwners['cold-file']).toBe(owner)
  expect(dockViews(store.getSnapshot().workbench.right).find(one => one.id === 'cold-file')?.view).toEqual(file)
  expect(calls('session/close')).toEqual([])
})


describe('explicit reveal of a cold restored resource owner', () => {
  const id = sessionId('cold-resource-owner')
  const key = sessionKey(AGENT, id)
  const owner = `session:${key}`
  const restore = async () => {
    answers['app/state/get'] = { layouts: { [REPO.path]: {
      main: { root: { kind: 'pane', id: 'other-draft', view: { kind: 'conversation', session: null } }, focused: 'other-draft' },
      right: { views: [{ id: 'cold-resource', view: { kind: 'file', path: '/repo/a.ts', runtime: AGENT } }], active: 'cold-resource', size: 400 },
      toolOwners: { 'cold-resource': owner },
      frameSubjects: { [owner]: { paneId: 'owner-pane', view: { kind: 'conversation', session: key } } },
      frameTools: { [owner]: { tool: 'files', mode: 'file', open: true } },
    } } }
    await store.loadPreferences()
    expect(store.getSnapshot().sessions.has(key)).toBe(false)
    expect(calls('session/read')).toEqual([])
    expect(calls('session/resume')).toEqual([])
  }
  it('reads and resumes its conversation once while preserving the revealed file and pane', async () => {
    await restore()
    let finish!: (session: Session) => void
    answers['session/read'] = () => new Promise<Session>(resolve => { finish = resolve })
    answers['session/resume'] = conversation(id, REPO.path)
    const file = dockViews(store.getSnapshot().workbench.right)[0]!
    store.revealView(file.id)
    store.revealView(file.id)
    expect(calls('session/read')).toEqual([{ runtime: AGENT, sessionId: id }])
    expect(store.getSnapshot().loadingSessions.has(key)).toBe(true)
    expect(store.getSnapshot().layout.focused).toBe('owner-pane')
    finish(conversation(id, REPO.path))
    await vi.waitFor(() => expect(store.getSnapshot().loadingSessions.has(key)).toBe(false))
    expect(calls('session/resume')).toEqual([{ runtime: AGENT, sessionId: id }])
    expect(store.getSnapshot().sessions.get(key)?.itemsLoaded).toBe(true)
    expect(store.getSnapshot().activeSessionKey).toBe(key)
    expect(dockViews(store.getSnapshot().workbench.right)[0]).toEqual(file)
    expect(store.getSnapshot().workbench.focus).toBe(file.id)
    expect(store.getSnapshot().workbench.frameTools[owner]).toEqual({ tool: 'files', mode: 'file', open: true })
    store.revealView(file.id)
    expect(calls('session/read')).toHaveLength(1)
    expect(calls('session/resume')).toHaveLength(1)
    expect(calls('session/close')).toEqual([])
  })
  it.each(['read', 'resume'] as const)('a confirmed removal during %s prevents its delayed answer restoring the conversation', async stage => {
    await restore()
    let finish!: (session: Session) => void
    const loaded = conversation(id, REPO.path)
    answers['session/read'] = loaded
    answers['session/resume'] = loaded
    answers[`session/${stage}`] = () => new Promise<Session>(resolve => { finish = resolve })
    store.revealView('cold-resource')
    await vi.waitFor(() => expect(calls(`session/${stage}`)).toHaveLength(1))
    const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
    handlers.onNotification({ method: 'session/removed', params: { runtime: AGENT, sessionId: id, deleted: true } })
    finish(loaded)
    await vi.waitFor(() => expect(store.getSnapshot().loadingSessions.has(key)).toBe(false))
    expect(store.getSnapshot().sessions.has(key)).toBe(false)
    expect(store.getSnapshot().activeSessionKey).toBeNull()
    expect(store.getSnapshot().workbench.frameSubjects[owner]).toBeUndefined()
    expect(store.getSnapshot().workbench.toolOwners['cold-resource']).toBe(owner)
    expect(dockViews(store.getSnapshot().workbench.right).map(one => one.id)).toEqual(['cold-resource'])
    if (stage === 'read') expect(calls('session/resume')).toEqual([])
    store.revealView('cold-resource')
    expect(store.getSnapshot().activeSessionKey).toBeNull()
    expect(calls('session/close')).toEqual([])
  })
})


it('an explicit compatible plugin revision updates the retained manifest while preserving its cache id and owner', async () => {
  const legacy = { kind: 'plugin' as const, contribution: 'fixture-revised', label: 'Legacy panel', mounts: ['sidebar'] as const }
  answers['app/state/get'] = { layouts: { [REPO.path]: {
    main: { root: { kind: 'pane', id: 'plugin-owner', view: { kind: 'conversation', session: null } }, focused: 'plugin-owner' },
    sidebar: { views: [{ id: 'revised-cache', view: legacy }], active: 'revised-cache', size: 240 },
  } } }
  await store.loadPreferences()
  const previous = store.getSnapshot().workbench.toolOwners['revised-cache']
  const compatible = { ...legacy, label: 'Revised panel', mounts: ['right'] as const }
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onNotification({ method: 'extension', params: { event: { type: 'contributions/changed', owner: 'fixture' as never, revision: 2, contributions: [{
    kind: 'ui', id: compatible.contribution, owner: 'fixture', slot: 'session.header', label: compatible.label,
    component: 'hd.panel', mounts: ['right'],
  }] as never } } })
  store.showViewIn('right', compatible)
  const current = store.getSnapshot().workbench
  expect(dockViews(current.right)).toEqual([{ id: 'revised-cache', view: compatible }])
  expect(current.toolOwners['revised-cache']).toBe(previous)
  expect(current.frameTools[previous!]).toEqual({ tool: 'details', mode: 'plugin', open: true })
  expect(calls('session/close')).toEqual([])
})


it('a current manifest revision refuses the saved right plugin at admission, reveal and mode selection', async () => {
  const view = { kind: 'plugin' as const, contribution: 'fixture-manifest', label: 'Saved panel', mounts: ['right'] as const }
  store.showViewIn('right', view)
  const before = store.getSnapshot().workbench
  const held = dockViews(before.right)[0]!
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onNotification({ method: 'extension', params: { event: { type: 'contributions/changed', owner: 'fixture' as never, revision: 2, contributions: [{
    kind: 'ui', id: view.contribution, owner: 'fixture', slot: 'session.header', label: view.label,
    component: 'hd.panel', mounts: ['sidebar'],
  }] as never } } })
  expect(store.getSnapshot().contributions).toHaveLength(1)
  for (const reveal of [() => store.showViewIn('right', view), () => store.revealView(held.id),
    () => store.chooseWorkTool('details', 'plugin')]) {
    reveal()
    expect(store.getSnapshot().workbench).toBe(before)
    expect(store.getSnapshot().notices.at(-1)?.message).toContain('does not support the fixed right panel')
  }
  expect(dockViews(store.getSnapshot().workbench.right)).toContainEqual(held)
})

it.each(['settings','review'] as const)('restores per-project %s and history without changing remembered work or docks', async kind => {
  const seed = emptyWorkbench(), b = emptyWorkbench()
  const a = { ...seed, frameTools:{[`draft:${seed.main.focused}`]:{tool:'files' as const,mode:'file' as const,open:true}}, right:{...seed.right,root:{kind:'stack' as const,id:'fixture-right',active:'fixture-file',views:[{id:'fixture-file',view:{kind:'file' as const,path:'/repo/README.md',runtime:AGENT}}]}}, bottom: { ...seed.bottom, root: { kind: 'stack' as const, id: 'fixture-bottom',
    active: 'fixture-terminal', views: [{ id: 'fixture-terminal', view: { kind: 'terminal' as const,
      terminalId: 'fixture-pty', runtime: AGENT, cwd: REPO.path } }] } } }
  const aWork = navigationFor(a.main).current, bWork = navigationFor(b.main).current
  const aPage = kind==='settings' ? { kind: 'settings', route: { kind: 'section', section: 'appearance', focus: null } } as const
    : {kind:'changes-review',root:REPO.path,returnTo:aWork.kind==='work'?aWork.view:{kind:'conversation',session:null}} as const
  const bPage = { kind: 'dashboard', view: 'plans', scope: null } as const
  answers['app/state/get'] = { layouts: {
    [REPO.path]: { ...a, navigation: { current: aPage, back: [aWork], forward: [{ kind: 'agents', id: null }] } },
    [OTHER.path]: { ...b, navigation: { current: bPage, back: [bWork], forward: [] } },
  } }
  await store.loadPreferences()
  await store.openWorkspace(OTHER.path)
  expect(store.getSnapshot().workbench.navigation.current).toEqual(bPage)
  await store.openWorkspace(REPO.path)
  expect(store.getSnapshot().workbench.navigation).toEqual({ current: aPage, back: [aWork], forward: [{ kind: 'agents', id: null }] })
  expect(store.getSnapshot().workbench.main).toEqual(a.main)
  expect(store.getSnapshot().workbench.bottom).toEqual(a.bottom)
  expect(store.getSnapshot().workbench.right).toEqual(a.right)
  expect(store.getSnapshot().workbench.frameTools).toEqual(a.frameTools)
  await store.navigateBack()
  expect(store.getSnapshot().workbench.navigation.current).toEqual(aWork)
  await store.navigateForward()
  expect(store.getSnapshot().workbench.navigation.current).toEqual(aPage)
})

it('restoring a page hydrates remembered conversation without visiting it', async () => {
  const seed = emptyWorkbench()
  const key = sessionKey(AGENT, sessionId('fixture-remembered'))
  const main = { root: { kind: 'pane' as const, id: 'fixture-main', view: { kind: 'conversation' as const, session: key } },
    focused: 'fixture-main', expanded: null }
  const page = { kind: 'dashboard', view: 'plans', scope: null } as const
  const navigation = { current: page, back: [{ kind: 'work' as const, view: main.root.view }], forward: [] }
  answers['app/state/get'] = { layouts: { [REPO.path]: { ...seed, main, navigation } } }
  answers['session/read'] = conversation('fixture-remembered', REPO.path)
  answers['session/resume'] = conversation('fixture-remembered', REPO.path)
  await store.loadPreferences()
  await vi.waitFor(() => expect(store.getSnapshot().sessions.has(key)).toBe(true))
  expect(store.getSnapshot().workbench.navigation).toEqual(navigation)
  expect(store.getSnapshot().layout).toEqual(main)
  expect(calls('session/close')).toEqual([])
})

it('historical tasks callers open the complete Activity body', async () => {
  answers['session/read'] = conversation('activity-work', REPO.path)
  await store.openSession(sessionId('activity-work'), { runtime: AGENT })
  store.openDetailsTab('tasks')
  const subject = store.workSubject()!
  expect(store.getSnapshot().workbench.frameTools[subject]?.mode).toBe('activity')
})


it('Show Terminal uses the chosen project on a page instead of the retained conversation', async () => {
  answers['session/read'] = conversation('old-project', OTHER.path)
  answers['terminal/open'] = { terminalId: 'page-terminal', runtime: AGENT }
  await store.openSession(sessionId('old-project'), { runtime: AGENT })
  store.openDestination({ kind: 'settings', route: { kind: 'project', root: REPO.path } })
  await store.openTerminal()
  expect(calls('terminal/open').at(-1)).toMatchObject({ cwd: REPO.path })
  expect(calls('terminal/open').at(-1)).not.toHaveProperty('sessionId')
  expect(dockViews(store.getSnapshot().workbench.bottom).at(-1)?.view).toMatchObject({ kind: 'terminal', cwd: REPO.path })
})
