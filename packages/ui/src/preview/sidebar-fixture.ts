import {
  NO_PERMISSIONS,
  pluginInstanceId,
  runtimeId,
  type Account,
  type AccountStatus,
  type PluginInstance,
  type AgentItem,
  type RuntimeId,
  type Session,
  type SessionId,
  type SessionSummary,
  type UsageReport,
} from '@harnessdesk/protocol'

/**
 * A sidebar with enough in it to judge its right edge.
 *
 * The column's trailing marks — counts, glyphs, the hover buttons — only
 * misalign when there is something in every slot at once: a badge on two nav
 * rows, a pinned project with a count, worktree sessions whose titles are
 * both short and long, and a fold of other projects. An empty store shows
 * none of it, which is why this fixture exists rather than a screenshot.
 */

const CODEX = runtimeId('codex')
const CURSOR = runtimeId('cursor')
const CLAUDE = runtimeId('claude')

/**
 * The folder the preview has open.
 *
 * Exported because it is one fact, not two: the sidebar groups by it, the
 * board is keyed on it, and the team room is opened at it. When those drifted
 * apart the board strip silently stopped rendering — nothing threw, the line
 * was simply never there.
 */
export const PREVIEW_ROOT = '/Users/shane/code/HarnessDesk'

const HOME = PREVIEW_ROOT

const account = (label: string): Account => ({ kind: 'oauth', label, email: label })

export const previewAccounts: Record<string, AccountStatus> = {
  [CODEX]: { signedIn: true, accounts: [account('shane@harnessdesk.app')] },
  [CURSOR]: { signedIn: true, accounts: [account('Shane-Cursor')] },
  [CLAUDE]: { signedIn: true, accounts: [account('shane@harnessdesk.app')] },
} as unknown as Record<string, AccountStatus>

const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * One rolling allowance.
 *
 * `elapsed` is what makes this fixture worth having: the burn-down draws the
 * *shape* of a window, so a lane has to say how far into its window it is as
 * well as how much of it is gone. A lane 60% through its week with 20% left
 * is the card that is about to bite; one 60% through with 80% left is the one
 * that is fine. Both read "20% used" and "80% used" without it.
 */
const lane = (
  id: string,
  label: string,
  usedPercent: number,
  windowMinutes: number,
  elapsed: number,
  over: Record<string, unknown> = {},
) => ({
  id,
  label,
  usedPercent,
  windowMinutes,
  resetsAt: Date.now() + windowMinutes * 60_000 * (1 - elapsed),
  ...over,
})

/**
 * Four accounts, chosen so every state the Dashboard draws is on the page at
 * once: one being outrun, one conserving, one with a model-scoped lane spent
 * behind a healthy account, one with a balance and no window at all.
 */
export const previewUsage: UsageReport[] = [
  {
    runtime: CLAUDE,
    account: 'shane@harnessdesk.app',
    plan: 'Max 20x',
    lanes: [
      lane('session', 'Session', 71, 300, 0.42),
      lane('weekly', 'Weekly', 88, 10_080, 0.55),
      lane('weekly:fable', 'Weekly', 100, 10_080, 0.55, { scope: 'Fable' }),
      lane('review', 'Code review', 0, 10_080, 0.55, { usageKnown: false }),
    ],
    credits: null,
    spend: null,
    reached: null,
    source: { kind: 'file', label: "from Claude Code's own cache" },
    fetchedAt: Date.now() - 4 * 60_000,
    staleAfterMs: 600_000,
    error: null,
  },
  {
    runtime: CODEX,
    account: 'shane@harnessdesk.app',
    plan: 'Team',
    lanes: [
      lane('session', '5-hour', 22, 300, 0.61),
      lane('weekly', 'Weekly', 34, 10_080, 0.48),
    ],
    credits: null,
    spend: null,
    reached: null,
    source: { kind: 'runtime', label: 'from its own API' },
    fetchedAt: Date.now() - 40_000,
    staleAfterMs: 600_000,
    error: null,
  },
  {
    /*
     * A second account on the same agent, because one agent holding two is a
     * supported shape and every surface has to say *which* — the rail keys its
     * rows by `runtime:account`, and the burn-down band used to draw whichever
     * of them sorted first with its account named nowhere.
     */
    runtime: CLAUDE,
    account: 'olivia@harnessdesk.app',
    plan: 'Pro',
    lanes: [lane('session', 'Session', 12, 300, 0.31), lane('weekly', 'Weekly', 44, 10_080, 0.55)],
    credits: null,
    spend: null,
    reached: null,
    source: { kind: 'file', label: "from Claude Code's own cache" },
    fetchedAt: Date.now() - 2 * 60_000,
    staleAfterMs: 600_000,
    error: null,
  },
  {
    runtime: CURSOR,
    account: 'Shane-Cursor',
    plan: 'Pro',
    lanes: [lane('plan', 'Plan', 9, 30 * 1_440, 0.72)],
    credits: { remaining: 10.66, used: 39.34, unit: 'USD' },
    spend: null,
    reached: null,
    source: { kind: 'api', label: 'from cursor.com' },
    fetchedAt: Date.now() - 90_000,
    staleAfterMs: 600_000,
    error: null,
  },
] as unknown as UsageReport[]

