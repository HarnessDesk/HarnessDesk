import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { PhoneSim } from '@harnessdesk/phone-link/sim'
import { runtimeId, sessionId, type GoalView, type LedgerQuery, type LedgerReport, type PhoneTier, type SessionSummary, type UsageReport } from '@harnessdesk/protocol'
import { Logger } from '../src/log.js'
import { dispatch, type HostContext } from '../src/methods/index.js'
import { phoneLinkOff, startPhoneLink, type PhoneLinkControl } from '../src/phone-link.js'
import { PhoneWorkspace, scrub, type PhoneLiveSession, type PhoneTeamInput } from '../src/phone-workspace.js'
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
  readonly done: () => Promise<void>
}

const fixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'hd-phone-workspace-'))
  const file = join(root, 'sessions.sqlite')
  const index = new SessionIndex(file)
  const db = new DatabaseSync(file)
  const state: Fixture = {
    index, db, live: [], teams: [], reports: [], ledger: () => ({ totalCost: null, scannedAt: null, rows: [], daily: [] } as unknown as LedgerReport),
    workspace: undefined as never, done: async () => { db.close(); index.close(); await rm(root, { recursive: true, force: true }) },
  }
  const workspace = new PhoneWorkspace({
    now: () => NOW,
    sessions: {
      page: options => index.phoneList(options),
      counts: () => index.phoneCounts(),
      touchedSince: since => index.touchedSince(since),
      costliestSince: (since, limit) => index.costliestSince(since, limit),
    },
    live: () => state.live,
    seatName: runtime => runtime === agent ? 'Fake Agent' : null,
    teams: async () => state.teams,
    reports: async () => state.reports,
    ledger: async query => state.ledger(query),
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

test('a session row carries only the redacted fields, and the live figure beats the stored one', async () => {
  const f = await populated()
  try {
    const list = f.workspace.sessionsList({})
    assert.deepEqual(list.rows.map(row => row.id), ['fake-agent:running', 'fake-agent:waiting', 'fake-agent:done-new', 'fake-agent:foreign-money', 'fake-agent:done-old'])
    const [running, waiting, doneNew, foreign] = list.rows
    assert.deepEqual(Object.keys(running!).sort(), ['cost', 'id', 'lastActivityAt', 'pinned', 'project', 'seat', 'startedBy', 'state', 'title'])
    assert.deepEqual({ project: running!.project, state: running!.state, startedBy: running!.startedBy, seat: running!.seat, cost: running!.cost, pinned: running!.pinned },
      { project: 'acme-api', state: 'running', startedBy: 'you', seat: 'Fake Agent', cost: 2.5, pinned: false })
    assert.equal(running!.lastActivityAt, NOW - HOUR)
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

// -------------------------------------------------------------- the phone door

/** A paired phone, and the real link, over a desk that answers only the three reads. */
const door = async (workspace: PhoneWorkspace) => {
  const home = await mkdtemp(join(tmpdir(), 'hd-phone-door-'))
  let attached: PhoneLinkControl | null = null
  const ctx = {
    phone: { state: () => attached?.state() ?? phoneLinkOff, pairing: () => attached!.pairing(), allow: (...a: never[]) => (attached!.allow as any)(...a),
      deny: (id: string) => attached!.deny(id), revoke: (d: string) => attached!.revoke(d) },
    phoneWorkspace: workspace,
  } as unknown as HostContext
  const host = {
    call: (method: string, params: unknown) => dispatch(ctx, method as never, params as never),
    addBroadcaster: () => () => {},
    attachPhoneLink: (control: PhoneLinkControl) => { attached = control },
  }
  const running = await startPhoneLink(host as never, new Logger('test', { console: false }), { home, host: '127.0.0.1', includeLoopback: true, name: 'Test desk' })
  const pair = async (tiers?: readonly PhoneTier[]) => {
    const code = running.control.pairing()
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
