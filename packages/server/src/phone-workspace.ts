import { answeredWithNothing, brandKeyField, burn, elapsedMinutes, formatElapsed, formatResetIn, remainingOf, leadStage, isWaitingOnYou, isSilentUsage } from '@harnessdesk/protocol'
import { teamLeadStage } from './work-stage.js'
import {
  sessionIndexCursorOf, sessionLabel,
  type LeadUsageSummary, type LeadUsageWindow, type LeadDeskSummary, type LeadDeskItem, type LeadStage,
  type GoalView, type LedgerQuery, type LedgerReport, type PhoneDashboard, type PhoneProjectShare, type PhoneRange, type PhoneSeatUsage,
  type PhoneSessionRow, type PhoneSessionsList, type PhoneSessionState, type PhoneTeamRow, type PhoneTeamsList, type PhoneTeamStage,
  type PhoneTeamStatus, type PhoneWorkAllowance, type PhoneWorkItem, type PhoneWorkPeriod, type PhoneWorkUsage, type PhoneWorkWorker,
  type RuntimeId, type SessionId, type SessionSummary, type UsageLane, type UsageReport, type UsageStandingStatus, useFirstNote, usageStandingOf, keptReading, pacingAdvice, type PhoneWorkPacing,
} from '@harnessdesk/protocol'
import { folderName, micros, money, scrub } from './phone-redact.js'

export { scrub }

/**
 * What a paired phone reads of the desk's work, written as projections: each row is built field by field from a
 * desk record, so a field a record grows later reaches the phone only when someone adds it here on purpose.
 * Nothing in this file produces a path, a transcript, a token, an account address or a file's contents; the
 * free text a person typed (a session's title, a Team's sentence) goes through `scrub` on its way out.
 */

export interface PhoneLiveSession {
  readonly runtime: RuntimeId
  readonly id: SessionId
  readonly failed?: boolean
  readonly queued?: boolean
  readonly queuePaused?: boolean
  readonly running: boolean
  /** An approval or a question is waiting on the person. */
  readonly waiting: boolean
  /** The latest turn was interrupted: stopped, not finished. */
  readonly stopped?: boolean
  /** When the conversation last changed; a stopped one counts against "finished" only when it changed in the window. */
  readonly updatedAt?: number
  readonly cost: number | null
  /** Live opening, while the runtime's preview has not reached the index yet. */
  readonly preview?: string | null
}

/** One open seat of a Team, as the phone draws a worker. */
export interface PhoneTeamMember {
  readonly seat: string
  readonly session: { readonly runtime: RuntimeId; readonly id: SessionId }
  /** The card it holds right now, or the role it was seated for. */
  readonly title: string
  readonly role: string | null
  /** The model the seat runs on, where the desk knows it. */
  readonly model: string | null
  /** Whether it holds an open card. */
  readonly holding: boolean
  readonly cost: number | null
}

export interface PhoneTeamInput {
  readonly view: GoalView
  /** The Team's open seats. Left out by a caller that only needs the row. */
  readonly members?: readonly PhoneTeamMember[]
  /** The Team's latest Flow run, if it has had one. */
  readonly execution: { readonly state: 'running' | 'settled' | 'stopped' | 'stalled'; readonly role: string | null } | null
  /** Dollars of each seat's conversation, live figure first and the stored one otherwise; null where unpriced. */
  readonly costs: readonly (number | null)[]
}

export interface PhoneWorkspacePorts {
  readonly now: () => number
  readonly sessions: {
    page(options: { archived: boolean; cursor?: string; pageSize: number }): { rows: { summary: SessionSummary; cost: number | null }[]; nextCursor: string | null }
    isOwn(runtime: RuntimeId, id: SessionId): boolean
    /** `byRuntime` lets a count leave out agents the desk cannot show, as the list does. */
    counts(): { active: number; archived: number; byRuntime?: readonly { runtime: RuntimeId; active: number; archived: number }[] }
    touchedSince(since: number): number
    costliestSince(since: number, limit: number): { summary: SessionSummary; cost: number }[]
  }
  /** The person's own open conversations that are live in this host right now. */
  readonly live: () => readonly PhoneLiveSession[]
  /** Whether a conversation the host does not hold ended on a stop, from the host's kept transcript: Stopped survives a restart. */
  readonly stopped?: (runtime: RuntimeId, id: SessionId) => boolean
  /** The agent's presentation name, from the runtime's own `presentation`; null for an agent this host does not know. */
  readonly seatName: (runtime: RuntimeId) => string | null
  /** The agent's mark, a lobe-icons key from `brandForRuntime`; null or absent when it has none. Checked here before it is sent. */
  readonly seatBrand?: (runtime: RuntimeId) => string | null
  /** Whether this agent moves deleted conversations to the Trash. */
  readonly canDelete?: (runtime: RuntimeId) => boolean
  /** Whether this runtime's `createdAt` is a measured start (`capabilities.startTimes`); absent means it is not. */
  readonly knowsStart?: (runtime: RuntimeId) => boolean
  readonly teams: () => Promise<readonly PhoneTeamInput[]>
  readonly reports: () => Promise<readonly UsageReport[]>
  readonly ledger: (query: LedgerQuery) => Promise<LedgerReport>
  /** The Lead's name and the chats it directs (`runtime:session`); null while no Lead runs here. */
  readonly leadChats?: () => LeadChats | null
}

