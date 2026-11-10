import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { PhoneSim } from '@harnessdesk/phone-link/sim'
import { runtimeId, sessionId, burn, type GoalView, type LedgerQuery, type LedgerReport, type PhoneTier, type PhoneWorkAllowance, type SessionSummary, type UsageReport } from '@harnessdesk/protocol'
import { Logger } from '../src/log.js'
import { dispatch, type HostContext } from '../src/methods/index.js'
import { phoneLinkOff, startPhoneLink, type PhoneLinkControl } from '../src/phone-link.js'
import { PhoneWorkspace, scrub, type PhoneLiveSession, type PhoneTeamInput } from '../src/phone-workspace.js'
import { PhoneWork } from '../src/phone-work.js'
import { SessionIndex } from '../src/session-index.js'

const agent = runtimeId('fake-agent')
const stranger = runtimeId('unregistered-agent')
const NOW = new Date(2026, 9, 23, 18, 0, 0).getTime()
const midnight = (daysAgo: number): number => { const date = new Date(NOW); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - daysAgo); return date.getTime() }
const HOUR = 60 * 60 * 1000

/** Every string a phone must never be able to read, planted where a careless projection would copy it. */
const HOSTILE = { path: '/Users/jane/code/acme-api', email: 'jane@example.com', transcript: 'the secret transcript line', origin: 'git@github.com:jane/acme-api.git', token: ['sk', 'live', '0123456789abcdefghijkl'].join('-') }
const leaks = (value: unknown): string[] => {
  const text = JSON.stringify(value)
  return [/\/Users\//, /@/, /github\.com/, /secret transcript/, /sk-live/, /\\\\/].filter(pattern => pattern.test(text)).map(String)
}

const summary = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  runtime: agent, id: sessionId(id), title: id, cwd: HOSTILE.path, createdAt: NOW - 30 * HOUR, updatedAt: NOW - HOUR, status: { type: 'notLoaded' }, archived: false, ...over,
})

const usageJson = (amount: number, currency = 'USD'): string =>
  JSON.stringify({ total: { total: 10 }, last: { total: 1 }, cost: { amount, currency } })

interface Fixture {
  readonly workspace: PhoneWorkspace
  readonly index: SessionIndex
  readonly db: DatabaseSync
  live: PhoneLiveSession[]
  teams: PhoneTeamInput[]
  reports: UsageReport[]
  ledger: (query: LedgerQuery) => LedgerReport
  lead: { name: string; ids: Set<string>; teams?: Map<string, { step: string | null; accepted: boolean }>; wrapsOnDesk?: (team: string) => boolean } | null
  knowsStart: boolean
  readonly done: () => Promise<void>
}

const fixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'hd-phone-workspace-'))
  const file = join(root, 'sessions.sqlite')
  const index = new SessionIndex(file)
  const db = new DatabaseSync(file)
  const state: Fixture = {
    index, db, live: [], teams: [], reports: [], lead: null, knowsStart: true, ledger: () => ({ totalCost: null, scannedAt: null, rows: [], daily: [] } as unknown as LedgerReport),
    workspace: undefined as never, done: async () => { db.close(); index.close(); await rm(root, { recursive: true, force: true }) },
  }
  const workspace = new PhoneWorkspace({
    now: () => NOW,
    sessions: {
      page: options => index.phoneList(options),
      isOwn: (runtime, id) => index.isOwn(runtime, id),
      counts: () => index.phoneCounts(),
      touchedSince: since => index.touchedSince(since),
      costliestSince: (since, limit) => index.costliestSince(since, limit),
    },
    live: () => state.live,
    seatName: (runtime: import('@harnessdesk/protocol').RuntimeId) => runtime === agent ? 'Fake Agent' : null,
    knowsStart: () => state.knowsStart,
    teams: async () => state.teams,
    reports: async () => state.reports,
    ledger: async query => state.ledger(query),
    leadChats: () => state.lead,
  })
  return Object.assign(state, { workspace })
}

/** A desk with the same sessions in every shape the list tells apart. */
const populated = async (): Promise<Fixture> => {
  const f = await fixture()
  f.db.prepare('INSERT INTO repos(cwd, repo_root, origin_url, worktree, "exists", checked_at) VALUES (?,?,?,0,1,0)').run(HOSTILE.path, HOSTILE.path, HOSTILE.origin)
  const add = (id: string, over: Partial<SessionSummary>, options: { archived?: boolean; teamId?: string; usage?: string } = {}): void => {
    f.index.upsert(summary(id, over), { archived: options.archived ?? false, ...(options.teamId ? { teamId: options.teamId } : {}) })
    if (options.usage) f.db.prepare('UPDATE sessions SET usage=?, preview=? WHERE runtime=? AND id=?').run(options.usage, HOSTILE.transcript, agent, id)
  }
  add('running', { title: `Fix login for ${HOSTILE.email} in ${HOSTILE.path}/src/auth.ts with ${HOSTILE.token}`, updatedAt: NOW - 1 * HOUR }, { usage: usageJson(1.239) })
  add('waiting', { title: 'Approve the migration', updatedAt: NOW - 2 * HOUR })
  add('done-new', { title: 'Tidy the settings page', updatedAt: NOW - 3 * HOUR }, { usage: usageJson(0.4) })
  add('done-old', { title: 'Rename the export', updatedAt: NOW - 40 * HOUR }, { usage: usageJson(7.5) })
  add('foreign-money', { title: 'Priced in another currency', updatedAt: NOW - 4 * HOUR }, { usage: usageJson(99, 'EUR') })
  add('archived', { title: 'Old idea', updatedAt: NOW - 90 * HOUR }, { archived: true })
  add('team-seat', { title: 'A Team’s seat', updatedAt: NOW - 1 * HOUR }, { teamId: 'team-1' })
  f.live = [
    { runtime: agent, id: sessionId('running'), running: true, waiting: false, cost: 2.5 },
    { runtime: agent, id: sessionId('waiting'), running: false, waiting: true, cost: null },
  ]
  return f
}

// ------------------------------------------------------------------- sessions

test('an unloaded untitled session uses its scrubbed indexed opening as the desktop does', async () => {
  const f = await fixture()
  try {
    f.index.upsert(summary('opening', { title: '', preview: 'Fix /Users/jane/proj/src/a.ts for dev@example.com\nSecond line' }))
    assert.equal(f.workspace.sessionsList({}).rows[0]?.title, 'Fix … for …')
  } finally { await f.done() }
})

test('a chat the Lead directs says so, by the Lead\'s name, and the person\'s own chats stay unmarked', async () => {
  const f = await populated()
  try {
    f.lead = { name: 'Lex', ids: new Set(['fake-agent:done-new']) }
    const rows = f.workspace.sessionsList({}).rows
    assert.equal(rows.find(row => row.id === 'fake-agent:done-new')?.startedBy, 'lead')
    assert.equal(rows.find(row => row.id === 'fake-agent:running')?.startedBy, 'you')
    const items = f.workspace.workSessions({}).items
    assert.equal(items.find(item => item.id === 'fake-agent:done-new')?.by, 'Lex')
    assert.equal(items.find(item => item.id === 'fake-agent:running')?.by, undefined, 'the person themselves is left out')
    f.lead = null
    assert.equal(f.workspace.workSessions({}).items.find(item => item.id === 'fake-agent:done-new')?.by, undefined, 'no Lead, no claim')
  } finally { await f.done() }
})

