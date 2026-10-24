import { basename } from 'node:path'
import {
  sessionIndexCursorOf,
  type GoalView, type LedgerQuery, type LedgerReport, type PhoneDashboard, type PhoneProjectShare, type PhoneRange, type PhoneSeatUsage,
  type PhoneSessionRow, type PhoneSessionsList, type PhoneSessionState, type PhoneTeamRow, type PhoneTeamsList, type PhoneTeamStage,
  type PhoneTeamStatus, type RuntimeId, type SessionId, type SessionSummary, type UsageLane, type UsageReport,
} from '@harnessdesk/protocol'

/**
 * What a paired phone reads of the desk's work, written as projections: each row is built field by field from a
 * desk record, so a field a record grows later reaches the phone only when someone adds it here on purpose.
 * Nothing in this file produces a path, a transcript, a token, an account address or a file's contents; the
 * free text a person typed (a session's title, a Team's sentence) goes through `scrub` on its way out.
 */

export interface PhoneLiveSession {
  readonly runtime: RuntimeId
  readonly id: SessionId
  readonly running: boolean
  /** An approval or a question is waiting on the person. */
  readonly waiting: boolean
  readonly cost: number | null
}

export interface PhoneTeamInput {
  readonly view: GoalView
  /** The Team's latest Flow run, if it has had one. */
  readonly execution: { readonly state: 'running' | 'settled' | 'stopped' | 'stalled'; readonly role: string | null } | null
  /** Dollars of each seat's conversation, live figure first and the stored one otherwise; null where unpriced. */
  readonly costs: readonly (number | null)[]
}

export interface PhoneWorkspacePorts {
  readonly now: () => number
  readonly sessions: {
    page(options: { archived: boolean; cursor?: string; pageSize: number }): { rows: { summary: SessionSummary; cost: number | null }[]; nextCursor: string | null }
    counts(): { active: number; archived: number }
    touchedSince(since: number): number
    costliestSince(since: number, limit: number): { summary: SessionSummary; cost: number }[]
  }
  /** The person's own open conversations that are live in this host right now. */
  readonly live: () => readonly PhoneLiveSession[]
  /** The agent's presentation name, from the runtime's own `presentation`; null for an agent this host does not know. */
  readonly seatName: (runtime: RuntimeId) => string | null
  readonly teams: () => Promise<readonly PhoneTeamInput[]>
  readonly reports: () => Promise<readonly UsageReport[]>
  readonly ledger: (query: LedgerQuery) => Promise<LedgerReport>
}

const WEEK_MINUTES = 7 * 24 * 60
const TITLE_LIMIT = 120
const SCAN_LIMIT = 2000

const clamp = (value: number | undefined, fallback: number, max: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(1, Math.floor(value)))

/**
 * Free text a person typed, made safe to leave the desk: paths, addresses and key-shaped strings become an
 * ellipsis, whitespace collapses, and it is shortened. A best effort on prose, which is why the fields built from
 * the desk's own records never go through it.
 */
export const scrub = (text: string, limit = TITLE_LIMIT): string => {
  const clean = text
    .replace(/[^\s@<>()"']+@[^\s@<>()"']+\.[^\s@<>()"']+/g, '…')
    .replace(/(?:[A-Za-z]:\\|~\/|\/)[^\s"'`)\]]*[\\/][^\s"'`)\]]*/g, '…')
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{12,}/g, '…')
    .replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, '…')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean
}

/** A folder's own name. Never the path above it, and never a name that is only a home or a root. */
const folderName = (path: string | null | undefined): string | null => {
  if (!path) return null
  const name = basename(path.replace(/[\\/]+$/, ''))
  return name === '' || name === '.' || name === '..' ? null : scrub(name, 60)
}

const projectOf = (summary: SessionSummary): string | null => summary.repo ? folderName(summary.repo.root) : null

const keyOf = (runtime: string, id: string): string => `${runtime}\u0000${id}`

const money = (value: number | null | undefined): number | null =>
  value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 100) / 100

const localMidnight = (at: number): number => { const date = new Date(at); date.setHours(0, 0, 0, 0); return date.getTime() }
const daysAgo = (midnight: number, days: number): number => { const date = new Date(midnight); date.setDate(date.getDate() - days); return date.getTime() }
const sameDay = (a: number, b: number): boolean => localMidnight(a) === localMidnight(b)