/** The chats the Lead holds in its project. A chat the person took over is theirs again. */
interface LeadChats {
  readonly name: string; readonly ids: ReadonlySet<string>; readonly retrying?: ReadonlySet<string>
  /** The Teams the current Lead goal started, by Team id. */
  readonly teams?: ReadonlyMap<string, { readonly step: string | null; readonly accepted: boolean }>
  /** The Teams whose waiting seat the Lead puts to the person as its own card, by Team id. */
  readonly relayed?: ReadonlySet<string>
  /**
   * Whether this Team's wrap needs a choice only the desk asks: a posting of its findings the pull request could not
   * confirm. The phone wraps with no such choice, so it does not offer Wrap there.
   */
  readonly wrapsOnDesk?: (team: string) => boolean
}

const workTeamStage = (input: PhoneTeamInput) => input.view.stage === undefined
  ? teamLeadStage(input.view, input.execution) : { stage: input.view.stage, reason: input.view.stageReason ?? 'idle' }

const WEEK_MINUTES = 7 * 24 * 60
const SCAN_LIMIT = 2000
const WORK_ITEMS = 80
const USAGE_TTL = 60_000
/** What the phone is told for a count the desk does not keep: its decoder has no way to read "unknown". */

const clamp = (value: number | undefined, fallback: number, max: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(1, Math.floor(value)))

const projectOf = (summary: SessionSummary): string | null => summary.repo ? folderName(summary.repo.root) : null

const keyOf = (runtime: string, id: string): string => `${runtime}\u0000${id}`

const localMidnight = (at: number): number => { const date = new Date(at); date.setHours(0, 0, 0, 0); return date.getTime() }
const daysAgo = (midnight: number, days: number): number => { const date = new Date(midnight); date.setDate(date.getDate() - days); return date.getTime() }
const sameDay = (a: number, b: number): boolean => localMidnight(a) === localMidnight(b)

export class PhoneWorkspace {
  readonly #ports: PhoneWorkspacePorts

  constructor(ports: PhoneWorkspacePorts) { this.#ports = ports }

  // ------------------------------------------------------------------ sessions

  /** The `brand` field of a row about this agent: a key shaped as the wire allows, or nothing. */
  #brand(runtime: RuntimeId): { brand?: string } { return brandKeyField(this.#ports.seatBrand?.(runtime)) }

  #stateOf(summary: SessionSummary, live: ReadonlyMap<string, PhoneLiveSession>): PhoneSessionState {
    if (summary.archived) return 'archived'
    const one = live.get(keyOf(summary.runtime, summary.id))
    return one?.waiting ? 'needs-you' : one?.running || this.#ports.leadChats?.()?.retrying?.has(`${summary.runtime}:${summary.id}`) ? 'running' : 'done'
  }