test('a phone work item says when its session began, and leaves it out when the desk does not know', async () => {
  const f = await populated()
  try {
    const items = f.workspace.workSessions({}).items
    assert.equal(items.find(item => item.id === 'fake-agent:running')?.startedAt, NOW - 30 * HOUR)
    f.index.upsert(summary('no-start', { createdAt: 0, updatedAt: NOW - HOUR }), { archived: false })
    f.index.upsert(summary('late-start', { createdAt: NOW, updatedAt: NOW - HOUR }), { archived: false })
    const rows = f.workspace.sessionsList({}).rows
    const after = f.workspace.workSessions({}).items
    for (const id of ['fake-agent:no-start', 'fake-agent:late-start']) {
      const row = rows.find(r => r.id === id)
      const item = after.find(i => i.id === id)
      assert.ok(row && item, `${id} is listed`)
      assert.ok(!('startedAt' in row), `${id}: an unknown or impossible start is left out of the row, never zero`)
      assert.ok(!('startedAt' in item), `${id}: and out of the work item`)
    }
    // An agent that lists only its last activity hands back that time as `createdAt`; it is not a start.
    f.knowsStart = false
    assert.ok(f.workspace.sessionsList({}).rows.every(row => !('startedAt' in row)), 'a runtime without measured starts reports none')
    assert.ok(f.workspace.workSessions({}).items.every(item => !('startedAt' in item)))
  } finally { await f.done() }
})

test('a session row carries only the redacted fields, and the live figure beats the stored one', async () => {
  const f = await populated()
  try {
    const list = f.workspace.sessionsList({})
    assert.deepEqual(list.rows.map(row => row.id), ['fake-agent:running', 'fake-agent:waiting', 'fake-agent:done-new', 'fake-agent:foreign-money', 'fake-agent:done-old'])
    const [running, waiting, doneNew, foreign] = list.rows
    assert.deepEqual(Object.keys(running!).sort(), ['archived', 'canDelete', 'cost', 'id', 'lastActivityAt', 'pinned', 'project', 'seat', 'startedAt', 'startedBy', 'state', 'title'])
    assert.deepEqual({ project: running!.project, state: running!.state, startedBy: running!.startedBy, seat: running!.seat, cost: running!.cost, pinned: running!.pinned },
      { project: 'acme-api', state: 'running', startedBy: 'you', seat: 'Fake Agent', cost: 2.5, pinned: false })
    assert.equal(running!.lastActivityAt, NOW - HOUR)
    assert.equal(running!.startedAt, NOW - 30 * HOUR, 'the phone reads how long a session has been open from when it began')
    assert.equal(waiting!.state, 'needs-you')
    assert.equal(waiting!.cost, null, 'no figure is zero, not invented')
    assert.equal(doneNew!.cost, 0.4, 'a finished session shows what the desk stored for it')
    assert.equal(foreign!.cost, null, 'money in another currency is not shown as dollars')
    assert.deepEqual(list.counts, { running: 1, needsYou: 1, done: 3, archived: 1 })
    assert.equal(list.next, null)
    assert.deepEqual(leaks(list), [])
  } finally { await f.done() }
})

test('a Team’s seats, archived rows and unknown agents stay out of the open list', async () => {
  const f = await populated()
  try {
    f.index.upsert(summary('stranger', { runtime: stranger, updatedAt: NOW }), { archived: false })
    const ids = f.workspace.sessionsList({}).rows.map(row => row.id)
    assert.ok(!ids.includes('fake-agent:team-seat'))
    assert.ok(!ids.includes('fake-agent:archived'))
    assert.ok(!ids.some(id => id.startsWith('unregistered-agent')), 'a row that cannot be labelled by the desk’s own presentation is left out')
    assert.deepEqual(f.workspace.sessionsList({ state: 'archived' }).rows.map(row => [row.id, row.state]), [['fake-agent:archived', 'archived']])
  } finally { await f.done() }
})

test('the list pages newest first, repeats nothing and ends', async () => {
  const f = await populated()
  try {
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = f.workspace.sessionsList({ limit: 2, cursor })
      seen.push(...page.rows.map(row => row.id))
      cursor = page.next ?? undefined
      pages++
    } while (cursor && pages < 10)
    assert.deepEqual(seen, f.workspace.sessionsList({}).rows.map(row => row.id))
    assert.equal(new Set(seen).size, seen.length)
    assert.ok(pages >= 3)
  } finally { await f.done() }
})

test('a state filter returns that state only, even when its rows are far down the list', async () => {
  const f = await populated()
  try {
    assert.deepEqual(f.workspace.sessionsList({ state: 'running' }).rows.map(row => row.id), ['fake-agent:running'])
    assert.deepEqual(f.workspace.sessionsList({ state: 'needs-you' }).rows.map(row => row.id), ['fake-agent:waiting'])
    assert.deepEqual(f.workspace.sessionsList({ state: 'done' }).rows.map(row => row.id), ['fake-agent:done-new', 'fake-agent:foreign-money', 'fake-agent:done-old'])
    const first = f.workspace.sessionsList({ state: 'done', limit: 1 })
    assert.equal(first.rows.length, 1)
    assert.ok(first.next)
    assert.deepEqual(f.workspace.sessionsList({ state: 'done', limit: 5, cursor: first.next! }).rows.map(row => row.id), ['fake-agent:foreign-money', 'fake-agent:done-old'])
  } finally { await f.done() }
})

test('a limit is clamped and a bad cursor is refused rather than guessed at', async () => {
  const f = await populated()
  try {
    assert.equal(f.workspace.sessionsList({ limit: 0 }).rows.length, 1)
    assert.equal(f.workspace.sessionsList({ limit: 10_000 }).rows.length, 5)
    assert.throws(() => f.workspace.sessionsList({ cursor: 'not-a-cursor' }), /Invalid session index cursor/)
  } finally { await f.done() }
})

test('free text loses paths, addresses and keys before it leaves the desk', () => {
  assert.equal(scrub(`Fix login for ${HOSTILE.email} in ${HOSTILE.path}/src/auth.ts with ${HOSTILE.token}`), 'Fix login for … in … with …')
  assert.equal(scrub('open ~/notes/todo.md and C:\\Users\\jane\\file.txt'), 'open … and …')
  assert.equal(scrub('use a/b and/or c'), 'use a/b and/or c', 'ordinary prose with a slash is left alone')
  assert.equal(scrub('  many   spaces\nand lines '), 'many spaces and lines')
  assert.equal(scrub('word '.repeat(80)).length, 120)
  assert.equal(scrub('x'.repeat(300)), '…', 'a long unbroken run is key-shaped, not prose')
})

// ---------------------------------------------------------------------- teams

