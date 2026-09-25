import { describe, expect, it } from 'vitest'

import type { SessionSummary, WorkspaceEntry } from '@harnessdesk/protocol'

import { folderShown, groupByProject, isWorktreeSession, migratedRoots, projectGroupRootOf, projectRootOf, repoKey } from './projects'

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

  /**
   * The public report (#907): opened through a path alias — a symlink, or
   * macOS's own `/var` → `/private/var` — the same project showed up as two
   * sidebar rows with different item counts, one of them empty. The workspace
   * list keeps the folder at the spelling it was opened at (`describeWorkspace`
   * never `realpath`'s it), but every session's `repo.root` is git's own
   * canonical answer, which resolves straight through the link. Grouping by
   * that canonical root, with the open workspace passed through so it claims
   * the same row, is what keeps this to one group instead of splitting the
   * populated one from an empty one at the raw spelling.
   */
  it('is one group, not an empty one and a populated one, for a workspace opened through an alias (#907)', () => {
    const real = '/private/var/folders/x/work/widgets'
    const link = '/var/folders/x/work/widgets'
    const groups = groupByProject(
      [
        session('a', real, null, 1, at(real)),
        session('b', real, null, 2, at(real)),
        session('c', real, null, 3, at(real)),
        session('d', real, null, 4, at(real)),
        session('e', real, null, 5, at(real)),
      ],
      [link],
      workspace(link, at(real)),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.root).toBe(real)
    expect(groups[0]?.sessions).toHaveLength(5)
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
    ).toBe(projectGroupRootOf(open))
  })

  /**
   * A review of #905 caught `ownPathOf`'s canonical form leaking into
   * `projectRootOf` — the same value `NewSessionChoice.tsx` and `App.tsx`
   * read as the folder to create a Goal, a flow or a race in. A subfolder
   * opened through a link is not textually inside the canonical checkout
   * (the link changes the prefix, not just the tail), so `ownPathOf` read it
   * as "must be the link's own top" and returned the repository's own root —
   * discarding the subfolder entirely. Work started there would land in a
   * different folder than the one that was actually open. `projectRootOf`
   * must never make that substitution: it is always the opened path, exactly
   * as opened, whatever grouping decides to call it.
   */
  it('keeps the opened path for creation, for a subfolder opened through a link', () => {
    const real = '/private/var/folders/x/work/widgets'
    const link = '/var/folders/x/work/widgets'
    const openedSub = `${link}/packages/ui`
    const open = workspace(openedSub, { root: real, worktree: false })
    expect(projectRootOf(open)).toBe(openedSub)
  })

  it('keeps the opened path for creation, for a link into a monorepo package', () => {
    const real = '/private/var/folders/x/monorepo'
    const link = '/var/folders/x/monorepo'
    const openedPackage = `${link}/packages/api`
    const open = workspace(openedPackage, { root: real, worktree: false })
    expect(projectRootOf(open)).toBe(openedPackage)
  })

  it('still leaves a genuine subfolder alone when the workspace also carries a checkoutRoot', () => {
    const sub = '/w/main/packages/ui'
    const open: WorkspaceEntry = { ...workspace(sub, { root: '/w/main', worktree: false }), checkoutRoot: '/w/main' }
    expect(projectRootOf(open)).toBe(sub)
  })
})

describe('projectGroupRootOf', () => {
  it('names the project a worktree is a checkout of, same as projectRootOf', () => {
    expect(projectGroupRootOf(workspace('/w/tree', { root: '/w/main', worktree: true }))).toBe('/w/main')
    expect(projectGroupRootOf(null)).toBeNull()
  })

  /**
   * The host keeps a workspace at the spelling it was opened at
   * (`describeWorkspace` never `realpath`s it, on purpose — a session with no
   * git repository is matched against the open list by that same raw
   * spelling). But its own sessions are grouped by `repo.root`, which git
   * resolves through a link — macOS keeps its temporary folders behind
   * `/var` → `/private/var` — so a project opened at its own top through such
   * a link used to be homed at the raw, un-resolved spelling while its
   * sessions grouped under the resolved one: the same folder, filed under two
   * keys, showed up twice in the sidebar (#898).
   */
  it('is not fooled by a link: opened at its own top through one, it still homes at the canonical root', () => {
    const real = '/private/var/folders/x/work/widgets'
    const link = '/var/folders/x/work/widgets'
    const open = workspace(link, { root: real, worktree: false })
    expect(projectGroupRootOf(open)).toBe(real)
    // Unlike `projectGroupRootOf`, `projectRootOf` never corrects the
    // spelling — that value is what creation reads, and canonicalising it
    // is the mistake #905's review caught.
    expect(projectRootOf(open)).toBe(link)
    const groups = groupByProject([session('a', real, null, 1, { root: real, worktree: false })], [], open)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.root).toBe(real)
    expect(groups[0]?.root).toBe(projectGroupRootOf(open))
  })

  it('leaves an open subfolder where grouping homes it, same as projectRootOf', () => {
    const sub = '/w/main/packages/ui'
    const open = workspace(sub, { root: '/w/main', worktree: false })
    expect(projectGroupRootOf(open)).toBe(sub)
  })
})

describe('migratedRoots', () => {
  it('rewrites a pin or a fold saved under the raw spelling a link introduced', () => {
    const real = '/private/var/folders/x/work/widgets'
    const link = '/var/folders/x/work/widgets'
    const open = workspace(link, { root: real, worktree: false })
    expect(migratedRoots([link, '/other/project'], open)).toEqual([real, '/other/project'])
  })

  it('leaves everything alone with no open workspace, or one that names no link', () => {
    expect(migratedRoots(['/a', '/b'], null)).toEqual(['/a', '/b'])
    const plain = workspace('/w/main', { root: '/w/main', worktree: false })
    expect(migratedRoots(['/a', '/w/main'], plain)).toEqual(['/a', '/w/main'])
  })
})

describe('folderShown', () => {
  it('names the project by its short name, and a folder inside it by the way down', () => {
    expect(folderShown('/home/dev/work/widgets', '/home/dev', '/home/dev/work/widgets')).toBe('widgets')
    expect(folderShown('/home/dev/work/widgets/packages/ui', '/home/dev', '/home/dev/work/widgets')).toBe('widgets/packages/ui')
  })

  it('shortens anything outside the project against home, and leaves the rest as it is', () => {
    expect(folderShown('/home/dev/elsewhere', '/home/dev', '/home/dev/work/widgets')).toBe('~/elsewhere')
    expect(folderShown('/srv/build', '/home/dev', null)).toBe('/srv/build')
  })
})