export class PhoneWorkspace {
  readonly #ports: PhoneWorkspacePorts

  constructor(ports: PhoneWorkspacePorts) { this.#ports = ports }

  // ------------------------------------------------------------------ sessions

  #stateOf(summary: SessionSummary, live: ReadonlyMap<string, PhoneLiveSession>): PhoneSessionState {
    if (summary.archived) return 'archived'
    const one = live.get(keyOf(summary.runtime, summary.id))
    return one?.waiting ? 'needs-you' : one?.running ? 'running' : 'done'
  }

  #sessionRow(entry: { summary: SessionSummary; cost: number | null }, live: ReadonlyMap<string, PhoneLiveSession>): PhoneSessionRow | null {
    const { summary } = entry
    const seat = this.#ports.seatName(summary.runtime)
    if (seat === null) return null
    const one = live.get(keyOf(summary.runtime, summary.id))
    return {
      id: `${summary.runtime}:${summary.id}`,
      title: scrub(summary.title ?? '') || 'Untitled',
      project: projectOf(summary),
      state: this.#stateOf(summary, live),
      // The desk lists the person's own conversations; a Team's seats are listed under their Team, and nothing
      // records that a Lead opened one.
      startedBy: 'you',
      seat,
      cost: money(one?.cost ?? entry.cost),
      lastActivityAt: summary.updatedAt,
      pinned: false,
    }
  }

  #counts(live: readonly PhoneLiveSession[]): PhoneSessionsList['counts'] {
    const { active, archived } = this.#ports.sessions.counts()
    const running = live.filter(one => one.running && !one.waiting).length
    const needsYou = live.filter(one => one.waiting).length
    return { running, needsYou, done: Math.max(0, active - running - needsYou), archived }
  }

  sessionsList(params: { state?: PhoneSessionState; limit?: number; cursor?: string }): PhoneSessionsList {
    const limit = clamp(params.limit, 30, 100)
    const liveSessions = this.#ports.live()
    const live = new Map(liveSessions.map(one => [keyOf(one.runtime, one.id), one]))
    const archived = params.state === 'archived'
    const rows: PhoneSessionRow[] = []
    let cursor = params.cursor
    let next: string | null = null
    let scanned = 0
    while (rows.length < limit && next === null) {
      const page = this.#ports.sessions.page({ archived, cursor, pageSize: params.state === undefined || archived ? limit : 200 })
      let last: SessionSummary | null = null
      for (const [index, entry] of page.rows.entries()) {
        scanned++
        last = entry.summary
        const row = this.#sessionRow(entry, live)
        if (row && (params.state === undefined || row.state === params.state)) rows.push(row)
        if (rows.length === limit) {
          const more = index < page.rows.length - 1 || page.nextCursor !== null
          next = more ? sessionIndexCursorOf(entry.summary, archived ? 'only' : 'exclude') : null
          break
        }
      }
      if (rows.length === limit) break
      if (page.nextCursor === null) { next = null; break }
      if (scanned >= SCAN_LIMIT && last) { next = sessionIndexCursorOf(last, archived ? 'only' : 'exclude'); break }
      cursor = page.nextCursor
    }
    return { rows, counts: this.#counts(liveSessions), next }
  }

  // --------------------------------------------------------------------- teams

  async teamsList(params: { limit?: number }): Promise<PhoneTeamsList> {
    const limit = clamp(params.limit, 30, 100)
    const inputs = await this.#ports.teams()
    const rows = inputs.map(input => this.#teamRow(input)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
    return { rows }
  }

  #teamRow({ view, execution, costs }: PhoneTeamInput): PhoneTeamRow {
    const cards = view.board.intents
    const priced = costs.filter((cost): cost is number => cost !== null)
    return {
      id: view.goal.id,
      title: scrub(view.goal.sentence) || 'Untitled',
      project: folderName(view.goal.root),
      stage: stageOf(view, execution),
      progress: { done: cards.filter(card => card.state === 'done').length, total: cards.filter(card => card.state !== 'abandoned').length },
      workers: { count: view.members.length, initials: view.members.slice(0, 3).map(member => initialsOf(member.agent?.name ?? member.role ?? member.seatLabel)) },
      cost: priced.length === 0 ? null : money(priced.reduce((sum, cost) => sum + cost, 0)),
      status: statusOf(view, execution),
      updatedAt: view.goal.updatedAt,
    }
  }

  // ----------------------------------------------------------------- dashboard

  async dashboardRead(params: { range?: PhoneRange }): Promise<PhoneDashboard> {
    const range = params.range ?? 'today'
    const days = range === 'today' ? 1 : range === '7d' ? 7 : 30
    const now = this.#ports.now()
    const midnight = localMidnight(now)
    const rangeStart = daysAgo(midnight, days - 1)
    const [reports, week, inRange, doubled, monthly, teams] = await Promise.all([
      this.#ports.reports(),
      this.#ports.ledger({ days: 7, groupBy: 'runtime' }),
      this.#ports.ledger({ days, groupBy: 'project' }),
      this.#ports.ledger({ days: days * 2, groupBy: 'runtime' }),
      this.#ports.ledger({ days: new Date(now).getDate(), groupBy: 'runtime' }),
      this.#ports.teams(),
    ])

    const daily = Array.from({ length: 7 }, (_, index) => {
      const day = daysAgo(midnight, 6 - index)
      const spent = week.scannedAt === null ? null : week.daily.filter(row => sameDay(row.day, day)).reduce((sum, row) => sum + row.cost, 0)
      return { day, spent: money(spent) }
    })

    const live = this.#ports.live()
    const counts = {
      running: live.filter(one => one.running && !one.waiting).length + teams.filter(({ view }) => view.activity === 'working').length,
      needsYou: live.filter(one => one.waiting).length + teams.filter(({ view }) => view.activity === 'needs-you').length,
      doneToday: this.#finishedSince(midnight, live, teams),
    }

    const spent = money(inRange.totalCost)
    const previous = inRange.totalCost !== null && doubled.totalCost !== null ? money(Math.max(0, doubled.totalCost - inRange.totalCost)) : null
    const costly = this.#ports.sessions.costliestSince(rangeStart, 3).flatMap(({ summary, cost }) => {
      const seat = this.#ports.seatName(summary.runtime)
      return seat === null ? [] : [{ id: `${summary.runtime}:${summary.id}`, title: scrub(summary.title ?? '') || 'Untitled', project: projectOf(summary), cost: money(cost)! }]
    })

    return {
      today: { spent: daily[6]!.spent },
      allowance: allowanceOf(reports, monthly, now),
      counts,
      daily,
      seats: seatsOf(reports, this.#ports.seatName),
      period: {
        range,
        finished: this.#finishedSince(rangeStart, live, teams),
        waitedOnYou: null,
        ruleBreaks: null,
        spent,
        spentPrevious: previous,
        spentVsPrevious: spent !== null && previous !== null && previous > 0 ? Math.round((spent - previous) / previous * 100) : null,
        byProject: projectShares(inRange),
        mostExpensive: costly,
      },
    }
  }

  /** Conversations touched since a time that are no longer working or waiting, and Teams wrapped since then. */
  #finishedSince(since: number, live: readonly PhoneLiveSession[], teams: readonly PhoneTeamInput[]): number {
    const touched = this.#ports.sessions.touchedSince(since)
    const busy = live.filter(one => one.running || one.waiting).length
    const wrapped = teams.filter(({ view }) => view.goal.state === 'wrapped' && view.goal.updatedAt >= since).length
    return Math.max(0, touched - busy) + wrapped
  }
}