/**
 * A month of spend, split three ways.
 *
 * Deliberately uneven: a weekend of nothing, one day that dwarfs the rest,
 * and one agent that only appears halfway through. A smooth fixture makes
 * every chart look correct.
 */
export const previewLedger = (days: number, groupBy: string): unknown => {
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const start = midnight.getTime()
  const daily: { day: number; runtime: RuntimeId; cost: number; tokens: number }[] = []
  for (let index = days - 1; index >= 0; index -= 1) {
    const day = start - index * DAY
    const weekend = [0, 6].includes(new Date(day).getDay())
    if (weekend && index % 3 !== 0) continue
    const swell = index === 4 ? 3.4 : index === 11 ? 2.1 : 1
    const wobble = 0.55 + ((index * 37) % 100) / 100
    daily.push({ day, runtime: CLAUDE, cost: 41 * wobble * swell, tokens: 4_100_000 * wobble })
    daily.push({ day, runtime: CODEX, cost: 12 * wobble, tokens: 1_800_000 * wobble })
    if (index < days / 2) {
      daily.push({ day, runtime: CURSOR, cost: 3.2 * wobble, tokens: 320_000 * wobble })
    }
  }
  const totalCost = daily.reduce((sum, entry) => sum + entry.cost, 0)
  const byKey = new Map<string, { label: string; runtime: RuntimeId | null; cost: number; tokens: number }>()
  const put = (key: string, label: string, runtime: RuntimeId | null, cost: number, tokens: number): void => {
    const row = byKey.get(key) ?? { label, runtime, cost: 0, tokens: 0 }
    row.cost += cost
    row.tokens += tokens
    byKey.set(key, row)
  }
  for (const entry of daily) {
    if (groupBy === 'runtime') put(String(entry.runtime), String(entry.runtime), entry.runtime, entry.cost, entry.tokens)
    else if (groupBy === 'model') {
      const model = entry.runtime === CODEX ? 'gpt-5.6-sol' : entry.runtime === CLAUDE ? 'claude-opus-5' : 'composer-2'
      put(model, model, entry.runtime, entry.cost, entry.tokens)
    } else {
      put(PREVIEW_ROOT, 'HarnessDesk', entry.runtime, entry.cost * 0.8, entry.tokens)
      put(`${HOME}/site`, 'harnessdesk-site', entry.runtime, entry.cost * 0.2, entry.tokens * 0.2)
    }
  }
  return {
    days,
    currency: 'USD',
    totalCost,
    totalTokens: daily.reduce((sum, entry) => sum + entry.tokens, 0),
    provenance: 'mixed',
    coverage: { priced: 30_052, unpriced: 44, unmetered: 0, estimated: 0, daysCovered: Math.min(days, 22), daysRequested: days },
    rows: [...byKey.entries()]
      .map(([key, row]) => ({ key, ...row, hasUnpriced: key.includes('composer') }))
      .sort((a, b) => b.cost - a.cost),
    daily,
    scannedAt: Date.now() - 20 * 60_000,
  }
}

const minutes = (n: number): number => Date.now() - n * 60_000

interface Seed {
  readonly title: string
  readonly cwd: string
  readonly branch: string
  readonly ago: number
  readonly runtime?: RuntimeId
}

const seed = (root: string, entries: readonly Seed[], offset = 0): SessionSummary[] =>
  entries.map(
    (entry, index) =>
      ({
        id: `s${offset + index}` as SessionId,
        runtime: entry.runtime ?? CODEX,
        title: entry.title,
        cwd: entry.cwd,
        status: { type: 'idle' },
        createdAt: minutes(entry.ago + 60),
        updatedAt: minutes(entry.ago),
        git: { branch: entry.branch, dirty: false },
        repo: { root, worktree: entry.cwd !== root, originUrl: null },
      }) as unknown as SessionSummary,
  )

