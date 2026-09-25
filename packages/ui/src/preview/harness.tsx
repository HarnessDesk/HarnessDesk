import type { ReactNode } from 'react'

import {
  runtimeId,
  sessionKey,
  type AgentAttachmentsView,
  type AgentEntry,
  type CarryFindingsInput,
  type FindingPublicationsView,
  type CeilingLevel,
  type CheckUnseen,
  type FindingDetailPage,
  type FindingView,
  type FlowEntry,
  type FlowExecution,
  type FlowPreview,
  type FlowSeat,
  type FlowUpdatePreview,
  type FlowUpdateResult,
  type GoalView,
  type MachineSeating,
  type ProjectChecks,
  type ModelInfo,
  type OptionValue,
  type RuntimeInfo,
  type SeatRecord,
  type SeatCeiling,
  type SeatPlan,
  type Session,
  type SessionId,
  type SessionKey,
  type TeamPeerInfo,
  type TeamState,
} from '@harnessdesk/protocol'

import { AppWindowMode } from '../components/AppWindow'
import { EMPTY_FINDINGS_STATE, findingDetail, findingsListState } from './findings-fixture'
import type { FindingFilter } from '../lib/findings'
import { Boundary } from './boundary'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import {
  NARROW_WINDOW,
  activate,
  areaVisible,
  focusView,
  moveView,
  resizeDock,
  resizeDockSplit,
  splitDock,
  toggleDock,
  undock,
  zoomArea,
  type AreaId,
  type DockId,
  type MountedId,
  type StackId,
  type Zoom,
} from '../state/workbench'
import { seatAgentKey } from '../lib/agents'
import { permits } from '../panels/views'
import { applyProfile, type ProfilePatch } from '../lib/profile'
import {
  PREVIEW_ROOT,
  previewAccounts,
  previewHistory,
  previewLedger,
  previewPlugins,
  previewSession,
  previewUsage,
  previewWorkspace,
  previewWorkspaces,
} from './sidebar-fixture'
import { gitCommit, gitLog, gitRefs, gitStatus, gitWorktrees } from './git-fixture'
import { EVIDENCE_BOARD, EVIDENCE_ROOM, EVIDENCE_TEAM, PREVIEW_CHECKS, PREVIEW_SEAT, PREVIEW_UNSEEN } from './evidence-fixture'
import { terminalAttach } from './terminal-fixture'
import { PREVIEW_GOAL, PREVIEW_GOALS, PREVIEW_TRIGGER_GOAL } from './goal-fixture'
import { FIX_PREVIEW, PREVIEW_FLOW_CUSTOMIZE, PREVIEW_FLOW_SOURCE, PREVIEW_FLOW_UPDATE, PREVIEW_FLOWS, previewFlowPreviewFor } from './flow-fixture'
import { triggerArmPreview, triggerGoalStatus, triggerHistoryPage, triggerPreferences as triggerPreferencesFixture, triggerProjectView, triggerView } from './intake-fixture'
/* The editor surface opens this file, and is given this file — its real
   source, read at build time. Edit `brands.ts` and the editor shows the edit;
   nothing here restates what the file says. Not a `design/ui` module on
   purpose: `ui-architecture` refuses any import from those but the public
   barrel, and a text read is still an import to it — rightly, since the rule
   is about what a screen may reach, not about why. */
import editorSource from '../lib/brands.ts?raw'

/**
 * The host a production screen needs in order to be mounted anywhere else.
 *
 * Two pages mount the app's own screens outside the app: /preview.html, where
 * a screen is restyled against every palette at once, and the design
 * explorer's surface boards, where the catalogue shows what a screen *is*.
 * Both mount `components/Conversation`, `components/Sidebar`, the real
 * modules — not a drawing of them — and a screen will not mount without a
 * store, so the store is the thing that had to be shared.
 *
 * It lives here rather than in either page because a second copy is the whole
 * failure mode: the catalogue's copy drifts from the app's, and then the
 * catalogue is showing something nobody ships. One fixture, one store, two
 * consumers.
 *
 * The stub is the smallest thing the mounted screens actually call — a
 * snapshot, a listener set, the team verbs (which mutate the fixture, so
 * posting works), and a method-aware transport for the library reads.
 * Everything else is answered by the proxy floor below.
 */

export const runtime = (id: string, name: string): RuntimeInfo =>
  ({ id: runtimeId(id), name, capabilities: {}, presentation: { name } }) as unknown as RuntimeInfo

/** The conversation every frame below is scoped to. */
export const PREVIEW_SESSION_KEY = sessionKey(runtimeId('codex'), 's1' as SessionId)

const now = Date.now()
const yesterday = now - 26 * 60 * 60 * 1000

export const PREVIEW_ROOM = 'room-preview'
/* A second room with nothing in it, so the board's empty state is a frame on
   the page rather than a thing you have to clear a fixture to see. */
export const EMPTY_ROOM = 'room-empty'
/*
 * The awkward board, so the awkward cases are a frame on the page rather than
 * something a screenshot from a real room happens to catch.
 *
 * Every entry below is a shape the ordinary fixture cannot produce, and each
 * one has broken something: a room nickname *and* a different conversation
 * title on one row (which drew `Curs… checkout tests`, the harness cut to four
 * letters so the title could keep every pixel it asked for); a title with no
 * spaces in it, which is the only string a column cannot wrap; four owned
 * paths in a chip that is one line tall; a lease that ran out while its holder
 * left the room; and a blocked reason long enough to be a paragraph.
 */
export const EDGE_ROOM = 'room-edges'

const TEAM: TeamState = {
  id: PREVIEW_ROOM,
  name: 'Checkout rewrite',
  updatedAt: 1,
  root: PREVIEW_ROOT,
  members: [
    sessionKey(runtimeId('codex'), 'c1' as SessionId),
    sessionKey(runtimeId('claude'), 'k1' as SessionId),
  ],
  messaging: true,
  intents: [
    {
      id: 1,
      title: 'Migrate the auth callers',
      detail: null,
      state: 'claimed',
      files: ['src/api/**'],
      dependsOn: [],
      claim: { runtime: runtimeId('codex'), sessionId: 'c1', at: yesterday },
      blockedReason: null,
      handoff: null,
      note: null,
      createdAt: yesterday,
      updatedAt: yesterday,
    },
    {
      id: 2,
      title: 'Integration tests for the gateway',
      detail: null,
      state: 'open',
      files: [],
      dependsOn: [],
      claim: null,
      blockedReason: null,
      handoff: null,
      note: null,
      createdAt: yesterday,
      updatedAt: yesterday,
    },
    {
      id: 3,
      title: 'Write the release notes',
      detail: null,
      state: 'blocked',
      files: [],
      dependsOn: [1],
      claim: null,
      blockedReason: 'waiting on the rename',
      handoff: null,
      note: null,
      createdAt: yesterday,
      updatedAt: now,
    },
  ],
  channel: [
    {
      id: 's0',
      at: yesterday,
      kind: 'signal',
      by: { kind: 'agent', runtime: runtimeId('codex'), sessionId: 'c1', title: 'API migration' },
      signal: 'claimed',
      intent: 1,
      title: 'Migrate the auth callers',
      detail: null,
    },
    {
      id: 'm1',
      at: yesterday + 60_000,
      kind: 'message',
      from: { kind: 'agent', runtime: runtimeId('codex'), sessionId: 'c1', title: 'API migration' },
      to: { runtime: runtimeId('claude'), sessionId: 'k1', title: 'Auth refactor' },
      text: 'verifyToken moved to src/api/token.ts — imports on your side will need the new path.',
      state: 'delivered',
      reason: null,
      envelope: 'Message from Alpha — "API migration"\n\nverifyToken moved to src/api/token.ts…',
    },
    {
      id: 'm2',
      at: yesterday + 90_000,
      kind: 'message',
      from: { kind: 'agent', runtime: runtimeId('codex'), sessionId: 'c1', title: 'API migration' },
      to: { runtime: runtimeId('claude'), sessionId: 'k1', title: 'Auth refactor' },
      text: 'The old barrel export stays until you land, so nothing breaks mid-flight.',
      state: 'delivered',
      reason: null,
      envelope: null,
    },
    {
      id: 'm3',
      at: now - 40 * 60_000,
      kind: 'message',
      from: { kind: 'agent', runtime: runtimeId('claude'), sessionId: 'k1', title: 'Auth refactor' },
      to: { runtime: runtimeId('codex'), sessionId: 'c1', title: 'API migration' },
      text: 'Understood — taking the new path now. Nothing else is open on my side.',
      state: 'held',
      reason: 'The user releases held messages from the Team panel.',
      envelope: 'Message from Beta — "Auth refactor"\n\nUnderstood — taking the new path now.',
    },
    {
      id: 'm4',
      at: now - 30 * 60_000,
      kind: 'message',
      from: { kind: 'agent', runtime: runtimeId('claude'), sessionId: 'k1', title: 'Auth refactor' },
      text: '@build-bot can you re-run the packaged smoke?',
      state: 'refused',
      reason: 'no conversation in this room is named “build-bot”. In this room: API migration.',
      envelope: null,
    },
    {
      id: 'm5',
      at: now - 10 * 60_000,
      kind: 'message',
      from: { kind: 'user' },
      to: { runtime: runtimeId('codex'), sessionId: 'c1', title: 'API migration' },
      text: 'Ship it when the gate is green.',
      state: 'delivered',
      reason: null,
      envelope: null,
    },
    {
      id: 'm6',
      at: now - 10 * 60_000,
      kind: 'message',
      from: { kind: 'user' },
      to: { runtime: runtimeId('claude'), sessionId: 'k1', title: 'Auth refactor' },
      text: 'Ship it when the gate is green.',
      state: 'delivered',
      reason: null,
      envelope: null,
    },
    {
      id: 's1',
      at: now - 5 * 60_000,
      kind: 'signal',
      by: { kind: 'agent', runtime: runtimeId('claude'), sessionId: 'k1', title: 'Auth refactor' },
      signal: 'completed',
      intent: 2,
      title: 'Integration tests for the gateway',
      detail: 'all green on Node 22',
    },
  ] as unknown as TeamState['channel'],
} as unknown as TeamState