// ------------------------------------------------------------------ pure parts

const initialsOf = (name: string): string => {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return (words.length === 0 ? '?' : words.slice(0, 2).map(word => [...word][0]!).join('')).toUpperCase()
}

/**
 * Where a Team is, in the four words the phone draws. The desk has no stage field: this reads the latest run's
 * round role, which a Flow author names, so a Flow with unusual role names lands in `build`.
 */
const stageOf = (view: GoalView, execution: PhoneTeamInput['execution']): PhoneTeamStage => {
  if (view.goal.state !== 'open') return 'land'
  if (view.activity === 'ready-to-wrap') return 'land'
  const role = execution?.role?.toLowerCase() ?? ''
  if (/review|check|verif|audit|test|referee|critic/.test(role)) return 'review'
  if (/land|merge|ship|wrap|publish|release/.test(role)) return 'land'
  if (/plan|scope|design|research|spec|intake|triage/.test(role)) return 'plan'
  if (execution === null && view.members.length === 0 && view.board.intents.length === 0) return 'plan'
  return 'build'
}

const statusOf = (view: GoalView, execution: PhoneTeamInput['execution']): PhoneTeamStatus => {
  if (view.goal.state === 'wrapped' || view.activity === null) return 'done'
  if (view.activity === 'needs-you') return 'needs-you'
  if (view.activity === 'ready-to-wrap') return 'ready'
  return execution && (execution.state === 'stopped' || execution.state === 'stalled') ? 'stopped' : 'working'
}

