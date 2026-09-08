import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { RuntimeInfo, SessionSummary, WorkspaceEntry } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
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

const session = (id: string, cwd: string, repo: { root: string; worktree: boolean }): SessionSummary =>
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

const workspace = (path: string, repo: { root: string; worktree: boolean }): WorkspaceEntry =>
  ({ path, name: path.split('/').at(-1) ?? path, lastOpenedAt: 1, repo })

const render = (history: SessionSummary[], open: WorkspaceEntry): void => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    runtimes: [runtime],
    history,
    workspace: open,
    workspaces: [open],
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    setListPrefs: vi.fn(),
    setProjectsCollapsed: vi.fn(),
    toggleProjectCollapsed: vi.fn(),
    setOthersOpen: vi.fn(),
  } as unknown as AppStore
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
    (head) => head.querySelector('[class*="groupName"]')?.textContent ?? '',
  )

/** The row the list is calling the folder you are in. */
const currentProject = (): string | null =>
  container.querySelector<HTMLElement>('[data-current] [class*="groupName"]')?.textContent ?? null

it('gives an open subfolder one row, not a second empty one for its repository', () => {
  // The subfolder is the project's home — grouping lets the folder you have
  // open claim it — so the list must look for it under that name too. Asking
  // for `/repo` instead pushed an empty `/repo` row beside the real one.
  const sub = `${REPO}/packages/ui`
  render([session('a', sub, { root: REPO, worktree: false })], workspace(sub, { root: REPO, worktree: false }))

  expect(projects()).toEqual(['ui'])
  expect(currentProject()).toBe('ui')
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