  #sessionRow(entry: { summary: SessionSummary; cost: number | null }, live: ReadonlyMap<string, PhoneLiveSession>,
    lead: LeadChats | null): PhoneSessionRow | null {
    const { summary } = entry
    const seat = this.#ports.seatName(summary.runtime)
    if (seat === null) return null
    const one = live.get(keyOf(summary.runtime, summary.id))
    const id = `${summary.runtime}:${summary.id}`
    return {
      id,
      canDelete: this.#ports.canDelete?.(summary.runtime) === true,
      title: scrub(sessionLabel(summary.title, one?.preview ?? summary.preview, '')) || 'Untitled',
      project: projectOf(summary),
      state: this.#stateOf(summary, live),
      // The desk lists the person's own conversations; a Team's seats are listed under their Team. A chat the
      // Lead directs is its work, even though it runs as an ordinary conversation.
      startedBy: lead?.ids.has(id) ? 'lead' : 'you',
      seat,
      ...this.#brand(summary.runtime),
      cost: money(one?.cost ?? entry.cost),
      lastActivityAt: summary.updatedAt,
      // A start the agent never recorded, or one later than the last activity, is left out rather than guessed.
      ...(this.#ports.knowsStart?.(summary.runtime) === true && Number.isFinite(summary.createdAt) && summary.createdAt > 0 &&
        summary.createdAt <= summary.updatedAt ? { startedAt: summary.createdAt } : {}),
      pinned: summary.pinned === true,
      archived: summary.archived === true,
    }
  }

  #sessionStage(one: PhoneLiveSession | undefined, archived = false) {
    return leadStage({ kind: 'session', archived, waiting: one?.waiting ?? false, failed: one?.failed ?? false, queuePaused: one?.queuePaused ?? false, running: one?.running ?? false, queued: one?.queued ?? false, stopped: one?.stopped ?? false })
  }

  /**
   * The person's own sessions by state. Live ones are filtered to their own, as `deskSummary` filters them: a Team's
   * seat waiting on the person is the Team's, and counted here it moved one of their sessions from done to needs-you,
   * so the phone and the Lead said different numbers for the same desk (#2150).
   */
  #counts(all: readonly PhoneLiveSession[]): PhoneSessionsList['counts'] {
    const live = all.filter(one => this.#ports.sessions.isOwn(one.runtime, one.id))
    const { active, archived } = this.#ownCounts()
    const running = live.filter(one => this.#sessionStage(one).stage === 'working').length
    const queued = live.filter(one => this.#sessionStage(one).stage === 'queued').length
    const needsYou = live.filter(one => isWaitingOnYou(this.#sessionStage(one).stage)).length
    return { running, needsYou, done: Math.max(0, active - running - queued - needsYou), archived }
  }

  sessionsList(params: { state?: PhoneSessionState; limit?: number; cursor?: string }): PhoneSessionsList {
    const limit = clamp(params.limit, 30, 100)
    const liveSessions = this.#ports.live()
    const live = new Map(liveSessions.map(one => [keyOf(one.runtime, one.id), one]))
    const lead = this.#ports.leadChats?.() ?? null
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
        const row = this.#sessionRow(entry, live, lead)
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

  /** Same 200-row pages and 2,000-session ceiling as filtered Sessions reads; also bound empty pages. */
  /** The person's own conversations by one definition everywhere: those the list can show, so an agent the desk no
   * longer knows is in no count, as it is in no list. */
  #ownCounts(): { active: number; archived: number } {
    const counts = this.#ports.sessions.counts()
    if (!counts.byRuntime) return counts
    const shown = counts.byRuntime.filter(one => this.#ports.seatName(one.runtime) !== null)
    return { active: shown.reduce((sum, one) => sum + one.active, 0), archived: shown.reduce((sum, one) => sum + one.archived, 0) }
  }

  #summarySessions(): { rows: SessionSummary[]; partial: boolean } {
    const rows: SessionSummary[] = []
    let cursor: string | undefined
    for (let pages = 0; pages < SCAN_LIMIT / 200; pages++) {
      const page = this.#ports.sessions.page({ archived: false, cursor, pageSize: 200 })
      rows.push(...page.rows.slice(0, 200).map(entry => entry.summary).filter(summary => this.#ports.seatName(summary.runtime) !== null))
      if (page.nextCursor === null) return { rows, partial: false }
      cursor = page.nextCursor
    }
    return { rows, partial: true }
  }

  /** The same own-session index and host stages as Sessions, with no preview/message fallback. */
  async deskSummary(params: { limit?: number }): Promise<LeadDeskSummary> {
    const limit = clamp(params.limit, 8, 20)
    const inputs = await this.#ports.teams()
    const liveSessions = this.#ports.live().filter(one => this.#ports.sessions.isOwn(one.runtime, one.id))
    const live = new Map(liveSessions.map(one => [keyOf(one.runtime, one.id), one]))
    const items: LeadDeskItem[] = []
    const stateOf = (stage: LeadStage): LeadDeskItem['state'] => isWaitingOnYou(stage) ? 'needs-you'
      : stage === 'working' ? 'running' : 'idle'
    const scan = this.#summarySessions()
    for (const summary of scan.rows) items.push({
      id: `${summary.runtime}:${summary.id}`, title: scrub(summary.title ?? '') || 'Untitled',
      project: projectOf(summary), kind: 'chat', updatedAt: summary.updatedAt,
      state: stateOf(this.#sessionStage(live.get(keyOf(summary.runtime, summary.id))).stage),
    })
    for (const input of inputs) items.push({ id: input.view.goal.id, title: scrub(input.view.goal.sentence) || 'Untitled',
      project: folderName(input.view.goal.root), kind: 'team', updatedAt: input.view.goal.updatedAt,
      state: stateOf(workTeamStage(input).stage) })
    const empty = () => ({ chats: { running: 0, needsYou: 0, idle: 0 }, teams: { running: 0, needsYou: 0, idle: 0 } })
    const totals = empty(), projects = new Map<string | null, ReturnType<typeof empty>>()
    // Mutate only local counters: returned fields are readonly to consumers.
    for (const item of items) {
      const project = projects.get(item.project) ?? empty()
      projects.set(item.project, project)
      const kind = item.kind === 'chat' ? 'chats' : 'teams', state = item.state === 'needs-you' ? 'needsYou' : item.state
      for (const counts of [totals[kind], project[kind]]) counts[state]++
    }
    // The index already has an exact aggregate. Live membership is checked without walking old session rows.
    const active = this.#ownCounts().active
    totals.chats.running = liveSessions.filter(one => this.#sessionStage(one).stage === 'working').length
    totals.chats.needsYou = liveSessions.filter(one => isWaitingOnYou(this.#sessionStage(one).stage)).length
    totals.chats.idle = Math.max(0, active - totals.chats.running - totals.chats.needsYou)
    items.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    const running = items.filter(item => item.state === 'running').slice(0, 20)
    const needsYou = items.filter(item => item.state === 'needs-you').slice(0, 20)
    const projectRows = [...projects].map(([project, counts]) => ({ project, ...counts }))
      .sort((a, b) => (a.project ?? '').localeCompare(b.project ?? ''))
    const recent = items.slice(0, limit)
    return { totals, countsPartial: scan.partial, sessionsScanned: scan.rows.length,
      projects: projectRows.slice(0, 20), projectsMore: Math.max(0, projectRows.length - 20), recent,
      running, runningMore: Math.max(0, totals.chats.running + totals.teams.running - running.length),
      needsYou, needsYouMore: Math.max(0, totals.chats.needsYou + totals.teams.needsYou - needsYou.length),
      olderCount: Math.max(0, active + inputs.length - recent.length) }
  }

  /** Cached Dashboard reports only. Runtime activity uses the same own-session index and stages as deskSummary. */
  async usageSummary(reports: readonly UsageReport[]): Promise<LeadUsageSummary> {
    const now = this.#ports.now()
    const live = new Map(this.#ports.live().map(one => [keyOf(one.runtime, one.id), one]))
    // Free text may repeat an account identity; redact known identities before the path/address/key scrub.
    const identities = reports.flatMap(report => report.account ? [report.account] : [])
    const safe = (text: string): string => scrub(identities.reduce((value, identity) => {
      if (identity.length >= 3) return value.split(identity).join('…')
      // Short account names still identify a person, but must not erase letters inside ordinary words.
      const literal = identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return value.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])`, 'gu'), '…')
    }, text), 400)
    const names = new Map<RuntimeId, string>()
    const running = new Map<string, number>()
    const nameOf = (runtime: RuntimeId) => {
      const name = names.get(runtime) ?? safe(this.#ports.seatName(runtime) ?? 'Agent')
      names.set(runtime, name)
      if (!running.has(name)) running.set(name, 0)
      return name
    }
    const scan = this.#summarySessions()
    for (const summary of scan.rows) {
      const name = nameOf(summary.runtime)
      if (this.#sessionStage(live.get(keyOf(summary.runtime, summary.id))).stage === 'working')
        running.set(name, running.get(name)! + 1)
    }
    const totals = new Map<string, number>(), ordinals = new Map<string, number>()
    for (const report of reports) { const name = nameOf(report.runtime); totals.set(name, (totals.get(name) ?? 0) + 1) }
    const accounts = reports.map(report => {
      const runtime = nameOf(report.runtime), ordinal = (ordinals.get(runtime) ?? 0) + 1
      ordinals.set(runtime, ordinal)
      const plan = report.planLabel ?? report.plan
      const windowsOf = (lanes: readonly UsageLane[], failed: boolean, hit: string | null): LeadUsageWindow[] => lanes.map(lane => {
        const view = failed ? null : burn(lane, now)
        const projection: LeadUsageWindow['projection'] = view?.forecast && lane.placeholder !== true ? {
          kind: view.runsOut ? 'runs-out' : 'lasts-to-reset',
          at: view.runsOut ? now + (view.etaMs ?? 0) : view.resetsAt,
          basis: 'average consumption since window start', since: view.startsAt, asOf: now,
        } : null
        const minutes = lane.windowMinutes
        return {
          label: safe(lane.scope ? `${lane.label} · ${lane.scope}` : lane.label),
          kind: minutes === 300 ? '5h' : minutes === 10080 ? 'weekly'
            : minutes !== null && minutes >= 28 * 24 * 60 && minutes <= 31 * 24 * 60 ? 'monthly'
            : minutes === null ? 'allowance' : 'window',
          windowMinutes: minutes, remainingPercent: lane.placeholder === true ? null : remainingOf(lane),
          remaining: lane.usageKnown !== false && lane.placeholder !== true && lane.used != null && lane.limit != null ? Math.max(0, lane.limit - lane.used) : null,
          // The Dashboard's countdown, so the Lead quotes it rather than rounding a timestamp itself (#2174).
          unit: lane.unit ? safe(lane.unit) : null, resetsAt: lane.resetsAt,
          resetsIn: lane.resetsAt === null ? null : formatResetIn(lane.resetsAt - now),
          ...(lane.resetsAt !== null && lane.resetsAt <= now ? { resetPassed: true as const } : {}),
          reached: lane.placeholder !== true && (hit === lane.id || hit === lane.label || remainingOf(lane) === 0), projection,
        }
      })
      const windows = windowsOf(report.lanes, report.error !== null, report.reached)
      // Another sign-in's figures, as the Dashboard draws them for this agent: said as that sign-in's, never as its own.
      const other = report.unverified
      const borrowed = other && other.lanes.length > 0 ? {
        whose: safe(other.whose), windows: windowsOf(other.lanes, Boolean(other.error), other.reached),
        readAgeMinutes: ageMinutes(other.fetchedAt, now), readAge: formatElapsed(other.fetchedAt, now), stale: Boolean(other.error) || now - other.fetchedAt > other.staleAfterMs,
      } : null
      if (report.credits) windows.push({ label: 'Balance', kind: 'balance', unlimited: report.credits.unlimited === true, windowMinutes: null,
        remainingPercent: null, remaining: report.credits.remaining, unit: safe(report.credits.unit), resetsAt: null, resetsIn: null,
        reached: report.reached === 'credits' || report.credits.unlimited !== true && report.credits.remaining !== null && report.credits.remaining <= 0, projection: null })
      const silent = isSilentUsage(report)
      // The Plans table's "plan usage unavailable · Not reporting": an answer with nothing to show is said the same way.
      const nothing = silent || answeredWithNothing(report, now)
      return {
        runtime, label: `${runtime}${plan ? ` · ${safe(plan)}` : ''}${totals.get(runtime)! > 1 ? ` · account ${ordinal}` : ''}`,
        plan: plan === null ? null : safe(plan), runningSessions: running.get(runtime) ?? 0, windows,
        reached: report.reached !== null, fetchedAt: report.fetchedAt,
        stale: !silent && now - report.fetchedAt > report.staleAfterMs,
        ...(nothing ? { notReporting: true as const } : {}),
        ...(borrowed ? { unverified: borrowed } : {}),
        ...(useFirstNote(report, now) ? { useFirst: true as const } : {}),
        error: report.error ? report.error.needsSignIn === true ? 'sign-in needed' as const : 'reading failed' as const : null,
        spend: report.spend ? { currency: safe(report.spend.currency), today: report.spend.todayCost,
          last30Days: report.spend.windowDays === 30 ? report.spend.windowCost : null, provenance: report.spend.provenance } : null,
        readAgeMinutes: ageMinutes(report.fetchedAt, now), readAge: formatElapsed(report.fetchedAt, now),
        ...(keptReading(report) ? { refreshFailed: true as const } : {}),
      }
    })
    // The same advice the Dashboard and the phone give, said with the label the Lead was given for that account. With
    // one account there is no "first", as on the desktop (`pacingNote`).
    const read = reports.filter(report => !isSilentUsage(report))
    const advice = read.length < 2 ? null : pacingAdvice(reports.map((report, at) => ({ id: String(at), report })), now)
    const advised = advice ? accounts[Number(advice.id)]! : null
    const pacing = advice && advised ? {
      account: advised.label, reason: advice.reason, window: safe(advice.laneLabel), remainingPercent: advice.remainingPercent,
      resetsAt: advice.resetsAt, resetsAtLocal: deskClock(advice.resetsAt), readAgeMinutes: ageMinutes(advice.readAt, now),
      said: pacingSaid(advised.label, advice.reason, safe(advice.laneLabel), advice.remainingPercent, deskClock(advice.resetsAt)),
    } : null
    return { countsPartial: scan.partial, sessionsScanned: scan.rows.length, asOf: now, runtimes: [...running].map(([name, runningSessions]) => ({ name, runningSessions })), accounts, pacing }
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
      running: live.filter(one => this.#sessionStage(one).stage === 'working').length + teams.filter(input => workTeamStage(input).stage === 'working').length,
      needsYou: live.filter(one => isWaitingOnYou(this.#sessionStage(one).stage)).length + teams.filter(input => isWaitingOnYou(workTeamStage(input).stage)).length,
      doneToday: this.#finishedSince(midnight, live, teams),
    }

    const spent = money(inRange.totalCost)
    const previous = inRange.totalCost !== null && doubled.totalCost !== null ? money(Math.max(0, doubled.totalCost - inRange.totalCost)) : null
    const costly = this.#ports.sessions.costliestSince(rangeStart, 3).flatMap(({ summary, cost }) => {
      const seat = this.#ports.seatName(summary.runtime)
      return seat === null ? [] : [{ id: `${summary.runtime}:${summary.id}`, title: scrub(sessionLabel(summary.title, summary.preview, '')) || 'Untitled', project: projectOf(summary), cost: money(cost)! }]
    })

    return {
      today: { spent: daily[6]!.spent },
      allowance: allowanceOf(reports, monthly, now),
      counts,
      daily,
      seats: seatsOf(reports, this.#ports.seatName, this.#ports.seatBrand),
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
    // A stopped conversation finished nothing, so it is not counted as finished either.
    const busy = live.filter(one => one.running || one.waiting || one.stopped === true && (one.updatedAt ?? 0) >= since).length
    const wrapped = teams.filter(({ view }) => view.goal.state === 'wrapped' && view.goal.updatedAt >= since).length
    return Math.max(0, touched - busy) + wrapped
  }

  // ------------------------------------------------------------ the phone's workspace

  workSessions(params: { archived?: boolean; cursor?: string; limit?: number }): { items: PhoneWorkItem[]; nextCursor: string | null } {
    const page = this.sessionsList({ ...(params.archived ? { state: 'archived' as const } : {}), cursor: params.cursor, limit: params.limit ?? WORK_ITEMS })
    const lead = this.#ports.leadChats?.()?.name
    const live = new Map(this.#ports.live().map(one => [`${one.runtime}:${one.id}`, one]))
    return { items: page.rows.map(row => this.#sessionItem(row, lead, live.get(row.id) ?? this.#keptStop(row))), nextCursor: page.next }
  }

  /** A conversation the host no longer holds, after a restart, keeps the stop it ended on. Runtime ids carry no colon. */
  #keptStop(row: PhoneSessionRow): PhoneLiveSession | undefined {
    const at = row.id.indexOf(':')
    if (row.archived === true || at < 0 || !this.#ports.stopped) return undefined
    const runtime = row.id.slice(0, at) as RuntimeId, id = row.id.slice(at + 1) as SessionId
    return this.#ports.stopped(runtime, id) ? { runtime, id, running: false, waiting: false, stopped: true, cost: null } : undefined
  }

  #sessionItem(row: PhoneSessionRow, leadName: string | undefined, live: PhoneLiveSession | undefined): PhoneWorkItem {
    const lead = row.startedBy === 'lead' ? leadName : undefined
    const { stage, reason: stageReason } = this.#sessionStage(live, row.state === 'archived')
    return {
      stage, stageReason, id: row.id, kind: 'session', title: row.title, ...(row.project ? { project: row.project } : {}),
      canDelete: row.canDelete, pinned: row.pinned, archived: row.archived === true,
      phase: row.state === 'needs-you' ? 'needsYou' : row.state === 'running' ? 'running' : 'done',
      line: row.state === 'archived' ? 'Archived' : row.state === 'needs-you' ? 'Waiting on you' : row.state === 'running' ? 'Working' : stageReason === 'stopped' ? 'Stopped' : 'Done',
      agent: { name: row.seat, ...(row.brand ? { brand: row.brand } : {}) }, ...(lead ? { by: lead } : {}),
      updatedAt: row.lastActivityAt, ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }),
      ...(row.cost === null ? {} : { cost: micros(row.cost) }),
    }
  }

  /** Open sessions and Teams as the phone lists them, newest first. */
  async workItems(limit = WORK_ITEMS): Promise<PhoneWorkItem[]> {
    const [{ rows: sessions }, inputs] = [this.sessionsList({ limit }), await this.#ports.teams()]
    const live = new Map(this.#ports.live().map(one => [keyOf(one.runtime, one.id), one]))
    // Read once: the Lead's view walks its seats and approvals, and every Team row consults it.
    const lead = this.#ports.leadChats?.() ?? null
    const items: PhoneWorkItem[] = [
      ...sessions.map(row => this.#sessionItem(row, lead?.name, [...live.values()].find(one => `${one.runtime}:${one.id}` === row.id))),
      ...inputs.map(input => this.#teamItem(input, live, lead)),
    ]
    return items.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  #teamItem(input: PhoneTeamInput, live: ReadonlyMap<string, PhoneLiveSession>, lead: LeadChats | null): PhoneWorkItem {
    const row = this.#teamRow(input)
    const { stage, reason: stageReason } = workTeamStage(input)
    const stageLine = { plan: 'Planning', build: 'Building', review: 'In review', land: 'Landing' }[row.stage]
    const [phase, line] = ({
      working: [row.stage === 'review' ? 'watching' : 'running', stageLine],
      'needs-you': ['needsYou', 'Needs you'],
      ready: ['needsYou', 'Ready to wrap'],
      stopped: ['needsYou', 'Stopped'],
      done: ['done', 'Done'],
    } as const)[row.status]
    const members = input.members ?? []
    const workers: PhoneWorkWorker[] = members.map(member => {
      const one = live.get(keyOf(member.session.runtime, member.session.id))
      return {
        id: member.seat, title: scrub(member.title, 80) || 'Seat',
        seat: { name: this.#ports.seatName(member.session.runtime) ?? 'Agent', ...(member.model ? { model: scrub(member.model, 40) } : {}), ...this.#brand(member.session.runtime) },
        status: one?.waiting ? 'waiting' : one?.running || member.holding ? 'running' : 'done',
        cost: micros(member.cost ?? 0),
      }
    })
    const { done, total } = row.progress
    // A Team the Lead started is the Lead's work: it says so, names its plan step, and once the person accepted the
    // result it can be wrapped from the phone.
    const owned = lead?.teams?.get(input.view.goal.id)
    const step = owned?.step ? scrub(owned.step, 80) : ''
    return {
      stage, stageReason, id: row.id, kind: 'team', title: row.title, ...(row.project ? { project: row.project } : {}), phase, line,
      ...(owned && lead ? { by: lead.name } : {}),
      updatedAt: row.updatedAt, ...(row.cost === null ? {} : { cost: micros(row.cost) }),
      team: {
        stage: row.stage, ...(total > 0 ? { stageNote: `${done} of ${total} done` } : {}),
        roomId: input.view.board.id, startedAt: input.view.goal.createdAt, workers,
        reviewers: members.filter(member => /review|referee|audit|critic/i.test(member.role ?? '')).length,
        spent: micros(row.cost ?? 0),
        ...(step ? { step } : {}),
        ...(owned?.accepted && row.status === 'ready' && !lead?.wrapsOnDesk?.(input.view.goal.id) ? { canWrap: true as const } : {}),
        ...(owned && lead?.relayed?.has(input.view.goal.id) ? { relayed: true as const } : {}),
      },
    }
  }

  #usage: { at: number; value: PhoneWorkUsage | undefined } | null = null

  /**
   * Spend and allowance in the phone's own shape. Cached for a minute: the ledger and the usage reports do not move
   * faster than that, and every change to a session would otherwise ask for them again. Absent until the desk has
   * scanned its usage once.
   */
  async workUsage(): Promise<PhoneWorkUsage | undefined> {
    const now = this.#ports.now()
    if (this.#usage && now - this.#usage.at < USAGE_TTL && now >= this.#usage.at) return this.#usage.value
    const value = await this.#readUsage(now)
    this.#usage = { at: now, value }
    return value
  }

  async #readUsage(now: number): Promise<PhoneWorkUsage | undefined> {
    const midnight = localMidnight(now)
    const ask = (days: number, groupBy: LedgerQuery['groupBy']): Promise<LedgerReport> => this.#ports.ledger({ days, groupBy })
    const [reports, byRuntime7, byProject7, total14, byRuntime30, byProject30, total60, teams] = await Promise.all([
      this.#ports.reports(), ask(7, 'runtime'), ask(7, 'project'), ask(14, 'runtime'), ask(30, 'runtime'), ask(30, 'project'), ask(60, 'runtime'),
      this.#ports.teams(),
    ])
    if (byRuntime7.scannedAt === null) return undefined
    const live = this.#ports.live()
    const letters = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
    const days = Array.from({ length: 7 }, (_, index) => {
      const day = daysAgo(midnight, 6 - index)
      const spent = byRuntime7.daily.filter(row => sameDay(row.day, day)).reduce((sum, row) => sum + row.cost, 0)
      return { label: letters[new Date(day).getDay()]!, cost: micros(money(spent) ?? 0), isToday: index === 6 }
    })
    const period = (span: number, runtimes: LedgerReport, projects: LedgerReport, doubled: LedgerReport): PhoneWorkPeriod => {
      const spent = money(runtimes.totalCost) ?? 0
      const previous = doubled.totalCost === null || runtimes.totalCost === null ? null : money(Math.max(0, doubled.totalCost - runtimes.totalCost))
      const slices = runtimes.rows.flatMap(row => {
        const name = row.cost === null || row.cost <= 0 ? null : this.#ports.seatName(row.key as RuntimeId)
        return name === null ? [] : [{ label: name, cost: micros(money(row.cost)!) }]
      })
      return {
        finished: this.#finishedSince(daysAgo(midnight, span - 1), live, teams),
        // The desk keeps neither how often it needed the person nor rule breaks per range, so both are left out.
        spent: micros(spent),
        ...(previous !== null && previous > 0 ? { change: Math.round((spent - previous) / previous * 1000) / 1000 } : {}),
        slices,
        byProject: projectShares(projects).map(share => ({ name: share.project, cost: micros(share.spent) })),
        mostExpensive: this.#ports.sessions.costliestSince(daysAgo(midnight, span - 1), 3).flatMap(({ summary, cost }) => {
          const seat = this.#ports.seatName(summary.runtime)
          const project = projectOf(summary)
          return seat === null ? [] : [{ title: scrub(sessionLabel(summary.title, summary.preview, '')) || 'Untitled', ...(project ? { project } : {}), cost: micros(money(cost) ?? 0) }]
        }),
      }
    }
    const seats = seatRows(reports, this.#ports.seatName, this.#ports.seatBrand)
    const runtimes = seats.map(seat => allowanceRowOf(seat, now))
    const pacing = pacingOf(seats, runtimes, now)
    return {
      spentToday: days[6]!.cost,
      days,
      runtimes,
      week: period(7, byRuntime7, byProject7, total14),
      month: period(30, byRuntime30, byProject30, total60),
      ...(pacing ? { pacing } : {}),
    }
  }
}

const STANDING_WORD: Record<UsageStandingStatus, string> = {
  // Nothing read says what the desk's Plans table and cards say for it.
  ready: 'Ready', low: 'Low', short: 'Short', out: 'Out', overdrawn: 'Overdrawn', unknown: 'Unknown',
}

/**
 * One allowance row in the phone's shape. The standing is the desk's own `usageStandingOf`, so the phone's word
 * and the Plans table's never disagree; times are epoch milliseconds the phone counts down to. The older string
 * fields stay for a phone that reads only them. A source's error goes through `scrub`; the account never leaves.
 */
const allowanceRowOf = (seat: SeatRow, now: number): PhoneWorkAllowance => ({ ...allowanceFiguresOf(seat, now), ...(seat.brand ? { brand: seat.brand } : {}) })
const allowanceFiguresOf = (seat: SeatRow, now: number): PhoneWorkAllowance => {
  const { report } = seat
  // A tracked agent nothing has read: listed, as the desk lists it, with no figures and no reading to date.
  // An account that answered with nothing to show reads the same: the Plans table's "plan usage unavailable · Not reporting".
  if (isSilentUsage(report) || answeredWithNothing(report, now)) return { id: seat.id, name: seat.label, models: [], running: [], last7: [], status: 'Not reporting', standing: 'unknown', notReporting: true }
  const standing = usageStandingOf(report, now)
  // A failed refresh that kept its last good figures: they stand, as a stale reading, never as Unknown (#2094).
  const refreshFailed = keptReading(report)
  const reset = seat.resetsAt === null ? null : resetsIn(seat.resetsAt - now)
  const fraction = (left: number): number => Math.round(Math.min(100, Math.max(0, left)) * 10) / 1000
  // Unknown means nothing has been read at all; a kept reading is not unknown, so its figures go out with it.
  const unread = standing.status === 'unknown'
  // A balance that decided Out or Overdrawn is the whole story: a window's figures beside it would contradict it.
  const onBalance = standing.lane === null && (standing.status === 'out' || standing.status === 'overdrawn') &&
    typeof report.credits?.remaining === 'number'
  const laneRows = (from: readonly UsageLane[], known: boolean) => from.filter(lane => !lane.placeholder).map(lane => ({
    label: scrub(lane.label, 40),
    ...(lane.scope ? { scope: scrub(lane.scope, 40) } : {}),
    ...(lane.usageKnown === false || !known ? {} : { left: fraction(100 - lane.usedPercent) }),
    ...(lane.resetsAt === null || lane.resetsAt <= now ? {} : { resetsAt: lane.resetsAt }),
  }))
  const lanes = laneRows(report.lanes, !unread)
  // Another sign-in's figures travel apart from the agent's own, as the desk's card keeps them: never a lane of its own.
  const borrowed = report.unverified ? laneRows(report.unverified.lanes, true) : []
  const scoped = standing.scopedOut
  // A non-finite amount turns into null on the wire and breaks the phone's numeric field.
  const raw = report.credits?.remaining
  const remaining = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  const plan = report.planLabel ?? report.plan
  return {
    id: seat.id, name: seat.label, models: [], running: [], last7: [],
    ...(seat.windowPercent === null || unread || onBalance ? {} : { used: seat.windowPercent / 100 }),
    ...(reset === null || onBalance ? {} : { resetsIn: reset }),
    ...(seat.weekPercent === null || unread || onBalance ? {} : { weekUsed: seat.weekPercent / 100 }),
    status: STANDING_WORD[standing.status],
    standing: standing.status,
    ...(standing.left === null || unread ? {} : { left: fraction(standing.left) }),
    ...(standing.lane?.resetsAt != null && standing.lane.resetsAt > now ? { resetsAt: standing.lane.resetsAt } : {}),
    ...(standing.backAt === null ? {} : { backAt: standing.backAt }),
    ...(standing.runsOutAt === null ? {} : { runsOutAt: Math.round(standing.runsOutAt) }),
    ...(scoped?.scope ? { scopedOut: { scope: scrub(scoped.scope, 40), ...(scoped.resetsAt === null || scoped.resetsAt <= now ? {} : { backAt: scoped.resetsAt }) } } : {}),
    ...(lanes.length === 0 ? {} : { lanes }),
    ...(remaining === null || unread || report.credits?.unlimited ? {} : { balance: { amount: remaining, unit: scrub(report.credits!.unit, 12) } }),
    ...(plan ? { plan: scrub(plan, 40) } : {}),
    ...(useFirstNote(report, now) ? { useFirst: true as const } : {}),
    ...(report.unverified && borrowed.length ? { unverified: { whose: scrub(report.unverified.whose, 60), lanes: borrowed, readAt: report.unverified.fetchedAt,
      ...(report.unverified.error || now - report.unverified.fetchedAt > report.unverified.staleAfterMs ? { stale: true as const } : {}) } } : {}),
    readAt: report.fetchedAt,
    ...(now - report.fetchedAt > report.staleAfterMs || refreshFailed ? { stale: true } : {}),
    ...(report.error ? { problem: scrub(report.error.message, 120) } : {}),
    ...(refreshFailed ? { refreshFailed: true as const } : {}),
  }
}

/**
 * The phone's pacing note: the account whose allowance is about to be lost, as the desk's own surfaces say it. Only
 * the `use-first` advice is a note; "resets soonest" with nothing at risk is an order, not something to tell anyone.
 */
const pacingOf = (seats: readonly SeatRow[], rows: readonly PhoneWorkAllowance[], now: number): PhoneWorkPacing | null => {
  // With one account there is no "first", as on the desktop (`pacingNote`).
  if (seats.filter(seat => !isSilentUsage(seat.report)).length < 2) return null
  const advice = pacingAdvice(seats.map(seat => ({ id: seat.id, report: seat.report })), now)
  const row = advice?.reason === 'use-first' ? rows.find(one => one.id === advice.id) : undefined
  if (!advice || !row) return null
  return { id: row.id, name: row.name, window: scrub(advice.laneLabel, 40), left: Math.round(advice.remainingPercent * 10) / 1000,
    resetsAt: advice.resetsAt, readAt: advice.readAt }
}

/**
 * The pacing advice as the Lead says it. "Use first" is the note the Dashboard and the phone show; "resets soonest"
 * is only the order of the accounts with room, which no surface shows as a note, so the sentence says it plainly as
 * that order and never as a suggestion from somewhere the person cannot see.
 */
const pacingSaid = (account: string, reason: 'use-first' | 'resets-soonest', window: string, left: number, at: string): string =>
  reason === 'use-first'
    ? `Use ${account} first: its ${window} has ${left}% left and resets ${at}, so the rest would go unused.`
    : `Nothing is about to go unused. Of the accounts with room, ${account} resets soonest (its ${window}, ${left}% left, resets ${at}), so it is the one to use next.`

/** Whole minutes since a reading, rounded down and never negative: the protocol's one elapsed rule (#2150). */
const ageMinutes = (at: number, now: number): number => elapsedMinutes(at, now)

/**
 * A time on the desk's own clock, as a person reads it, with its zone: "Tue, Nov 17, 5:00 PM PST". The zone is the
 * desk process's, so it is named rather than left for the reader to assume. Node writes a narrow no-break space
 * before AM/PM; a plain space reads the same and survives every client.
 */
const deskClock = (at: number): string =>
  new Date(at)
    .toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    .replace(/\u202f/g, ' ')

/** "45m", "2h 10m", "3d 4h": how long until a window frees up; null once it has. */
const resetsIn = (ms: number): string | null => {
  const minutes = Math.round(ms / 60_000)
  if (minutes <= 0) return null
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(minutes / (24 * 60))}d ${Math.floor((minutes % (24 * 60)) / 60)}h`
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

/** One row per signed-in agent, with the runtime and its report kept for the caller and never sent whole. */
interface SeatRow extends PhoneSeatUsage {
  readonly runtime: RuntimeId
  /** The runtime, with the row's number when the agent is signed in more than once: never an account. */
  readonly id: string
  readonly report: UsageReport
}

/**
 * One row per signed-in agent. A name shared by several accounts gets a number so the rows can be told apart;
 * the account itself is never part of a row.
 */
const seatRows = (reports: readonly UsageReport[], seatName: PhoneWorkspacePorts['seatName'], seatBrand?: PhoneWorkspacePorts['seatBrand']): SeatRow[] => {
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
    const several = (total.get(name) ?? 0) > 1
    return {
      runtime: report.runtime,
      id: several && nth > 1 ? `${report.runtime}:${nth}` : String(report.runtime),
      report,
      label: several ? `${name} ${nth}` : name,
      ...brandKeyField(seatBrand?.(report.runtime)),
      windowPercent: short ? Math.round(short.usedPercent) : null,
      resetsAt: short?.resetsAt ?? null,
      weekPercent: week ? Math.round(week.usedPercent) : null,
    }
  })
}

const seatsOf = (reports: readonly UsageReport[], seatName: PhoneWorkspacePorts['seatName'], seatBrand?: PhoneWorkspacePorts['seatBrand']): PhoneSeatUsage[] =>
  seatRows(reports, seatName, seatBrand).map(({ label, brand, windowPercent, resetsAt, weekPercent }) => ({ label, ...(brand ? { brand } : {}), windowPercent, resetsAt, weekPercent }))

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
