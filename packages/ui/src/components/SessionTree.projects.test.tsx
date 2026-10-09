import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sessionKey, type HostMethodName, type RuntimeInfo, type SessionSummary, type WireNotification, type WorkspaceEntry } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { AppStore, emptySnapshot, type AppSnapshot, type AppStore as AppStoreShape } from '../state/store'
import { SessionTree } from './SessionTree'

/**
 * What the list makes of the folder you have open.
 *
 * One repository is one row however many of its checkouts you have worked in,
 * and the row the app calls "the project you are in" has to be a row that is
 * actually there. These are at the rendered list rather than at
 * `groupByProject`, because the bug they hold the line on lives in the seam:
 * grouping and the list agreeing on which root is the current one.
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

const runtime = {
  id: 'agent',
  name: 'Agent',
  capabilities: { deleteHistory: true },
  presentation: { name: 'Agent' },
} as unknown as RuntimeInfo

const REPO = '/repo'

const session = (id: string, cwd: string, repo: { root: string; worktree: boolean; origin?: string }): SessionSummary =>
  ({
    id,
    runtime: runtime.id,
    title: id,
    preview: null,
    cwd,
    git: null,
    repo,
    status: { type: 'notLoaded' },
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  }) as unknown as SessionSummary

const notify = (store: AppStore, notification: WireNotification): void => {
  const transport = store.transport as unknown as { handlers: { onNotification(value: WireNotification): void } }
  transport.handlers.onNotification(notification)
}

const workspace = (path: string, repo: { root: string; worktree: boolean; origin?: string }): WorkspaceEntry =>
  ({ path, name: path.split('/').at(-1) ?? path, lastOpenedAt: 1, repo })

const render = (history: SessionSummary[], open: WorkspaceEntry, over: Partial<AppSnapshot> = {}): void => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    runtimes: [runtime],
    history,
    workspace: open,
    workspaces: [open],
    ...over,
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    setListPrefs: vi.fn(),
    setProjectsCollapsed: vi.fn(),
    toggleProjectCollapsed: vi.fn(),
    setOthersOpen: vi.fn(),
  } as unknown as AppStoreShape
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={2} />
      </StoreProvider>,
    )
  })
}

/** The project rows, by the name each one shows. */
const projects = (): string[] =>
  [...container.querySelectorAll<HTMLElement>('[draggable="true"]')].map(
    (head) => head.querySelector('[data-draggable] [data-role="prose"]')?.textContent ?? '',
  )

/** The row the list is calling the folder you are in. */
const currentProject = (): string | null =>
  container.querySelector<HTMLElement>('[data-current] [data-draggable] [data-role="prose"]')?.textContent ?? null

const currentProjectRoot = (): string | null =>
  container.querySelector<HTMLElement>('[data-current]')?.closest<HTMLElement>('[data-project-root]')?.dataset.projectRoot ?? null

it('gives an open subfolder one row, not a second empty one for its repository', () => {
  // The subfolder is the project's home — grouping lets the folder you have
  // open claim it — so the list must look for it under that name too. Asking
  // for `/repo` instead pushed an empty `/repo` row beside the real one.
  const sub = `${REPO}/packages/ui`
  render([session('a', sub, { root: REPO, worktree: false })], workspace(sub, { root: REPO, worktree: false }))

  expect(projects()).toEqual(['ui'])
  expect(currentProject()).toBe('ui')
})