const team = (id: string, over: { sentence?: string; state?: 'open' | 'wrapping' | 'wrapped'; activity?: GoalView['activity']; role?: string | null; run?: 'running' | 'stopped'; cards?: ('open' | 'done' | 'abandoned')[]; seats?: string[]; costs?: (number | null)[]; updatedAt?: number } = {}): PhoneTeamInput => ({
  view: {
    goal: { id, root: HOSTILE.path, cwd: HOSTILE.path, sentence: over.sentence ?? 'Ship the importer', state: over.state ?? 'open', updatedAt: over.updatedAt ?? NOW - HOUR },
    activity: over.activity === undefined ? 'working' : over.activity,
    members: (over.seats ?? ['Reviewer', 'Frontend Builder']).map(name => ({ agent: { name }, role: null, seatLabel: `Fake Agent on ${name}`, session: { runtime: 'fake-agent', sessionId: name } })),
    board: { intents: (over.cards ?? ['done', 'open', 'abandoned']).map((state, index) => ({ id: index + 1, title: `Card ${index + 1} in ${HOSTILE.path}`, state })) },
    waitingOn: [], receipt: null, problem: null,
  } as unknown as GoalView,
  execution: over.run === undefined && over.role === undefined ? null : { state: over.run ?? 'running', role: over.role ?? null },
  costs: over.costs ?? [1.25, 0.5],
})

test('a Team row says stage, progress, who works on it and what it cost, and nothing about where', async () => {
  const f = await fixture()
  try {
    f.teams = [
      team('t-build', { role: 'implementer' }),
      team('t-review', { role: 'code-reviewer', activity: 'needs-you', updatedAt: NOW - 2 * HOUR }),
      team('t-plan', { role: 'planner', seats: [], cards: [], costs: [], updatedAt: NOW - 3 * HOUR }),
      team('t-ready', { activity: 'ready-to-wrap', cards: ['done', 'done'], updatedAt: NOW - 4 * HOUR }),
      team('t-stopped', { run: 'stopped', role: 'implementer', updatedAt: NOW - 5 * HOUR }),
      team('t-done', { state: 'wrapped', activity: null, cards: ['done'], updatedAt: NOW - 6 * HOUR }),
      team('t-unpriced', { costs: [null, null], updatedAt: NOW - 7 * HOUR }),
    ]
    const { rows } = await f.workspace.teamsList({})
    const by = Object.fromEntries(rows.map(row => [row.id, row]))
    assert.deepEqual(rows.map(row => row.id), ['t-build', 't-review', 't-plan', 't-ready', 't-stopped', 't-done', 't-unpriced'], 'newest first')
    assert.deepEqual(Object.keys(rows[0]!).sort(), ['cost', 'id', 'progress', 'project', 'stage', 'status', 'title', 'updatedAt', 'workers'])
    assert.deepEqual({ ...by['t-build']!, updatedAt: 0 }, { id: 't-build', title: 'Ship the importer', project: 'acme-api', stage: 'build', progress: { done: 1, total: 2 },
      workers: { count: 2, initials: ['R', 'FB'] }, cost: 1.75, status: 'working', updatedAt: 0 })
    assert.equal(by['t-review']!.stage, 'review')
    assert.equal(by['t-review']!.status, 'needs-you')
    assert.equal(by['t-plan']!.stage, 'plan')
    assert.equal(by['t-ready']!.stage, 'land')
    assert.equal(by['t-ready']!.status, 'ready')
    assert.equal(by['t-stopped']!.status, 'stopped')
    assert.equal(by['t-done']!.status, 'done')
    assert.equal(by['t-done']!.stage, 'land')
    assert.equal(by['t-unpriced']!.cost, null)
    assert.deepEqual(leaks({ rows }), [])
    assert.equal((await f.workspace.teamsList({ limit: 2 })).rows.length, 2)
  } finally { await f.done() }
})

// ------------------------------------------------------------------ dashboard

test('a snapshot session cap never hides Teams, including older Teams', async () => {
  const f = await populated()
  try {
    f.teams = Array.from({ length: 105 }, (_, i) => team(`team-${i}`, { updatedAt: NOW - (i + 2) * HOUR }))
    const items = await f.workspace.workItems(2)
    assert.equal(items.filter(item => item.kind === 'session').length, 2)
    assert.equal(items.filter(item => item.kind === 'team').length, 105)
  } finally { await f.done() }
})

const report = (account: string, over: Partial<UsageReport> = {}): UsageReport => ({
  runtime: agent, account, plan: 'Pro', lanes: [
    { id: 'session', label: '5-hour', usedPercent: 42.4, windowMinutes: 300, resetsAt: NOW + 2 * HOUR },
    { id: 'weekly', label: 'Weekly', usedPercent: 61.2, windowMinutes: 10080, resetsAt: NOW + 70 * HOUR },
    { id: 'weekly:fable', label: 'Weekly (one model)', usedPercent: 99, windowMinutes: 10080, resetsAt: null, scope: 'one model' },
  ], credits: null, spend: null, reached: null, source: { kind: 'runtime' }, fetchedAt: NOW, staleAfterMs: 1000, error: null, ...over,
} as unknown as UsageReport)

const ledgerOf = (rows: { key: string; cost: number | null }[], total: number | null, daily: { day: number; cost: number }[] = []): LedgerReport =>
  ({ totalCost: total, scannedAt: NOW - HOUR, rows: rows.map(row => ({ ...row, label: row.key, runtime: null, tokens: 1, hasUnpriced: false })), daily: daily.map(day => ({ ...day, runtime: agent, tokens: 1 })) } as unknown as LedgerReport)

test('the dashboard shows today’s spend, seats, counts, the week and the range, with no account in sight', async () => {
  const f = await populated()
  try {
    f.reports = [report(HOSTILE.email), report('john@example.com', { billing: { kinds: ['windows'], budget: { amount: 100, currency: 'USD', period: 'month' } } as never })]
    f.teams = [team('t-work'), team('t-wait', { activity: 'needs-you' }), team('t-done', { state: 'wrapped', activity: null, updatedAt: NOW - HOUR })]
    const queries: LedgerQuery[] = []
    f.ledger = query => {
      queries.push(query)
      if (query.groupBy === 'project') return ledgerOf([{ key: HOSTILE.path, cost: 12 }, { key: '/Users/jane/code/site', cost: 6 }, { key: '/Users/jane/work/site', cost: 2 }, { key: '/Users/jane/code/idle', cost: null }], 20)
      if (query.days === 7) return ledgerOf([], 20, [{ day: midnight(0), cost: 1.5 }, { day: midnight(0) + 1, cost: 2 }, { day: midnight(1), cost: 2 }, { day: midnight(6), cost: 4 }])
      if (query.days === 14) return ledgerOf([], 30)
      if (query.days === 23) return ledgerOf([], 15)
      return ledgerOf([], 0)
    }
    const week = await f.workspace.dashboardRead({ range: '7d' })
    assert.deepEqual(week.daily.map(day => day.day), [6, 5, 4, 3, 2, 1, 0].map(midnight))
    assert.deepEqual(week.daily.map(day => day.spent), [4, 0, 0, 0, 0, 2, 3.5])
    assert.deepEqual(week.today, { spent: 3.5 })
    assert.deepEqual(week.counts, { running: 1 + 1, needsYou: 1 + 1, doneToday: week.counts.doneToday })
    assert.deepEqual(week.seats, [
      { label: 'Fake Agent 1', windowPercent: 42, resetsAt: NOW + 2 * HOUR, weekPercent: 61 },
      { label: 'Fake Agent 2', windowPercent: 42, resetsAt: NOW + 2 * HOUR, weekPercent: 61 },
    ])
    assert.deepEqual(week.allowance, { amount: 100, spent: 15, resetsAt: new Date(2026, 10, 1).getTime() })
    assert.equal(week.period.range, '7d')
    assert.equal(week.period.spent, 20)
    assert.equal(week.period.spentPrevious, 10)
    assert.equal(week.period.spentVsPrevious, 100)
    assert.deepEqual(week.period.byProject, [{ project: 'acme-api', spent: 12, share: 0.6 }, { project: 'site', spent: 8, share: 0.4 }], 'two folders of one name are one project, and an unpriced one is left out')
    assert.deepEqual(week.period.mostExpensive.map(one => [one.id, one.cost]), [['fake-agent:done-old', 7.5], ['fake-agent:running', 1.24], ['fake-agent:done-new', 0.4]])
    assert.deepEqual(week.period.mostExpensive.map(one => one.project), ['acme-api', 'acme-api', 'acme-api'])
    assert.equal(week.period.waitedOnYou, null)
    assert.equal(week.period.ruleBreaks, null)
    assert.deepEqual(leaks(week), [])
    assert.ok(queries.every(query => query.days > 0))
  } finally { await f.done() }
})

