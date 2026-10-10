import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import { INSIGHT_ROW_NOTES } from '@harnessdesk/protocol'

import type {
  AgentOrigin, Goal, InsightAmounts, InsightComparison, InsightCompareQuery, InsightGoalsReport, InsightMetric, InsightOrderPreview, InsightOrderQuery,
  InsightQuery, InsightReport, InsightSelector, InsightSource, Measure, SeatRecord,
} from '@harnessdesk/protocol'

import type { MachineSeatingFile } from '../agent-seating-file.js'
import type { GoalPlane } from '../goals/plane.js'
import type { GoalDocument } from '../goals/store.js'
import type { Ledger } from '../ledger/index.js'
import { seatFor, seatWindowOf } from './attribution.js'
import { canonicalPath, sameCanonicalPath, withCanonicalPaths } from '../path-identity.js'
import { pairedCosts } from './compare.js'
import { sumMeasures } from './measures.js'

import { INSIGHT_BYTE_LIMIT_MESSAGE, type UsageDetail, type UsageSample } from '../ledger/insight.js'

const DAY = 86_400_000
const unknown = (unit: InsightMetric['unit'], basis: InsightMetric['basis'] = 'unknown'): InsightMetric =>
  ({ value: null, quality: 'unknown', unit, basis, sourceIds: [], coverage: 'none', missing: ['No recorded measurement.'] })

const metric = (
  parts: readonly Measure[], unit: InsightMetric['unit'], basis: InsightMetric['basis'], sources: readonly InsightSource[], gaps: readonly string[],
): InsightMetric => {
  const total = sumMeasures(parts)
  return {
    ...total, unit, basis, sourceIds: sources.map((source) => source.id),
    // Estimate describes the basis, not missing source records.  A fully
    // observed list-price total is comparable (and says that it is an
    // estimate); a floor or an actual source gap is not silently complete.
    coverage: parts.length === 0 ? 'none' : gaps.length > 0 || total.quality === 'floor' ? 'partial' : 'complete',
    missing: gaps,
  }
}

const amounts = (samples: readonly import('../ledger/insight.js').UsageSample[], sources: readonly InsightSource[], gaps: readonly string[]): InsightAmounts => {
  const basis = new Set(samples.map((sample) => sample.moneyBasis))
  const moneyBasis: InsightMetric['basis'] = basis.size === 1
    ? [...basis][0] === 'vendorMetered' ? 'vendorMetered' : [...basis][0] === 'listPrice' ? 'listPrice' : 'unknown'
    : basis.size === 0 ? 'unknown' : 'mixed'
  return {
    usd: metric(samples.map((sample) => sample.usd), 'usd', moneyBasis, sources, gaps),
    tokens: metric(samples.map((sample) => sumMeasures([sample.input, sample.output, sample.cacheRead, sample.cacheWrite])), 'tokens', 'observed', sources, gaps),
    activeMs: unknown('milliseconds'),
    turns: metric(samples.map(() => ({ value: 1, quality: 'exact' as const })), 'count', 'observed', sources, gaps),
  }
}

const emptyReport = (root: string | null, from: number, to: number, generatedAt: number): InsightReport => {
  const total = { usd: unknown('usd'), tokens: unknown('tokens', 'observed'), activeMs: unknown('milliseconds'), turns: unknown('count', 'observed') }
  return {
    id: randomUUID(), generatedAt, query: { root, from, to }, goals: [], seats: [], goal: null, receipt: null,
    totals: total, elapsedMs: unknown('milliseconds'), breakdowns: [], sources: [], recordedSpend: [],
    provenance: { state: 'unavailable', note: 'Commit associations are unavailable; recorded usage is still shown.' }, gaps: ['No recorded usage was found for this scope.'],
  }
}

const seatKey = (seat: import('@harnessdesk/protocol').FlowSeat): string => JSON.stringify([
  seat.runtime, seat.model ?? null, seat.effort ?? null, seat.thinking ?? null,
])