/**
 * One row per signed-in agent. A name shared by several accounts gets a number so the rows can be told apart;
 * the account itself is never part of a row.
 */
const seatsOf = (reports: readonly UsageReport[], seatName: PhoneWorkspacePorts['seatName']): PhoneSeatUsage[] => {
  const named = reports.flatMap(report => { const name = seatName(report.runtime); return name === null ? [] : [{ report, name }] })
  const total = new Map<string, number>()
  for (const { name } of named) total.set(name, (total.get(name) ?? 0) + 1)
  const seen = new Map<string, number>()
  return named.map(({ report, name }) => {
    const nth = (seen.get(name) ?? 0) + 1
    seen.set(name, nth)
    const planWide = report.lanes.filter(lane => !lane.scope)
    const short = pick(planWide.filter(lane => lane.windowMinutes !== null && lane.windowMinutes < WEEK_MINUTES), (a, b) => a.windowMinutes! - b.windowMinutes!)
    const week = planWide.find(lane => lane.id === 'weekly') ?? planWide.find(lane => lane.windowMinutes === WEEK_MINUTES)
    return {
      label: (total.get(name) ?? 0) > 1 ? `${name} ${nth}` : name,
      windowPercent: short ? Math.round(short.usedPercent) : null,
      resetsAt: short?.resetsAt ?? null,
      weekPercent: week ? Math.round(week.usedPercent) : null,
    }
  })
}

const pick = (lanes: readonly UsageLane[], compare: (a: UsageLane, b: UsageLane) => number): UsageLane | undefined => [...lanes].sort(compare)[0]

/** The sum of the monthly caps the person set, against what the ledger shows spent so far this month. */
const allowanceOf = (reports: readonly UsageReport[], monthSoFar: LedgerReport, now: number): PhoneDashboard['allowance'] => {
  const caps = reports.flatMap(report => {
    const budget = report.billing?.budget
    return budget && budget.currency === 'USD' && budget.period === 'month' && budget.amount > 0 ? [budget.amount] : []
  })
  if (caps.length === 0) return null
  const date = new Date(now)
  return { amount: money(caps.reduce((sum, amount) => sum + amount, 0))!, spent: money(monthSoFar.totalCost), resetsAt: new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime() }
}

const projectShares = (report: LedgerReport): PhoneProjectShare[] => {
  const byName = new Map<string, number>()
  for (const row of report.rows) {
    if (row.cost === null || row.cost <= 0) continue
    // The row's key is a folder path: only its last component leaves the desk. Two folders of one name merge.
    const name = folderName(row.key) ?? 'Other'
    byName.set(name, (byName.get(name) ?? 0) + row.cost)
  }
  const sorted = [...byName.entries()].sort((a, b) => b[1] - a[1])
  const sum = sorted.reduce((total, [, cost]) => total + cost, 0)
  if (sum <= 0) return []
  const top = sorted.slice(0, 5)
  const rest = sorted.slice(5).reduce((total, [, cost]) => total + cost, 0)
  const shares = top.map(([project, cost]) => ({ project, spent: money(cost)!, share: Math.round(cost / sum * 1000) / 1000 }))
  return rest > 0 ? [...shares, { project: 'Other', spent: money(rest)!, share: Math.round(rest / sum * 1000) / 1000 }] : shares
}