test('the dashboard says null for what the desk cannot know, and nothing for what was never set', async () => {
  const f = await fixture()
  try {
    const fresh = await f.workspace.dashboardRead({})
    assert.equal(fresh.period.range, 'today')
    assert.equal(fresh.today.spent, null, 'a machine that never scanned has no spend, not zero')
    assert.equal(fresh.allowance, null)
    assert.deepEqual(fresh.seats, [])
    assert.deepEqual(fresh.counts, { running: 0, needsYou: 0, doneToday: 0 })
    assert.equal(fresh.period.spent, null)
    assert.equal(fresh.period.spentVsPrevious, null)
    assert.deepEqual(fresh.period.byProject, [])
    assert.deepEqual(fresh.period.mostExpensive, [])
    assert.equal(fresh.daily.length, 7)
    assert.ok(fresh.daily.every(day => day.spent === null))
  } finally { await f.done() }
})

test('a plan with no short window shows a seat with no bar, and an agent the desk does not know shows nothing', async () => {
  const f = await fixture()
  try {
    f.reports = [report('a', { lanes: [] }), report('b', { runtime: stranger })]
    assert.deepEqual((await f.workspace.dashboardRead({})).seats, [{ label: 'Fake Agent', windowPercent: null, resetsAt: null, weekPercent: null }])
  } finally { await f.done() }
})

test('a phone allowance says the desk’s own standing, counts down to times and names no account', async () => {
  const f = await fixture()
  try {
    f.ledger = () => ledgerOf([], 0)
    f.reports = [
      report(HOSTILE.email, { fetchedAt: NOW - 5000, error: { message: `token refused for ${HOSTILE.email}` } } as never),
      report('john@example.com', { lanes: [{ id: 'session', label: '5-hour', usedPercent: 100, windowMinutes: 300, resetsAt: NOW + HOUR }] }),
      report('kim@example.com', { lanes: [], credits: { remaining: -2.15, unit: 'USD' } }),
    ]
    const rows = (await f.workspace.workUsage())!.runtimes
    assert.deepEqual(rows.map(row => row.id), ['fake-agent', 'fake-agent:2', 'fake-agent:3'], 'one agent signed in three times sends three ids')
    assert.deepEqual(rows.map(row => [row.standing, row.status]), [['unknown', 'Unknown'], ['out', 'Out'], ['overdrawn', 'Overdrawn']])
    const [failed, out, overdrawn] = rows as [typeof rows[0], typeof rows[0], typeof rows[0]]
    assert.equal(failed.stale, true)
    assert.equal(failed.readAt, NOW - 5000)
    assert.equal(failed.problem, 'token refused for …')
    assert.equal(failed.plan, 'Pro')
    assert.deepEqual(failed.lanes, [
      { label: '5-hour', resetsAt: NOW + 2 * HOUR },
      { label: 'Weekly', resetsAt: NOW + 70 * HOUR },
      { label: 'Weekly (one model)', scope: 'one model' },
    ], 'a failed read names its windows but sends none of the cached figures')
    assert.deepEqual([failed.left, failed.used, failed.weekUsed, failed.balance], [undefined, undefined, undefined, undefined])
    assert.equal(out.backAt, NOW + HOUR)
    assert.equal(out.left, 0)
    assert.equal(out.resetsIn, '1h 00m', 'an older phone still reads the string')
    assert.deepEqual(overdrawn.balance, { amount: -2.15, unit: 'USD' })
    assert.equal(overdrawn.lanes, undefined)
    assert.deepEqual([overdrawn.used, overdrawn.weekUsed, overdrawn.resetsIn], [undefined, undefined, undefined])
    assert.deepEqual(leaks(rows), [])
  } finally { await f.done() }
})

test('a spent model says when it is back only while that time is ahead', async () => {
  const f = await fixture()
  try {
    f.ledger = () => ledgerOf([], 0)
    const spentModel = (resetsAt: number) => report('dev@example.com', { lanes: [
      { id: 'session', label: '5-hour', usedPercent: 10, windowMinutes: 300, resetsAt: NOW + HOUR },
      { id: 'weekly:opus', label: 'Weekly', scope: 'Opus', usedPercent: 100, windowMinutes: 10_080, resetsAt },
    ] })
    f.reports = [spentModel(NOW + 3 * HOUR), spentModel(NOW - HOUR)]
    const [ahead, passed] = (await f.workspace.workUsage())!.runtimes as [PhoneWorkAllowance, PhoneWorkAllowance]
    assert.deepEqual(ahead.scopedOut, { scope: 'Opus', backAt: NOW + 3 * HOUR })
    assert.deepEqual(passed.scopedOut, { scope: 'Opus' }, 'a cached read past its reset promises no time already gone')
  } finally { await f.done() }
})

test('a balance that is not a finite number is left off the phone row', async () => {
  const f = await fixture()
  try {
    f.ledger = () => ledgerOf([], 0)
    const odd = (remaining: number) => report('dev@example.com', { lanes: [], credits: { remaining, unit: 'USD' } })
    f.reports = [odd(Number.NaN), odd(Number.POSITIVE_INFINITY), odd(4.5)]
    const rows = (await f.workspace.workUsage())!.runtimes as PhoneWorkAllowance[]
    assert.deepEqual(rows.map(row => row.balance), [undefined, undefined, { amount: 4.5, unit: 'USD' }])
  } finally { await f.done() }
})

// -------------------------------------------------------------- the phone door

/** A paired phone, and the real link, over a desk that answers only the three reads. */
const door = async (workspace: PhoneWorkspace, extra: Partial<HostContext> = {}) => {
  const home = await mkdtemp(join(tmpdir(), 'hd-phone-door-'))
  let attached: PhoneLinkControl | null = null
  const ctx = {
    phone: { state: () => attached?.state() ?? phoneLinkOff, pairing: () => attached!.pairing(), allow: (...a: never[]) => (attached!.allow as any)(...a),
      deny: (id: string) => attached!.deny(id), revoke: (d: string) => attached!.revoke(d) },
    phoneWorkspace: workspace,
    ...extra,
  } as unknown as HostContext
  const host = {
    call: (method: string, params: unknown) => dispatch(ctx, method as never, params as never),
    addBroadcaster: () => () => {},
    attachPhoneLink: (control: PhoneLinkControl) => { attached = control },
  }
  const running = await startPhoneLink(host as never, new Logger('test', { console: false }), { home, host: '127.0.0.1', includeLoopback: true, name: 'Test desk' })
  const pair = async (tiers?: readonly PhoneTier[]) => {
    const code = await running.control.pairing()
    const phone = await PhoneSim.fromCode(code.url)
    await phone.open(running.service.port, phone.offer!.deskPub)
    await phone.enroll(phone.offer!.enroll, 'Jane’s phone')
    for (let i = 0; i < 200 && running.control.state().pending.length === 0; i++) await new Promise(r => setTimeout(r, 10))
    running.control.allow(running.control.state().pending[0]!.id, tiers)
    await phone.next(m => m.t === 'enroll.ok')
    return phone
  }
  return { pair, done: async () => { await running.close(); await rm(home, { recursive: true, force: true }) } }
}

