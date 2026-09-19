import {
  runtimeId,
  sessionKey,
  type BoardEvidence,
  type CardEvidence,
  type CheckRun,
  type CheckUnseen,
  type Evidence,
  type EvidenceView,
  type Freshness,
  type Intent,
  type ProjectChecks,
  type SeatRecord,
  type SessionId,
  type TeamState,
} from '@harnessdesk/protocol'

import { PREVIEW_ROOT } from './sidebar-fixture'

/** Synthetic evidence fixtures shared by the preview and renderer tests. */
export const EVIDENCE_ROOM = 'room-evidence'

export const FRESH: Freshness = { state: 'fresh' }

const sha = (short: string): string => short.padEnd(40, '0')

export const HEAD = sha('a1b2c3d')
export const BASE = sha('0f1e2d3')

let minted = 0

export const factView = (
  fact: Evidence,
  over: {
    readonly freshness?: Freshness
    readonly card?: number
    readonly by?: EvidenceView['by']
    readonly round?: number | null
    readonly observedAt?: number
  } = {},
): EvidenceView => {
  minted += 1
  return {
    record: {
      id: `fact-${minted}`,
      fact,
      card: { board: EVIDENCE_ROOM, id: over.card ?? 1 },
      checkout: { cwd: PREVIEW_ROOT, branch: 'retry-on-502' },
      seat: over.by === null ? null : 'seat-1',
      round: over.round ?? null,
      observedAt: over.observedAt ?? Date.UTC(2026, 8, 18, 14, 5),
      posted: null,
    },
    freshness: over.freshness ?? FRESH,
    by: over.by === undefined ? { agent: 'Scout', seat: 'Alpha · alpha-max' } : over.by,
  }
}

export const checkView = (
  over: {
    readonly name?: string
    readonly exit?: number | null
    readonly timedOut?: boolean
    readonly at?: string
    readonly tail?: string
    readonly run?: string
    readonly freshness?: Freshness
    readonly card?: number
  } = {},
): EvidenceView =>
  factView(
    {
      kind: 'check',
      name: over.name ?? 'verify',
      run: over.run ?? 'pnpm verify',
      exit: over.exit === undefined ? 0 : over.exit,
      timedOut: over.timedOut ?? false,
      at: over.at ?? HEAD,
      dirty: over.freshness?.state === 'uncommitted',
      tail: over.tail ?? '',
    },
    { ...(over.freshness ? { freshness: over.freshness } : {}), ...(over.card ? { card: over.card } : {}) },
  )

export const ciView = (
  states: readonly CheckRun['state'][],
  over: { readonly freshness?: Freshness; readonly card?: number } = {},
): EvidenceView =>
  factView(
    {
      kind: 'ci',
      checks: states.map((state, n) => ({
        name: ['build', 'lint', 'e2e', 'docs'][n] ?? `check ${n}`,
        state,
        url: null,
      })),
      at: HEAD,
    },
    { ...over, by: null },
  )

export const prView = (
  state: 'open' | 'merged' | 'closed',
  over: { readonly number?: number; readonly freshness?: Freshness; readonly card?: number } = {},
): EvidenceView =>
  factView(
    { kind: 'pr', number: over.number ?? 12, head: HEAD, state, url: 'https://example.com/storefront/pull/12' },
    { ...(over.freshness ? { freshness: over.freshness } : {}), ...(over.card ? { card: over.card } : {}), by: null },
  )

export const diffView = (over: { readonly freshness?: Freshness; readonly card?: number } = {}): EvidenceView =>
  factView({ kind: 'diff', files: 6, added: 120, removed: 30, from: BASE, to: HEAD }, over)

export const cardEvidence = (
  card: number,
  facts: readonly EvidenceView[],
  running: CardEvidence['running'] = [],
): CardEvidence => ({ card, facts, running })

const at = Date.UTC(2026, 8, 18, 13, 0)

const card = (id: number, title: string, over: Partial<Intent> = {}): Intent => ({
  id,
  title,
  detail: null,
  state: 'done',
  files: [],
  dependsOn: [],
  claim: null,
  blockedReason: null,
  handoff: null,
  note: null,
  createdAt: at,
  updatedAt: at,
  ...over,
})