const edgeIntent = (extra: Record<string, unknown>): unknown => ({
  id: 0,
  title: '',
  detail: null,
  state: 'open',
  files: [],
  dependsOn: [],
  claim: null,
  blockedReason: null,
  handoff: null,
  note: null,
  createdAt: yesterday,
  updatedAt: yesterday,
  ...extra,
})

const EDGE_TEAM = {
  ...TEAM,
  id: EDGE_ROOM,
  name: 'Edges',
  /* The room's own name for a conversation. Without one the card draws a
     single name and the two-name row — the one that broke — never appears. */
  /* Names, not harnesses. The runtimes in this file are Alpha, Beta and
     Gamma for the reason `teamPeers` states below: a screenshot of a fixture
     must never read as a claim about somebody's product. */
  nicknames: {
    [`${runtimeId('cursor')}\u0000x1`]: 'Gamma',
    [`${runtimeId('codex')}\u0000gone`]: 'Alpha, on the long branch',
  },
  plans: [],
  intents: [
    edgeIntent({
      id: 1,
      title: 'Cover a 502 mid-retry in checkout.test.ts',
      state: 'claimed',
      files: ['src/checkout/checkout.test.ts'],
      claim: { runtime: runtimeId('cursor'), sessionId: 'x1', at: yesterday },
      updatedAt: now - 4 * 60 * 1000,
    }),
    edgeIntent({
      id: 2,
      title: 'packages/server/src/methods/conversation.ts::resumeAfterCompaction',
      state: 'claimed',
      files: [
        'packages/server/src/methods/conversation.ts',
        'packages/protocol/src/wire.ts',
        'packages/ui/src/components/Conversation.tsx',
        'packages/adapter-codex/src/session.ts',
      ],
      /* A holder the roster no longer knows: `teamPeers` answers with c1 and
         k1, so a claim on any other session is one the host would let another
         agent take — which is what the stranded chip advertises, and the only
         way to see it drawn. */
      claim: { runtime: runtimeId('codex'), sessionId: 'gone', at: yesterday, leaseUntil: now - 40 * 60 * 1000 },
      updatedAt: now - 40 * 60 * 1000,
    }),
    edgeIntent({
      id: 3,
      title: 'Stop',
      state: 'blocked',
      blockedBy: 'hand',
      blockedReason:
        'The rename has to land upstream first, and until it does every caller in this package points at a symbol that no longer exists — so anything done here would be rewritten twice.',
      updatedAt: now - 3 * 24 * 60 * 60 * 1000,
    }),
    edgeIntent({
      id: 4,
      title: 'Write the migration note',
      state: 'done',
      handoff: 'The new column is nullable; backfill runs nightly until the old one is dropped.',
      note: 'Landed in 2 commits.',
      dependsOn: [1, 2, 3],
      updatedAt: now - 20 * 60 * 1000,
    }),
    edgeIntent({ id: 5, title: 'Drop the legacy shim', state: 'abandoned', updatedAt: now }),
  ],
} as unknown as TeamState