const row = (
  key: string, label: string, samples: readonly import('../ledger/insight.js').UsageSample[], sources: readonly InsightSource[], gaps: readonly string[],
  extra: Pick<import('@harnessdesk/protocol').InsightRow, 'seat' | 'goal' | 'session' | 'message' | 'note'>,
): import('@harnessdesk/protocol').InsightRow => {
  const total = amounts(samples, sources, gaps)
  return { key, label, amounts: total, ...extra, elapsedMs: total.activeMs }
}

export interface InsightReadApi {
  goal(goal: string): Promise<InsightReport>
  goals(goals: readonly string[]): Promise<InsightGoalsReport>
  usage(query: InsightQuery): Promise<InsightReport>
  agent(root: string | undefined, agent: string, origin: AgentOrigin): Promise<InsightReport>
  compare(query: InsightCompareQuery): Promise<InsightComparison>
}

interface Stamp {
  readonly expiresAt: number
  readonly fingerprint: string
  readonly agent: string
  readonly proposed: readonly import('@harnessdesk/protocol').FlowSeat[]
  readonly query: InsightOrderQuery
  readonly reportFingerprint: string
}

/** Presentation timestamps do not invalidate a review; recorded values and their evidence do. */
const comparisonFingerprint = (report: InsightComparison): string => createHash('sha256').update(JSON.stringify({
  included: report.included,
  excluded: report.excluded,
  left: report.left,
  right: report.right,
  leftPerGoalUsd: report.leftPerGoalUsd,
  rightPerGoalUsd: report.rightPerGoalUsd,
  differenceUsd: report.differenceUsd,
  ratio: report.ratio,
  sources: report.sources.map((source) => ({ id: source.id, observedAt: source.observedAt, stale: source.stale, problem: source.problem })),
})).digest('hex')

/**
 * One read of a project's recorded usage, with its Goals and Seats, shared by
 * every report drawn from it. Each sample is attributed to its Seat at most
 * once, against windows built once, however many Teams read the project.
 */
interface ProjectScan {
  readonly detail: UsageDetail
  readonly projectGoals: readonly Goal[]
  readonly projectSeats: readonly SeatRecord[]
  readonly seatOf: (sample: UsageSample) => string | null
}

/** A deliberately narrow, read-first host plane. It never receives evidence writers or Goal mutators. */
export class InsightPlane implements InsightReadApi {
  readonly #stamps = new Map<string, Stamp>()

  constructor(
    private readonly port: { readonly ledger: () => Ledger; readonly goals: GoalPlane; readonly seats: () => readonly SeatRecord[]; readonly seating: MachineSeatingFile; readonly now?: () => number },
  ) {}

