import { describe, expect, it } from 'vitest'

import type { SessionSummary, WorkspaceEntry } from '@harnessdesk/protocol'

import { groupByProject, isWorktreeSession, projectRootOf, repoKey } from './projects'

const session = (
  id: string,
  cwd: string,
  originUrl: string | null,
  updatedAt = 1,
  repo?: { root: string; worktree: boolean } | null,
): SessionSummary =>
  ({
    id,
    runtime: 'codex',
    title: id,
    preview: '',
    cwd,
    status: 'idle',
    createdAt: updatedAt,
    updatedAt,
    git: originUrl ? { sha: 'x', branch: 'main', originUrl } : null,
    ...(repo === undefined ? {} : { repo }),
  }) as unknown as SessionSummary

const workspace = (path: string, repo?: { root: string; worktree: boolean } | null): WorkspaceEntry =>
  ({ path, name: path.split('/').at(-1) ?? path, lastOpenedAt: 1, ...(repo === undefined ? {} : { repo }) })

describe('repoKey', () => {
  it('spells one repository one way', () => {
    expect(repoKey('git@github.com-work:AcmeCo/ledger-api.git')).toBe('github.com/acmeco/ledger-api')
    expect(repoKey('https://github.com/AcmeCo/ledger-api')).toBe('github.com/acmeco/ledger-api')
    expect(repoKey('ssh://git@github.com/AcmeCo/ledger-api.git')).toBe('github.com/acmeco/ledger-api')
  })
  it('has nothing to say without a remote', () => {
    expect(repoKey(null)).toBeNull()
    expect(repoKey('')).toBeNull()
  })
})