it('keeps the cached home when an older unloaded match is returned while both clones are open', async () => {
  const home = session('home-session', '/widgets', {
    root: '/widgets', worktree: false, origin: 'github.com/acme/widgets',
  })
  const clone = session('clone-session', '/widgets-clone', {
    root: '/widgets-clone', worktree: false, origin: 'github.com/acme/widgets',
  })
  // The first history page has only the home checkout. Search can return an
  // older matching conversation from another clone before pagination reaches it.
  const history = [{ ...home, createdAt: 10 }]
  let listCalls = 0
  const opened = [
    workspace('/widgets', { root: '/widgets', worktree: false, origin: 'github.com/acme/widgets' }),
    workspace('/widgets-clone', { root: '/widgets-clone', worktree: false, origin: 'github.com/acme/widgets' }),
  ]
  const runtimeInfo = {
    id: runtime.id,
    name: runtime.presentation.name,
    capabilities: { listHistory: true, searchHistory: true },
    presentation: runtime.presentation,
  }
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (
    method: HostMethodName,
    params: { query?: string },
  ) => {
    if (method === 'session/index') {
      listCalls += 1
      return { data: history, nextCursor: null }
    }
    if (method === 'session/search') return { data: [{ ...clone, createdAt: 1 }], nextCursor: null }
    if (method === 'workspace/recent') return opened
    if (method === 'routes/list') return []
    if (params.query) throw new Error(`unexpected query: ${params.query}`)
    return null
  }) as never)
  let searching = false
  const renderTree = (): void => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={4} searching={searching} />
      </StoreProvider>,
    )
  }
  const afterStoreWake = (): Promise<void> => new Promise((resolve) => {
    const unsubscribe = store.subscribe(() => {
      unsubscribe()
      resolve()
    })
  })

  await act(async () => {
    notify(store, {
      method: 'sync',
      params: {
        sessions: [{
          id: home.id,
          runtime: home.runtime,
          cwd: home.cwd,
          title: home.title,
          status: { type: 'notLoaded' },
          createdAt: home.createdAt,
          updatedAt: home.updatedAt,
          turns: [],
          git: { originUrl: 'https://github.com/acme/widgets' },
        }],
        queues: [], tasks: [], health: [], runtimes: [runtimeInfo], plugins: [], contributions: [],
      },
    } as unknown as WireNotification)
    await store.loadHistory({ reset: true })
    await store.loadWorkspaces()
    renderTree()
  })

  expect(projects()).toEqual(['widgets'])

  searching = true
  await act(async () => {
    renderTree()
    await store.searchHistory('clone-only')
    await afterStoreWake()
  })
  expect(store.getSnapshot().history.map((row) => row.id)).toEqual(['clone-session'])
  expect(projects()).toEqual(['widgets'])
  const cloneRows = [...container.querySelectorAll<HTMLElement>('[data-region="session-row"] [data-slot="sidebar-menu-button"]')]
    .filter((row) => row.textContent?.includes('clone-session'))
  expect(cloneRows).toHaveLength(1)
  const homeRows = [...container.querySelectorAll<HTMLElement>('[data-region="session-row"] [data-slot="sidebar-menu-button"]')]
    .filter((row) => row.textContent?.includes('home-session'))
  expect(homeRows).toHaveLength(1)

  searching = false
  act(() => {
    renderTree()
  })
  // Clearing the field restores cached identity without another request.
  expect(currentProjectRoot()).toBe('/widgets')
  let clear!: Promise<void>
  act(() => { clear = store.searchHistory('') })
  expect(currentProjectRoot()).toBe('/widgets')
  await act(async () => {
    await clear
  })
  expect(listCalls).toBe(1)
  expect(store.getSnapshot().history.map((row) => row.id)).toEqual(['home-session'])
  expect(currentProjectRoot()).toBe('/widgets')
  expect(projects()).toEqual(['widgets'])
})

it('selects exactly the open conversation, never its current project head', () => {
  const here = session('a', REPO, { root: REPO, worktree: false })
  render([here], workspace(REPO, { root: REPO, worktree: false }), {
    activeSessionKey: sessionKey(runtime.id, here.id),
  })
  const active = container.querySelectorAll('[data-slot="sidebar-menu-button"][data-active="true"]')
  expect(active).toHaveLength(1)
  expect(active[0]?.textContent).toBe('a')
  const project = container.querySelector('[draggable="true"] [data-slot="sidebar-menu-button"]')
  expect(project).not.toBeNull()
  expect(project?.getAttribute('data-active')).not.toBe('true')
})

it('gives an open worktree the project it was cut from, and no row of its own', () => {
  const tree = `${REPO}/.claude/worktrees/hours-bug`
  render(
    [
      session('a', REPO, { root: REPO, worktree: false }),
      session('b', tree, { root: REPO, worktree: true }),
    ],
    workspace(tree, { root: REPO, worktree: true }),
  )

  expect(projects()).toEqual(['repo'])
  expect(currentProject()).toBe('repo')
})