test('a phone that may read gets the three projections, and no response holds a path, an address or a key', async () => {
  const f = await populated()
  f.reports = [report(HOSTILE.email)]
  f.teams = [team('t-work', { sentence: `Ship ${HOSTILE.path} for ${HOSTILE.email}` })]
  f.ledger = query => query.groupBy === 'project' ? ledgerOf([{ key: HOSTILE.path, cost: 3 }], 3) : ledgerOf([], 3, [{ day: midnight(0), cost: 3 }])
  const d = await door(f.workspace)
  try {
    const phone = await d.pair(['read'])
    const sessions = await phone.request('phone/sessions/list', { state: 'done', limit: 2 })
    assert.equal(sessions.ok, true, JSON.stringify(sessions))
    assert.equal(sessions.result.rows.length, 2)
    assert.ok(sessions.result.next)
    const teams = await phone.request('phone/teams/list', {})
    assert.equal(teams.ok, true, JSON.stringify(teams))
    assert.equal(teams.result.rows[0].title, 'Ship … for …')
    const dashboard = await phone.request('phone/dashboard/read', { range: '30d' })
    assert.equal(dashboard.ok, true, JSON.stringify(dashboard))
    assert.equal(dashboard.result.period.range, '30d')
    for (const [name, reply] of Object.entries({ sessions, teams, dashboard })) assert.deepEqual(leaks(reply.result), [], name)
    phone.close()
  } finally { await d.done(); await f.done() }
})

test('a phone without the read tier is refused all three, and bad params are refused before any work', async () => {
  const f = await populated()
  const d = await door(f.workspace)
  try {
    const runOnly = await d.pair(['run'])
    for (const method of ['phone/sessions/list', 'phone/teams/list', 'phone/dashboard/read']) {
      const reply = await runOnly.request(method, {})
      assert.equal(reply.ok, false, method)
      assert.equal(reply.error.code, 'tierNotGranted', method)
    }
    runOnly.close()
    const reader = await d.pair(['read'])
    for (const [method, params] of [['phone/sessions/list', { state: 'everything' }], ['phone/sessions/list', { limit: 'ten' }], ['phone/dashboard/read', { range: '1y' }], ['phone/teams/list', { limit: {} }]] as const) {
      const reply = await reader.request(method, params)
      assert.equal(reply.error.code, 'badRequest', `${method} ${JSON.stringify(params)}`)
    }
    const stale = await reader.request('phone/sessions/list', { cursor: 'not-a-cursor' })
    assert.equal(stale.ok, false)
    assert.equal(stale.error.code, 'methodFailed', 'a cursor the desk did not issue is refused, not guessed at')
    for (const method of ['sessions/list', 'session/index', 'usage/reports', 'usage/ledger', 'flow/executions', 'goal/list', 'insight/goal']) {
      const reply = await reader.request(method, {})
      assert.equal(reply.error.code, 'notOnPhoneSurface', `${method}: the raw method stays behind the window`)
    }
    reader.close()
  } finally { await d.done(); await f.done() }
})

test('work stages carry host waits and both counts use the same waiting predicate', async () => {
  const f = await populated()
  try {
    f.teams = [team('answer', { activity: 'needs-you' }), team('review', { activity: 'ready-to-wrap' }),
      team('blocked', { run: 'stopped' }), team('working'), team('done', { state: 'wrapped', activity: null })]
    const items = await f.workspace.workItems()
    const stages = Object.fromEntries(items.map(item => [item.id, (item as any).stage]))
    assert.equal(stages['fake-agent:waiting'], 'you-answer')
    assert.equal(stages['fake-agent:running'], 'working')
    assert.equal(stages.answer, 'you-answer'); assert.equal(stages.review, 'you-review'); assert.equal(stages.blocked, 'you-blocked')
    assert.equal(stages.working, 'working'); assert.equal(stages.done, 'idle')
    assert.ok(items.every(item => typeof (item as any).stageReason === 'string' && (item as any).stageReason.length > 0))
    const waiting = (item: any) => item.stage.startsWith('you-')
    assert.equal((await f.workspace.dashboardRead({})).counts.needsYou, items.filter(waiting).length)
    assert.equal(f.workspace.sessionsList({}).counts.needsYou, items.filter(item => item.kind === 'session').filter(waiting).length)
    assert.equal((f.workspace.workSessions({ archived: true }).items[0] as any).stage, 'idle')
  } finally { await f.done() }
})

test('queued, failed and paused live sessions keep legacy words while stage names the actual wait', async () => {
  const f = await fixture()
  try {
    for (const id of ['queued', 'failed', 'paused']) f.index.upsert(summary(id))
    f.live = ['queued', 'failed', 'paused'].map(id => ({ runtime: agent, id: sessionId(id), running: false, waiting: false, cost: null,
      queued: id !== 'failed', failed: id === 'failed', queuePaused: id === 'paused' }))
    const items = f.workspace.workSessions({}).items
    assert.deepEqual(Object.fromEntries(items.map(item => [item.id.split(':')[1], item.stage])), { queued: 'queued', failed: 'you-blocked', paused: 'you-blocked' })
    assert.ok(items.every(item => item.phase === 'done' && item.line === 'Done'))
    assert.equal(f.workspace.sessionsList({}).counts.needsYou, 2)
    const input = team('reserved', { run: 'stopped' })
    f.teams = [{ ...input, view: { ...input.view, stage: 'queued', stageReason: 'start-queued' } }]
    const one = (await f.workspace.workItems()).find(item => item.id === 'reserved')!
    assert.equal(one.stage, 'queued', 'the authoritative host stage wins over an older run used by legacy phone words')
  } finally { await f.done() }
})

test('a session the person stopped says Stopped with its own stage reason, and is not counted done today', async () => {
  const f = await fixture()
  try {
    f.index.upsert(summary('stopped', { updatedAt: NOW - HOUR }))
    f.index.upsert(summary('finished', { updatedAt: NOW - HOUR }))
    f.live = [{ runtime: agent, id: sessionId('stopped'), running: false, waiting: false, cost: null, stopped: true, updatedAt: NOW - HOUR }]
    const items = Object.fromEntries(f.workspace.workSessions({}).items.map(item => [item.id.split(':')[1], item]))
    assert.equal(items.stopped!.stage, 'idle')
    assert.equal(items.stopped!.stageReason, 'stopped')
    assert.equal(items.stopped!.line, 'Stopped')
    assert.equal(items.finished!.stageReason, 'idle')
    assert.equal(items.finished!.line, 'Done')
    const board = await f.workspace.dashboardRead({ range: '7d' })
    assert.equal(board.counts.doneToday, 1, 'only the finished one is done today')
  } finally { await f.done() }
})

