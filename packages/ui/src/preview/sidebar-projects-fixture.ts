import {
  runtimeId,
  sessionKey,
  type GoalView,
  type RepoInfo,
  type SessionId,
  type SessionSummary,
  type TeamState,
  type WorkspaceEntry,
} from '@harnessdesk/protocol'

import type { AppSnapshot } from '../state/store'
import { captureHealth } from './provenance-fixture'

/**
 * A busy desk's left bar, as it stands after a month of Teams.
 *
 * One repository, `acme/widgets`, was cloned once per Team — the clones are
 * folders the person never opened, each holding a few conversations — and the
 * desk has also run agents in worktrees and clones that were deleted since.
 * That is the state the list is judged in: the clones are one project, the
 * deleted folders are not projects at all but are counted in one quiet line,
 * and the rows are named by what a person said rather than by what an agent
 * wrote about itself.
 *
 * Four things are here on purpose, because each is what an old list got wrong:
 *
 * - **Clones.** Four full clones of one repository, one of them the folder the
 *   person opened. One project row. Beside it, a second repository, and a
 *   folder with no remote, which keeps its own row.
 * - **Gone folders.** Twelve deleted folders — nine Codex worktrees and three
 *   Team clones — each holding a conversation, none listed.
 * - **Compaction.** A Claude conversation whose own name is the summary it
 *   wrote of its compacted history, and a seat whose only text is one.
 * - **Seats.** A Team's two seats, which nobody typed to.
 *
 * Every person, folder and remote is a placeholder.
 */

const CODEX = runtimeId('codex')
const CLAUDE = runtimeId('claude')
const CURSOR = runtimeId('cursor')

const HOME = '/Users/dev'
export const PROJECTS_ROOT = `${HOME}/code/widgets`
const ORIGIN = 'github.com/acme/widgets'
const CLONES = ['widgets-team-plan-pr18', 'widgets-team-luna-954', 'widgets-team-x1324'] as const

const minutes = (n: number): number => Date.now() - n * 60_000

const repoAt = (root: string, worktree = false, origin: string | null = ORIGIN): RepoInfo => ({
  root,
  worktree,
  ...(origin === null ? {} : { origin }),
})

interface Seed {
  readonly id: string
  readonly runtime: typeof CODEX | typeof CLAUDE | typeof CURSOR
  readonly title: string | null
  readonly preview?: string | null
  readonly cwd: string
  readonly repo: RepoInfo | null
  readonly ago: number
  readonly branch?: string
  readonly originUrl?: string
}

const row = (seed: Seed): SessionSummary =>
  ({
    id: seed.id as SessionId,
    runtime: seed.runtime,
    title: seed.title,
    preview: seed.preview ?? null,
    cwd: seed.cwd,
    status: { type: 'idle' },
    createdAt: minutes(seed.ago + 30),
    updatedAt: minutes(seed.ago),
    git: seed.branch || seed.originUrl ? { ...(seed.branch ? { branch: seed.branch } : {}), ...(seed.originUrl ? { originUrl: seed.originUrl } : {}) } : null,
    repo: seed.repo,
  }) as unknown as SessionSummary

/** What an agent writes after it compacts: its own summary, in the user's seat. */
const SUMMARY_TITLE = '<summary> ## 1. Primary Request and Intent The user asked to back off the checkout retry after a 502. ## 2. Key Technical Concepts'
const SUMMARY_PREVIEW = '<summary> 1. Primary Request and Intent: Worker 4 was asked to retry the checkout call'