it('still gives a folder you have just opened a row of its own', () => {
  // Nothing has been run in it yet, so no group can carry it; the empty row
  // is the only thing that answers "where am I".
  render([session('a', REPO, { root: REPO, worktree: false })], workspace('/other', { root: '/other', worktree: false }))

  expect(projects().sort()).toEqual(['other', 'repo'])
  expect(currentProject()).toBe('other')
})

it('only a stopped project adds capture text, including its folded canonical alias', () => {
  const tree = `${REPO}/.claude/worktrees/hours-bug`
  const off = { project: REPO, enabled: false, state: 'stopped' as const, reason: 'Capture is off.', nextStep: 'Turn capture on.', checkedAt: 1, lastCapturedAt: 1, pending: 0, gaps: 0, revision: 1 }
  render(
    [session('a', REPO, { root: REPO, worktree: false }), session('b', tree, { root: REPO, worktree: true })],
    workspace(tree, { root: REPO, worktree: true }),
    { captureHealth: new Map([[REPO, off]]) },
  )
  expect(container.textContent).toContain('Capture stopped')
  const state = container.querySelector<HTMLElement>('[data-slot="sidebar-menu-state"]')
  expect(state?.getAttribute('aria-label')).toBe('Capture stopped')
  expect(state?.getAttribute('title')).toBe('Capture is off. Turn capture on.')
  expect(state?.hasAttribute('data-compact-at-narrow')).toBe(true)
  expect(state?.querySelector('[data-slot="chip"]')?.getAttribute('data-variant')).toBe('quiet')
  expect(container.querySelector('[data-project-root="/repo"] [data-role="prose"]')?.textContent).toBe('repo')
  render([session('a', REPO, { root: REPO, worktree: false })], workspace(REPO, { root: REPO, worktree: false }), { captureHealth: new Map([[REPO, { ...off, enabled: true, state: 'healthy' }]]) })
  expect(container.textContent).not.toContain('Capture stopped')
})

it('a trigger Goal’s room is named by its Goal, with no origin line of its own, and no row asks Intake for one', async () => {
  const room = {
    id: 'room-1', name: 'Fix the retry bug', updatedAt: 2, members: [], root: REPO,
    intents: [], channel: [], messaging: true,
  } as unknown as import('@harnessdesk/protocol').TeamState
  const goal = {
    goal: { id: 'room-1', root: REPO, cwd: REPO, sentence: 'Fix the retry bug', state: 'open', revision: 1, checkout: 'shared', dependsOn: [], origin: { kind: 'trigger', trigger: 'review-pr', event: 'e1' }, createdAt: 1, updatedAt: 2, receipt: null },
    activity: 'working', waitingOn: [], members: [], board: room, receipt: null, problem: null,
  } as unknown as import('@harnessdesk/protocol').GoalView
  const triggerGoal = vi.fn(async () => ({
    goal: 'room-1', trigger: 'review-pr', source: 'pull-request' as const, label: 'from PR #12', url: null, budget: null, waits: [],
  }))
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    runtimes: [runtime],
    history: [session('a', REPO, { root: REPO, worktree: false })],
    workspace: workspace(REPO, { root: REPO, worktree: false }),
    workspaces: [workspace(REPO, { root: REPO, worktree: false }), workspace('/other', { root: '/other', worktree: false })],
    teams: new Map([['room-1', room]]),
    goals: new Map([['room-1', goal]]),
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    setListPrefs: vi.fn(),
    setProjectsCollapsed: vi.fn(),
    toggleProjectCollapsed: vi.fn(),
    setOthersOpen: vi.fn(),
    triggerGoal,
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={2} />
      </StoreProvider>,
    )
  })
  // Where the Goal came from is its room's own header chip; the sidebar
  // names the Goal and never asks.
  expect(triggerGoal).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Fix the retry bug')
  expect(container.textContent).not.toContain('from PR #12')
})