const LIBRARY = {
  generatedAt: now,
  runtimes: [runtimeId('codex'), runtimeId('claude'), runtimeId('cursor')],
  locations: (['codex', 'claude', 'cursor'] as const).flatMap((id) => [
    {
      runtime: runtimeId(id),
      kind: 'skill' as const,
      path: `/home/u/.${id}/skills`,
      scope: 'user' as const,
      scanned: true,
      exists: true,
      readOnly: false,
    },
    {
      runtime: runtimeId(id),
      kind: 'mcp' as const,
      path: `/home/u/.${id}/mcp.json`,
      scope: 'user' as const,
      scanned: true,
      exists: true,
      readOnly: false,
    },
  ]),
  entries: [
    {
      kind: 'skill',
      name: 'code-review',
      title: null,
      description: 'Review the current diff for correctness bugs.',
      catalogTokens: 96,
      copies: [
        {
          path: '/home/u/.claude/skills/code-review',
          scope: 'user',
          readBy: [runtimeId('claude')],
          hollow: false,
          digest: 'abc',
          readOnly: false,
        },
      ],
      reach: [
        { runtime: runtimeId('codex'), state: 'absent', basis: 'scanned' },
        { runtime: runtimeId('claude'), state: 'reaches', basis: 'scanned' },
        { runtime: runtimeId('cursor'), state: 'absent', basis: 'scanned' },
      ],
    },
    {
      kind: 'skill',
      name: 'deploy-notes',
      title: null,
      description: 'Draft the release notes from the merged PRs.',
      catalogTokens: 64,
      copies: [
        {
          path: '/home/u/.codex/skills/deploy-notes',
          scope: 'user',
          readBy: [],
          hollow: true,
          digest: null,
          readOnly: false,
        },
      ],
      reach: [
        { runtime: runtimeId('codex'), state: 'hollow', basis: 'scanned' },
        { runtime: runtimeId('claude'), state: 'absent', basis: 'scanned' },
        { runtime: runtimeId('cursor'), state: 'unscanned', basis: 'scanned' },
      ],
    },
    {
      kind: 'skill',
      name: 'benchmark',
      title: null,
      description: 'Performance regression detection for the site.',
      catalogTokens: 120,
      copies: [
        {
          path: '/home/u/.claude/skills/benchmark',
          scope: 'user',
          readBy: [runtimeId('claude')],
          hollow: false,
          digest: 'one',
          readOnly: false,
        },
        {
          path: '/home/u/.codex/skills/benchmark',
          scope: 'user',
          readBy: [runtimeId('codex')],
          hollow: false,
          digest: 'two',
          readOnly: false,
        },
      ],
      reach: [
        { runtime: runtimeId('codex'), state: 'differs', basis: 'scanned' },
        { runtime: runtimeId('claude'), state: 'differs', basis: 'scanned' },
        { runtime: runtimeId('cursor'), state: 'absent', basis: 'scanned' },
      ],
    },
    {
      kind: 'skill',
      name: 'brainstorming',
      title: null,
      description:
        'Use before any creative work — creating features, building components, adding functionality. Explores intent and requirements before implementation.',
      catalogTokens: 148,
      copies: [
        {
          path: '/home/u/.claude/skills/brainstorming',
          scope: 'user',
          readBy: [runtimeId('claude'), runtimeId('codex'), runtimeId('cursor')],
          hollow: false,
          digest: 'br',
          readOnly: false,
        },
      ],
      reach: [
        { runtime: runtimeId('codex'), state: 'reaches', basis: 'reported' },
        { runtime: runtimeId('claude'), state: 'reaches', basis: 'reported' },
        { runtime: runtimeId('cursor'), state: 'reaches', basis: 'scanned' },
      ],
    },
    {
      kind: 'skill',
      name: 'systematic-debugging',
      title: null,
      description:
        'Use when encountering any bug, test failure, or unexpected behaviour, before proposing fixes.',
      catalogTokens: 88,
      copies: [
        {
          path: '/home/u/.agents/skills/systematic-debugging',
          scope: 'user',
          readBy: [],
          hollow: false,
          digest: 'sd',
          readOnly: false,
        },
      ],
      reach: [
        { runtime: runtimeId('codex'), state: 'unscanned', basis: 'scanned', note: 'the copy sits in ~/.agents/skills, which Alpha does not read.' },
        { runtime: runtimeId('claude'), state: 'unscanned', basis: 'scanned' },
        { runtime: runtimeId('cursor'), state: 'unscanned', basis: 'scanned' },
      ],
    },
    {
      kind: 'skill',
      name: 'design-review',
      title: null,
      description:
        'Designer’s eye QA: finds visual inconsistency, spacing issues and hierarchy problems, then fixes them.',
      catalogTokens: 104,
      copies: [
        {
          path: '/home/u/.claude/skills/design-review',
          scope: 'user',
          readBy: [runtimeId('claude'), runtimeId('codex')],
          hollow: false,
          digest: 'dr',
          readOnly: false,
        },
      ],
      reach: [
        { runtime: runtimeId('codex'), state: 'off', basis: 'reported' },
        { runtime: runtimeId('claude'), state: 'reaches', basis: 'reported' },
        { runtime: runtimeId('cursor'), state: 'absent', basis: 'scanned' },
      ],
    },
    {
      kind: 'skill',
      name: 'writing-plans',
      title: null,
      description: null,
      catalogTokens: 32,
      copies: [
        {
          path: '/home/u/.cursor/skills/writing-plans',
          scope: 'user',
          readBy: [runtimeId('cursor')],
          hollow: false,
          digest: 'wp',
          readOnly: false,
        },
      ],
      reach: [
        { runtime: runtimeId('codex'), state: 'absent', basis: 'scanned' },
        { runtime: runtimeId('claude'), state: 'absent', basis: 'scanned' },
        { runtime: runtimeId('cursor'), state: 'reaches', basis: 'scanned' },
      ],
    },
  ],
  gaps: [],
}

/**
 * What `library/definition` answers here. Real frontmatter and real prose,
 * because a sheet fed lorem ipsum cannot be judged: the whole question the
 * design has to answer is whether a genuine `SKILL.md` reads well in it.
 */
const DEFINITIONS: Record<string, string> = {
  'code-review': `---
name: code-review
description: Review the current diff for correctness bugs and reuse cleanups. Use when the user asks for a review, before opening a PR, or after a large refactor.
---

# Code review

Review the working tree's diff at the requested effort level.

## What to look for

- **Correctness first.** A bug that changes behaviour outranks every style
  note in the file. Report it with the inputs that trigger it.
- **Reuse.** A helper that already exists three directories away is worth
  more than a clean reimplementation of it.
- **Efficiency**, but only where the cost is real and reachable.

## What not to report

Formatting the project's own linter would catch, and preferences the
surrounding code has already decided against.

## How to verify a finding

1. Name the input that triggers it, and the line it reaches.
2. Run the narrowest test that covers that line, or write one.
3. Say what the test printed, not what you expected it to print.
4. A finding no test can reach is a question for the author, not a defect.

## Output

One finding per defect, most severe first, each with a concrete failure
scenario. If nothing survives verification, say so plainly rather than
padding the list.`,
  'deploy-notes': `---
name: deploy-notes
description: Draft the release notes from the merged PRs since the last tag.
---

# Deploy notes

Collect every PR merged since the last tag, group them by what a reader
would call the change, and write the notes in the project's own voice.`,
  'design-review': `---
name: design-review
description: Designer's eye QA: finds visual inconsistency, spacing issues and hierarchy problems, then fixes them.
---

# Design review

Look at the thing, not at the code that made it.

1. Screenshot the surface at the widths it really gets.
2. Name what is wrong in one sentence each.
3. Fix the source, re-shoot, and put the two side by side.

Report nothing you have not seen rendered.`,
  benchmark: `---
name: benchmark
description: Performance regression detection for the site. Establishes baselines for page load and Core Web Vitals, then compares before and after on every PR.
---

# Benchmark

Measure, don't guess.

1. Establish a baseline on the current \`main\`.
2. Apply the change.
3. Re-measure with the same rig, same machine, same run count.

Report the delta with its variance. A single run is an anecdote.`,
}

/**
 * The roster every Agent screen below is drawn from: a project Agent that
 * shadows a shipped one, one of yours, the shipped ones, and a file that will
 * not parse — the four shapes a roster row has — with a dry run in which one
 * Agent cannot be seated here.
 */
const agentEntry = (
  id: string,
  name: string,
  origin: AgentEntry['origin'],
  description: string,
  ceiling: CeilingLevel = 'read',
  shadows: AgentEntry['shadows'] = [],
  ceilingFrom: NonNullable<AgentEntry['definition']>['ceilingFrom'] = 'ceiling',
): AgentEntry => ({
  id,
  origin,
  path:
    origin === 'project'
      ? `${PREVIEW_ROOT}/.harnessdesk/agents/${id}/AGENT.md`
      : origin === 'user'
        ? `/home/u/.harnessdesk/agents/${id}/AGENT.md`
        : `/app/agents/${id}/AGENT.md`,
  digest: `digest-${id}`,
  shadows,
  problems: [],
  definition: {
    id,
    name,
    description,
    ceiling,
    ceilingFrom,
    answers: ceiling === 'read' ? ['approve', 'request-changes'] : [],
    produces: ['review'],
    skills: [],
    mcp: [],
    prefer: [{ runtime: 'claude' }, { runtime: 'codex' }, { runtime: 'cursor' }],
    brief: `You review a change somebody else wrote.\n\n## How to report\n\nEvery finding, then a verdict.\n\n## What you never do\n\nNever push.`,
  },
})

const PREVIEW_AGENTS: readonly AgentEntry[] = [
  agentEntry('code-reviewer', 'Code reviewer', 'project', 'The storefront team’s reviewer: reads the diff against our checkout rules.', 'read', [
    { origin: 'builtin', path: '/app/agents/code-reviewer/AGENT.md' },
  ]),
  agentEntry('release-checker', 'Release checker', 'user', 'Reads a release branch against the changelog before it is tagged.', 'edit'),
  agentEntry('implementer', 'Implementer', 'builtin', 'Builds the change it is given on its own branch, proves it with the project’s checks, and hands it over.', 'publish'),
  agentEntry('security-reviewer', 'Security reviewer', 'builtin', 'Reads a change it did not write for the ways it could be abused, and says how to close each one.'),
  {
    id: 'draft',
    origin: 'user',
    path: '/home/u/.harnessdesk/agents/draft/AGENT.md',
    digest: 'digest-draft',
    shadows: [],
    problems: [{ level: 'error', at: 'permission', text: '"admin" is not a permission — it is read, publish or merge' }],
    definition: null,
  },
]