const worktree = (name: string): string => `${HOME}/.claude/worktrees/${name}`

/**
 * The rows the screenshot showed, plus the two cases it did not: a title
 * short enough to leave the worktree glyph stranded mid-row, and one long
 * enough to truncate against it.
 */
export const previewHistory: SessionSummary[] = [
  ...seed(
    HOME,
    [
      { title: 'Duplicate Codex accounts logged in twice', cwd: worktree('dupe-accounts-91c2'), branch: 'fix/dupe-accounts', ago: 4 },
      { title: 'Worktree Management', cwd: worktree('worktree-mgmt-4f10'), branch: 'feat/worktrees', ago: 26 },
      { title: 'Learn from every single tab of the settings screen', cwd: worktree('settings-audit-77aa'), branch: 'chore/settings-audit', ago: 90 },
      { title: 'Codex Clade DeepSeek — Research', cwd: worktree('research-2b41'), branch: 'docs/research', ago: 150, runtime: CURSOR },
      { title: '[done] Agents icon to circle-gauge', cwd: worktree('agents-icon-7e7e24'), branch: 'claude/agents-icon', ago: 260 },
      { title: 'Panel system', cwd: HOME, branch: 'feat/panel-system', ago: 400 },
      { title: 'Delegation plane', cwd: HOME, branch: 'feat/runtime-frontier', ago: 520 },
      { title: 'Repo history pane', cwd: worktree('repo-history-1a09'), branch: 'feat/repo-history', ago: 900 },
    ],
    0,
  ),
  ...seed(
    '/Users/shane/code/harnessdesk-site',
    [
      { title: 'Hero recording over the recorded wire', cwd: '/Users/shane/code/harnessdesk-site', branch: 'main', ago: 1200 },
      { title: 'Launch checklist', cwd: '/Users/shane/code/harnessdesk-site', branch: 'main', ago: 2000 },
    ],
    20,
  ),
  ...seed(
    '/Users/shane/code/harnessdesk-mobile',
    [
      { title: 'Approvals are the product', cwd: '/Users/shane/code/harnessdesk-mobile', branch: 'main', ago: 3000, runtime: CURSOR },
    ],
    40,
  ),
]

export const previewWorkspace = { path: HOME, name: 'HarnessDesk', lastOpenedAt: Date.now() }

export const previewWorkspaces = [
  previewWorkspace,
  { path: '/Users/shane/code/harnessdesk-site', name: 'harnessdesk-site', lastOpenedAt: minutes(1200) },
  { path: '/Users/shane/code/harnessdesk-mobile', name: 'harnessdesk-mobile', lastOpenedAt: minutes(3000) },
]

/**
 * Twelve live plugins: the count the Plugins row shows.
 *
 * Spelled out as real `PluginInstance`s rather than cast, so that a change to
 * the plugin shape fails this build instead of crashing the preview — the
 * point of a fixture is to be held to the contract it stands in for.
 */
export const previewPlugins: PluginInstance[] = Array.from({ length: 12 }, (_, index) => ({
  instanceId: pluginInstanceId(`plugin-${index}`),
  identity: {
    id: `plugin-${index}`,
    name: `Plugin ${index}`,
    version: '1.0.0',
    source: { kind: 'builtin' },
  },
  state: { type: 'active' },
  revision: 1,
  permissions: NO_PERMISSIONS,
  injects: [],
  provides: [],
  contributions: [],
  enabled: true,
}))

/**
 * One conversation with a real transcript.
 *
 * Two things need it and neither can be faked past. The **conversation view**
 * is the app's largest screen and renders nothing at all from an empty
 * `turns`; the **room** calls `isBusy(session)`, which reads `session.turns`,
 * so a `Session` cast from an object literal without it threw on render — the
 * long-standing "TeamRoomPane throws in the preview".
 *
 * The turn is chosen to put one of each thing on screen at once, because the
 * items that break a transcript's rhythm are the ones that sit *between* the
 * prose: a reasoning block, a shell command with output, a file change with a
 * diff, and a final answer. A transcript of four assistant messages looks
 * fine and proves nothing.
 */
const item = (id: string, rest: Record<string, unknown>): AgentItem =>
  ({ id: id as never, ...rest }) as unknown as AgentItem