describe('groupByProject', () => {
  const origin = 'git@github.com-work:AcmeCo/ledger-api.git'
  const main = '/Users/a/code/ledger-api'
  const at = (root: string, worktree = false) => ({ root, worktree })

  it('folds worktree checkouts into their project, homed at the main checkout', () => {
    const groups = groupByProject(
      [
        session('a', main, origin, 5),
        session('b', '/Users/a/.codex/worktrees/4d4b/ledger-api', origin, 9),
        session('c', '/Users/a/.codex/worktrees/b017/ledger-api', origin, 2),
      ],
      [],
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.root).toBe(main)
    expect(groups[0]?.name).toBe('ledger-api')
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(['b', 'a', 'c'])
    expect(groups[0]?.updatedAt).toBe(9)
  })

  it('prefers an open workspace as the home even with fewer sessions', () => {
    const groups = groupByProject(
      [
        session('a', '/Users/a/elsewhere/ledger-api', origin),
        session('b', '/Users/a/elsewhere/ledger-api', origin),
        session('c', main, origin),
      ],
      [main],
    )
    expect(groups[0]?.root).toBe(main)
  })

  it('does not rename a project because a subfolder was worked in last', () => {
    // Both the repo root and packages/desktop are open workspaces of one
    // project. A session in the subfolder being the most recent must not move
    // the project's home there.
    const sub = `${main}/packages/desktop`
    const groups = groupByProject(
      [session('newest', sub, origin, 9), session('a', main, origin, 5), session('b', main, origin, 4)],
      [main, sub],
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.root).toBe(main)
    expect(groups[0]?.name).toBe('ledger-api')
  })

  it('homes a project at the folder you have open', () => {
    const sub = `${main}/packages/desktop`
    const groups = groupByProject(
      [session('a', main, origin, 9), session('b', main, origin, 8), session('c', sub, origin, 1)],
      [main, sub],
      workspace(sub),
    )
    expect(groups[0]?.root).toBe(sub)
  })

  it('lets a session with no git info join the project another session placed its folder in', () => {
    const groups = groupByProject([session('codex', main, origin), session('claude', main, null)], [])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.sessions).toHaveLength(2)
  })

  it('keeps folders without a remote apart', () => {
    const groups = groupByProject([session('a', '/tmp/x', null), session('b', '/tmp/y', null)], [])
    expect(groups.map((g) => g.root).sort()).toEqual(['/tmp/x', '/tmp/y'])
  })

  it('does not let a worktree be the home when only worktrees exist', () => {
    const groups = groupByProject(
      [session('a', '/Users/a/.codex/worktrees/1/repo', origin, 1), session('b', '/Users/a/.codex/worktrees/2/repo', origin, 3)],
      [],
    )
    expect(groups[0]?.root).toMatch(/worktrees\/\d\/repo$/)
    expect(groups[0]?.name).toBe('repo')
  })

  // The repository the host read from git. This is the only signal most
  // agents give anything for: they report no remote at all.
  it('folds a worktree in on the repository alone, with no remote anywhere', () => {
    const tree = `${main}/.claude/worktrees/hours-bug`
    const groups = groupByProject(
      [
        session('a', main, null, 5, at(main)),
        session('b', tree, null, 9, at(main, true)),
        session('c', `${main}/packages/desktop`, null, 2, at(main)),
      ],
      [],
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.root).toBe(main)
    expect(groups[0]?.name).toBe('ledger-api')
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(['b', 'a', 'c'])
  })

  it('reconciles a remote with a repository so one project is never two', () => {
    // The folder of the second row has since been deleted, so the host could
    // ask git nothing about it; all it has is the remote the agent recorded.
    const groups = groupByProject(
      [
        session('live', main, origin, 5, at(main)),
        session('gone', '/Users/a/.codex/worktrees/4d4b/ledger-api', origin, 9, null),
      ],
      [],
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.root).toBe(main)
    expect(groups[0]?.sessions).toHaveLength(2)
  })

  it('does not rename a project after a worktree you have open', () => {
    const tree = '/Users/a/.harnessdesk/worktrees/ledger-api-7ae5/hours-bug'
    const groups = groupByProject(
      [session('a', main, null, 5, at(main)), session('b', tree, null, 9, at(main, true))],
      [main, tree],
      workspace(tree, at(main, true)),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.root).toBe(main)
    expect(groups[0]?.name).toBe('ledger-api')
  })

  it('keeps a removed worktree with the project whose folder it was cut from', () => {
    // git can say nothing about a folder that is gone. The path can: Claude
    // Code keeps its worktrees inside the repository they came from.
    const groups = groupByProject(
      [
        session('live', main, null, 5, at(main)),
        session('gone', `${main}/.claude/worktrees/hours-bug`, null, 9, null),
      ],
      [],
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.root).toBe(main)
  })

  it('will not invent a project from a path nothing else vouches for', () => {
    const groups = groupByProject(
      [session('gone', '/Users/a/code/never-seen/.claude/worktrees/x', null, 9, null)],
      [],
    )
    expect(groups[0]?.root).toBe('/Users/a/code/never-seen/.claude/worktrees/x')
  })

  it('keeps two repositories apart even where their folders look alike', () => {
    const other = '/Users/a/code/other-api'
    const groups = groupByProject(
      [
        session('a', `${main}/.claude/worktrees/x`, null, 1, at(main, true)),
        session('b', `${other}/.claude/worktrees/x`, null, 2, at(other, true)),
      ],
      [],
    )
    expect(groups.map((g) => g.root).sort()).toEqual([main, other].sort())
  })
})

describe('isWorktreeSession', () => {
  it('takes git’s answer over the shape of the path', () => {
    // A folder called "worktrees" that is the main checkout is not one.
    const summary = session('a', '/Users/a/worktrees/thing', null, 1, { root: '/Users/a/worktrees/thing', worktree: false })
    expect(isWorktreeSession(summary)).toBe(false)
  })
  it('falls back to the path when the host could not ask', () => {
    expect(isWorktreeSession(session('a', '/Users/a/.codex/worktrees/1/repo', null))).toBe(true)
    expect(isWorktreeSession(session('b', '/Users/a/code/repo', null))).toBe(false)
  })
})

describe('projectRootOf', () => {
  it('names the project a worktree is a checkout of', () => {
    expect(projectRootOf(workspace('/w/tree', { root: '/w/main', worktree: true }))).toBe('/w/main')
    expect(projectRootOf(workspace('/w/main'))).toBe('/w/main')
    expect(projectRootOf(null)).toBeNull()
  })

  it('leaves an open subfolder where grouping homes it', () => {
    // Not the repository root: `groupByProject` lets the folder you have open
    // be its project's home, and a second opinion here is a duplicate row.
    const sub = '/w/main/packages/ui'
    const open = workspace(sub, { root: '/w/main', worktree: false })
    expect(projectRootOf(open)).toBe(sub)
    expect(
      groupByProject([session('a', sub, null, 1, { root: '/w/main', worktree: false })], [], open)[0]?.root,
    ).toBe(projectRootOf(open))
  })
})