const takenOn = (
  id: string,
  runtime: string,
  label: string,
  ceiling: SeatCeiling = { level: 'read', hold: 'asked' },
): SeatPlan => ({
  id,
  from: 'prefer',
  winner: 0,
  blocked: null,
  ceiling,
  candidates: [{ seat: { runtime }, label, runtimeName: label.split(' · ')[0] ?? label, state: 'taken', reason: null, fix: null }],
})

export const PREVIEW_PLANS: ReadonlyMap<string, SeatPlan> = new Map([
  [
    'code-reviewer',
    {
      id: 'code-reviewer',
      from: 'machine',
      winner: 0,
      blocked: null,
      ceiling: { level: 'read', hold: 'asked' },
      candidates: [
        {
          seat: { runtime: 'cursor', model: 'gamma-pro' },
          label: 'Gamma · Pro',
          runtimeName: 'Gamma',
          state: 'passed',
          reason: { kind: 'signedOut' },
          fix: { kind: 'signIn', runtime: 'cursor' },
        },
        {
          seat: { runtime: 'claude', model: 'opus', effort: 'high' },
          label: 'Beta · Opus · High',
          runtimeName: 'Beta',
          state: 'taken',
          reason: null,
          fix: null,
        },
      ],
      // Its own `prefer`, weighed the same way, muted on its page since this
      // Mac's seats above replace it here.
      own: [
        { seat: { runtime: 'claude' }, label: 'Beta', runtimeName: 'Beta', state: 'taken', reason: null, fix: null },
        { seat: { runtime: 'codex' }, label: 'Alpha', runtimeName: 'Alpha', state: 'untried', reason: null, fix: null },
        { seat: { runtime: 'cursor' }, label: 'Gamma', runtimeName: 'Gamma', state: 'untried', reason: null, fix: null },
      ],
    },
  ],
  ['release-checker', takenOn('release-checker', 'codex', 'Alpha · GPT-5.6 Sol', { level: 'edit', hold: 'held' })],
  ['implementer', takenOn('implementer', 'claude', 'Beta', { level: 'edit', hold: 'asked' })],
  [
    'security-reviewer',
    {
      id: 'security-reviewer',
      from: 'machine',
      winner: null,
      blocked: null,
      ceiling: null,
      candidates: [
        { seat: { runtime: 'cursor' }, label: 'Gamma', runtimeName: 'Gamma', state: 'passed', reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'cursor' } },
        { seat: { runtime: 'shipper' }, label: 'Delta', runtimeName: 'Delta', state: 'passed', reason: { kind: 'notInstalled', added: false }, fix: { kind: 'add', runtime: 'shipper' } },
      ],
      // Its own `prefer`, muted on its page since this Mac's seats replace it
      // here too — a `from: 'machine'` plan always carries one.
      own: [
        { seat: { runtime: 'claude' }, label: 'Beta', runtimeName: 'Beta', state: 'taken', reason: null, fix: null },
        { seat: { runtime: 'codex' }, label: 'Alpha', runtimeName: 'Alpha', state: 'untried', reason: null, fix: null },
        { seat: { runtime: 'cursor' }, label: 'Gamma', runtimeName: 'Gamma', state: 'untried', reason: null, fix: null },
      ],
    },
  ],
  ['draft', { id: 'draft', from: 'prefer', winner: null, blocked: 'its file will not parse', ceiling: null, candidates: [] }],
])

/** The smallest store the mounted screens call. */
class PreviewStore {
  #snapshot: AppSnapshot
  #listeners = new Set<() => void>()