export const EVIDENCE_TEAM: TeamState = {
  id: EVIDENCE_ROOM,
  name: 'Checkout hardening',
  updatedAt: at,
  root: PREVIEW_ROOT,
  members: [
    sessionKey(runtimeId('codex'), 'c1' as SessionId),
    sessionKey(runtimeId('claude'), 'k1' as SessionId),
  ],
  messaging: true,
  intents: [
    card(1, 'Retry the checkout call on a 502'),
    card(2, 'Cap the backoff and add jitter'),
    card(3, 'Cover both in retry.test.ts'),
    card(4, 'Make the webhook receiver idempotent', {
      state: 'claimed',
      claim: { runtime: runtimeId('codex'), sessionId: 'c1', at },
    }),
    card(5, 'Decide the alert threshold for retry storms', { state: 'open' }),
    card(6, 'Tidy the retry logging', { note: 'Done — all tests pass.' }),
    card(7, 'Retry on a 429 as well', {
      state: 'abandoned',
      note: 'Not needed: the gateway retries these itself.',
    }),
  ],
  channel: [
    {
      id: 'claim-1',
      at,
      kind: 'message',
      from: { kind: 'agent', runtime: runtimeId('claude'), sessionId: 'k1', title: 'Auth refactor' },
      to: { runtime: runtimeId('codex'), sessionId: 'c1', title: 'API migration' },
      text: 'verify passed on #6, all tests pass — ready to merge.',
      state: 'delivered',
    },
  ],
  nicknames: {},
  plans: [],
}

export const EVIDENCE_BOARD: BoardEvidence = {
  room: EVIDENCE_ROOM,
  stamp: at,
  checks: ['verify', 'lint'],
  refused: [
    {
      name: 'e2e',
      why: 'The command holds a character that is not plain printable ASCII — a control character, an invisible one, or a letter that can pass for another. What runs has to be exactly what is shown, so it is not offered.',
    },
  ],
  unreadable: null,
  cards: [
    cardEvidence(1, [
      checkView({ card: 1 }),
      ciView(['passed', 'passed', 'skipped'], { card: 1 }),
      prView('open', { card: 1 }),
      diffView({ card: 1 }),
    ]),
    cardEvidence(2, [
      checkView({ card: 2, freshness: { state: 'behind', commits: 2 } }),
      diffView({ card: 2, freshness: { state: 'behind', commits: 2 } }),
    ]),
    cardEvidence(3, [prView('open', { number: 14, card: 3 })], [{ name: 'verify', since: at }]),
    cardEvidence(4, [diffView({ card: 4 })]),
  ],
}

export const PREVIEW_SEAT: SeatRecord = {
  id: 'seat-1',
  agent: { id: 'scout', name: 'Scout', origin: 'project' },
  briefDigest: 'digest-1',
  seat: { runtime: 'codex', model: 'alpha-max' },
  seatLabel: 'Alpha · alpha-max',
  passedOver: [
    {
      seat: { runtime: 'claude' },
      label: 'Beta · beta-pro',
      runtimeName: 'Beta',
      state: 'passed',
      reason: null,
      fix: null,
    },
  ],
  standing: { kind: 'permission', permission: 'read' },
  ceiling: null,
  checkout: { cwd: '/home/dev/code/HarnessDesk', project: PREVIEW_ROOT, branch: 'retry-on-502', head: HEAD },
  session: { runtime: 'codex', sessionId: 's1' },
  board: EVIDENCE_ROOM,
  role: null,
  openedAt: Date.UTC(2026, 8, 18, 12, 40),
  closed: null,
}

export const PREVIEW_CHECKS: ProjectChecks = {
  project: PREVIEW_ROOT,
  file: `${PREVIEW_ROOT}/.harnessdesk/checks.yml`,
  exists: true,
  at: HEAD,
  uncommitted: false,
  checks: [
    { name: 'verify', run: 'pnpm verify', timeout: 1200, seen: 'yes' },
    { name: 'lint', run: 'pnpm lint --max-warnings 0', timeout: 600, seen: 'changed' },
    { name: 'types', run: 'pnpm typecheck', timeout: 600, seen: 'no' },
  ],
  problems: [
    {
      at: 'e2e.run',
      check: 'e2e',
      text: 'The command holds a character that is not plain printable ASCII — a control character, an invisible one, or a letter that can pass for another. What runs has to be exactly what is shown, so it is not offered.',
    },
  ],
}

export const PREVIEW_UNSEEN: CheckUnseen = {
  check: { name: 'lint', run: 'pnpm lint --max-warnings 0', timeout: 600 },
  previous: 'pnpm lint',
  cwd: PREVIEW_ROOT,
  file: `${PREVIEW_ROOT}/.harnessdesk/checks.yml`,
  digest: sha('c4ec5f1'),
}
