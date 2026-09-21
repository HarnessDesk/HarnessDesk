import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import type {
  AgentOrigin, InsightAmounts, InsightComparison, InsightCompareQuery, InsightMetric, InsightOrderPreview, InsightOrderQuery,
  InsightQuery, InsightReport, InsightSelector, InsightSource, Measure, SeatRecord,
} from '@harnessdesk/protocol'

import type { MachineSeatingFile } from '../agent-seating-file.js'
import type { GoalPlane } from '../goals/plane.js'
import type { Ledger } from '../ledger/index.js'
import { seatFor, seatWindowOf } from './attribution.js'
import { pairedCosts } from './compare.js'
import { sumMeasures } from './measures.js'

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
  left: report.left.usd,
  right: report.right.usd,
  leftPerGoalUsd: report.leftPerGoalUsd,
  rightPerGoalUsd: report.rightPerGoalUsd,
  differenceUsd: report.differenceUsd,
  ratio: report.ratio,
  sources: report.sources.map((source) => ({ id: source.id, observedAt: source.observedAt, stale: source.stale, problem: source.problem })),
})).digest('hex')

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

  async usage(query: InsightQuery): Promise<InsightReport> {
    this.#range(query)
    const generatedAt = this.#now()
    const detail = await this.port.ledger().readInsight(query, { refresh: true })
    if (detail.samples.length === 0) return emptyReport(query.root, query.from, query.to, generatedAt)
    const allGoals = this.port.goals.store.list().map((document) => document.goal).filter((goal) => goal.root === query.root)
    const seats = this.port.seats().filter((seat) => seat.checkout.project === query.root)
    const total = amounts(detail.samples, detail.sources, detail.gaps)
    const bySeat = new Map<string, import('../ledger/insight.js').UsageSample[]>()
    const unattributed: import('../ledger/insight.js').UsageSample[] = []
    for (const sample of detail.samples) {
      const id = seatFor(sample, seats.map(seatWindowOf))
      if (!id) { unattributed.push(sample); continue }
      bySeat.set(id, [...(bySeat.get(id) ?? []), sample])
    }
    const sourceFor = (samples: readonly import('../ledger/insight.js').UsageSample[]) =>
      [...new Map(samples.map((sample) => [sample.source.id, sample.source])).values()]
    const seatRows = seats.map((seat) => row(
      `seat:${seat.id}`, seat.seatLabel, bySeat.get(seat.id) ?? [], sourceFor(bySeat.get(seat.id) ?? []), detail.gaps,
      { seat: seat.id, goal: seat.board, session: seat.session, message: null, note: seat.briefDigest ? 'Recorded brief cohort' : 'Brief cohort unavailable' },
    ))
    const goalRows = seats.flatMap((seat) => {
      if (!seat.board) return []
      const goal = allGoals.find((candidate) => candidate.id === seat.board)
      if (!goal) return []
      const samples = bySeat.get(seat.id) ?? []
      return [row(`goal:${goal.id}:seat:${seat.id}`, goal.sentence, samples, sourceFor(samples), detail.gaps, {
        seat: seat.id, goal: goal.id, session: seat.session, message: null, note: seat.agent?.name ?? 'Historical Seat',
      })]
    })
    const agentRows = [...new Map(seats.filter((seat) => seat.agent).map((seat) => [`${seat.agent!.origin}:${seat.agent!.id}`, seat.agent!] as const)).entries()].map(([key, agent]) => {
      const selected = seats.filter((seat) => seat.agent?.id === agent.id && seat.agent.origin === agent.origin).flatMap((seat) => bySeat.get(seat.id) ?? [])
      return row(`agent:${key}`, agent.name, selected, sourceFor(selected), detail.gaps, { seat: null, goal: null, session: null, message: null, note: 'Historical Agent Seats' })
    })
    const unallocated = amounts(unattributed, sourceFor(unattributed), detail.gaps)
    return {
      id: randomUUID(), generatedAt, query, goals: allGoals, seats, goal: null, receipt: null, totals: total, elapsedMs: total.activeMs,
      breakdowns: [
        { dimension: 'seat', rows: seatRows, unattributed: unallocated, reason: 'Recorded corpus rows without a unique historical Seat remain unattributed.' },
        { dimension: 'goal', rows: goalRows, unattributed: unallocated, reason: 'Not attributed to a Goal.' },
        { dimension: 'agent', rows: agentRows, unattributed: unallocated, reason: 'Recorded usage without a historical Agent Seat remains unassigned.' },
      ],
      sources: detail.sources, recordedSpend: [], provenance: { state: 'unavailable', note: 'Commit associations are unavailable; recorded usage is still shown.' }, gaps: detail.gaps,
    }
  }

  async goal(id: string): Promise<InsightReport> {
    const document = this.port.goals.store.read(id)
    const to = this.#now(); const from = Math.max(0, to - 90 * DAY)
    const report = await this.usage({ root: document.goal.root, from, to })
    const receipt = document.receipt
    const seatIds = new Set(receipt?.seats ?? [])
    return { ...report, goal: id, receipt: receipt?.id ?? null, goals: [document.goal], seats: this.port.seats().filter((seat) => seatIds.has(seat.id)),
      gaps: receipt ? report.gaps : [...report.gaps, 'This Goal is not wrapped; its history is so far, not a receipt.'] }
  }

  async agent(root: string | undefined, agent: string, origin: AgentOrigin): Promise<InsightReport> {
    const to = this.#now(); const from = to - 90 * DAY
    const projects = this.port.goals.store.list().map((document) => document.goal.root)
    const selectedRoot = root ?? projects[0]
    if (!selectedRoot) return emptyReport(null, from, to, to)
    const report = await this.usage({ root: selectedRoot, from, to })
    const seats = this.port.seats().filter((seat) => seat.agent?.id === agent && seat.agent.origin === origin && (root === undefined || seat.checkout.project === root))
    return { ...report, seats, gaps: seats.length === 0 ? [...report.gaps, 'No historical Seats were recorded for this Agent.'] : report.gaps }
  }

  async compare(query: InsightCompareQuery): Promise<InsightComparison> {
    this.#range(query)
    const report = await this.usage(query)
    const selected = report.breakdowns.find((breakdown) => breakdown.dimension === 'goal')?.rows ?? []
    const historical = new Map(report.seats.map((seat) => [seat.id, seat]))
    const metricFor = (goal: string, selector: InsightSelector): InsightMetric | null => {
      const found = selected.find((entry) => {
        if (entry.goal !== goal || entry.seat === null) return false
        const seat = historical.get(entry.seat)
        return seat?.agent?.id === selector.agent && seat.agent.origin === selector.origin
          && seat.briefDigest === selector.briefDigest && selector.seat !== null && seatKey(seat.seat) === seatKey(selector.seat)
      })
      return found?.amounts.usd ?? null
    }
    const rows: import('./compare.js').ComparableCost[] = query.goals.flatMap((goal) => (['left', 'right'] as const).map((side) => {
      const value = metricFor(goal, query[side])
      const basis: import('./compare.js').ComparableCost['basis'] = value?.basis === 'listPrice' || value?.basis === 'vendorMetered' || value?.basis === 'mixed' ? value.basis : 'unknown'
      return { goal, side, value: value?.value ?? null, basis, complete: value?.coverage === 'complete' }
    }))
    const paired = pairedCosts(rows)
    const included = paired.goals
    const sourceMetric = metricFor(included[0] ?? '', query.left) ?? report.totals.usd
    const copied = (value: number | null, unit: InsightMetric['unit']): InsightMetric => ({ ...sourceMetric, value, unit, quality: value === null ? 'unknown' : sourceMetric.quality, coverage: value === null ? 'none' : sourceMetric.coverage })
    const left = copied(paired.left, 'usd'); const right = copied(paired.right, 'usd')
    return {
      query, included, excluded: query.goals.filter((goal) => !included.includes(goal)).map((goal) => ({ goal, reason: 'This Goal did not have a compatible complete measurement on both selected sides.' })),
      left: { ...report.totals, usd: left }, right: { ...report.totals, usd: right },
      leftPerGoalUsd: copied(left.value === null || included.length === 0 ? null : left.value / included.length, 'usd'),
      rightPerGoalUsd: copied(right.value === null || included.length === 0 ? null : right.value / included.length, 'usd'),
      differenceUsd: copied(left.value === null || right.value === null ? null : right.value - left.value, 'usd'),
      ratio: copied(left.value === null || right.value === null || left.value === 0 ? null : right.value / left.value, 'ratio'),
      sources: report.sources, generatedAt: report.generatedAt, reason: included.length === 0 ? 'Choose completed Goals with compatible complete recorded usage.' : null,
    }
  }

  async previewOrder(query: InsightOrderQuery): Promise<InsightOrderPreview> {
    if (query.agent !== query.left.agent || query.agent !== query.right.agent || query.origin !== query.left.origin || query.origin !== query.right.origin ||
      query.left.briefDigest === null || query.left.briefDigest !== query.right.briefDigest || query.left.seat === null || query.right.seat === null) {
      throw new Error('Choose two resolved Seats of one Agent with the same recorded brief.')
    }
    const report = await this.compare(query)
    const current = (await this.port.seating.read()).entries.find((entry) => entry.id === query.agent)?.seats ?? []
    const leftKey = JSON.stringify(query.left.seat); const rightKey = JSON.stringify(query.right.seat)
    const proposed = [...current]
    const leftAt = proposed.findIndex((seat) => JSON.stringify(seat) === leftKey); const rightAt = proposed.findIndex((seat) => JSON.stringify(seat) === rightKey)
    if (leftAt < 0 || rightAt < 0 || report.leftPerGoalUsd.value === null || report.rightPerGoalUsd.value === null || report.leftPerGoalUsd.value <= report.rightPerGoalUsd.value) {
      return { stamp: null, expiresAt: null, current, proposed, labels: current.map((seat) => seat.runtime), report, reason: 'These seats are already in this order or cannot be compared from complete recorded usage.' }
    }
    ;[proposed[leftAt], proposed[rightAt]] = [proposed[rightAt]!, proposed[leftAt]!]
    const fingerprint = await this.port.seating.fingerprint(); const stamp = randomUUID()
    this.#stamps.set(stamp, {
      expiresAt: this.#now() + 5 * 60_000, fingerprint, agent: query.agent, proposed,
      query, reportFingerprint: comparisonFingerprint(report),
    })
    while (this.#stamps.size > 20) this.#stamps.delete(this.#stamps.keys().next().value!)
    return { stamp, expiresAt: this.#now() + 5 * 60_000, current, proposed, labels: proposed.map((seat) => seat.runtime), report, reason: null }
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