export const previewTurns = [
  {
    id: 't1' as never,
    status: 'completed',
    startedAt: minutes(32),
    completedAt: minutes(26),
    items: [
      item('i1', {
        type: 'userMessage',
        content: [
          {
            type: 'text',
            text: 'The worktree list is showing branches that were deleted on the remote. Can you find where we read them and only keep the ones that still resolve?',
          },
        ],
      }),
      item('i2', {
        type: 'reasoning',
        summary: ['Finding where worktrees are listed'],
        content: [
          'The list almost certainly comes from `git worktree list --porcelain`, which reports the local registry and knows nothing about the remote. If a branch was deleted upstream the worktree entry survives, so the filter has to be a second question rather than a different parse.',
        ],
      }),
      /* The same thought, shaped the way a model that does not pre-summarise
         sends it: content and no summary. Claude and Codex fill `summary`, so
         only this shape exercises the derived row title — and before it did,
         a whole turn of these rendered as identical rows reading "Thinking". */
      item('i2b', {
        type: 'reasoning',
        summary: [],
        content: [
          '**Checking whether the registry is authoritative**',
          'The porcelain output is the local registry, so a branch deleted upstream still has a row. The check belongs next to the parse rather than inside it.',
        ],
      }),
      item('i3', {
        type: 'command',
        command: 'git worktree list --porcelain',
        cwd: '/Users/shane/code/harnessdesk',
        origin: 'agent',
        status: 'completed',
        actions: [{ type: 'unknown', command: 'git worktree list --porcelain' }],
        output:
          'worktree /Users/shane/code/harnessdesk\nHEAD 5a1253e9c0\nbranch refs/heads/main\n\nworktree /Users/shane/.claude/worktrees/dupe-accounts-91c2\nHEAD 8f21ab04d1\nbranch refs/heads/fix/dupe-accounts\n\nworktree /Users/shane/.claude/worktrees/settings-audit-77aa\nHEAD 1c07de5520\nbranch refs/heads/chore/settings-audit\n',
        exitCode: 0,
      }),
      item('i4', {
        type: 'assistantMessage',
        phase: 'commentary',
        text: 'Three registered, and the porcelain output is the whole of what the pane reads — so a branch deleted upstream still has a row here. The check belongs next to the parse.',
      }),
      item('i5', {
        type: 'fileChange',
        status: 'completed',
        changes: [
          {
            path: 'packages/server/src/git/worktrees.ts',
            kind: { type: 'update' },
            diff: `@@ -84,6 +84,17 @@ export const listWorktrees = async (root: string): Promise<Worktree[]> => {
   const raw = await git(root, ['worktree', 'list', '--porcelain'])
-  return parsePorcelain(raw)
+  const all = parsePorcelain(raw)
+
+  // \`worktree list\` reports the local registry, which outlives the remote:
+  // a branch deleted upstream keeps its row here forever. Ask git whether
+  // each ref still resolves, and drop the ones that do not.
+  const alive = await Promise.all(
+    all.map(async (one) =>
+      one.branch === null ? true : await refExists(root, one.branch),
+    ),
+  )
+  return all.filter((_, index) => alive[index] ?? false)
 }`,
          },
        ],
      }),
      item('i6', {
        type: 'assistantMessage',
        phase: 'final',
        text: 'Found it — `listWorktrees` in `packages/server/src/git/worktrees.ts` returned the porcelain parse unchanged.\n\nThe registry is local, so it outlives the remote: deleting a branch upstream leaves its worktree row in place indefinitely. I now ask git whether each branch still resolves and drop the ones that do not, leaving detached worktrees (`branch === null`) alone since they have no ref to check.\n\nOne thing worth deciding: a worktree whose branch is gone but which still has uncommitted work will now vanish from the list. If that is not what you want, the filter should mark it rather than hide it.',
      }),
    ],
  },
] as unknown as Session['turns']

/** The conversation the preview opens: `s1`, with the transcript above. */
export const previewSession = {
  id: 's1' as SessionId,
  runtime: CODEX,
  title: 'Worktree Management',
  cwd: worktree('worktree-mgmt-4f10'),
  status: { type: 'idle' },
  createdAt: minutes(86),
  updatedAt: minutes(26),
  itemsLoaded: true,
  turns: previewTurns,
  git: { branch: 'feat/worktrees', dirty: true },
} as unknown as Session
