import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  runtimeId,
  sessionKey,
  type GoalView,
  type RepoInfo,
  type RuntimeInfo,
  type SessionSummary,
  type TeamState,
  type WorkspaceEntry,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { SessionTree } from './SessionTree'

/**
 * What the left list contains, and how its rows are titled.
 *
 * One repository is one project however many clones of it were made. A folder
 * that no longer exists is not a project, but nothing in it is lost. A row is
 * named by what a person said, and a seat nobody typed to is named by its job.
 * These are at the rendered list rather than at `groupByProject` because the
 * rules live in the seam: the grouping, the pins and folds, the hiding and the
 * rows have to agree about what a project is.
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

const WIDGETS = '/Users/a/code/widgets'
const PLAN = '/Users/a/code/widgets-team-plan-pr18'
const LUNA = '/Users/a/code/widgets-team-luna-954'
const ORIGIN = 'github.com/acme/widgets'

const at = (rootPath: string, origin: string | null = ORIGIN): RepoInfo => ({
  root: rootPath,
  worktree: false,
  ...(origin === null ? {} : { origin }),
})

const row = (
  id: string,
  cwd: string,
  over: Partial<SessionSummary> & { repo?: RepoInfo | null } = {},
): SessionSummary =>
  ({
    id,
    runtime: runtime.id,
    title: id,
    preview: null,
    cwd,
    git: null,
    repo: at(cwd),
    status: { type: 'notLoaded' },
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    ...over,
  }) as unknown as SessionSummary

const workspace = (path: string, repo: RepoInfo | null = at(path)): WorkspaceEntry =>
  ({ path, name: path.split('/').at(-1) ?? path, lastOpenedAt: 1, ...(repo === null ? {} : { repo }) })

interface Rig {
  readonly store: AppStore
  readonly update: (patch: Partial<AppSnapshot>) => void
}

const mount = (
  history: readonly SessionSummary[],
  over: Partial<AppSnapshot> = {},
  props: { searching?: boolean } = {},
  storeOver: Partial<AppStore> = {},
): Rig => {
  let snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    runtimes: [runtime],
    history,
    historyIdentity: history,
    workspace: workspace(WIDGETS),
    workspaces: [workspace(WIDGETS)],
    ...over,
  } as AppSnapshot
  const listeners = new Set<() => void>()
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    setListPrefs: vi.fn(),
    setProjectsCollapsed: vi.fn(),
    toggleCollapsed: vi.fn(),
    togglePinned: vi.fn(),
    setOthersOpen: vi.fn(),
    forgetFolders: vi.fn(async () => {}),
    openSession: vi.fn(),
    ...storeOver,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SessionTree now={3} {...props} />
      </StoreProvider>,
    )
  })
  return {
    store,
    update: (patch) => {
      snapshot = { ...snapshot, ...patch } as AppSnapshot
      act(() => listeners.forEach((listener) => listener()))
    },
  }
}

/** The project rows, by the name each one shows. */
const projects = (): string[] =>
  [...container.querySelectorAll<HTMLElement>('[draggable="true"]')].map(
    (head) => head.querySelector('[data-draggable] [data-role="prose"]')?.textContent ?? '',
  )

/** Every conversation row's title, wherever it is drawn. */
const titles = (): string[] =>
  [...container.querySelectorAll<HTMLElement>('[data-region="session-row"] [data-slot="sidebar-menu-button"]')].map(
    (button) => button.textContent?.trim() ?? '',
  )

const goneLine = (): HTMLElement | null => container.querySelector<HTMLElement>('[data-region="gone-folders"]')

// ------------------------------------------------------------------ clones

it('lists the clones of one repository as one project, with every conversation in it', () => {
  mount([
    row('a', WIDGETS, { updatedAt: 10 }),
    row('b', PLAN, { updatedAt: 30 }),
    row('c', LUNA, { updatedAt: 20 }),
  ])
  expect(projects()).toEqual(['widgets'])
  expect(titles()).toEqual(['b', 'c', 'a'])
})

it('keeps a clone with no remote, and a different repository, as projects of their own', () => {
  const scratch = '/Users/a/code/scratch'
  mount([
    row('a', WIDGETS),
    row('b', PLAN),
    row('c', scratch, { repo: at(scratch, null) }),
    row('d', '/Users/a/code/other', { repo: at('/Users/a/code/other', 'github.com/acme/other') }),
  ], { listPrefs: { ...emptySnapshot().listPrefs, othersOpen: true } })
  expect(projects().sort()).toEqual(['other', 'scratch', 'widgets'])
})

