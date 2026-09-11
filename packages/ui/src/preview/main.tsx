import {
  Component,
  StrictMode,
  useState,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { createRoot } from 'react-dom/client'

import { runtimeId, sessionKey, type RuntimeInfo, type Session, type SessionId, type TeamPeerInfo, type TeamState } from '@harnessdesk/protocol'

import { Conversation } from '../components/Conversation'
import { ChangesView, TrajectoryView } from '../components/Details'
import { AppearanceSection } from '../components/SettingsYou'
import { LibrarySection } from '../components/Library'
import { Settings, type Section } from '../components/Settings'
import { Usage } from '../components/Usage'
import { Sidebar } from '../components/Sidebar'
import { TeamBoardPane } from '../components/TeamBoardPane'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { NativeSelect } from '../design/ui'
import { PaneProvider, StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
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
import '../styles/app.css'

/**
 * The screen preview: real screens on a stubbed store, in a browser.
 *
 * `pnpm --filter @harnessdesk/ui run dev`, then /preview.html. Dev-only —
 * the build's rollup inputs never list this page. It exists because the
 * screens worth restyling are exactly the ones that need a host: the Team
 * tab wants a board with traffic on it, the Library wants four agents'
 * directories, and neither state can be arranged on demand in the real app.
 * Here the store is a fixture and every theme dial is on the page, so a
 * change to a screen or to the token layer can be seen in every palette in
 * under a minute.
 *
 * The store stub is the smallest thing the mounted screens actually call —
 * a snapshot, a listener set, the team verbs (which mutate the fixture, so
 * posting works), and a method-aware transport for the library reads.
 */

const runtime = (id: string, name: string): RuntimeInfo =>
  ({ id: runtimeId(id), name, capabilities: {}, presentation: { name } }) as unknown as RuntimeInfo

/** The conversation every frame below is scoped to. */
const PREVIEW_SESSION_KEY = sessionKey(runtimeId('codex'), 's1' as SessionId)

const now = Date.now()
const yesterday = now - 26 * 60 * 60 * 1000

const PREVIEW_ROOM = 'room-preview'
/* A second room with nothing in it, so the board's empty state is a frame on
   the page rather than a thing you have to clear a fixture to see. */
const EMPTY_ROOM = 'room-empty'
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
const EDGE_ROOM = 'room-edges'

const TEAM: TeamState = {
  id: PREVIEW_ROOM,
  name: 'Checkout rewrite',
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

/** The smallest store the mounted screens call. */
class PreviewStore {
  #snapshot: AppSnapshot
  #listeners = new Set<() => void>()

  constructor() {
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
        runtime('codex', 'Alpha'),
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
          name: 'Careful reviewer',
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
      ]),
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
          previewSession,
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
    } as AppSnapshot
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

  #team(mutate: (team: TeamState) => TeamState): void {
    const team = this.#snapshot.teams.get(PREVIEW_ROOM)
    if (!team) return
    this.patch({ teams: new Map([[PREVIEW_ROOM, mutate(team)]]) } as Partial<AppSnapshot>)
  }

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
const store = new Proxy(new PreviewStore(), {
  get(target, property, receiver) {
    if (Reflect.has(target, property)) {
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
    if (typeof property === 'symbol') return Reflect.get(target, property, receiver)
    return async (...args: unknown[]) => {
      console.warn(`[preview] store.${String(property)} is not implemented here`, ...args)
    }
  },
}) as unknown as AppStore

/**
 * One screen's crash is one screen's crash.
 *
 * React unmounts the whole root on an uncaught render error, so without this
 * a single broken frame blanks the page and takes every other screen — and
 * the reason to open this page at all — with it.
 *
 * It logs as well as renders, because a component going blank sends most
 * people to DevTools before the page; and the message is a button, because
 * an error boundary latches — without a way to clear it, fixing the bug and
 * letting HMR swap the module still shows the old error until a full reload.
 */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[preview] a frame threw while rendering', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <button
          type="button"
          className="block w-full p-4 text-left text-sm text-destructive"
          onClick={() => this.setState({ error: null })}
          title="Render this frame again — use it after fixing the cause."
        >
          This screen threw while rendering: {this.state.error.message}
          <span className="mt-1 block text-muted-foreground">Click to retry.</span>
        </button>
      )
    }
    return this.props.children
  }
}

