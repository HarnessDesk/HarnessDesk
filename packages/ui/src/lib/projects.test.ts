import { describe, expect, it } from 'vitest'

import type { RepoInfo, SessionSummary, TeamState, WorkspaceEntry } from '@harnessdesk/protocol'

import { commandShown, folderShown, groupByProject, groupHolding, isWorktreeSession, migratedRoots, projectGroupRootOf, projectRootOf, repoKey, roomGroupRootOf } from './projects'

const session = (
  id: string,
  cwd: string,
  originUrl: string | null,
  updatedAt = 1,
  repo?: RepoInfo | null,
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

const workspace = (path: string, repo?: RepoInfo | null): WorkspaceEntry =>
  ({ path, name: path.split('/').at(-1) ?? path, lastOpenedAt: 1, ...(repo === undefined ? {} : { repo }) })

describe('roomGroupRootOf', () => {
  const link = '/var/folders/x/work/widgets'
  const real = '/private/var/folders/x/work/widgets'
  const opened = [workspace(link, { root: real, worktree: false })]
  const room = { root: link, realRoot: real } as TeamState

  it('files a room at an open folder spelling under that folder group', () => {
    expect(roomGroupRootOf(room, opened)).toBe(real)
  })

  it('uses the resolved root when the linked folder is not open', () => {
    expect(roomGroupRootOf(room, [])).toBe(real)
  })

  it('falls back to the recorded root without a resolved spelling', () => {
    expect(roomGroupRootOf({ root: link } as TeamState, [])).toBe(link)
  })

  it('keeps accepting a bare root string', () => {
    expect(roomGroupRootOf(link, opened)).toBe(real)
  })

  it('files a linked room where the same room at the resolved spelling goes, when that folder is open as a worktree', () => {
    const checkout = '/private/var/folders/x/work/widgets'
    const worktree = '/private/var/folders/x/work/widgets/.worktrees/retry'
    const open = [workspace(worktree, { root: checkout, worktree: true })]
    expect(roomGroupRootOf({ root: worktree } as TeamState, open)).toBe(checkout)
    expect(roomGroupRootOf({ root: '/var/folders/x/work/widgets/.worktrees/retry', realRoot: worktree } as TeamState, open)).toBe(checkout)
  })
})

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

  it('groups host-supplied single-label repository identities with raw remotes', () => {
    const clone = '/demo/widgets-clone'
    const home = '/demo/widgets'
    const repo = { root: home, worktree: false, origin: 'internal/acme/widgets' }
    const groups = groupByProject([
      session('home', home, null, 1, repo),
      session('clone', clone, null, 2, { ...repo, root: clone }),
      session('recorded', '/demo/widgets-old', 'git@internal:acme/widgets.git', 3),
    ], [workspace(home, repo)], workspace(home, repo))
    expect(groups).toHaveLength(1)
    expect(groups[0]?.root).toBe(home)
    expect(groups[0]?.sessions.map(one => one.id)).toEqual(['recorded', 'clone', 'home'])
  })

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
   * sidebar rows with different item counts, one of them empty. `groupByProject`
   * alone cannot show this: every session here already carries the same
   * `repo.root`, so it was always going to fold into one group, fix or no fix
   * — a fact a run against the pre-fix `groupByProject` confirms. The row
   * `SessionTree.tsx` actually adds a second, empty copy of is keyed by
   * comparing `projectGroupRootOf(workspace)` against the group's own root,
   * so that is the comparison this asserts: the same alias `projectGroupRootOf`
   * is already guarded against, one link deep, one more time at the boundary
   * the sidebar itself reads.
   */
  it('answers the group its own row is compared against, for a workspace opened through an alias (#907)', () => {
    const real = '/private/var/folders/x/work/widgets'
    const link = '/var/folders/x/work/widgets'
    const open = workspace(link, at(real))
    const groups = groupByProject([session('a', real, null, 1, at(real))], [link], open)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.root).toBe(real)
    expect(projectGroupRootOf(open)).toBe(groups[0]?.root)
  })

  /**
   * The same report, for a folder no git repository ever names (#907). Outside
   * git there is no `repo.root` to fold sessions by, so `groupByProject` keys
   * a session with no remote by its own `cwd` — and an agent process started
   * at a link already reports that `cwd` resolved, the same way `getcwd`
   * always does. The open workspace's own `path` is kept at the alias
   * spelling on purpose (`describeWorkspace`), so without `realPath` the two
   * disagree and the folder shows up twice, one of them empty — reproduced
   * here by leaving `realPath` off the workspace the way the host used to
   * answer before it carried one.
   */
  it('answers the group its own row is compared against, for a non-git folder opened through an alias (#907)', () => {
    const real = '/private/var/folders/x/work/scratch'
    const link = '/var/folders/x/work/scratch'
    const openWithoutRealPath: WorkspaceEntry = { path: link, name: 'scratch', lastOpenedAt: 1 }
    const openWithRealPath: WorkspaceEntry = { ...openWithoutRealPath, realPath: real }
    const groups = groupByProject([session('a', real, null, 1, null)], [link], openWithRealPath)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.root).toBe(real)
    // Fails without `realPath`: `projectGroupRootOf` had nothing left to
    // correct the alias with, so it answered the raw spelling instead.
    expect(projectGroupRootOf(openWithoutRealPath)).not.toBe(groups[0]?.root)
    expect(projectGroupRootOf(openWithRealPath)).toBe(groups[0]?.root)
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

/**
 * Full clones of one repository.
 *
 * A worktree is a checkout of a project and folds into it; a clone is a second
 * copy of the same repository in a folder of its own, and the Team clones a
 * desk makes — one per Team — left one repository as a dozen project rows.
 * Git cannot say two clones are one thing and neither can their folders: only
 * the remote does, so the host sends each folder's `origin` and the list files
 * every folder with the same `owner/name` on the same host under one project.
 */
describe('groupByProject — clones of one repository', () => {
  const origin = 'acme-widgets-origin'
  const widgets = '/Users/a/code/widgets'
  const planClone = '/Users/a/code/widgets-team-plan-pr18'
  const lunaClone = '/Users/a/code/widgets-team-luna-954'
  const repoAt = (root: string, worktree = false, remote: string | null = origin) => ({
    root,
    worktree,
    ...(remote === null ? {} : { origin: `github.com/acme/${remote}` }),
  })
  /** A row with the dates grouping reads to say which folder was worked in first. */
  const row = (id: string, cwd: string, repo: RepoInfo | null, createdAt: number, updatedAt = createdAt): SessionSummary =>
    ({
      id, runtime: 'codex', title: id, preview: '', cwd, status: 'idle', createdAt, updatedAt, git: null, repo,
    }) as unknown as SessionSummary

  it('files every clone of a repository under one project', () => {
    const groups = groupByProject(
      [
        row('a', widgets, repoAt(widgets), 10),
        row('b', planClone, repoAt(planClone), 30),
        row('c', lunaClone, repoAt(lunaClone), 40),
        row('d', widgets, repoAt(widgets), 20),
      ],
      [widgets],
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.root).toBe(widgets)
    expect(groups[0]?.name).toBe('widgets')
    expect(groups[0]?.sessions.map((one) => one.id)).toEqual(['c', 'b', 'd', 'a'])
    expect(groups[0]?.updatedAt).toBe(40)
    expect(groups[0]?.folders).toEqual(expect.arrayContaining([widgets, planClone, lunaClone]))
  })

  it('uses origin signals from visible uncached matches without letting their dates choose the home', () => {
    const goneClone = '/gone/widgets-clone'
    const home = row('home', widgets, repoAt(widgets), 10)
    const fromRemote = {
      ...row('remote-match', goneClone, repoAt(goneClone, false, null), 1),
      git: { originUrl: 'https://github.com/acme/acme-widgets-origin.git' },
    } as SessionSummary
    const sameFolderWithoutMetadata = row('no-git-match', goneClone, null, 2)
    const sameRootWithoutRemote = row(
      'root-match', `${goneClone}/packages/ui`, { root: goneClone, worktree: false }, 3,
    )

    const groups = groupByProject(
      [home, fromRemote, sameFolderWithoutMetadata, sameRootWithoutRemote],
      [widgets],
      null,
      { identityHistory: [home] },
    )

    expect(groups).toHaveLength(1)
    expect(groups[0]?.root).toBe(widgets)
    expect(groups[0]?.sessions.map((summary) => summary.id).sort()).toEqual([
      'home', 'no-git-match', 'remote-match', 'root-match',
    ])
  })

  it('keeps a clone with no remote apart, and so a repository somebody else owns', () => {
    const scratch = '/Users/a/code/scratch'
    const groups = groupByProject(
      [
        row('a', widgets, repoAt(widgets), 10),
        row('b', planClone, repoAt(planClone), 20),
        row('c', scratch, repoAt(scratch, false, null), 30),
        row('d', '/Users/a/code/other', { root: '/Users/a/code/other', worktree: false, origin: 'github.com/acme/other-repo' }, 40),
        row('e', '/Users/a/code/fork', { root: '/Users/a/code/fork', worktree: false, origin: 'github.com/jane-doe/acme-widgets-origin' }, 50),
        row('f', '/Users/a/code/mirror', { root: '/Users/a/code/mirror', worktree: false, origin: 'git.example.com/acme/acme-widgets-origin' }, 60),
      ],
      [widgets],
    )
    expect(groups.map((group) => group.root).sort()).toEqual(
      [widgets, scratch, '/Users/a/code/other', '/Users/a/code/fork', '/Users/a/code/mirror'].sort(),
    )
    expect(groups.find((group) => group.root === widgets)?.sessions.map((one) => one.id).sort()).toEqual(['a', 'b'])
  })

  it('homes the project at a checkout the person opened, whatever the clones hold', () => {
    const groups = groupByProject(
      [
        row('a', widgets, repoAt(widgets), 100),
        row('b', planClone, repoAt(planClone), 10),
        row('c', planClone, repoAt(planClone), 20),
        row('d', lunaClone, repoAt(lunaClone), 30),
      ],
      [widgets],
    )
    expect(groups[0]?.root).toBe(widgets)
  })

  it('with none of them opened, homes it at the folder whose history began first, in any order', () => {
    const rows = [
      row('a', lunaClone, repoAt(lunaClone), 300),
      row('b', widgets, repoAt(widgets), 100),
      row('c', planClone, repoAt(planClone), 200),
    ]
    expect(groupByProject(rows, [])[0]?.root).toBe(widgets)
    expect(groupByProject([...rows].reverse(), [])[0]?.root).toBe(widgets)
    // The oldest conversation is the folder's age, not its newest one.
    const busy = [row('a', planClone, repoAt(planClone), 500, 900), row('b', lunaClone, repoAt(lunaClone), 400, 410)]
    expect(groupByProject(busy, [])[0]?.root).toBe(lunaClone)
  })

  it('among several opened folders, the one worked in first is home', () => {
    const groups = groupByProject(
      [
        row('a', planClone, repoAt(planClone), 10),
        row('b', widgets, repoAt(widgets), 90),
        row('c', lunaClone, repoAt(lunaClone), 50),
      ],
      [widgets, planClone, lunaClone],
    )
    expect(groups[0]?.root).toBe(planClone)
  })

  it('is not renamed after a clone you have open', () => {
    // Opening a copy to look at it must not rename the project after it — the same rule a worktree has.
    const groups = groupByProject(
      [row('a', widgets, repoAt(widgets), 10), row('b', planClone, repoAt(planClone), 20)],
      [widgets, planClone],
      workspace(planClone, repoAt(planClone)),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.root).toBe(widgets)
    expect(groupHolding(groups, workspace(planClone, repoAt(planClone)))).toBe(groups[0])
  })

  it('is homed at the clone you have open when it is the only one you opened', () => {
    // A desk that only ever opened the clone: the project is the folder in front of it.
    const open = workspace(planClone, repoAt(planClone))
    const groups = groupByProject(
      [row('a', widgets, repoAt(widgets), 10), row('b', planClone, repoAt(planClone), 20)],
      [planClone],
      open,
    )
    expect(groups[0]?.root).toBe(planClone)
    expect(projectGroupRootOf(open)).toBe(groups[0]?.root)
  })

  it('still lets the folder you have open claim the home inside the checkout that leads', () => {
    const sub = `${widgets}/packages/ui`
    const groups = groupByProject(
      [row('a', widgets, repoAt(widgets), 10), row('b', sub, repoAt(widgets), 20), row('c', planClone, repoAt(planClone), 30)],
      [widgets, sub],
      workspace(sub, repoAt(widgets)),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.root).toBe(sub)
  })

  it('files an open clone that has no conversations yet under the project it is a clone of', () => {
    const fresh = '/Users/a/code/widgets-team-new'
    const open = workspace(fresh, repoAt(fresh))
    const groups = groupByProject([row('a', widgets, repoAt(widgets), 10)], [widgets, fresh], open)
    expect(groups).toHaveLength(1)
    expect(groupHolding(groups, open)).toBe(groups[0])
    // …and one that is a different repository is not.
    const stranger = workspace('/Users/a/code/elsewhere', { root: '/Users/a/code/elsewhere', worktree: false, origin: 'github.com/acme/elsewhere' })
    expect(groupHolding(groups, stranger)).toBeUndefined()
  })

  it('keeps a worktree of a clone with the project, and a row that knows only the remote or only the root', () => {
    const tree = `${planClone}/.claude/worktrees/hours-bug`
    const goneTree = '/Users/a/.codex/worktrees/4d4b/widgets'
    const groups = groupByProject(
      [
        row('a', widgets, repoAt(widgets), 10),
        row('b', tree, repoAt(planClone, true), 20),
        // Its folder was deleted, so git could say nothing: only the agent's own remote is left.
        { ...row('c', goneTree, null, 30), git: { originUrl: 'git@github.com-work:Acme/acme-widgets-origin.git' } } as SessionSummary,
        // A repository the host could name but whose remote it could not read: known by its root alone.
        row('d', lunaClone, { root: lunaClone, worktree: false }, 40),
        row('e', lunaClone, repoAt(lunaClone), 50),
      ],
      [widgets],
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.sessions).toHaveLength(5)
    expect(groups[0]?.root).toBe(widgets)
  })

  it('leaves single-checkout projects exactly as they were', () => {
    const groups = groupByProject([row('a', widgets, repoAt(widgets), 10), row('b', `${widgets}/packages/ui`, repoAt(widgets), 20)], [])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.root).toBe(widgets)
    expect(groups[0]?.folders).toEqual([widgets, `${widgets}/packages/ui`])
  })
})

