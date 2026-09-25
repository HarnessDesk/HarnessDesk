import type {
  GitCommitDetail,
  GitLogCommit,
  GitLogPage,
  GitRefsSummary,
  GitStatus,
  GitWorktree,
} from '@harnessdesk/protocol'

import { PREVIEW_ROOT } from './sidebar-fixture'

/**
 * A repository for the git pane to show, in the shape the host sends.
 *
 * The pane is the shipped `GitPane`; what it had nothing to show was a
 * repository. Mounted without one it drew an empty frame, which on a design
 * page is its own kind of lie — a reader takes "Git history" at its word and
 * concludes the pane is blank.
 *
 * So this is a history with the things a graph is actually judged on: a
 * feature branch that merges back, a second one still open, a tag, a remote a
 * commit ahead, and a stash. Every answer is typed as the protocol's result
 * type for its method, not as whatever the pane happens to read today — which
 * is not a formality: `GitBranchRef.gone` is a field the pane does not read,
 * and the compiler refused this file until it was here. An invented fixture
 * that only matches the component is how a screen passes on this page and
 * fails against a real host. (The protocol validates params, not results, so
 * the type is the whole check — there is no runtime validator to add.)
 *
 * Authored by the demo persona. A real `git log` of this repository would be
 * realer, and would also put real addresses into a committed file.
 */

const DAY = 24 * 60 * 60 * 1000
const at = (daysAgo: number, hour = 11) => Date.UTC(2026, 8, 17 - daysAgo, hour)

const SHANE = { author: 'Shane', authorEmail: 'shane@harnessdesk.app' } as const
const AGENT = { author: 'Codex', authorEmail: 'agent@harnessdesk.app' } as const

const sha = (n: number) => n.toString(16).padStart(4, '0').repeat(10)

/* Newest first, the order `git log` gives. Two branches: `feat/worktree-list`
   merged into main at c7, and `fix/stale-rows` still open at c9. */
export const GIT_COMMITS: readonly GitLogCommit[] = [
  { sha: sha(9), parents: [sha(6)], subject: 'Keep a row whose folder is gone, and say so', ...AGENT, authoredAt: at(0, 15), committedAt: at(0, 15), refs: ['fix/stale-rows'] },
  { sha: sha(8), parents: [sha(7)], subject: 'Name the numbers the screens were still guessing', ...SHANE, authoredAt: at(0, 10), committedAt: at(0, 10), refs: ['HEAD -> main', 'origin/main'] },
  { sha: sha(7), parents: [sha(6), sha(5)], subject: "Merge branch 'feat/worktree-list'", ...SHANE, authoredAt: at(1, 17), committedAt: at(1, 17), refs: ['tag: v0.4.0'] },
  { sha: sha(6), parents: [sha(3)], subject: 'Let a sheet be its own size', ...SHANE, authoredAt: at(1, 12), committedAt: at(1, 12), refs: [] },
  { sha: sha(5), parents: [sha(4)], subject: 'Show which worktrees an agent is holding', ...AGENT, authoredAt: at(2, 16), committedAt: at(2, 16), refs: ['feat/worktree-list'] },
  { sha: sha(4), parents: [sha(3)], subject: 'List worktrees with the branch each one is on', ...AGENT, authoredAt: at(3, 14), committedAt: at(3, 14), refs: [] },
  { sha: sha(3), parents: [sha(2)], subject: 'One prompt at a time, so a room says it once', ...SHANE, authoredAt: at(4, 9), committedAt: at(4, 9), refs: [] },
  { sha: sha(2), parents: [sha(1)], subject: 'Sign in and out over ACP', ...SHANE, authoredAt: at(6, 13), committedAt: at(6, 13), refs: [] },
  { sha: sha(1), parents: [], subject: 'HarnessDesk 0.1.0', ...SHANE, authoredAt: at(9, 10), committedAt: at(9, 10), refs: [] },
]

export const gitLog = (): GitLogPage => ({ commits: GIT_COMMITS, hasMore: false })

export const gitRefs = (): GitRefsSummary => ({
  headSha: sha(8),
  branch: 'main',
  branches: [
    { name: 'main', sha: sha(8), current: true, committedAt: at(0, 10), upstream: 'origin/main', ahead: 0, behind: 0, gone: false },
    { name: 'fix/stale-rows', sha: sha(9), current: false, committedAt: at(0, 15), upstream: null, ahead: 1, behind: 1, gone: false },
    { name: 'feat/worktree-list', sha: sha(5), current: false, committedAt: at(2, 16), upstream: null, ahead: 0, behind: 3, gone: false },
  ],
  remotes: [{ remote: 'origin', name: 'main', sha: sha(8), committedAt: at(0, 10) }],
  tags: [{ name: 'v0.4.0', sha: sha(7), at: at(1, 17) }],
  stashes: [{ ref: 'stash@{0}', sha: sha(10), message: 'WIP on main: probe the row height', at: at(0, 9) }],
})

export const gitStatus = (): GitStatus => ({
  root: PREVIEW_ROOT,
  branch: 'main',
  ahead: 0,
  behind: 0,
  files: [],
  concluding: null,
})

export const gitWorktrees = (): readonly GitWorktree[] => []

export const gitCommit = (wanted: string): GitCommitDetail | null => {
  const commit = GIT_COMMITS.find((one) => one.sha === wanted)
  if (!commit) return null
  return {
    ...commit,
    committer: commit.author,
    message: `${commit.subject}\n`,
    files: [],
  }
}

export { DAY }