/** A stand-in pane, so the frame's own edges are what the frame shows. */
const Frame = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="min-w-0">
    <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{title}</h2>
    <div className="overflow-hidden rounded-lg border bg-background">
      <Boundary>{children}</Boundary>
    </div>
  </section>
)

const Dial = <T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly T[]
  onChange: (next: T) => void
}) => (
  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
    {label}
    <NativeSelect value={value} onChange={(event) => onChange(event.target.value as T)}>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </NativeSelect>
  </label>
)

const SETTINGS_SECTIONS = [
  'profile',
  'general',
  'appearance',
  'notifications',
  'shortcuts',
  'workspaces',
  'archive',
  'agents',
  'models',
  'skills',
  'extensions',
  'library',
  'plugins',
  'permissions',
  'browser',
] as const satisfies readonly Section[]

const Preview = () => {
  useTheme()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  // The whole `Section`, not just the dial's shortlist: the sheet's own nav
  // rail writes back here too, and it offers every page.
  const [settingsSection, setSettingsSection] = useState<Section>('general')
  return (
    <div className="min-h-full bg-background p-4 text-foreground">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold">Screen preview</span>
        <Dial
          label="theme"
          value={snapshot.theme}
          options={['system', 'light', 'dark'] as const}
          onChange={(next) => store.setTheme(next)}
        />
        <Dial
          label="palette"
          value={snapshot.palette}
          options={['harnessdesk', 'editorial', 'shadcn'] as const}
          onChange={(next) => store.setPalette(next)}
        />
        <Dial
          label="accent"
          value={snapshot.accent}
          options={['default', 'violet', 'green', 'rose', 'orange', 'mono'] as const}
          onChange={(next) => store.setAccent(next)}
        />
        <Dial
          label="interface"
          value={snapshot.look}
          options={['desk', 'studio'] as const}
          onChange={(next) => store.setLook(next)}
        />
        <Dial
          label="corners"
          value={snapshot.corners}
          options={['default', 'square', 'round'] as const}
          onChange={(next) => store.setCorners(next)}
        />
      </div>
      {/* The board, in a pane of its own — which is one of the two shapes it
          really has (the other is the room's right half, further down). It is
          first here because it is the widest surface the token layer touches:
          a button, a chip, a card, a column ground and an empty state all in
          one screen, so a change to the system is visible here before it is
          hunted for anywhere else. */}
      <Frame title="Board — the pane, with work on it">
        <div className="h-[560px]">
          <TeamBoardPane room={PREVIEW_ROOM} />
        </div>
      </Frame>
      <Frame title="Board — the empty state">
        <div className="h-[420px]">
          <TeamBoardPane room={EMPTY_ROOM} />
        </div>
      </Frame>
      {/* Narrow on purpose: the room gives its board whatever the rail left
          over, and every truncation bug this fixture exists for only appears
          at a width the card cannot have all of. */}
      <Frame title="Board — the edges, at the width the room leaves it">
        <div className="h-[560px] w-[760px]">
          <TeamBoardPane room={EDGE_ROOM} />
        </div>
      </Frame>
      {/* Settings is a fixed-position sheet, so it would paint over the whole
          page. A `transform` on the wrapper makes it the containing block for
          `position: fixed`, which pins the real dialog — unedited — inside a
          frame. It is the only way to see the settings surface at the 980px
          it actually opens at. */}
      <Frame title="Settings — the sheet, its nav, and a page">
        <div className="relative h-[860px]" style={{ transform: 'translateZ(0)' }}>
          {/* The page is the caller's, so the dial drives it directly and the
              sheet's own nav rail writes back to the same state — no remount,
              and clicking around in here moves the dial with it. */}
          <Settings
            section={settingsSection}
            onSection={setSettingsSection}
            onClose={() => {}}
            onSignIn={() => {}}
          />
        </div>
      </Frame>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Dial
          label="settings page"
          value={settingsSection}
          options={SETTINGS_SECTIONS}
          onChange={setSettingsSection}
        />
      </div>
      {/* The Dashboard, at the width the window really opens it at. Its own
          rail scopes the page, so clicking an account in here shows the
          burn-down band the way the app does.

          It needs the same `transform` the Settings frame above does, and for
          the same reason: `Usage` is an `AppWindow`, which is
          `position: fixed`. Without a containing block it escaped its frame
          and painted over the *whole* preview page — every other frame on
          this page became unreachable, and a screenshot of any of them came
          back as the Dashboard. One line, and the trap is already documented
          four frames up. */}
      <Frame title="Dashboard — what is left, what it cost, where it went">
        <div className="relative h-[900px]" style={{ transform: 'translateZ(0)' }}>
          <Usage onClose={() => {}} onSignIn={() => {}} />
        </div>
      </Frame>

      {/* The conversation, which is the app. It is scoped by a `PaneProvider`
          exactly the way the workbench scopes it, so this is the same
          component the window renders and not a reduced one — the transcript,
          its header, and the composer under it. */}
      <Frame title="Conversation — the transcript and its composer">
        <div className="h-[820px]">
          <PaneProvider
            scope={{
              paneId: 'preview' as never,
              view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
              sessionKey: PREVIEW_SESSION_KEY,
            }}
          >
            <Conversation
              onChooseProject={() => {}}
              onSignIn={() => {}}
              onOpenUsage={() => {}}
              onOpenAgents={() => {}}
            />
          </PaneProvider>
        </div>
      </Frame>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[380px_1fr]">
        {/* The two right-dock panels, at the width the dock actually gives
            them — a panel judged at full width is not the panel. */}
        <Frame title="Side panel — Changes">
          <div className="h-[420px]">
            <PaneProvider
              scope={{
                paneId: 'preview' as never,
                view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
                sessionKey: PREVIEW_SESSION_KEY,
              }}
            >
              <ChangesView />
            </PaneProvider>
          </div>
        </Frame>
        <Frame title="Side panel — Trajectory">
          <div className="h-[420px]">
            <PaneProvider
              scope={{
                paneId: 'preview' as never,
                view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
                sessionKey: PREVIEW_SESSION_KEY,
              }}
            >
              <TrajectoryView />
            </PaneProvider>
          </div>
        </Frame>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[380px_1fr]">
        {/* The sidebar at its real width, on the plate it really sits on:
            the right edge only reads true against the column's own ground. */}
        <Frame title="Sidebar — the column and its right edge">
          <div
            className="h-[720px]"
            style={{ width: 260, background: 'var(--hd-sidebar-plate, transparent)' }}
          >
            <Sidebar
              onOpenSettings={() => {}}
              onOpenPlugins={() => {}}
              onOpenUsage={() => {}}
              onBrowseFolders={() => {}}
              onSignIn={() => {}}
              onSearch={() => {}}
            />
          </div>
        </Frame>
        <Frame title="Team room — the roster, and the channel">
          <div className="h-[540px]">
            <TeamRoomPane room={PREVIEW_ROOM} />
          </div>
        </Frame>
        <div className="flex min-w-0 flex-col gap-4">
          <Frame title="Settings › Library">
            <div className="max-h-[540px] overflow-y-auto p-4">
              <LibrarySection />
            </div>
          </Frame>
          <Frame title="Settings › Appearance">
            <div className="p-4">
              <AppearanceSection />
            </div>
          </Frame>
        </div>
      </div>
    </div>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from preview.html')

createRoot(container).render(
  <StrictMode>
    <StoreProvider store={store}>
      <Preview />
    </StoreProvider>
  </StrictMode>,
)