test('ready Teams, stopped Teams and failed sessions now count as needing you', async () => {
  const f = await fixture()
  try {
    f.index.upsert(summary('failed'))
    f.live = [{ runtime: agent, id: sessionId('failed'), running: false, waiting: false, failed: true, cost: null }]
    f.teams = [team('ready', { activity: 'ready-to-wrap' }), team('stopped', { run: 'stopped' })]
    const items = await f.workspace.workItems()
    assert.deepEqual(Object.fromEntries(items.map(item => [item.id, item.stage])), {
      'fake-agent:failed': 'you-blocked', ready: 'you-review', stopped: 'you-blocked',
    })
    assert.equal((await f.workspace.dashboardRead({})).counts.needsYou, 3)
    assert.equal(f.workspace.sessionsList({}).counts.needsYou, 1)
    assert.equal(items.find(item => item.kind === 'session')!.phase, 'done')
    assert.equal(items.find(item => item.kind === 'session')!.line, 'Done')
    assert.ok(items.filter(item => item.kind === 'team').every(item => item.phase === 'needsYou'))
  } finally { await f.done() }
})

test('a Lead Team offers Wrap once accepted and ready, and not while a posting waits on the desk', async () => {
  const f = await fixture()
  try {
    const unsettled = new Set<string>()
    f.lead = { name: 'Dex', ids: new Set(), wrapsOnDesk: team => unsettled.has(team),
      teams: new Map([['ready', { step: 'Fix the bug', accepted: true }], ['open', { step: null, accepted: false }], ['posting', { step: null, accepted: true }]]) }
    unsettled.add('posting')
    f.teams = [team('ready', { activity: 'ready-to-wrap' }), team('open', { activity: 'ready-to-wrap' }), team('posting', { activity: 'ready-to-wrap' })]
    const wraps = async () => Object.fromEntries((await f.workspace.workItems()).map(item => [item.id, item.team?.canWrap ?? false]))
    assert.deepEqual(await wraps(), { ready: true, open: false, posting: false })
    unsettled.delete('posting')
    assert.deepEqual(await wraps(), { ready: true, open: false, posting: true })
  } finally { await f.done() }
})

test('phone running, needsYou and done counts partition work by host stage', async () => {
  const f = await fixture()
  try {
    for (const id of ['paused', 'failed', 'working', 'done']) f.index.upsert(summary(id))
    f.live = [
      { runtime: agent, id: sessionId('paused'), running: true, waiting: false, queuePaused: true, cost: null },
      { runtime: agent, id: sessionId('failed'), running: false, waiting: false, failed: true, cost: null },
      { runtime: agent, id: sessionId('working'), running: true, waiting: false, cost: null },
    ]
    const stalled = team('stalled', { run: 'stopped' })
    f.teams = [team('stopped', { run: 'stopped' }), { ...stalled, execution: { state: 'stalled', role: null } }, team('working')]
    const counts = f.workspace.sessionsList({}).counts
    assert.deepEqual(counts, { running: 1, needsYou: 2, done: 1, archived: 0 })
    assert.equal(counts.running + counts.needsYou + counts.done, 4)
    const items = await f.workspace.workItems(), dashboard = await f.workspace.dashboardRead({})
    assert.equal(dashboard.counts.running, 2)
    assert.equal(dashboard.counts.running, items.filter(item => item.stage === 'working').length)
    assert.equal(dashboard.counts.needsYou, 4)
    assert.equal(dashboard.counts.needsYou, items.filter(item => item.stage.startsWith('you-')).length)
  } finally { await f.done() }
})

test('queued sessions count as neither running nor done', async () => {
  const f = await fixture()
  try {
    for (const id of ['queued', 'working', 'waiting', 'done']) f.index.upsert(summary(id))
    f.live = [
      { runtime: agent, id: sessionId('queued'), running: false, waiting: false, queued: true, cost: null },
      { runtime: agent, id: sessionId('working'), running: true, waiting: false, cost: null },
      { runtime: agent, id: sessionId('waiting'), running: false, waiting: true, cost: null },
    ]
    assert.deepEqual(f.workspace.sessionsList({}).counts, { running: 1, needsYou: 1, done: 1, archived: 0 })
    f.live.push({ runtime: agent, id: sessionId('no-longer-indexed'), running: false, waiting: false, queued: true, cost: null })
    f.live.push({ runtime: agent, id: sessionId('also-no-longer-indexed'), running: false, waiting: false, queued: true, cost: null })
    assert.equal(f.workspace.sessionsList({}).counts.done, 0, 'a changed index cannot make done negative')
  } finally { await f.done() }
})


test('Lead summary counts every project, keeps old attention items, and bounds only recents', async () => {
  const f = await fixture()
  try {
    for (const project of ['alpha', 'beta']) {
      const root = `/workspace/${project}`
      f.db.prepare('INSERT INTO repos(cwd, repo_root, origin_url, worktree, "exists", checked_at) VALUES (?,?,NULL,0,1,0)').run(root, root)
      for (let n = 0; n < 15; n++) f.index.upsert(summary(`${project}-${n}`, {
        title: n === 0 ? `Build ${root}/src/main.ts` : `Task ${project} ${n}`, cwd: root,
        preview: HOSTILE.transcript, updatedAt: NOW - n * HOUR,
      }), { archived: false })
    }
    f.index.upsert(summary('team-seat'), { archived: false, teamId: 'old-team' })
    f.index.upsert(summary('archived'), { archived: true })
    f.live = [{ runtime: agent, id: sessionId('alpha-0'), running: true, waiting: false, cost: null }]
    const old = team('old-team', { activity: 'needs-you', updatedAt: NOW - 1000 * HOUR })
    f.teams = [{ ...old, view: { ...old.view, goal: { ...old.view.goal, root: '/workspace/beta' } } }]
    // Dynamic lookup permits the missing feature to fail as an assertion before its contract exists.
    const summarize = (f.workspace as unknown as { deskSummary?: (params: { limit?: number }) => Promise<any> }).deskSummary
    assert.equal(typeof summarize, 'function', 'a desk-wide projection must exist')
    const result = await summarize!.call(f.workspace, { limit: 2 })
    assert.deepEqual(result.totals, { chats: { running: 1, needsYou: 0, idle: 29 }, teams: { running: 0, needsYou: 1, idle: 0 } })
    assert.deepEqual(result.projects, [
      { project: 'alpha', chats: { running: 1, needsYou: 0, idle: 14 }, teams: { running: 0, needsYou: 0, idle: 0 } },
      { project: 'beta', chats: { running: 0, needsYou: 0, idle: 15 }, teams: { running: 0, needsYou: 1, idle: 0 } },
    ])
    assert.equal(result.recent.length, 2)
    assert.equal(result.olderCount, 29)
    assert.deepEqual(result.needsYou, [{ id: 'old-team', title: 'Ship the importer', project: 'beta', state: 'needs-you', kind: 'team', updatedAt: NOW - 1000 * HOUR }])
    assert.ok(result.recent[0].updatedAt >= result.recent[1].updatedAt)
    assert.equal((await summarize!.call(f.workspace, {})).recent.length, 8)
    assert.equal((await summarize!.call(f.workspace, { limit: 100 })).recent.length, 20)
    assert.equal(JSON.stringify(result).includes(HOSTILE.transcript), false)
    assert.equal(JSON.stringify(result).includes('/workspace/'), false)
    assert.deepEqual(Object.keys(result.recent[0]).sort(), ['id', 'kind', 'project', 'state', 'title', 'updatedAt'])
    const phone = await f.workspace.workItems(100)
    assert.equal(phone.filter(item => item.stage === 'working').length, result.totals.chats.running + result.totals.teams.running)
    assert.equal(phone.filter(item => item.stage?.startsWith('you-')).length, result.needsYou.length)
    const wired = await dispatch({ leadDeskSummary: (params: { limit?: number }) => summarize!.call(f.workspace, params) } as unknown as HostContext,
      'lead/desk/summary' as never, { limit: 2 } as never)
    assert.deepEqual(wired, result)
  } finally { await f.done() }
})