const live: Seed[] = [
  { id: 'w1', runtime: CODEX, title: 'Retry the checkout call on a 502', cwd: PROJECTS_ROOT, repo: repoAt(PROJECTS_ROOT), ago: 6, branch: 'main' },
  // Claude named this conversation after the summary it wrote of its own compacted history; what the person asked is the name.
  { id: 'w2', runtime: CLAUDE, title: SUMMARY_TITLE, preview: 'Back off the checkout retry after a 502', cwd: PROJECTS_ROOT, repo: repoAt(PROJECTS_ROOT), ago: 22, branch: 'main' },
  { id: 'w3', runtime: CURSOR, title: 'Add jitter to the retry', cwd: PROJECTS_ROOT, repo: repoAt(PROJECTS_ROOT), ago: 41, branch: 'main' },
  { id: 'w4', runtime: CODEX, title: 'Document the retry settings', cwd: PROJECTS_ROOT, repo: repoAt(PROJECTS_ROOT), ago: 95, branch: 'main' },
  { id: 'w5', runtime: CODEX, title: 'Fix the flaky retry test', cwd: `${PROJECTS_ROOT}/.claude/worktrees/retry-jitter`, repo: repoAt(PROJECTS_ROOT, true), ago: 130, branch: 'fix/retry-jitter' },
  // The Team's two seats: the desk handed each its brief, so nobody typed a first message to either.
  { id: 'seat-impl', runtime: CLAUDE, title: null, preview: SUMMARY_PREVIEW, cwd: `${HOME}/code/${CLONES[0]}`, repo: repoAt(`${HOME}/code/${CLONES[0]}`), ago: 12, branch: 'team/plan-pr18' },
  { id: 'seat-review', runtime: CODEX, title: null, preview: null, cwd: `${HOME}/code/${CLONES[1]}`, repo: repoAt(`${HOME}/code/${CLONES[1]}`), ago: 15, branch: 'team/luna-954' },
  // Clones the person never opened: one project with the folder they did.
  { id: 'c1', runtime: CODEX, title: 'Plan the checkout boundary', cwd: `${HOME}/code/${CLONES[0]}`, repo: repoAt(`${HOME}/code/${CLONES[0]}`), ago: 300, branch: 'team/plan-pr18' },
  { id: 'c2', runtime: CURSOR, title: 'Review the retry tests', cwd: `${HOME}/code/${CLONES[1]}`, repo: repoAt(`${HOME}/code/${CLONES[1]}`), ago: 420, branch: 'team/luna-954' },
  { id: 'c3', runtime: CODEX, title: 'Reproduce the 502 locally', cwd: `${HOME}/code/${CLONES[2]}`, repo: repoAt(`${HOME}/code/${CLONES[2]}`), ago: 610, branch: 'team/x1324' },
  // A second repository, and a folder with no remote at all: each keeps its own row.
  { id: 'd1', runtime: CODEX, title: 'Rewrite the retry guide', cwd: `${HOME}/code/widgets-docs`, repo: repoAt(`${HOME}/code/widgets-docs`, false, 'github.com/acme/widgets-docs'), ago: 700, branch: 'main' },
  { id: 'd2', runtime: CLAUDE, title: 'Link the API reference', cwd: `${HOME}/code/widgets-docs`, repo: repoAt(`${HOME}/code/widgets-docs`, false, 'github.com/acme/widgets-docs'), ago: 760, branch: 'main' },
  { id: 'sc1', runtime: CODEX, title: 'Try a token bucket', cwd: `${HOME}/code/scratch`, repo: repoAt(`${HOME}/code/scratch`, false, null), ago: 900 },
]

const CODEX_WORKTREES = ['4d4b', 'b017', 'c3a9', '7e21', '91fa', 'a0d6', '2b88', 'e45c', '5f13']
const goneCodex: Seed[] = CODEX_WORKTREES.map((id, index) => ({
  id: `g-${id}`,
  runtime: CODEX,
  title: `Worktree conversation ${index + 1}`,
  cwd: `${HOME}/.codex/worktrees/${id}/widgets`,
  // The folder is gone, so git can say nothing about it; only the agent's own remote is left.
  repo: null,
  ago: 1000 + index * 40,
  originUrl: 'git@github.com:acme/widgets.git',
}))
const goneClones: Seed[] = ['old-1', 'old-2', 'old-3'].map((suffix, index) => ({
  id: `g-clone-${suffix}`,
  runtime: CODEX,
  title: `Deleted Team clone ${index + 1}`,
  cwd: `${HOME}/code/widgets-team-${suffix}`,
  repo: null,
  ago: 1500 + index * 60,
}))

export const projectsHistory: SessionSummary[] = [...live, ...goneCodex, ...goneClones].map(row)

/** Every folder above that no longer exists, said the way the host says it. */
export const projectsGone = new Map<string, string>(
  [...goneCodex, ...goneClones].map((seed) => [seed.cwd, 'This conversation’s folder no longer exists.']),
)

