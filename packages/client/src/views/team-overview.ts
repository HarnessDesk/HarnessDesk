/**
 * Portable Overview contract (also the contract for the later client selector):
 * SeatState = 'needs-you' | 'unread' | 'working' | 'idle'.
 * SeatRow = { seat, name, role, card: { id, title } | null, round, state, done,
 *             reason, doing, since, durationMs, cost: { unit: 'money' | 'turns', value, estimated } | null }.
 * NeedsYouItem = { kind: 'card' | 'question' | 'approval', seat, card, summary, since,
 *                  approval?: the open request's id, on a question or an approval }.
 * RunStrip = { run, state: 'running' | 'settled' | 'stopped' | 'stalled', round,
 *              role, startedAt: number | null, reviewRounds: { used, of } | null, total: { money, turns } }.
 * teamOverview(TeamOverviewInput) -> { run: RunStrip | null, needsYou: NeedsYouItem[], seats: SeatRow[] }.
 * doingLine(DoingLine | null, string | null, epochMilliseconds) -> DoingLine { line, at }.
 * Nullable facts stay null. All timestamps are epoch milliseconds. No store,
 * clock, component, DOM or mutable cache is read here. Names are supplied from
 * the seat's nickname or RuntimeInfo.presentation. Unread marks belong to the
 * window. The caller still supplies the run's start time.
 * InsightMetric.basis carries rate provenance; quality/coverage qualify it.
 * Channel signals retain hand-block and completion ownership after claims clear.
 * Historical seat money uses supplied runtime capabilities; unknown metering
 * stays unknown. Run turns use the Team total, money only eligible seat rows.
 * Text remains plain data; consumers render agent text through sanitize.ts.
 */
import {
  currentTurn,
  doingSentence,
  inFlightItem,
  seatDoing,
  isBusy,
  type AgentItem,
  type Approval,
  type ApprovalId,
  type FlowExecution,
  type FindingRunView,
  type InsightMetric,
  type InsightReport,
  type Intent,
  type RuntimeCapabilities,
  type SeatRecord,
  type SeatActivity,
  type Session,
  type SessionKey,
  type TeamSignal,
  sessionKey,
} from '@harnessdesk/protocol'
import { runNeedsAttention, waitingForEvidence, waitingForFindings } from './run-attention.js'

export type SeatState = 'needs-you' | 'unread' | 'working' | 'idle'

export interface SeatRow {
  seat: string
  name: string
  role: string | null
  card: { id: number; title: string } | null
  round: number | null
  state: SeatState
  done: boolean
  reason: string | null
  doing: string | null
  since: number | null
  /** Fixed first-claim (or first turn) to last completed-turn duration; unknown stays null. */
  durationMs?: number | null
  cost: { unit: 'money' | 'turns'; value: number; estimated: boolean } | null
}

export interface NeedsYouItem {
  kind: 'card' | 'question' | 'approval'
  seat: string | null
  card: number | null
  summary: string
  since: number
  /** The open request a question or an approval is, so an answer reaches that one and not another asked in the same instant. Absent on a card. */
  approval?: ApprovalId
  /** The conversation that owns the request; approval ids are only unique within that conversation. */
  sessionKey?: SessionKey
}

export interface RunStrip {
  /** Publication is shown only after this Run has been read, never inferred from execution. */
  findingRun?: FindingRunView | null
  publicationOn?: boolean
  needsYou?: boolean
  waitingEvidence?: boolean
  waitingFindings?: boolean
  run: string
  state: 'running' | 'settled' | 'stopped' | 'stalled'
  round: number | null
  role: string | null
  startedAt: number | null
  reviewRounds: { used: number; of: number } | null
  total: { money: number | null; turns: number | null }
}

/** One seat's already-held facts, grouped by its full runtime/session identity. */
export interface TeamOverviewSeat {
  readonly record: Pick<SeatRecord, 'id' | 'session' | 'role' | 'openedAt'>
  readonly name: string
  readonly runtime: { readonly capabilities: Pick<RuntimeCapabilities, 'metered'> } | null
  readonly session: Session | null
  readonly activity?: SeatActivity | null
  readonly unreadSince: number | null
  readonly approvals: readonly Approval[]
}