it('lights one project when the folder you have open is a clone of it, and draws no second row for it', () => {
  mount([row('a', WIDGETS, { createdAt: 1 }), row('b', PLAN, { createdAt: 5 })], {
    workspace: workspace(PLAN),
    workspaces: [workspace(WIDGETS), workspace(PLAN)],
  })
  expect(projects()).toEqual(['widgets'])
  expect(container.querySelector('[data-current]')).not.toBeNull()
})

it('keeps a fresh clone you have open in the project it is a copy of, before it holds a conversation', () => {
  const fresh = '/Users/a/code/widgets-team-new'
  mount([row('a', WIDGETS)], { workspace: workspace(fresh), workspaces: [workspace(WIDGETS), workspace(fresh)] })
  expect(projects()).toEqual(['widgets'])
})

// ---------------------------------------------------------- pins and folds

const answerPreferences = (rig: Rig): void => {
  const apply = (patch: Partial<AppSnapshot['listPrefs']>) =>
    rig.update({ listPrefs: { ...rig.store.getSnapshot().listPrefs, ...patch } })
  vi.mocked(rig.store.setListPrefs).mockImplementation(apply)
  vi.mocked(rig.store.toggleCollapsed).mockImplementation(key => {
    const roots = rig.store.getSnapshot().listPrefs.collapsed
    apply({ collapsed: roots.includes(key) ? roots.filter(one => one !== key) : [...roots, key] })
  })
  vi.mocked(rig.store.togglePinned).mockImplementation(key => {
    const roots = rig.store.getSnapshot().listPrefs.pinned
    apply({ pinned: roots.includes(key) ? roots.filter(one => one !== key) : [...roots, key] })
  })
  vi.mocked(rig.store.setProjectsCollapsed).mockImplementation((roots, collapsed) => {
    const current = rig.store.getSnapshot().listPrefs.collapsed
    apply({ collapsed: collapsed ? [...new Set([...current, ...roots])] : current.filter(one => !roots.includes(one)) })
  })
}

for (const state of ['filtered', 'searching', 'loading'] as const) {
  it(`can unfold and unpin clone aliases while ${state}, without changing unrelated preferences`, () => {
    const untouched = '/demo/unseen-project'
    const rig = mount([row('home', WIDGETS, { runtime: state === 'filtered' ? runtimeId('other') : runtime.id }), row('clone', PLAN)], {
      historyLoading: state === 'loading',
      listPrefs: { ...emptySnapshot().listPrefs, agent: state === 'filtered' ? runtime.id : null,
        pinned: [PLAN, WIDGETS, untouched], collapsed: [PLAN, WIDGETS, untouched, 'unseen-team'] },
    }, { searching: state === 'searching' })
    answerPreferences(rig)
    const project = () => container.querySelector<HTMLElement>(`[data-project-root="${WIDGETS}"]`)!
    act(() => project().querySelector<HTMLButtonElement>('[data-draggable]')!.click())
    expect(titles()).toEqual(state === 'filtered' ? ['clone'] : ['home', 'clone'])
    expect(rig.store.getSnapshot().listPrefs.collapsed).toEqual([untouched, 'unseen-team'])
    act(() => project().querySelector<HTMLButtonElement>('[aria-label="Actions for widgets"]')!.click())
    const unpin = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(one => one.textContent?.trim() === 'Unpin')
    expect(unpin).toBeDefined()
    act(() => unpin!.click())
    expect(rig.store.getSnapshot().listPrefs.pinned).toEqual([untouched])
    rig.update({ listPrefs: { ...rig.store.getSnapshot().listPrefs, agent: null }, historyLoading: false })
    expect(project().querySelector('[aria-label="Pinned"]')).toBeNull()
    expect(titles()).toEqual(['home', 'clone'])
  })
}