  #now(): number { return this.port.now?.() ?? Date.now() }
  #range(query: InsightQuery): void {
    if (!isAbsolute(query.root)) throw new Error('Choose an opened project before reading Insight.')
    if (!Number.isSafeInteger(query.from) || !Number.isSafeInteger(query.to) || query.from < 0 || query.from >= query.to || query.to - query.from > 90 * DAY) {
      throw new Error('Choose a valid Insight range of at most 90 days.')
    }
  }

  async usage(query: InsightQuery): Promise<InsightReport> { return this.#usage(query) }

  /* One read shares folder identities: the ledger compares every sample's
     project with the root, and resolving each anew is a realpath per sample. */
  #usage(query: InsightQuery, selectedSeatIds?: ReadonlySet<string>): Promise<InsightReport> {
    return withCanonicalPaths(async () => {
      this.#range(query)
      return this.#report(query, selectedSeatIds, await this.#scan(query))
    })
  }

  async #scan(query: InsightQuery): Promise<ProjectScan> {
    return this.#scanOf(query, await this.port.ledger().readInsight(query, { refresh: true }))
  }

  #scanOf(query: InsightQuery, detail: UsageDetail, held?: { readonly goals: readonly Goal[]; readonly seats: readonly SeatRecord[] }): ProjectScan {
    if (detail.samples.length === 0 && detail.gaps.length === 0) return { detail, projectGoals: [], projectSeats: [], seatOf: () => null }
    const projectGoals = (held?.goals ?? this.port.goals.store.list().map((document) => document.goal)).filter((goal) => sameCanonicalPath(goal.root, query.root))
    const projectSeats = (held?.seats ?? this.port.seats()).filter((seat) => sameCanonicalPath(seat.checkout.project, query.root))
    const windows = projectSeats.map(seatWindowOf)
    // A sample's one Seat among the project's is also its one Seat among any
    // subset holding it: `seatFor` matches runtime, session, folder and window
    // alone, so a narrower report can reuse the project-wide answer.
    const attributed = new Map<UsageSample, string | null>()
    const seatOf = (sample: UsageSample): string | null => {
      let id = attributed.get(sample)
      if (id === undefined) { id = seatFor(sample, windows); attributed.set(sample, id) }
      return id
    }
    return { detail, projectGoals, projectSeats, seatOf }
  }

  #report(query: InsightQuery, selectedSeatIds: ReadonlySet<string> | undefined, scan: ProjectScan): InsightReport {
    const generatedAt = this.#now()
    const { detail, projectGoals, projectSeats, seatOf } = scan
    if (detail.samples.length === 0 && detail.gaps.length === 0) return emptyReport(query.root, query.from, query.to, generatedAt)
    const runtimeSeats = query.runtime === undefined ? projectSeats : projectSeats.filter((seat) => seat.session.runtime === query.runtime)
    const seats = selectedSeatIds ? runtimeSeats.filter((seat) => selectedSeatIds.has(seat.id)) : runtimeSeats
    const runtimeSamples = query.runtime === undefined ? detail.samples : detail.samples.filter((sample) => sample.runtime === query.runtime)
    const selectedSamples = selectedSeatIds ? runtimeSamples.filter((sample) => {
      const id = seatOf(sample); return id !== null && selectedSeatIds.has(id)
    }) : runtimeSamples
    const sourceFor = (samples: readonly UsageSample[]) =>
      [...new Map(samples.map((sample) => [sample.source.id, sample.source])).values()]
    const sources = [...new Map([
      ...sourceFor(selectedSamples),
      // A failed source has no sample to carry it, but must remain inspectable
      // rather than becoming an apparently empty scoped report. A runtime
      // report may only inherit a failed source whose owner is that runtime;
      // older unscoped source records are deliberately not guessed into it.
      ...detail.sources.filter((source) => source.problem !== null && (query.runtime === undefined || source.runtime === query.runtime)),
    ].map((source) => [source.id, source])).values()]
    const allGoals = selectedSeatIds || query.runtime !== undefined
      ? projectGoals.filter((goal) => seats.some((seat) => seat.board === goal.id))
      : projectGoals
    const total = amounts(selectedSamples, sources, detail.gaps)
    const kept = new Set(seats.map((seat) => seat.id))
    const bySeat = new Map<string, UsageSample[]>()
    const unattributed: UsageSample[] = []
    for (const sample of selectedSamples) {
      const id = seatOf(sample)
      if (!id || !kept.has(id)) { unattributed.push(sample); continue }
      const held = bySeat.get(id)
      if (held) held.push(sample); else bySeat.set(id, [sample])
    }
    const seatRows = seats.map((seat) => row(
      `seat:${seat.id}`, seat.seatLabel, bySeat.get(seat.id) ?? [], sourceFor(bySeat.get(seat.id) ?? []), detail.gaps,
      { seat: seat.id, goal: seat.board, session: seat.session, message: null, note: seat.briefDigest ? INSIGHT_ROW_NOTES.cohort : INSIGHT_ROW_NOTES.missingCohort },
    ))
    const goalRows = allGoals.flatMap((goal) => {
      const goalSeats = seats.filter((seat) => seat.board === goal.id)
      if (goalSeats.length === 0) return []
      const samples = goalSeats.flatMap((seat) => bySeat.get(seat.id) ?? [])
      return [row(`goal:${goal.id}`, goal.sentence, samples, sourceFor(samples), detail.gaps, { seat: null, goal: goal.id, session: null, message: null, note: INSIGHT_ROW_NOTES.goal })]
    })
    const agentRows = [...new Map(seats.filter((seat) => seat.agent).map((seat) => [`${seat.agent!.origin}:${seat.agent!.id}`, seat.agent!] as const)).entries()].map(([key, agent]) => {
      const selected = seats.filter((seat) => seat.agent?.id === agent.id && seat.agent.origin === agent.origin).flatMap((seat) => bySeat.get(seat.id) ?? [])
      return row(`agent:${key}`, agent.name, selected, sourceFor(selected), detail.gaps, { seat: null, goal: null, session: null, message: null, note: INSIGHT_ROW_NOTES.agent })
    })
    const unallocated = amounts(unattributed, sourceFor(unattributed), detail.gaps)
    return {
      scan: detail.gaps.some((gap) => gap === INSIGHT_BYTE_LIMIT_MESSAGE || gap.startsWith('Insight stopped before')) ? 'partial' : 'complete',
      id: randomUUID(), generatedAt, query, goals: allGoals, seats, goal: null, receipt: null, totals: total, elapsedMs: total.activeMs,
      breakdowns: [
        { dimension: 'seat', rows: seatRows, unattributed: unallocated, reason: 'Recorded corpus rows without a unique historical Seat remain unattributed.' },
        { dimension: 'goal', rows: goalRows, unattributed: unallocated, reason: 'Not attributed to a Team.' },
        { dimension: 'agent', rows: agentRows, unattributed: unallocated, reason: 'Recorded usage without a historical Agent Seat remains unassigned.' },
      ],
      sources, recordedSpend: [], provenance: { state: 'unavailable', note: 'Commit associations are unavailable; recorded usage is still shown.' }, gaps: detail.gaps,
    }
  }

  async goal(id: string): Promise<InsightReport> {
    const document = this.port.goals.store.read(id)
    const to = this.#now(); const from = Math.max(0, to - 90 * DAY)
    return withCanonicalPaths(async () => {
      const query = { root: document.goal.root, from, to }
      this.#range(query)
      return this.#goalReport(document, query, await this.#scan(query))
    })
  }

  /**
   * Many Teams' usage from one ledger read: every project's share of the
   * usage sources comes from a single pass over them, rather than one pass
   * per Team or per project. A Team that cannot be read is named in
   * `failed`, never a zero, and does not take the others down; a ledger
   * read that fails names every Team it was for.
   */
  async goals(ids: readonly string[]): Promise<InsightGoalsReport> {
    const to = this.#now(); const from = Math.max(0, to - 90 * DAY)
    return withCanonicalPaths(async () => {
      const failed = new Set<string>()
      const projects = new Map<string, { query: InsightQuery; documents: GoalDocument[] }>()
      for (const id of ids) {
        try {
          const document = this.port.goals.store.read(id)
          const query = { root: document.goal.root, from, to }
          this.#range(query)
          const key = canonicalPath(query.root)
          const project = projects.get(key)
          if (project) project.documents.push(document); else projects.set(key, { query, documents: [document] })
        } catch { failed.add(id) }
      }
      const reports: InsightReport[] = []
      const read = [...projects.values()]
      let details: readonly UsageDetail[] = []
      try {
        // One query per Team: each keeps the source-data budget its own read
        // had, so Teams sharing a project do not share one read's budget.
        const queries = read.flatMap(({ query, documents }) => documents.map(() => query))
        if (queries.length) details = await this.port.ledger().readInsights(queries, { refresh: true })
      } catch {
        for (const { documents } of read) for (const document of documents) failed.add(document.goal.id)
        return { reports, failed: ids.filter((id) => failed.has(id)) }
      }
      const held = { goals: this.port.goals.store.list().map((document) => document.goal), seats: this.port.seats() }
      let first = 0
      for (const { query, documents } of read) {
        const detail = details[first]!
        first += documents.length
        let scan: ProjectScan
        try { scan = this.#scanOf(query, detail, held) } catch { for (const document of documents) failed.add(document.goal.id); continue }
        for (const document of documents) {
          try { reports.push(this.#goalReport(document, query, scan)) } catch { failed.add(document.goal.id) }
        }
      }
      return { reports, failed: ids.filter((id) => failed.has(id)) }
    })
  }

  #goalReport(document: GoalDocument, query: InsightQuery, scan: ProjectScan): InsightReport {
    const id = document.goal.id
    const receipt = document.receipt
    const seatIds = new Set(receipt?.seats ?? scan.projectSeats.filter((seat) => seat.board === id).map((seat) => seat.id))
    const report = this.#report(query, seatIds, scan)
    return { ...report, goal: id, receipt: receipt?.id ?? null, goals: [document.goal], seats: report.seats,
      gaps: receipt ? report.gaps : [...report.gaps, 'This Goal is not wrapped; its history is so far, not a receipt.'] }
  }

  async agent(root: string | undefined, agent: string, origin: AgentOrigin): Promise<InsightReport> {
    const to = this.#now(); const from = to - 90 * DAY
    const projects = this.port.goals.store.list().map((document) => document.goal.root)
    const selectedRoot = root ?? projects[0]
    if (!selectedRoot) return emptyReport(null, from, to, to)
    const seats = this.port.seats().filter((seat) => seat.agent?.id === agent && seat.agent.origin === origin && sameCanonicalPath(seat.checkout.project, selectedRoot))
    const report = await this.#usage({ root: selectedRoot, from, to }, new Set(seats.map((seat) => seat.id)))
    return { ...report, seats, gaps: seats.length === 0 ? [...report.gaps, 'No historical Seats were recorded for this Agent.'] : report.gaps }
  }

  async compare(query: InsightCompareQuery): Promise<InsightComparison> {
    this.#range(query)
    const report = await this.usage(query)
    const selected = report.breakdowns.find((breakdown) => breakdown.dimension === 'seat')?.rows ?? []
    const historical = new Map(report.seats.map((seat) => [seat.id, seat]))
    const rowsFor = (goal: string, selector: InsightSelector) =>
      selected.filter((entry) => {
        if (entry.goal !== goal || entry.seat === null) return false
        const seat = historical.get(entry.seat)
        return seat?.agent?.id === selector.agent && seat.agent.origin === selector.origin
          && seat.briefDigest === selector.briefDigest && selector.seat !== null && seatKey(seat.seat) === seatKey(selector.seat)
      })
    const metricFor = (goal: string, selector: InsightSelector): InsightMetric | null => {
      const found = rowsFor(goal, selector)
      if (found.length === 0) return null
      const metrics = found.map((entry) => entry.amounts.usd)
      const first = metrics[0]!
      if (metrics.some((value) => value.value === null || value.coverage !== 'complete' || value.basis !== first.basis)) return null
      return { ...first, value: metrics.reduce((sum, value) => sum + value.value!, 0) }
    }
    const rows: import('./compare.js').ComparableCost[] = query.goals.flatMap((goal) => (['left', 'right'] as const).map((side) => {
      const value = metricFor(goal, query[side])
      const basis: import('./compare.js').ComparableCost['basis'] = value?.basis === 'listPrice' || value?.basis === 'vendorMetered' || value?.basis === 'mixed' ? value.basis : 'unknown'
      return { goal, side, value: value?.value ?? null, basis, complete: value?.coverage === 'complete' }
    }))
    const paired = pairedCosts(rows)
    const included = paired.goals
    const combinedMetric = (metrics: readonly InsightMetric[], unit: InsightMetric['unit']): InsightMetric => {
      if (metrics.length === 0) return unknown(unit)
      const total = sumMeasures(metrics)
      const bases = new Set(metrics.map((metric) => metric.basis))
      const coverage = total.value === null ? 'none' : metrics.some((metric) => metric.coverage !== 'complete') ? 'partial' : 'complete'
      return {
        ...total,
        unit,
        basis: bases.size === 1 ? metrics[0]!.basis : 'mixed',
        sourceIds: [...new Set(metrics.flatMap((metric) => metric.sourceIds))],
        coverage,
        missing: [...new Set(metrics.flatMap((metric) => metric.missing))],
      }
    }
    const amountsFor = (selector: InsightSelector): InsightAmounts => {
      const matching = included.flatMap((goal) => rowsFor(goal, selector).map((row) => row.amounts))
      return {
        usd: combinedMetric(matching.map((amounts) => amounts.usd), 'usd'),
        tokens: combinedMetric(matching.map((amounts) => amounts.tokens), 'tokens'),
        activeMs: combinedMetric(matching.map((amounts) => amounts.activeMs), 'milliseconds'),
        turns: combinedMetric(matching.map((amounts) => amounts.turns), 'count'),
      }
    }
    const leftAmounts = amountsFor(query.left)
    const rightAmounts = amountsFor(query.right)
    const withValue = (metric: InsightMetric, value: number | null, unit = metric.unit): InsightMetric => ({ ...metric, value, unit, quality: value === null ? 'unknown' : metric.quality, coverage: value === null ? 'none' : metric.coverage })
    const left = withValue(leftAmounts.usd, paired.left); const right = withValue(rightAmounts.usd, paired.right)
    const derived = (value: number | null, unit: InsightMetric['unit']): InsightMetric => withValue(combinedMetric([left, right], unit), value, unit)
    return {
      query, included, excluded: query.goals.filter((goal) => !included.includes(goal)).map((goal) => ({ goal, reason: 'This Goal did not have a compatible complete measurement on both selected sides.' })),
      left: { ...leftAmounts, usd: left }, right: { ...rightAmounts, usd: right },
      leftPerGoalUsd: withValue(left, left.value === null || included.length === 0 ? null : left.value / included.length),
      rightPerGoalUsd: withValue(right, right.value === null || included.length === 0 ? null : right.value / included.length),
      differenceUsd: derived(left.value === null || right.value === null ? null : right.value - left.value, 'usd'),
      ratio: derived(left.value === null || right.value === null || left.value === 0 ? null : right.value / left.value, 'ratio'),
      sources: report.sources, generatedAt: report.generatedAt, reason: included.length === 0 ? 'Choose completed Goals with compatible complete recorded usage.' : null,
    }
  }

  async previewOrder(query: InsightOrderQuery): Promise<InsightOrderPreview> {
    if (query.agent !== query.left.agent || query.agent !== query.right.agent || query.origin !== query.left.origin || query.origin !== query.right.origin ||
      query.left.briefDigest === null || query.left.briefDigest !== query.right.briefDigest || query.left.seat === null || query.right.seat === null) {
      throw new Error('Choose two resolved Seats of one Agent with the same recorded brief.')
    }
    const report = await this.compare(query)
    const current = (await this.port.seating.read()).entries.find((entry) => entry.id === query.agent)?.seats ?? query.current ?? []
    const leftKey = JSON.stringify(query.left.seat); const rightKey = JSON.stringify(query.right.seat)
    const proposed = [...current]
    const leftAt = proposed.findIndex((seat) => JSON.stringify(seat) === leftKey); const rightAt = proposed.findIndex((seat) => JSON.stringify(seat) === rightKey)
    if (leftAt < 0 || rightAt < 0 || report.leftPerGoalUsd.value === null || report.rightPerGoalUsd.value === null || report.leftPerGoalUsd.value <= report.rightPerGoalUsd.value) {
      return { stamp: null, expiresAt: null, current, proposed, labels: current.map((seat) => seat.model ?? seat.runtime), report, reason: 'These seats are already in this order or cannot be compared from complete recorded usage.' }
    }
    ;[proposed[leftAt], proposed[rightAt]] = [proposed[rightAt]!, proposed[leftAt]!]
    const fingerprint = await this.port.seating.fingerprint(); const stamp = randomUUID()
    this.#stamps.set(stamp, {
      expiresAt: this.#now() + 5 * 60_000, fingerprint, agent: query.agent, proposed,
      query, reportFingerprint: comparisonFingerprint(report),
    })
    while (this.#stamps.size > 20) this.#stamps.delete(this.#stamps.keys().next().value!)
    return { stamp, expiresAt: this.#now() + 5 * 60_000, current, proposed, labels: current.map((seat) => seat.model ?? seat.runtime), report, reason: null }
  }

  async applyOrder(stamp: string): Promise<import('@harnessdesk/protocol').MachineSeating> {
    const saved = this.#stamps.get(stamp)
    if (!saved || saved.expiresAt <= this.#now()) throw new Error('This reviewed order expired. Refresh and try again.')
    const fresh = await this.compare(saved.query)
    if (comparisonFingerprint(fresh) !== saved.reportFingerprint) {
      this.#stamps.delete(stamp)
      throw new Error('Recorded usage changed while this order was being reviewed. Refresh and try again.')
    }
    const outcome = await this.port.seating.set(saved.agent, saved.proposed, { expectedTextHash: saved.fingerprint })
    this.#stamps.delete(stamp)
    return outcome.seating
  }
}