export interface TeamOverviewInput {
  readonly team: string
  readonly seats: readonly TeamOverviewSeat[]
  readonly cards: readonly Intent[]
  readonly run: { readonly execution: FlowExecution; readonly startedAt: number | null } | null
  readonly findingRun?: FindingRunView | null
  readonly publicationOn?: boolean
  readonly report: InsightReport | null
  /** Held channel signals in append order, including card lifecycle transitions. */
  readonly signals?: readonly TeamSignal[]
  /** Runtime facts, including historical Seats no longer in the window's roster. */
  readonly runtimeCapabilities?: ReadonlyMap<string, Pick<RuntimeCapabilities, 'metered'>>
  readonly toolSentences?: ReadonlyMap<string, string>
}

export interface DoingLine {
  readonly line: string | null
  /** When the displayed line changed, rather than when it was last read. */
  readonly at: number
}

export function doingLine(previous: DoingLine | null, next: string | null, now: number): DoingLine {
  if (previous && (previous.line === next || now - previous.at < 2500)) return previous
  return { line: next, at: now }
}

const observed = (metric: InsightMetric): number | null =>
  metric.coverage !== 'none' && metric.quality !== 'unknown' ? metric.value : null

const hasRate = (metric: InsightMetric): boolean =>
  metric.basis === 'listPrice' || metric.basis === 'vendorMetered' || metric.basis === 'mixed'

const estimated = (metric: InsightMetric): boolean =>
  metric.quality === 'estimate' || metric.quality === 'floor' || metric.coverage === 'partial' ||
  metric.basis === 'listPrice' || metric.basis === 'mixed'

const moneyOf = (metric: InsightMetric, metered: boolean | undefined): number | null =>
  metered === true && hasRate(metric) ? observed(metric) : null

/** Recorded usage belongs to a Seat even when its receipt kept no conversation to open. */
export const teamSeatCost = (input: Pick<TeamOverviewInput, 'team' | 'report'>, seat: string, metered: boolean | undefined): SeatRow['cost'] => {
  const amounts = input.report?.breakdowns.find((one) => one.dimension === 'seat')?.rows.find(
    (row) => row.seat === seat && row.goal === input.team,
  )?.amounts
  if (!amounts) return null
  const money = moneyOf(amounts.usd, metered)
  if (money !== null) {
    return { unit: 'money', value: money, estimated: estimated(amounts.usd) }
  }
  const turns = observed(amounts.turns)
  return turns === null ? null : { unit: 'turns', value: turns, estimated: estimated(amounts.turns) }
}

/** Summarise the action with the shared structured derivation and wording. */
const toolLine = (item: AgentItem, sentences: ReadonlyMap<string, string>): string =>
  doingSentence(seatDoing(item), sentences)

const approvalWords = (request: Approval): string => {
  switch (request.type) {
    case 'userInput': return request.questions.map((one) => one.question).join(' · ') || 'Answer a question'
    case 'elicitation': return request.message
    case 'permission': return request.summary
    case 'command': return 'Approve a command'
    case 'fileChange': return 'Approve file changes'
  }
}

/** The same Team-scoped usage applies whether or not it has a Run. */
export function teamTotals(input: TeamOverviewInput): RunStrip['total'] {
  const totals = input.report?.goal === input.team ? input.report.totals : null
  let money: number | null = null
  if (totals) {
    // Only one partition contributes. Report totals can include list prices
    // for subscription accounts, which are turns in the Overview.
    for (const row of input.report?.breakdowns.find((one) => one.dimension === 'seat')?.rows ?? []) {
      if (row.goal !== input.team || row.seat === null) continue
      const seat = input.seats.find((one) => one.record.id === row.seat)
      const runtime = row.session?.runtime ?? seat?.record.session.runtime ??
        input.report?.seats.find((one) => one.id === row.seat)?.session.runtime
      const capabilities = seat?.runtime?.capabilities ?? (runtime ? input.runtimeCapabilities?.get(runtime) : undefined)
      const value = moneyOf(row.amounts.usd, capabilities?.metered)
      if (value !== null) money = (money ?? 0) + value
    }
  }
  return { money, turns: totals ? observed(totals.turns) : null }
}