  constructor(seed: Partial<AppSnapshot> = {}) {
    this.#snapshot = {
      ...emptySnapshot(),
      status: 'open',
      preferencesLoaded: true,
      // The sidebar wants a real project open; the team room wants its board,
      // and the board is keyed on the folder — so the fixture folder is the
      // sidebar's own root and the board moves to it.
      workspace: previewWorkspace,
      workspaces: previewWorkspaces,
      runtimes: [
        {
          ...runtime('codex', 'Alpha'),
          ceilings: {
            read: { settings: [{ option: 'permissions', value: ':read-only' }], how: 'Read-only sandbox; anything past it asks you' },
            edit: {
              settings: [{ option: 'permissions', value: ':workspace' }],
              how: 'Workspace sandbox: it changes files here, but cannot commit, reach the network or listen on a port; anything past it asks you',
            },
          },
        } as RuntimeInfo,
        runtime('claude', 'Beta'),
        runtime('cursor', 'Gamma'),
      ],
      activeRuntime: runtimeId('codex'),
      // A list with nothing selected cannot show what selection looks like,
      // which is most of what a sidebar's design is. `s1` is the second row —
      // mid-list, so the filled row has neighbours on both sides.
      activeSessionKey: PREVIEW_SESSION_KEY,
      health: { state: 'ready' },
      healthByRuntime: {
        codex: { state: 'ready' },
        claude: { state: 'ready' },
        cursor: { state: 'ready' },
      },
      accountsByRuntime: previewAccounts,
      history: previewHistory,
      foldersGone: new Map([[previewHistory[2]!.cwd, 'This folder no longer exists.']]),
      usage: previewUsage,
      plugins: previewPlugins,
      // The agent-side pages want something to list: a catalogue with a
      // default, a thinking model and effort levels; a route that works and
      // one the agent cannot speak; a saved preset; skills of every scope,
      // one of them not switchable.
      models: [
        {
          id: 'gpt-5.6-sol',
          displayName: 'GPT-5.6 Sol',
          description: 'Best for everyday, complex tasks',
          reasoningLevels: [
            { id: 'low', label: 'Low' },
            { id: 'medium', label: 'Medium' },
            { id: 'high', label: 'High' },
            { id: 'xhigh', label: 'Extra high' },
          ],
          supportsImages: true,
          isDefault: true,
        },
        {
          id: 'gpt-5.4-mini',
          displayName: 'GPT-5.4 mini',
          description: 'Fast and affordable agentic coding model',
          reasoningLevels: [
            { id: 'low', label: 'Low' },
            { id: 'medium', label: 'Medium' },
          ],
          supportsImages: true,
        },
        {
          id: 'gpt-5.6-luna',
          displayName: 'GPT-5.6-Luna',
          description: 'Long-context research model',
          reasoningLevels: [],
          supportsImages: false,
          thinking: 'always',
        },
      ],
      routes: [
        {
          id: 'r1',
          name: 'Team proxy',
          endpoint: 'https://proxy.example.com/v1',
          wireProtocol: 'responses',
          credentialRef: 'cred_r1',
          model: 'gpt-5.6-sol',
          usable: true,
        },
        {
          id: 'r2',
          name: 'Local gateway',
          endpoint: 'http://localhost:4000/v1',
          wireProtocol: 'chat',
          credentialRef: 'cred_r2',
          usable: false,
          reason: 'this agent speaks responses, not chat',
        },
      ],
      customPresets: [
        {
          id: 'custom-1',
          name: 'High effort, asks first',
          description: 'GPT-5.6 Sol · High · Read only',
          runtime: 'codex',
          values: {},
        },
      ],
      skills: [
        {
          name: 'code-review',
          displayName: 'Code Review',
          description: 'Review the current diff for correctness bugs and reuse cleanups. Use when the user asks for a review, before opening a PR, or after a large refactor.',
          shortDescription: 'Review the current diff for correctness bugs.',
          enabled: true,
          path: '/home/u/.claude/skills/code-review',
          scope: 'user',
        },
        {
          name: 'brainstorming',
          description: 'Use before any creative work — creating features, building components, adding functionality. Explores intent and requirements before implementation.',
          enabled: true,
          path: '/home/u/code/HarnessDesk/.claude/skills/brainstorming',
          scope: 'repo',
        },
        {
          name: 'deploy-notes',
          description: 'Draft the release notes from the merged PRs.',
          enabled: false,
          path: '/home/u/.claude/skills/deploy-notes',
          scope: 'user',
        },
        {
          name: 'playwright',
          displayName: 'Playwright',
          description: 'Drive a headed browser for end-to-end checks.',
          enabled: true,
          scope: 'system',
          toggleable: false,
        },
      ],
      planEdits: {},
      listPrefs: {
        density: 'compact',
        agent: null,
        sort: 'recency',
        pinned: [],
        pinnedSessions: [],
        collapsed: [],
        panelsCollapsed: [],
        othersOpen: false,
      },
      teams: new Map([
        [PREVIEW_ROOM, TEAM],
        [EMPTY_ROOM, { ...TEAM, id: EMPTY_ROOM, name: 'Empty room', intents: [], plans: [] }],
        [EDGE_ROOM, EDGE_TEAM],
        [EVIDENCE_ROOM, EVIDENCE_TEAM],
        ...PREVIEW_GOALS.map((view) => [view.goal.id, view.board] as const),
      ]),
      goals: new Map(PREVIEW_GOALS.map((view) => [view.goal.id, view])),
      boardEvidence: new Map([[EVIDENCE_ROOM, EVIDENCE_BOARD]]),
      /*
       * Every session here carries `turns`, and that is not optional padding.
       * `isBusy(session)` reads `session.turns.length`, so a `Session` cast
       * from a literal without it throws the moment the room renders its
       * roster — which is exactly what "TeamRoomPane throws in the preview"
       * was, for as long as it stood.
       */
      sessions: new Map([
        [
          sessionKey(runtimeId('codex'), 's1' as SessionId),
          {
            ...previewSession,
            settings: {
              ...previewSession.settings,
              cwd: previewSession.cwd,
              model: 'gpt-5.6-sol',
              agent: 'code-reviewer',
              // Not the roster's digest: the file has moved on since this was handed over.
              briefDigest: 'digest-when-it-started',
              ceiling: { level: 'read', hold: 'held' },
              ceilingNote: 'Read-only sandbox; anything past it asks you',
              seatLabel: 'Alpha · GPT-5.6 Sol',
              passedOver: [
                { seat: { runtime: 'cursor' }, label: 'Gamma', runtimeName: 'Gamma', state: 'passed', reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'cursor' } },
              ],
            },
          } as unknown as Session,
        ],
        [
          sessionKey(runtimeId('codex'), 'c1' as SessionId),
          {
            id: 'c1',
            runtime: runtimeId('codex'),
            title: 'API migration',
            cwd: PREVIEW_ROOT,
            /* Mid-turn on purpose. Whether a member is working is the fact the
               room's rail exists to show without anything being opened, and a
               fixture where nothing is ever running cannot show it. */
            status: { type: 'active' },
            /* `isBusy` reads the last turn, so a session without `turns` is not
               a smaller fixture — it is one that throws the moment anything
               asks whether this member is working. */
            turns: [],
            itemsLoaded: true,
          } as unknown as Session,
        ],
        /* The edge board's holder: a conversation with a title of its own,
           beside a room nickname that is not the same string. That pair is
           the whole two-name row, and without it the card draws one name and
           the split that used to be wrong cannot be seen. */
        [
          sessionKey(runtimeId('cursor'), 'x1' as SessionId),
          {
            id: 'x1',
            runtime: runtimeId('cursor'),
            title: 'checkout tests',
            cwd: PREVIEW_ROOT,
            status: { type: 'idle' },
            turns: [],
            itemsLoaded: true,
          } as unknown as Session,
        ],
        [
          sessionKey(runtimeId('claude'), 'k1' as SessionId),
          {
            id: 'k1',
            runtime: runtimeId('claude'),
            title: 'Auth refactor',
            cwd: PREVIEW_ROOT,
            status: { type: 'idle' },
            turns: [],
            itemsLoaded: true,
          } as unknown as Session,
        ],
      ]),
      agents: PREVIEW_AGENTS,
      agentsProject: PREVIEW_ROOT,
      agentPlans: PREVIEW_PLANS,
      seating: {
        revision: 1,
        path: '/home/u/.harnessdesk/seating.json',
        entries: [
          {
            id: 'code-reviewer',
            seats: [
              { runtime: 'cursor', model: 'gamma-pro' },
              { runtime: 'claude', model: 'opus', effort: 'high' },
            ],
          },
        ],
        problems: [
          {
            id: 'security-reviewer',
            at: '[1]',
            text: '“+fast” is not a switch a seat takes — the only one is +thinking',
          },
        ],
      } satisfies MachineSeating,
      seatAgents: new Map([[seatAgentKey(previewSession.cwd, 'code-reviewer'), PREVIEW_AGENTS[0] ?? null]]),
      home: '/home/u',
      stateDir: '/home/u/.harnessdesk',
      ...seed,
    } as AppSnapshot
    this.#watchWindowWidth()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = (): AppSnapshot => this.#snapshot

  patch(partial: Partial<AppSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...partial }
    for (const listener of this.#listeners) listener()
  }

  /* The terminal's live stream. A real subscription with nothing on the other
     end: the pane registers, unregisters on unmount, and hears nothing, which
     is exactly a shell that has gone quiet. Answered here rather than by the
     floor below so the page does not log a missing verb every time a
     terminal mounts. */
  #terminalListeners = new Map<string, Set<(notification: unknown) => void>>()
  onTerminal(terminalId: string, listener: (notification: never) => void): () => void {
    const set = this.#terminalListeners.get(terminalId) ?? new Set()
    set.add(listener as (notification: unknown) => void)
    this.#terminalListeners.set(terminalId, set)
    return () => {
      set.delete(listener as (notification: unknown) => void)
    }
  }

  /* The panel verbs, answered by the functions the app's own store answers
     them with. `AppStore.togglePanel` is one line — `toggleDock` over the
     workbench — and so is every verb below, so calling the same function here
     is not a model of the panel system: it is the panel system, minus the
     socket. What a reader sees on the Panels tab when they collapse a dock is
     what the app would do, because it is the code the app would run. */
  #workbench(next: AppSnapshot['workbench']): void {
    this.patch({ workbench: next })
  }
  togglePanel(area: DockId): void {
    this.#workbench(toggleDock(this.#snapshot.workbench, area))
  }
  zoomPanel(area: AreaId, scope: Zoom['scope']): void {
    this.#workbench(zoomArea(this.#snapshot.workbench, area, scope))
  }
  moveView(id: string, to: AreaId, into?: StackId): void {
    this.#workbench(moveView(this.#snapshot.workbench, id, to, permits, into))
  }
  activateView(area: DockId, id: MountedId): void {
    this.#workbench(activate(this.#snapshot.workbench, area, id))
  }
  closeView(id: MountedId): void {
    this.#workbench(undock(this.#snapshot.workbench, id))
  }
  resizePanel(area: DockId, size: number): void {
    this.#workbench(resizeDock(this.#snapshot.workbench, area, size))
  }
  splitPanel(id: MountedId, direction: 'row' | 'column', place: 'before' | 'after' = 'after'): void {
    this.#workbench(splitDock(this.#snapshot.workbench, id, direction, place))
  }
  resizePanelSplit(area: DockId, branchId: string, ratio: number): void {
    this.#workbench(resizeDockSplit(this.#snapshot.workbench, area, branchId, ratio))
  }
  focusView(id: MountedId | null): void {
    if ((this.#snapshot.workbench.focus ?? null) === (id ?? null)) return
    this.#workbench(focusView(this.#snapshot.workbench, id))
  }

  /* The sidebar's verbs, answered as the app's store answers them
     (`toggleSidebar`, `closeFloatingSidebar` and `setNarrowWindow` in
     state/store.ts): a wide window collapses the column, a narrow one floats
     the sidebar over the page, and a panel given the whole window hands the
     sidebar back first. Narrow is read from the window's width, as the app
     reads it, so a narrow viewport floats the Panels tab's sidebar exactly
     where the app would float its own. */
  toggleSidebar(): void {
    const { workbench, narrowWindow } = this.#snapshot
    if (workbench.zoom && !areaVisible(workbench, 'sidebar')) {
      this.#workbench(zoomArea(workbench, workbench.zoom.area, 'content'))
      this.patch(narrowWindow ? { sidebarFloating: true } : { sidebarCollapsed: false })
      return
    }
    if (narrowWindow) this.patch({ sidebarFloating: !this.#snapshot.sidebarFloating })
    else this.patch({ sidebarCollapsed: !this.#snapshot.sidebarCollapsed })
  }
  closeFloatingSidebar(): void {
    if (this.#snapshot.sidebarFloating) this.patch({ sidebarFloating: false })
  }
  setNarrowWindow(narrow: boolean): void {
    if (narrow === this.#snapshot.narrowWindow) return
    this.patch({ narrowWindow: narrow, sidebarFloating: false })
  }
  #watchWindowWidth(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(`(max-width: ${NARROW_WINDOW - 0.02}px)`)
    this.#snapshot = { ...this.#snapshot, narrowWindow: query.matches }
    query.addEventListener?.('change', (event) => this.setNarrowWindow(event.matches))
  }

  #team(mutate: (team: TeamState) => TeamState): void {
    const team = this.#snapshot.teams.get(PREVIEW_ROOM)
    if (!team) return
    this.patch({ teams: new Map([[PREVIEW_ROOM, mutate(team)]]) } as Partial<AppSnapshot>)
  }

  loadBoardEvidence = async (): Promise<void> => {}
  runCheck = async (): Promise<{ readonly kind: 'unseen'; readonly unseen: CheckUnseen }> => ({
    kind: 'unseen',
    unseen: PREVIEW_UNSEEN,
  })
  seatRecord = async (runtime: string, sessionId: string): Promise<SeatRecord | null> =>
    sessionKey(runtime, sessionId) === PREVIEW_SESSION_KEY ? PREVIEW_SEAT : null
  // Mirrors the real `attachment/agent` handler's own contract: a full view
  // (even an empty one) for a readable Agent, never `undefined` — a
  // resolved-but-missing view is exactly what crashed the Library roster
  // read in #893, because nothing downstream expects that shape.
  readAgentAttachments = async (id: string, origin: AgentEntry['origin']): Promise<AgentAttachmentsView> => {
    const found = PREVIEW_AGENTS.find((one) => one.id === id && one.origin === origin)
    if (!found?.definition || found.digest === null) {
      throw new Error(`${found?.path ?? id} cannot be read as an Agent, so its attachments cannot be shown.`)
    }
    return {
      agent: found.id,
      origin: found.origin,
      agentDigest: found.digest,
      skillsMode: 'runtime-defaults',
      mcpMode: 'runtime-defaults',
      declarations: [],
      support: [],
    }
  }
  projectChecks = async (): Promise<ProjectChecks> => PREVIEW_CHECKS

  // --- intake ------------------------------------------------------------
  projectTriggers = async (): Promise<import('@harnessdesk/protocol').TriggerProjectView> => triggerProjectView()
  previewTrigger = async (): Promise<import('@harnessdesk/protocol').TriggerArmPreview> => triggerArmPreview()
  armTrigger = async (): Promise<import('@harnessdesk/protocol').TriggerView> => triggerView({ armed: true, state: 'armed' })
  disarmTrigger = async (): Promise<import('@harnessdesk/protocol').TriggerView> => triggerView({ armed: false, state: 'off' })
  triggerHistory = async (): Promise<import('@harnessdesk/protocol').TriggerHistoryPage> => triggerHistoryPage()
  triggerPreferences = async (): Promise<import('@harnessdesk/protocol').TriggerPreferences> => triggerPreferencesFixture()
  setTriggerPreferences = async (
    _revision: number, paused: boolean, dailyUsd: number,
  ): Promise<import('@harnessdesk/protocol').TriggerPreferences> => triggerPreferencesFixture({ paused, dailyUsd })
  triggerGoal = async (goal: string): Promise<import('@harnessdesk/protocol').TriggerGoalStatus | null> =>
    goal === PREVIEW_TRIGGER_GOAL.goal.id ? triggerGoalStatus({ goal }) : null
  loadUnattendedCeilings = async (): Promise<'seat' | 'refuse'> => 'refuse'
  setUnattendedCeilings = async (): Promise<void> => {}

  // --- flows -----------------------------------------------------------
  flowGeneration = (): number => 0
  flowCatalog = async (): Promise<readonly FlowEntry[]> => PREVIEW_FLOWS
  flowSource = async (_root: string, id: string): Promise<string> => PREVIEW_FLOW_SOURCE[id] ?? PREVIEW_FLOW_SOURCE['fix']!
  previewFlow = async (_root: string, source: string): Promise<FlowPreview> => previewFlowPreviewFor(source)
  startFlowGoal = async (): Promise<FlowExecution> => {
    console.info('[preview] startFlowGoal')
    throw new Error('Starting a flow is not wired up in the preview harness.')
  }
  previewFlowUpdate = async (_root: string, _id: string, mode: 'update' | 'customize'): Promise<FlowUpdatePreview> =>
    mode === 'update' ? PREVIEW_FLOW_UPDATE : PREVIEW_FLOW_CUSTOMIZE
  applyFlowUpdate = async (): Promise<FlowUpdateResult> => ({ state: 'applied', written: PREVIEW_FLOW_UPDATE.edits.map((edit) => edit.path), message: 'The flow update was applied.' })
  readFlowExecution = async (): Promise<FlowExecution> => { throw new Error('[preview] no live flow execution to read here') }
  previewFlowRetry = async (): Promise<FlowPreview> => ({ ...FIX_PREVIEW, token: null, problems: [{ level: 'error', at: 'run', text: 'This flow or its seating changed. Review the dry run again before starting.' }] })
  retryFlowCheck = async (): Promise<FlowExecution> => { throw new Error('[preview] no live flow run to retry here') }

  // --- the dials -----------------------------------------------------------
  setTheme = (theme: AppSnapshot['theme']): void => this.patch({ theme })
  setPalette = (palette: AppSnapshot['palette']): void => this.patch({ palette })
  setAccent = (accent: AppSnapshot['accent']): void => this.patch({ accent })
  setCorners = (corners: AppSnapshot['corners']): void => this.patch({ corners })
  setLook = (next: AppSnapshot['look']): void => this.patch({ look: next })
  setProfile = (patch: ProfilePatch): void =>
    this.patch({ profile: applyProfile(this.#snapshot.profile, patch) })
  setEditorPrefs = (prefs: Partial<AppSnapshot['editorPrefs']>): void =>
    this.patch({ editorPrefs: { ...this.#snapshot.editorPrefs, ...prefs } })
  setListPrefs = (prefs: Partial<AppSnapshot['listPrefs']>): void =>
    this.patch({ listPrefs: { ...this.#snapshot.listPrefs, ...prefs } })

  // --- the composer's controls ---------------------------------------------
  // A choice lands on the conversation the way the host's answer would, so a
  // control reads back what was picked rather than the fixture's first word.
  setOption = async (id: string, value: OptionValue, key: SessionKey = PREVIEW_SESSION_KEY): Promise<void> => {
    const session = this.#snapshot.sessions.get(key)
    if (!session?.options) return
    const options = session.options.map((option) =>
      option.id === id ? ({ ...option, currentValue: value } as typeof option) : option,
    )
    this.patch({ sessions: new Map(this.#snapshot.sessions).set(key, { ...session, options }) })
  }

  // --- arranging the list --------------------------------------------------
  /*
   * These are real, not no-ops: folding a project, pinning one, expanding the
   * fold and pinning a session all change what the column looks like, which
   * is the whole reason to open this page. Every *other* verb the sidebar can
   * reach is answered by the proxy below.
   */
  toggleCollapsed = (root: string): void => {
    const collapsed = this.#snapshot.listPrefs.collapsed
    this.setListPrefs({
      collapsed: collapsed.includes(root)
        ? collapsed.filter((entry) => entry !== root)
        : [...collapsed, root],
    })
  }
  setProjectsCollapsed = (roots: readonly string[], collapsed: boolean): void => {
    const current = new Set(this.#snapshot.listPrefs.collapsed)
    for (const root of roots) collapsed ? current.add(root) : current.delete(root)
    this.setListPrefs({ collapsed: [...current] })
  }
  togglePinned = (root: string): void => {
    const pinned = this.#snapshot.listPrefs.pinned
    this.setListPrefs({
      pinned: pinned.includes(root) ? pinned.filter((entry) => entry !== root) : [...pinned, root],
    })
  }
  toggleSessionPinned = (key: string): void => {
    const pinned = this.#snapshot.listPrefs.pinnedSessions
    this.setListPrefs({
      pinnedSessions: pinned.includes(key)
        ? pinned.filter((entry) => entry !== key)
        : [...pinned, key],
    })
  }
  moveProject = (root: string, toIndex: number): void => {
    const pinned = this.#snapshot.listPrefs.pinned.filter((entry) => entry !== root)
    if (toIndex < 0 || toIndex > pinned.length) return this.setListPrefs({ pinned })
    this.setListPrefs({ pinned: [...pinned.slice(0, toIndex), root, ...pinned.slice(toIndex)] })
  }
  setOthersOpen = (othersOpen: boolean): void => this.setListPrefs({ othersOpen })

  // --- the team verbs, against the fixture ---------------------------------
  /* Annotated rather than inferred. An `async () =>` answers to nothing, which
     is how these objects once shipped without the `nickname` that
     `TeamPeerInfo` requires — a fixture that did not satisfy the type it was
     standing in for, and a room that threw because of it. */
  teamPeers = async (): Promise<readonly TeamPeerInfo[]> => [
    {
      runtime: runtimeId('codex'),
      sessionId: 'c1',
      title: 'API migration',
      /* The fixture names no real harness anywhere — the runtimes above are
         Alpha, Beta and Gamma — so a screen can never be read as a claim about
         one vendor's product. */
      agent: 'Alpha',
      nickname: 'Alpha',
      model: 'alpha-max',
      busy: true,
      here: true,
      inbound: 'accept',
    },
    {
      runtime: runtimeId('claude'),
      sessionId: 'k1',
      title: 'Auth refactor',
      agent: 'Beta',
      nickname: 'Beta',
      model: 'beta-pro',
      busy: false,
      /* One of the two is a member the desk does not have open, because that
         is the ordinary state of a room on the first launch of the day and a
         fixture where everybody is warm cannot show what the rail does with
         it. */
      here: false,
      inbound: 'accept',
    },
  ]

  teamPost = async (_root: string, text: string, to?: { runtime: unknown; sessionId: unknown }) => {
    this.#team((team) => ({
      ...team,
      channel: [
        ...team.channel,
        {
          id: `p${Date.now()}`,
          at: Date.now(),
          kind: 'message',
          from: { kind: 'user' },
          ...(to ? { to: { ...to, title: 'API migration' } } : {}),
          text,
          state: 'delivered',
          reason: null,
          envelope: null,
        } as unknown as TeamState['channel'][number],
      ],
    }))
  }

  teamAdd = async (_root: string, intent: { title: string }) => {
    this.#team((team) => ({
      ...team,
      intents: [
        ...team.intents,
        {
          id: team.intents.length + 1,
          title: intent.title,
          detail: null,
          state: 'open',
          files: [],
          dependsOn: [],
          claim: null,
          blockedReason: null,
          handoff: null,
          note: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as unknown as TeamState['intents'][number],
      ],
    }))
  }

  /**
   * The user's verbs, against the fixture — all five of them.
   *
   * `block` was missing here while it worked everywhere else, so on
   * /preview.html the Stop dialog closed and the card stayed exactly where it
   * was. That is worse than a preview that cannot do something at all: the one
   * surface whose whole job is to let a person try the interaction quietly
   * disagreed with the app about what the interaction does.
   *
   * It stops the same way the host stops it: the claim goes with it, the reason
   * is written on the card, and `blockedBy: 'hand'` so a finished dependency
   * would not put it back.
   */
  teamIntent = async (_root: string, id: number, action: string, reason?: string) => {
    this.#team((team) => ({
      ...team,
      intents: team.intents.map((intent) => {
        if (intent.id !== id) return intent
        if (action === 'block') {
          return {
            ...intent,
            state: 'blocked',
            claim: null,
            blockedReason: reason?.trim() || null,
            blockedBy: 'hand',
          } as typeof intent
        }
        return {
          ...intent,
          state: action === 'done' ? 'done' : action === 'abandon' ? 'abandoned' : 'open',
          claim: action === 'release' ? null : intent.claim,
          /* Reopening and releasing both clear the stop, the way the host's do
             — a card put back in play must not keep the sentence that stopped
             it. */
          ...(action === 'reopen' || action === 'release'
            ? { blockedReason: null, blockedBy: null }
            : {}),
        } as typeof intent
      }),
    }))
  }

  teamMessaging = async (_root: string, on: boolean) => {
    this.#team((team) => ({ ...team, messaging: on }))
  }

  teamDeliver = async (_root: string, id: string) => {
    this.#team((team) => ({
      ...team,
      channel: team.channel.map((entry) =>
        entry.kind === 'message' && entry.id === id
          ? ({ ...entry, state: 'delivered', reason: null } as typeof entry)
          : entry,
      ),
    }))
  }

  setSkillEnabled = async (
    skill: { name: string },
    enabled: boolean,
    on?: string,
  ): Promise<void> => {
    console.info('[preview] setSkillEnabled', skill.name, enabled, on)
  }

  // --- the pages that load something before they can draw --------------------
  // Each of these reads its answer with `.length`, so the proxy's undefined
  // answer is a throw, not an empty page.
  loadPolicyRules = async () => []
  savePolicyRules = async () => {}
  listBrowsers = async () => [
    { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  ]
  loadWorktrees = async () => {}
  agentCatalog = async () => []
  agentsIn = async (): Promise<readonly AgentEntry[]> => PREVIEW_AGENTS
  plansIn = async (): Promise<readonly SeatPlan[]> => [...PREVIEW_PLANS.values()]
  modelsFor = async (): Promise<readonly ModelInfo[]> => [
    {
      id: 'opus',
      displayName: 'Opus',
      isDefault: true,
      reasoningLevels: [{ id: 'high', label: 'High' }],
      supportsImages: false,
      thinking: 'optional',
    },
  ]
  loadSeating = async (): Promise<void> => {}
  setSeating = async (id: string, seats: readonly FlowSeat[] | null): Promise<void> => {
    const seating = this.#snapshot.seating
    if (!seating) return
    const entries = seating.entries.filter((entry) => entry.id !== id)
    this.patch({ seating: { ...seating, entries: seats ? [...entries, { id, seats }] : entries } })
  }
  // What a new session starts with, for the one agent that declares it —
  // the same shape Codex reports — so Permissions has something to show.
  newSessionDefaultsFor = async (id: string) =>
    id === 'codex'
      ? ([
          {
            id: 'approval',
            type: 'select',
            label: 'Approval',
            description: 'When the agent asks before acting.',
            currentValue: 'on-request',
            choices: [
              { value: 'untrusted', label: 'Untrusted commands' },
              { value: 'on-request', label: 'When it asks' },
              { value: 'never', label: 'Never', risk: 'high' },
            ],
          },
          {
            id: 'sandbox',
            type: 'select',
            label: 'Sandbox',
            currentValue: 'workspace-write',
            choices: [
              { value: 'read-only', label: 'Read only' },
              { value: 'workspace-write', label: 'Workspace' },
              { value: 'danger-full-access', label: 'Full access', risk: 'high' },
            ],
          },
          {
            id: 'approvalsReviewer',
            type: 'select',
            label: 'Reviewed by',
            description: 'Who decides on approval requests.',
            currentValue: 'user',
            choices: [
              { value: 'user', label: 'You' },
              { value: 'auto_review', label: 'Automatic review' },
              { value: 'guardian_subagent', label: 'Guardian sub-agent' },
            ],
          },
          {
            id: 'network',
            type: 'boolean',
            label: 'Network access',
            description: 'Lets commands in the sandbox reach the network.',
            currentValue: false,
          },
        ] as const)
      : []
  optionsFor = async () => []
  healthFor = async () => ({ state: 'ready' as const })
  limitsFor = async () => null
  // The Dashboard's own verbs. `ledger` is the only one that has to answer
  // with something: the rest are refreshes of a fixture that never goes
  // stale, so a resolved promise is the honest stub.
  ledger = async (query: { days: number; groupBy: string }): Promise<unknown> =>
    previewLedger(query.days, query.groupBy)

  loadUsage = async (): Promise<void> => {}
  refreshUsage = async (): Promise<void> => {}
  scanUsage = async (): Promise<void> => {}
  setUsageTracked = (): void => {}
  loadHooks = async () => []
  acpRegistry = async () => ({ agents: [], fetchedAt: null })

  /**
   * The findings ledger. Only the preview Goal (`PREVIEW_GOAL`) has one; any
   * other room reads as empty — never the fallback proxy's silent `undefined`,
   * which would leave `GoalFindings` reading "Reading findings…" forever.
   */
  loadFindings = async (goal: string, filter: FindingFilter = 'all'): Promise<void> => {
    const state = goal === PREVIEW_GOAL.goal.id ? findingsListState(filter) : EMPTY_FINDINGS_STATE
    this.patch({ findings: new Map(this.#snapshot.findings).set(goal, state) })
  }

  readFinding = async (_goal: string, finding: string): Promise<FindingDetailPage> => findingDetail(finding)

  carryFindings = async (_input: CarryFindingsInput): Promise<readonly FindingView[]> => []

  readFindingPublications = async (goal: string, run: string): Promise<FindingPublicationsView> =>
    ({ goal, run, items: [], backfill: null, backfillRefusal: 'The preview desk posts nothing.' })

  publishFinding = async (input: { goal: string; run: string }): Promise<FindingPublicationsView> =>
    ({ goal: input.goal, run: input.run, items: [], backfill: null, backfillRefusal: 'The preview desk posts nothing.' })

  setFindingPublication = async (goal: string, revision: number, enabled: boolean): Promise<GoalView> => {
    const current = this.#snapshot.goals.get(goal)
    const next: GoalView = current
      ? { ...current, goal: { ...current.goal, findingPublication: enabled, revision: revision + 1 } }
      : PREVIEW_GOAL
    this.patch({ goals: new Map(this.#snapshot.goals).set(goal, next) })
    return next
  }

  // --- the wire, method-aware ----------------------------------------------
  transport = {
    request: async (method: string, params?: unknown): Promise<unknown> => {
      if (method === 'library/read') return LIBRARY
      if (method === 'library/definition') {
        const name = (params as { name?: string } | undefined)?.name ?? ''
        const text = DEFINITIONS[name]
        return text === undefined
          ? null
          : {
              name,
              kind: 'skill',
              path: `/home/u/.claude/skills/${name}`,
              text,
              truncated: false,
              files: [
                { path: 'SKILL.md', bytes: text.length },
                { path: 'references/checklist.md', bytes: 2410 },
                { path: 'scripts/run.py', bytes: 5120 },
              ],
              moreFiles: 0,
            }
      }
      if (method === 'library/usage')
        return {
          generatedAt: now,
          sessionsScanned: 42,
          skills: {
            'code-review': {
              activations: 18,
              sessions: 9,
              lastAt: now - 86_400_000,
              byRuntime: { claude: { activations: 18 } },
            },
          },
        }
      /* The repository the git pane shows — `git-fixture.ts`. Reads only;
         a write verb from the pane falls through to `null` like any other
         method this page does not implement. */
      /* A terminal redraws from its scrollback before anything else; see
         `terminal-fixture.ts`. Writes and resizes answer `null`, as the host
         does — there is no shell here to receive them. */
      if (method === 'terminal/attach') return terminalAttach()
      if (method === 'workspace/readFile') {
        const path = (params as { path?: string } | undefined)?.path ?? ''
        if (path.endsWith('lib/brands.ts'))
          return { content: editorSource, truncated: false, hash: `len-${editorSource.length}` }
        return null
      }
      if (method === 'workspace/stat') return { kind: 'file', isSymlink: false, modifiedAt: now }
      if (method === 'git/log') return gitLog()
      if (method === 'git/refs') return gitRefs()
      if (method === 'git/status') return gitStatus()
      if (method === 'git/worktrees') return gitWorktrees()
      if (method === 'git/commit') return gitCommit((params as { sha?: string } | undefined)?.sha ?? '')
      if (method === 'audit/query') return []
      if (method === 'library/plan') return { plannedAt: now, ops: [] }
      return null
    },
  }
}

/**
 * The store the page mounts screens on: the fixture, with a floor under it.
 *
 * A screen reaches for far more verbs than a fixture wants to implement —
 * `forkSession`, `revealWorkspace`, `openTerminal`, `deleteSession` — and the
 * `as unknown as AppStore` cast means the compiler cannot say which are
 * missing. Listing them by hand is the same bet each time, and it is lost the
 * day someone adds a verb: `toggleCollapsed` was missing from the
 * first version of this file, so clicking a project row threw.
 *
 * So anything not implemented above is answered by a no-op that resolves, and
 * says on the console which verb it swallowed. The page cannot be crashed by
 * an unimplemented action, and the fixture still tells you what it is not
 * doing. Functions are bound to the instance because the private fields the
 * real methods read are not reachable through a proxy `this`.
 */
/**
 * A store of the page's own, seeded over the fixture.
 *
 * Every surface shares `store` below, which is what `/preview.html` and the
 * browser specs read. A surface that needs a different *state* — the Panels
 * tab needs docks with something in them, and the app opens with every dock
 * empty — takes one of these instead, so its state cannot leak into a screen
 * or a spec that did not ask for it.
 */
export const previewStore = (seed: Partial<AppSnapshot> = {}): AppStore => new Proxy(new PreviewStore(seed), {
  get(target, property, receiver) {
    if (Reflect.has(target, property)) {
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
    if (typeof property === 'symbol') return Reflect.get(target, property, receiver)
    /* A subscription must answer synchronously with its unsubscribe.
       `onTerminal` is the store's one `on…` verb and returns `() => void`; the
       async floor below handed back a Promise instead, so the terminal pane
       called `offLive()` on it during cleanup and threw — which is how the
       tools surface mounted a browser and an editor and a crash where the
       terminal should be. Keyed on the store's own naming, so the next
       subscription added to the store is answered correctly without anyone
       having to remember this file. */
    if (/^on[A-Z]/.test(property)) {
      return (...args: unknown[]) => {
        console.warn(`[preview] store.${property} is not implemented here`, ...args)
        return () => {}
      }
    }
    return async (...args: unknown[]) => {
      console.warn(`[preview] store.${String(property)} is not implemented here`, ...args)
    }
  },
}) as unknown as AppStore

export const store = previewStore()

/**
 * Mount a production screen: the store under it, the app's window mode around
 * it, and one screen's crash kept to one screen.
 *
 * The app gives a screen a store through context and tells it, through
 * `AppWindowMode`, whether it is standing in a window of its own. A screen
 * mounted without those does not render a *simpler* version of itself — it
 * throws, or it renders the branch the app never shows. So every surface goes
 * through here, and what the catalogue draws is what the app draws.
 */
export const Mount = ({ children, with: own }: { children: ReactNode; with?: AppStore }) => (
  <StoreProvider store={own ?? store}>
    <AppWindowMode.Provider value="embedded">
      <Boundary>{children}</Boundary>
    </AppWindowMode.Provider>
  </StoreProvider>
)

export { Boundary }