it('expands all projects through clone folds while filtered', () => {
  const rig = mount([row('home', WIDGETS), row('clone', PLAN)], {
    listPrefs: { ...emptySnapshot().listPrefs, agent: runtime.id, collapsed: [PLAN, 'unseen-team'] },
  })
  answerPreferences(rig)
  act(() => container.querySelector<HTMLButtonElement>('[data-draggable]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true })))
  expect(titles()).toEqual(['home', 'clone'])
  expect(rig.store.getSnapshot().listPrefs.collapsed).toEqual(['unseen-team'])
})

it('moves a filtered project from its clone aliases using the effective pin order', () => {
  const untouched = '/demo/unseen-project'
  const rig = mount([row('home', WIDGETS), row('clone', PLAN)], {
    listPrefs: { ...emptySnapshot().listPrefs, agent: runtime.id, pinned: [PLAN, WIDGETS, untouched] },
  })
  answerPreferences(rig)
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Actions for widgets"]')!.click())
  const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(one => one.querySelector('[class*="title"]')?.textContent?.trim() === label)!
  act(() => menuItem('Move').click())
  expect(menuItem('Move up').getAttribute('aria-disabled')).toBe('true')
  act(() => menuItem('Move down').click())
  expect(rig.store.getSnapshot().listPrefs.pinned).toEqual([untouched, WIDGETS])
  expect(container.querySelector('[data-slot="sortable-announcer"]')?.textContent).toBe('Moved widgets to position 2 of 2')
})

it('keeps the opened home and its fold while another agent’s clone is the only visible history', () => {
  const other = '/demo/other'
  const second = { ...runtime, id: 'second', presentation: { name: 'Second' } } as RuntimeInfo
  const rig = mount([row('home', WIDGETS), row('clone', PLAN, { runtime: second.id })], {
    runtimes: [runtime, second],
    workspace: workspace(other, at(other, 'github.com/acme/other')),
    workspaces: [workspace(WIDGETS), workspace(other, at(other, 'github.com/acme/other'))],
    listPrefs: { ...emptySnapshot().listPrefs, agent: second.id, pinned: [WIDGETS], collapsed: [WIDGETS] },
  })
  expect(projects()).toEqual(['widgets'])
  expect(container.querySelector('[draggable="true"] [aria-label="Pinned"]')).not.toBeNull()
  expect(titles()).toEqual([])
  expect(rig.store.setListPrefs).not.toHaveBeenCalled()
  rig.update({ listPrefs: { ...rig.store.getSnapshot().listPrefs, collapsed: [] } })
  expect(titles()).toEqual(['clone'])
})

it('uses opened repository metadata before a history page contains the home checkout', () => {
  const other = '/demo/other'
  mount([row('clone', PLAN)], {
    workspace: workspace(other, at(other, 'github.com/acme/other')),
    workspaces: [workspace(WIDGETS), workspace(other, at(other, 'github.com/acme/other'))],
    historyLoading: true,
    listPrefs: { ...emptySnapshot().listPrefs, pinned: [WIDGETS], collapsed: [WIDGETS] },
  })
  expect(projects().sort()).toEqual(['other', 'widgets'])
  expect(container.querySelector('[draggable="true"] [aria-label="Pinned"]')).not.toBeNull()
  expect(titles()).toEqual([])
})

it('carries a gone clone’s pin and fold to the surviving checkout at startup', () => {
  const rig = mount([row('home', WIDGETS), row('gone-clone', PLAN, { repo: null, git: { originUrl: 'https://github.com/acme/widgets.git' } as never })], {
    foldersGone: new Map([[PLAN, 'This folder no longer exists.']]),
    listPrefs: { ...emptySnapshot().listPrefs, pinned: [PLAN], collapsed: [PLAN] },
  })
  expect(projects()).toEqual(['widgets'])
  expect(container.querySelector('[draggable="true"] [aria-label="Pinned"]')).not.toBeNull()
  expect(titles()).toEqual([])
  expect(rig.store.setListPrefs).toHaveBeenCalledWith({ pinned: [WIDGETS], collapsed: [WIDGETS] })
  expect(goneLine()?.textContent).toContain('1 folder is gone')
})

it('uses a surviving clone as home when the original checkout is gone, retaining its aliases', () => {
  const rig = mount([row('gone-home', WIDGETS), row('clone', PLAN, { createdAt: 5 })], {
    foldersGone: new Map([[WIDGETS, 'This folder no longer exists.']]),
    workspaces: [workspace(WIDGETS), workspace(PLAN)],
    listPrefs: { ...emptySnapshot().listPrefs, pinned: [WIDGETS], collapsed: [WIDGETS] },
  })
  expect(projects()).toEqual(['widgets-team-plan-pr18'])
  expect(titles()).toEqual([])
  expect(rig.store.setListPrefs).toHaveBeenCalledWith({ pinned: [PLAN], collapsed: [PLAN] })
})

it('a pin or a fold recorded under a clone is the project’s, and is rewritten under its home once', () => {
  const rig = mount([row('a', WIDGETS), row('b', PLAN), row('c', LUNA), row('d', '/Users/a/code/other', { repo: at('/Users/a/code/other', 'github.com/acme/other') })], {
    listPrefs: { ...emptySnapshot().listPrefs, pinned: [PLAN, '/Users/a/code/other'], collapsed: [LUNA] },
  })
  // Read through the group: the project is pinned and folded though nothing is stored under its home.
  expect(container.querySelector('[draggable="true"] [aria-label="Pinned"]')).not.toBeNull()
  expect(titles().filter((title) => ['a', 'b', 'c'].includes(title))).toEqual([])
  // And the lists are rewritten so a toggle or a move works on what is stored.
  expect(rig.store.setListPrefs).toHaveBeenCalledWith({ pinned: [WIDGETS, '/Users/a/code/other'], collapsed: [WIDGETS] })
})

it('writes nothing when every pin and fold is already under its project’s home', () => {
  const rig = mount([row('a', WIDGETS), row('b', PLAN)], { listPrefs: { ...emptySnapshot().listPrefs, pinned: [WIDGETS], collapsed: [] } })
  expect(rig.store.setListPrefs).not.toHaveBeenCalled()
})

it('does not rewrite what is stored from a list that is filtered or still being searched', () => {
  const prefs = { ...emptySnapshot().listPrefs, pinned: [PLAN] }
  const filtered = mount([row('a', WIDGETS), row('b', PLAN)], { listPrefs: { ...prefs, agent: runtime.id } })
  expect(filtered.store.setListPrefs).not.toHaveBeenCalled()
  act(() => root.unmount())
  root = createRoot(container)
  const searching = mount([row('a', WIDGETS), row('b', PLAN)], { listPrefs: prefs }, { searching: true })
  expect(searching.store.setListPrefs).not.toHaveBeenCalled()
})

// ------------------------------------------------------------- gone folders

const GONE = new Map([
  ['/Users/a/code/old-one', 'This folder no longer exists.'],
  ['/Users/a/code/old-two', 'This folder no longer exists.'],
  ['/Users/a/.codex/worktrees/4d4b/widgets', 'This folder no longer exists.'],
])

const withGone = (): SessionSummary[] => [
  row('live', WIDGETS),
  row('in-gone-project', '/Users/a/code/old-one', { repo: at('/Users/a/code/old-one', null) }),
  row('in-gone-project-too', '/Users/a/code/old-one', { repo: at('/Users/a/code/old-one', null) }),
  row('in-other-gone-project', '/Users/a/code/old-two', { repo: at('/Users/a/code/old-two', null) }),
  // A worktree of a project that is still there, whose own folder was deleted.
  row('in-gone-worktree', '/Users/a/.codex/worktrees/4d4b/widgets', { repo: null, git: { originUrl: 'git@github.com:acme/widgets.git' } as never }),
]

it('does not list a project whose folder is gone, nor a worktree whose folder is gone, and keeps every conversation', () => {
  const history = withGone()
  const rig = mount(history, { foldersGone: GONE })
  expect(projects()).toEqual(['widgets'])
  expect(titles()).toEqual(['live'])
  // Nothing was archived, deleted or forgotten: the history still holds all of them for search and the archive.
  expect(rig.store.getSnapshot().history).toHaveLength(5)
})

it('does not recreate a gone project from the open folder or a Team’s recorded root', () => {
  const lost = '/Users/a/code/old-one'
  mount([row('live', WIDGETS), row('lost', lost, { repo: null })], {
    workspace: workspace(lost, null),
    foldersGone: new Map([[lost, 'This folder no longer exists.']]),
    teams: new Map([['old-team', { id: 'old-team', root: lost, name: 'Old work', members: [], intents: [], channel: [], updatedAt: 1 } as unknown as TeamState]]),
  })
  expect(projects()).toEqual(['widgets'])
  expect(goneLine()?.textContent).toContain('1 folder is gone')
})

it('says how many folders are gone in one quiet line at the end, counting a folder once', () => {
  mount(withGone(), { foldersGone: GONE })
  const line = goneLine()
  expect(line?.textContent).toContain('3 folders are gone')
  expect(container.querySelectorAll('[data-region="gone-folders"]')).toHaveLength(1)
  // It is the last thing in the list (the screen-reader announcer after it draws nothing).
  const rows = [...container.querySelector('[data-region="session-tree"]')!.children].filter((child) => child.getAttribute('role') !== 'status')
  expect(rows.at(-1)?.contains(line)).toBe(true)
})

it('says nothing when no folder is gone, and one folder is said in the singular', () => {
  mount([row('live', WIDGETS)])
  expect(goneLine()).toBeNull()
  act(() => root.unmount())
  root = createRoot(container)
  mount([row('live', WIDGETS), row('lost', '/Users/a/code/old-one', { repo: null })], {
    foldersGone: new Map([['/Users/a/code/old-one', 'This folder no longer exists.']]),
  })
  expect(goneLine()?.textContent).toContain('1 folder is gone')
})

it('lists a pinned conversation whose folder is gone in Pinned, because somebody put it there', () => {
  const lost = row('lost-but-pinned', '/Users/a/code/old-one', { repo: at('/Users/a/code/old-one', null) })
  mount([row('live', WIDGETS), lost], {
    foldersGone: new Map([['/Users/a/code/old-one', 'This folder no longer exists.']]),
    listPrefs: { ...emptySnapshot().listPrefs, pinnedSessions: [String(sessionKey(lost.runtime, lost.id))] },
  })
  expect(projects()).toEqual(['widgets'])
  expect(container.querySelector('[data-sidebar-band="pinned"]')?.textContent).toContain('lost-but-pinned')
  // The folder is still said to be gone, on the row.
  expect(container.querySelector('[data-sidebar-band="pinned"] [role="img"][aria-label^="Folder is gone"]')).not.toBeNull()
})

it('lists them again while the list is being searched, because a search is asking for them', () => {
  mount(withGone(), { foldersGone: GONE, listPrefs: { ...emptySnapshot().listPrefs, othersOpen: true } }, { searching: true })
  expect(projects().length).toBeGreaterThan(1)
  expect(titles()).toContain('in-gone-project')
  expect(goneLine()).toBeNull()
})

it('leaves a folder that exists again where it was, and counts only folders that are still gone', () => {
  const rig = mount(withGone(), { foldersGone: GONE })
  expect(goneLine()?.textContent).toContain('3 folders are gone')
  rig.update({ foldersGone: new Map([['/Users/a/code/old-two', 'This folder no longer exists.']]) })
  expect(goneLine()?.textContent).toContain('1 folder is gone')
  expect(projects().sort()).toEqual(['old-one', 'widgets'])
})

it('does not count a folder the person has asked the list to forget', () => {
  mount(withGone(), {
    foldersGone: GONE,
    listPrefs: { ...emptySnapshot().listPrefs, forgottenFolders: ['/Users/a/code/old-one'] },
  })
  expect(goneLine()?.textContent).toContain('2 folders are gone')
  act(() => root.unmount())
  root = createRoot(container)
  mount(withGone(), {
    foldersGone: GONE,
    listPrefs: { ...emptySnapshot().listPrefs, forgottenFolders: [...GONE.keys()] },
  })
  expect(goneLine()).toBeNull()
})

it('its menu forgets every folder that is gone, and names what that leaves alone', () => {
  const rig = mount(withGone(), { foldersGone: GONE })
  const action = goneLine()?.querySelector<HTMLButtonElement>('[aria-label="Actions for gone folders"]')
  expect(action).not.toBeNull()
  act(() => action!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  const forget = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.startsWith('Forget 3 folders'))
  expect(forget).toBeDefined()
  // A consequence the label cannot carry, so it is on the row.
  expect(forget?.textContent).toContain('Their conversations are kept')
  act(() => forget!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(rig.store.forgetFolders).toHaveBeenCalledWith([...GONE.keys()].sort())
})

it('puts the line at the end of Other projects when that fold is drawn', () => {
  const others = ['b', 'c', 'd', 'e'].map((name) => row(name, `/Users/a/code/${name}`, { repo: at(`/Users/a/code/${name}`, `github.com/acme/${name}`) }))
  mount([row('live', WIDGETS), ...others, row('lost', '/Users/a/code/old-one', { repo: null })], {
    foldersGone: new Map([['/Users/a/code/old-one', 'This folder no longer exists.']]),
    listPrefs: { ...emptySnapshot().listPrefs, othersOpen: true },
  })
  const fold = [...container.querySelectorAll<HTMLElement>('[aria-expanded]')].find((one) => one.textContent?.startsWith('Other projects'))
  expect(fold).toBeDefined()
  const block = fold!.closest('[data-slot="sidebar-menu"]')!.parentElement!
  expect(block.contains(goneLine())).toBe(true)
  expect(block.lastElementChild?.contains(goneLine())).toBe(true)
})

// ------------------------------------------------------------------- titles

const seatRig = (members: Array<{ id: string; role: string | null; name?: string }>, over: Partial<SessionSummary> = {}) => {
  const rows = members.map((member) => row(member.id, WIDGETS, { title: null, preview: null, ...over }))
  const keys = rows.map((one) => sessionKey(one.runtime, one.id))
  const team = {
    id: 'team-1', name: 'Retry the checkout call', updatedAt: 3, root: WIDGETS, members: keys.map(String),
    messaging: true, intents: [], channel: [],
  } as unknown as TeamState
  const goal = {
    goal: {
      id: team.id, root: WIDGETS, cwd: WIDGETS, sentence: 'Retry the checkout call', state: 'open', revision: 1,
      checkout: 'shared', dependsOn: [], origin: { kind: 'person' }, createdAt: 1, updatedAt: 3, receipt: null,
    },
    activity: 'working', waitingOn: [], board: team, receipt: null, problem: null,
    members: members.map((member, index) => ({
      id: `seat-${index}`, session: { runtime: runtime.id, sessionId: member.id }, role: member.role, openedAt: 1,
      closed: null, agent: { name: member.name ?? 'Claude Code' }, seatLabel: 'agent · model',
    })),
  } as unknown as GoalView
  const rig = mount(rows, { teams: new Map([[team.id, team]]), goals: new Map([[team.id, goal]]) })
  // Seats start folded; inspect their names through the real disclosure.
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Show the agents in Retry the checkout call"]')!.click())
  return rig
}

it('names a seat nobody typed to by its job and its Team, never “Untitled session”', () => {
  seatRig([{ id: 'seat-a', role: 'implementer' }, { id: 'seat-b', role: 'reviewer' }])
  const names = titles()
  expect(names).toContain('Implementer · Retry the checkout call')
  expect(names).toContain('Reviewer · Retry the checkout call')
  expect(names).not.toContain('Untitled session')
})

it('names a newly seated conversation by its job before its history arrives', () => {
  const rig = seatRig([{ id: 'seat-a', role: 'implementer' }])
  rig.update({ history: [] })
  expect(titles()).toContain('Implementer · Retry the checkout call')
})

it('does not synthesize a hidden gone-folder conversation back into its Team', () => {
  const rig = seatRig([{ id: 'seat-a', role: 'implementer' }], { cwd: PLAN, repo: at(PLAN) })
  rig.update({ foldersGone: new Map([[PLAN, 'This folder no longer exists.']]) })
  expect(titles()).toEqual([])
})

it('names a seat with no job by the agent it is, and still prefers what a person said', () => {
  seatRig([{ id: 'seat-a', role: null, name: 'Claude Code' }])
  expect(titles()).toContain('Claude Code · Retry the checkout call')
  act(() => root.unmount())
  root = createRoot(container)
  seatRig([{ id: 'seat-a', role: 'implementer' }], { preview: 'Retry the checkout call on a 502' })
  expect(titles()).toContain('Retry the checkout call on a 502')
  expect(titles()).not.toContain('Implementer · Retry the checkout call')
})

it('leaves a conversation that is no seat’s as “Untitled session”', () => {
  mount([row('loose', WIDGETS, { title: null, preview: null })])
  expect(titles()).toEqual(['Untitled session'])
})

it('never takes a conversation’s name from a summary an agent wrote of its own history', () => {
  mount([
    row('summary-title', WIDGETS, { title: '<summary> ## 1. Primary Request and Intent The user asked for a retry on a 502.', preview: 'Retry the checkout call' }),
    row('summary-only', WIDGETS, { title: null, preview: '<summary> 1. Primary Request and Intent: Worker 4 was asked to' }),
    row('continued', WIDGETS, { title: 'This session is being continued from a previous conversation that ran out of context.', preview: null }),
  ])
  const names = titles()
  expect(names).toContain('Retry the checkout call')
  expect(names.filter((name) => name === 'Untitled session')).toHaveLength(2)
  expect(names.some((name) => name.includes('Primary Request'))).toBe(false)
  expect(names.some((name) => name.includes('being continued'))).toBe(false)
})