export function teamOverview(input: TeamOverviewInput): { run: RunStrip | null; needsYou: NeedsYouItem[]; seats: SeatRow[] } {
  const execution = input.run?.execution.goal === input.team ? input.run.execution : null
  const rounds = execution?.rounds ?? []
  const activeCards = input.cards.filter((card) => card.state !== 'done' && card.state !== 'abandoned').sort((a, b) => a.id - b.id)
  const ownerOf = (card: Intent): TeamOverviewSeat | undefined => {
    if (card.claim) return input.seats.find((seat) =>
      seat.record.session.runtime === card.claim?.runtime && seat.record.session.sessionId === card.claim?.sessionId)
    if (card.state === 'done') {
      // Completion clears the claim, including on manual cards and earlier
      // Runs whose seat/card journal is not the current Run's. Metadata writes
      // and refused claims do not supersede the completing actor.
      const signal = [...(input.signals ?? [])].reverse().find((one) =>
        one.intent === card.id && one.signal !== 'conflict')
      if (signal && signal.signal !== 'completed') return undefined
      const actor = signal?.by
      if (actor?.kind === 'agent') return input.seats.find((seat) =>
        seat.record.session.runtime === actor.runtime && seat.record.session.sessionId === actor.sessionId)
    }
    if (card.state === 'blocked' && card.blockedBy === 'hand') {
      // Stop capture and other metadata writes advance updatedAt without
      // changing the block. Only a later lifecycle transition supersedes it;
      // a refused claim's conflict signal does not change card ownership.
      const signal = [...(input.signals ?? [])].reverse().find((one) =>
        one.intent === card.id && one.signal !== 'conflict')
      if (signal && signal.signal !== 'blocked') return undefined
      const actor = signal?.by
      if (actor?.kind === 'agent') return input.seats.find((seat) =>
        seat.record.session.runtime === actor.runtime && seat.record.session.sessionId === actor.sessionId)
    }
    // Blocking clears the claim. The run's explicit seat/card journal retains
    // attribution; round.seats is not zipped to cards (recovery can reorder it).
    const opening = execution ? [...execution.operations].reverse().find((operation) => operation.kind === 'seat' && operation.card === card.id && operation.seat !== null) : undefined
    return opening ? input.seats.find((seat) => seat.record.id === opening.seat) : undefined
  }
  const personRoles = new Set(execution?.document.flow.roles.filter((role) => role.kind === 'person').map((role) => role.id) ?? [])
  const personCards = activeCards.filter((card) => (execution?.state === 'running' || execution?.state === 'stalled') &&
    card.role && personRoles.has(card.role) && rounds.some((round) =>
      round.state !== 'closed' && round.role === card.role && round.cards.includes(card.id)) &&
    (card.state === 'open' || card.state === 'claimed' || (card.blockedBy === 'hand' && Boolean(card.blockedReason?.trim()))))
  const needsYou: NeedsYouItem[] = personCards.map((card) => ({
    kind: 'card', seat: ownerOf(card)?.record.id ?? null, card: card.id, summary: card.title, since: card.updatedAt,
  }))
  const sentences = input.toolSentences ?? new Map<string, string>()
  const seats: SeatRow[] = input.seats.map((seat) => {
    const card = activeCards.find((one) => ownerOf(one)?.record.id === seat.record.id) ?? null
    const session = seat.session?.runtime === seat.record.session.runtime && seat.session.id === seat.record.session.sessionId ? seat.session : null
    const activity = session ? null : seat.activity
    const turn = session ? currentTurn(session) : undefined
    const waits: NeedsYouItem[] = seat.approvals.filter((request) => request.sessionId === seat.record.session.sessionId).map((request) => ({
      kind: request.type === 'userInput' || request.type === 'elicitation' ? 'question' : 'approval',
      seat: seat.record.id, card: card?.id ?? null, summary: approvalWords(request), since: request.requestedAt,
      approval: request.id, sessionKey: sessionKey(seat.record.session.runtime, seat.record.session.sessionId),
    }))
    needsYou.push(...waits)
    waits.push(...needsYou.filter((one) => one.kind === 'card' && one.seat === seat.record.id))
    waits.sort((a, b) => a.since - b.since)
    const waiting = waits[0]
    const blocked = card?.state === 'blocked' && card.blockedBy === 'hand' && card.blockedReason?.trim() ? card : null
    const busy = session ? isBusy(session) : activity?.state === 'working'
    const state: SeatState = waiting || blocked ? 'needs-you'
      : seat.unreadSince !== null ? 'unread'
        : busy || card?.state === 'claimed' ? 'working' : 'idle'
    const round = [...rounds].reverse().find((one) => card ? one.cards.includes(card.id) : one.seats.includes(seat.record.id))
    const dependencies = card?.blockedBy === 'graph' ? card.dependsOn.filter((id) => {
      const dependency = input.cards.find((one) => one.id === id)
      // The board treats trimmed rows as settled, but dropping a dependency
      // does not finish it (Team#unblock uses exactly this rule).
      return dependency !== undefined && dependency.state !== 'done'
    }) : []
    const latest = session ? inFlightItem(session) : undefined
    const held = input.cards.filter(one => ownerOf(one)?.record.id === seat.record.id)
    const done = state === 'idle' && held.length > 0 && held.every(one => one.state === 'done')
    const claims = (input.signals ?? []).filter(one => one.signal === 'claimed' && one.at >= seat.record.openedAt &&
      one.by.kind === 'agent' && one.by.runtime === seat.record.session.runtime && one.by.sessionId === seat.record.session.sessionId)
      .map(one => one.at)
    const turns = session?.turns.filter(one => typeof one.startedAt === 'number' && one.startedAt >= seat.record.openedAt) ?? []
    const starts = claims.length ? claims : turns.flatMap(one => typeof one.startedAt === 'number' ? [one.startedAt] : [])
    const ends = turns.flatMap(one => one.completedAt === null || one.completedAt === undefined ? [] : [one.completedAt])
    const durationMs = done && starts.length && ends.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : null

    return {
      done, durationMs,
      seat: seat.record.id, name: seat.name, role: card?.role ?? round?.role ?? seat.record.role,
      card: card ? { id: card.id, title: card.title + (dependencies.length ? ` · after ${dependencies.map((id) => `#${id}`).join(', ')}` : '') } : null,
      round: round?.n ?? null, state, reason: blocked?.blockedReason ?? waiting?.summary ?? null,
      doing: latest ? toolLine(latest, sentences) : activity?.doing?.kind === 'tool' ? doingSentence(activity.doing, sentences) : null,
      since: state === 'needs-you' ? waiting?.since ?? blocked?.updatedAt ?? null
        : state === 'unread' ? seat.unreadSince
          : state === 'working' ? busy ? turn?.startedAt ?? activity?.since ?? card?.claim?.at ?? null : card?.claim?.at ?? null
            : card?.state === 'blocked' ? card.updatedAt : turn?.completedAt ?? seat.record.openedAt,
      cost: teamSeatCost(input, seat.record.id, (seat.runtime?.capabilities ?? input.runtimeCapabilities?.get(seat.record.session.runtime))?.metered),
    }
  })
  const precedence: Readonly<Record<SeatState, number>> = { 'needs-you': 0, unread: 1, working: 2, idle: 3 }
  seats.sort((a, b) => precedence[a.state] - precedence[b.state] || (a.card?.id ?? Infinity) - (b.card?.id ?? Infinity))
  needsYou.sort((a, b) => a.since - b.since || (a.card ?? Infinity) - (b.card ?? Infinity))
  const lastRound = rounds.at(-1)
  const total = teamTotals(input)
  const findingRun = input.findingRun?.run === execution?.id && input.findingRun?.goal === input.team ? input.findingRun : null
  const reviewNeedsYou = findingRun && (findingRun.publication === 'partial' || findingRun.publication === 'uncertain'
    || (findingRun.publication === 'local' && findingRun.boundPr !== null && input.publicationOn !== false
      && findingRun.rounds.some(round => round.state !== 'none')))
  const run: RunStrip | null = execution && input.run ? {
    run: execution.id, state: execution.state, round: lastRound?.n ?? null, role: lastRound?.role ?? null,
    startedAt: input.run.startedAt,
    waitingEvidence: waitingForEvidence(execution),
    waitingFindings: waitingForFindings(execution),
    needsYou: runNeedsAttention(execution, Boolean(reviewNeedsYou)),
    ...(findingRun ? { findingRun, publicationOn: input.publicationOn !== false } : {}),
    reviewRounds: execution.findings ? {
      used: execution.findings.closedRounds.length,
      of: Math.max(execution.findings.budget.rounds, execution.findings.extraRound
        ? execution.findings.extraRound.after + (execution.findings.extraRound.count ?? 1) : 0),
    } : null,
    total,
  } : null
  return { run, needsYou, seats }
}