test('Lead allowance is private, cached, account-distinct and counts running chats across projects', async () => {
  const f = await fixture()
  try {
    for (const [id, cwd] of [['alpha-chat', '/workspace/alpha'], ['beta-chat', '/workspace/beta']] as const) {
      f.db.prepare('INSERT INTO repos(cwd, repo_root, origin_url, worktree, "exists", checked_at) VALUES (?,?,NULL,0,1,0)').run(cwd, cwd)
      f.index.upsert(summary(id, { cwd }))
      f.live.push({ runtime: agent, id: sessionId(id), running: true, waiting: false, cost: null })
    }
    // Neither archived chats nor Team seats are ordinary running chats in desk_summary.
    for (const id of ['archived', 'team-seat']) {
      f.index.upsert(summary(id), id === 'archived' ? { archived: true } : { teamId: 'team-1' })
      f.live.push({ runtime: agent, id: sessionId(id), running: true, waiting: false, cost: null })
    }
    const lane = { id: 'session', label: '5-hour', usedPercent: 80, windowMinutes: 300, resetsAt: NOW + 2 * HOUR }
    const reports = [report('dev@example.com', { lanes: [lane], credits: { remaining: 12, unit: 'USD' },
      spend: { currency: 'USD', todayCost: 2, windowCost: 30, windowDays: 30, provenance: 'listPrice' } as UsageReport['spend'] }),
      report('Jane Doe', { planLabel: 'Team', fetchedAt: NOW - HOUR, reached: 'session',
        error: { message: `Jane Doe dev@example.com: API_KEY=${HOSTILE.token} failed` } })]
    Object.assign(reports[0]!, { apiKey: HOSTILE.token, userName: 'Jane Doe' })
    // Ignore the normal reports port: Lead passes already cached reports explicitly.
    f.reports = [report('not a cached account')]
    const result = await f.workspace.usageSummary(reports)
    assert.deepEqual(result.runtimes, [{ name: 'Fake Agent', runningSessions: 2 }])
    const desk = await f.workspace.deskSummary({})
    assert.deepEqual(desk.projects.map(project => [project.project, project.chats.running]), [['alpha', 1], ['beta', 1]])
    assert.equal(result.accounts[0]!.runningSessions, desk.totals.chats.running)
    assert.deepEqual(result.accounts.map(account => account.label), ['Fake Agent · Pro · account 1', 'Fake Agent · Team · account 2'])
    assert.deepEqual(result.accounts.map(account => [account.stale, account.reached]), [[false, false], [true, true]])
    assert.match(result.accounts[1]!.error!, /failed/)
    const text = JSON.stringify(result)
    for (const forbidden of ['@', 'Jane Doe', HOSTILE.token, 'not a cached account']) assert.equal(text.includes(forbidden), false, forbidden)
    const window = result.accounts[0]!.windows[0]!
    assert.equal(window.remainingPercent, 20)
    assert.equal(window.kind, '5h')
    assert.deepEqual(window.projection, { kind: 'runs-out', at: NOW + 0.75 * HOUR,
      basis: 'average consumption since window start', since: NOW - 3 * HOUR, asOf: NOW })
    assert.equal(window.projection!.at, NOW + burn(lane, NOW)!.etaMs!)
    assert.equal(result.accounts[1]!.windows[0]!.projection, null, 'failed readings cannot forecast')
    assert.deepEqual(result.accounts[0]!.spend, { currency: 'USD', today: 2, last30Days: 30, provenance: 'listPrice' })
    assert.equal(result.accounts[0]!.windows[1]!.kind, 'balance')
    assert.equal(result.accounts[0]!.windows[1]!.remaining, 12)
    assert.equal(result.accounts[0]!.windows[1]!.resetsAt, null)
    const wired = await dispatch({ leadUsageSummary: () => f.workspace.usageSummary(reports) } as unknown as HostContext,
      'lead/usage/summary', {})
    assert.deepEqual(wired, result)
  } finally { await f.done() }
})

test('Lead allowance keeps unknown figures unknown and shares the Dashboard lasts-to-reset projection', async () => {
  const f = await fixture()
  try {
    const value = report('dev@example.com', { credits: { remaining: null, unit: 'USD', unlimited: true }, lanes: [
      { id: 'weekly', label: 'Weekly', usedPercent: 20, windowMinutes: 10080, resetsAt: NOW + 84 * HOUR },
      { id: 'monthly', label: 'Monthly', usedPercent: 60, used: 60, limit: 100, unit: 'requests', windowMinutes: 43200, resetsAt: NOW + 240 * HOUR },
      { id: 'unknown', label: 'Unknown', usedPercent: 0, usageKnown: false, windowMinutes: null, resetsAt: null },
    ] })
    const result = await f.workspace.usageSummary([value])
    assert.equal(result.accounts[0]!.windows[0]!.projection?.kind, 'lasts-to-reset')
    assert.equal(result.accounts[0]!.windows[0]!.projection?.at, NOW + 84 * HOUR)
    assert.equal(result.accounts[0]!.windows[1]!.remaining, 40)
    assert.equal(result.accounts[0]!.windows[1]!.kind, 'monthly')
    assert.equal(result.accounts[0]!.windows[2]!.remainingPercent, null)
    assert.equal(result.accounts[0]!.windows[2]!.projection, null)
    assert.equal(result.accounts[0]!.spend, null)
    assert.equal(result.accounts[0]!.windows[3]!.unlimited, true)
  } finally { await f.done() }
})

test('Lead allowance emits only closed error words and preserves ordinary words around short identities', async () => {
  const f = await fixture()
  try {
    const result = await f.workspace.usageSummary([
      report('dev@example.com', { error: { message: 'jane-d at Acme Example Org: token xy failed' } }),
      report('other@example.com', { error: { message: 'jane-d at Acme Example Org', needsSignIn: true } }),
      report('a', { planLabel: 'Standard', fetchedAt: NOW - 1000 }),
    ])
    assert.deepEqual(result.accounts.map(account => account.error), ['reading failed', 'sign-in needed', null])
    assert.equal(result.accounts[2]!.plan, 'Standard')
    assert.equal(result.accounts[2]!.stale, false, 'the Dashboard boundary is strictly greater than the TTL')
    assert.ok(!JSON.stringify(result).includes('jane-d'))
    assert.ok(!JSON.stringify(result).includes('Acme Example Org'))
  } finally { await f.done() }
})