describe('migratedRoots — folders that were folded into a project', () => {
  const widgets = '/Users/a/code/widgets'
  const planClone = '/Users/a/code/widgets-team-plan-pr18'
  const lunaClone = '/Users/a/code/widgets-team-luna-954'
  const remote = { origin: 'github.com/acme/widgets' }
  const row = (id: string, cwd: string, createdAt: number): SessionSummary =>
    ({ id, runtime: 'codex', title: id, preview: '', cwd, status: 'idle', createdAt, updatedAt: createdAt, git: null, repo: { root: cwd, worktree: false, ...remote } }) as unknown as SessionSummary
  const groups = groupByProject([row('a', widgets, 10), row('b', planClone, 20), row('c', lunaClone, 30)], [widgets])

  it('moves a pin or a fold saved under a clone onto the project that took it in', () => {
    expect(migratedRoots([planClone, '/elsewhere'], null, groups)).toEqual([widgets, '/elsewhere'])
    expect(migratedRoots([lunaClone, widgets, planClone], null, groups)).toEqual([widgets])
  })

  it('leaves a room’s id and a folder that is not in any project alone', () => {
    expect(migratedRoots(['room-1', '/elsewhere'], null, groups)).toEqual(['room-1', '/elsewhere'])
  })

  it('still corrects the spelling a link introduced, then folds', () => {
    const real = '/private/var/folders/x/work/widgets'
    const link = '/var/folders/x/work/widgets'
    const open = workspace(link, { root: real, worktree: false })
    const linked = groupByProject([row('a', real, 10), row('b', planClone, 20)], [link], open)
    expect(migratedRoots([link, planClone], open, linked)).toEqual([linked[0]!.root])
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

describe('commandShown', () => {
  it('shortens every home path in a command, including quotes and assignments', () => {
    expect(commandShown('ROOT=/home/dev node "/home/dev/tools/land.mjs" < /home/dev/input', '/home/dev'))
      .toBe('ROOT=~ node "~/tools/land.mjs" < ~/input')
  })
  it('shortens home paths after path-list separators', () => {
    expect(commandShown('PATH=/usr/bin:/home/dev/bin node /home/dev/tools/land.mjs --check', '/home/dev'))
      .toBe('PATH=/usr/bin:~/bin node ~/tools/land.mjs --check')
  })
  it('shortens bare home entries before and after path-list separators', () => {
    const home = '/home/dev'
    expect(commandShown(`PATH=${home}:/usr/bin:${home}:${home}/bin node`, home))
      .toBe('PATH=~:/usr/bin:~:~/bin node')
  })
  it('keeps sibling names and embedded path fragments in path lists intact', () => {
    const command = 'PATH=/usr/bin:/home/user/bin:/srv/home/u/bin:/home/user2 node'
    expect(commandShown(command, '/home/u')).toBe(command)
  })
  it('keeps other homes, sibling names and embedded path fragments intact', () => {
    const command = 'node /home/dev/work-two/run /home/agent/run /tmp/home/dev/work/run prefix/home/dev/work/run'
    expect(commandShown(command, '/home/dev/work')).toBe(command)
  })
  it('keeps commands intact before home is known and handles a trailing separator', () => {
    expect(commandShown('node /home/dev/run', null)).toBe('node /home/dev/run')
    expect(commandShown('/home/dev/run', '/home/dev/')).toBe('~/run')
  })
  it('treats characters in a home directory literally', () => {
    expect(commandShown('node "/home/dev/.profile/tools/run" /home/dev/Xprofile/run', '/home/dev/.profile'))
      .toBe('node "~/tools/run" /home/dev/Xprofile/run')
  })
})