const workspaceAt = (path: string, repo: RepoInfo): WorkspaceEntry => ({
  path,
  name: path.split('/').at(-1) ?? path,
  lastOpenedAt: minutes(5),
  git: { branch: 'main' },
  repo,
})

const SEATS = [
  { id: 'seat-impl', runtime: CLAUDE, role: 'implementer', agent: 'Beta' },
  { id: 'seat-review', runtime: CODEX, role: 'reviewer', agent: 'Alpha' },
] as const

const team: TeamState = {
  id: 'team-checkout',
  name: 'Retry the checkout call on a 502',
  root: PROJECTS_ROOT,
  updatedAt: minutes(10),
  members: SEATS.map((seat) => sessionKey(seat.runtime, seat.id as SessionId)),
  messaging: true,
  intents: [],
  channel: [],
  nicknames: {},
  roles: {},
  plans: [],
  problem: null,
}

const goal: GoalView = {
  goal: {
    id: team.id,
    root: PROJECTS_ROOT,
    cwd: PROJECTS_ROOT,
    sentence: team.name,
    state: 'open',
    revision: 2,
    checkout: 'shared',
    dependsOn: [],
    origin: { kind: 'person' },
    createdAt: minutes(60),
    updatedAt: minutes(10),
    receipt: null,
  },
  activity: 'working',
  waitingOn: [],
  members: SEATS.map((seat, index) => ({
    id: `seat-${index + 1}`,
    agent: { id: `agent-${index + 1}`, name: seat.agent, origin: 'project' },
    briefDigest: null,
    seat: { runtime: seat.runtime },
    seatLabel: `${seat.agent} · default`,
    passedOver: [],
    standing: { kind: 'permission', permission: 'edit' },
    ceiling: null,
    checkout: { cwd: PROJECTS_ROOT, project: PROJECTS_ROOT, branch: 'team/work', head: 'a'.repeat(40) },
    session: { runtime: seat.runtime, sessionId: seat.id },
    board: team.id,
    role: seat.role,
    openedAt: minutes(60),
    closed: null,
  })) as unknown as GoalView['members'],
  board: team,
  receipt: null,
  problem: null,
}

/**
 * The preview's own store, over the desk above.
 *
 * Replaced outright rather than added to: the shared fixture's conversations
 * and Teams would draw themselves into this list as projects of their own.
 */
export const sidebarProjectsFixture = (base: AppSnapshot): AppSnapshot => {
  const opened = workspaceAt(PROJECTS_ROOT, repoAt(PROJECTS_ROOT))
  return {
    ...base,
    history: projectsHistory,
    foldersGone: projectsGone,
    sessions: new Map(),
    approvals: [],
    queues: new Map(),
    tasks: new Map(),
    teams: new Map([[team.id, team]]),
    goals: new Map([[team.id, goal]]),
    flowExecutions: new Map(),
    activeSessionKey: null,
    workspace: opened,
    workspaces: [opened, workspaceAt(`${HOME}/code/widgets-docs`, repoAt(`${HOME}/code/widgets-docs`, false, 'github.com/acme/widgets-docs'))],
    // The repository's capture has stopped: the project's menu says so, its row does not.
    captureHealth: new Map([
      [PROJECTS_ROOT, captureHealth({ project: PROJECTS_ROOT, state: 'stopped', reason: 'Repository metadata is refused.', nextStep: 'Use a supported checkout.' })],
    ]),
    listPrefs: { ...base.listPrefs, othersOpen: true, pinned: [], pinnedSessions: [], collapsed: [], forgottenFolders: [] },
  }
}

/** The search result is older than the first loaded page but belongs here. */
export const sidebarProjectsUnloadedSearchFixture = (base: AppSnapshot): AppSnapshot => {
  const fixture = sidebarProjectsFixture(base)
  const home = projectsHistory.find((summary) => summary.id === 'w1')
  const match = projectsHistory.find((summary) => summary.id === 'c1')
  if (!home || !match) throw new Error('the sidebar search fixture is incomplete')
  return {
    ...fixture,
    history: [match],
    historyIdentity: [home],
    teams: new Map(),
    goals: new Map(),
    flowExecutions: new Map(),
    captureHealth: new Map(),
  }
}