test('Lead allowance redacts one- and two-character account identities in report labels', async () => {
  const f = await fixture()
  try {
    for (const account of ['a', 'xy']) {
      const result = await f.workspace.usageSummary([report(account, {
        planLabel: `${account} Standard`,
        lanes: [{ id: 'short', label: `Plan for ${account}`, scope: account, windowMinutes: 300, usedPercent: 10, resetsAt: NOW + HOUR }],
      })])
      assert.equal(result.accounts[0]!.plan, '… Standard')
      assert.equal(result.accounts[0]!.windows[0]!.label, 'Plan for … · …')
      assert.equal(result.runtimes[0]!.name, 'Fake Agent')
    }
  } finally { await f.done() }
})

test('Lead summary caps running and attention lists while keeping exact totals and omitted counts', async () => {
  const f = await fixture()
  try {
    for (let n = 0; n < 120; n++) {
      const id = `chat-${n}`
      f.index.upsert(summary(id, { updatedAt: NOW - n }))
      f.live.push({ runtime: agent, id: sessionId(id), running: n < 60, waiting: n >= 60, cost: null })
    }
    const result = await f.workspace.deskSummary({})
    assert.deepEqual(result.totals.chats, { running: 60, needsYou: 60, idle: 0 })
    assert.equal(result.running.length, 20)
    assert.equal(result.runningMore, 40)
    assert.equal(result.needsYou.length, 20)
    assert.equal(result.needsYouMore, 40)
    assert.equal(result.countsPartial, false)
  } finally { await f.done() }
})

test('Lead summary scans stop at the Sessions paging bound and expose partial counts', async () => {
  const f = await fixture()
  try {
    for (let n = 0; n < 2001; n++) f.index.upsert(summary(`chat-${n}`, { updatedAt: NOW - n }))
    f.live.push({ runtime: agent, id: sessionId('chat-2000'), running: true, waiting: false, cost: null })
    const result = await f.workspace.deskSummary({})
    assert.equal(result.sessionsScanned, 2000)
    assert.equal(result.countsPartial, true)
    assert.deepEqual(result.totals.chats, { running: 1, needsYou: 0, idle: 2000 })
    assert.equal(result.runningMore, 1, 'exact live totals include old items outside the scan')
    const usage = await f.workspace.usageSummary([report('dev@example.com')])
    assert.equal(usage.sessionsScanned, 2000)
    assert.equal(usage.countsPartial, true)
    assert.equal(usage.accounts[0]!.runningSessions, 0, 'a partial count is explicitly marked, never presented as exact')
  } finally { await f.done() }
})


for (const [verb, params] of [
  ['rename', { title: 'New title' }], ['archive', { archived: true }], ['pin', { pinned: true }], ['delete', {}],
] as const) test(`phone session ${verb} requires run and rejects unknown ids`, async () => {
  const f = await populated()
  const work = new PhoneWork({ seatName: (runtime: import('@harnessdesk/protocol').RuntimeId) => runtime === agent ? 'Agent' : null,
    isOwn: (runtime: import('@harnessdesk/protocol').RuntimeId, id: import('@harnessdesk/protocol').SessionId, archived = false) => f.index.isOwn(runtime, id, archived) } as never)
  const d = await door(f.workspace, { phoneWork: work, sessionIndex: {
    setPinned: (runtime, id, pinned) => f.index.setPinned(runtime, id, pinned),
    setTitle: (runtime, id, title) => f.index.setTitle(runtime, id, title),
    setArchived: (runtime, id, archived) => f.index.setArchived(runtime, id, archived),
  } as HostContext['sessionIndex'], runtimes: {
    resolve: () => ({ info: { id: agent, capabilities: { deleteHistory: 'erase' }, presentation: { name: 'Agent' } } }),
    ensureStarted: async () => {},
  } as unknown as HostContext['runtimes'], names: { set: async () => {} } as unknown as HostContext['names'],
    archive: { set: async () => {} } as unknown as HostContext['archive'], sessionWorktrees: {
      remember: async () => {}, prepare: async () => ({}), cleanup: async () => undefined,
    } as unknown as HostContext['sessionWorktrees'] })
  try {
    const reader = await d.pair(['read'])
    const method = `workspace/session/${verb}`
    assert.equal((await reader.request(method, { id: 'fake-agent:done-new', ...params })).error.code, 'tierNotGranted')
    reader.close()
    const runner = await d.pair(['read', 'run'])
    const unknown = await runner.request(method, { id: 'fake-agent:unknown', ...params })
    assert.equal(unknown.ok, false)
    assert.match(unknown.error.message, /not a session/)
    if (verb === 'rename' || verb === 'archive') {
      assert.equal((await runner.request(method, { id: 'fake-agent:done-new', ...params })).ok, true)
      const updated = f.index.get(agent, sessionId('done-new'))!
      if (verb === 'rename') assert.equal(updated.title, 'New title')
      else {
        assert.equal(updated.archived, true)
        assert.equal((await runner.request(method, { id: 'fake-agent:done-new', archived: false })).ok, true)
        assert.equal(f.index.get(agent, sessionId('done-new'))?.archived, false)
      }
    }
    if (verb === 'delete') {
      const refused = await runner.request(method, { id: 'fake-agent:done-new' })
      assert.equal(refused.error.message, 'Agent erases conversations for good, so delete it on the computer.')
    }
    if (verb === 'pin') {
      assert.equal((await runner.request(method, { id: 'fake-agent:done-new', pinned: true })).ok, true)
      assert.equal(f.index.get(agent, sessionId('done-new'))?.pinned, true)
      const list = await runner.request('phone/sessions/list', {})
      assert.equal(list.result.rows.find((row: any) => row.id === 'fake-agent:done-new').pinned, true)
      assert.equal(f.workspace.workSessions({}).items.find(row => row.id === 'fake-agent:done-new')?.pinned, true)
    }
    runner.close()
  } finally { await d.done(); await f.done() }
})

test('phone session lists carry host pins and archive state', async () => {
  const f = await populated()
  try {
    f.index.setPinned(agent, sessionId('archived'), true)
    const row = f.workspace.sessionsList({ state: 'archived' }).rows[0]!
    assert.equal(row.pinned, true)
    assert.equal(row.archived, true)
    assert.deepEqual(f.workspace.workSessions({ archived: true }).items.map(row => [row.pinned, row.archived]), [[true, true]])
  } finally { await f.done() }
})

test('the phone and the Lead both learn which allowance is about to expire unspent, and only then', async () => {
  const f = await fixture()
  try {
    f.ledger = () => ledgerOf([], 0)
    const lane = (usedPercent: number, resetsIn: number) => ({ id: 'session', label: '5-hour', usedPercent, windowMinutes: 300, resetsAt: NOW + resetsIn })
    f.reports = [
      report('john@example.com', { lanes: [lane(30, HOUR)] }),
      report('kim@example.com', { lanes: [lane(30, 3 * HOUR)] }),
      report('lee@example.com', { lanes: [lane(60, HOUR)] }),
      report('max@example.com', { lanes: [lane(30, HOUR)], fetchedAt: NOW - 10 * HOUR }),
    ]
    const rows = (await f.workspace.workUsage())!.runtimes
    assert.deepEqual(rows.map(row => row.useFirst), [true, undefined, undefined, undefined])
    const summary = await f.workspace.usageSummary(f.reports)
    assert.deepEqual(summary.accounts.map(one => one.useFirst), [true, undefined, undefined, undefined])
  } finally { await f.done() }
})
