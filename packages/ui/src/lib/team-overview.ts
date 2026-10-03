/**
 * Portable Overview contract (also the contract for the later client selector):
 * SeatState = 'needs-you' | 'unread' | 'working' | 'idle'.
 * SeatRow = { seat, name, role, card: { id, title } | null, round, state, done,
 *             reason, doing, since, cost: { unit: 'money' | 'turns', value, estimated } | null }.
 * NeedsYouItem = { kind: 'card' | 'question' | 'approval', seat, card, summary, since }.
 * RunStrip = { run, state: 'running' | 'settled' | 'stopped' | 'stalled', round,
 *              role, startedAt: number | null, reviewRounds: { used, of } | null, total: { money, turns } }.
 * teamOverview(TeamOverviewInput) -> { run: RunStrip | null, needsYou: NeedsYouItem[], seats: SeatRow[] }.
 * doingLine(DoingLine | null, string | null, epochMilliseconds) -> DoingLine { line, at }.
 * Nullable facts stay null. All timestamps are epoch milliseconds. No store,
 * clock, component, DOM or mutable cache is read here. Names are supplied from
 * the seat's nickname or RuntimeInfo.presentation. Unread marks belong to the
 * window. The caller supplies the run's start time: FlowExecution has none.
 * InsightMetric.basis carries rate provenance; quality/coverage qualify it.
 * Channel signals retain hand-block ownership when a release clears a claim.
 * Historical seat money uses supplied runtime capabilities; unknown metering
 * stays unknown. Run turns use the Team total, money only eligible seat rows.
 * Text remains plain data; consumers render agent text through sanitize.ts.
 */
import {
  currentTurn,
  isBusy,
  type AgentItem,
  type Approval,
  type FlowExecution,
  type InsightMetric,
  type InsightReport,
  type Intent,
  type RuntimeCapabilities,
  type SeatRecord,
  type Session,
  type TeamSignal,
} from '@harnessdesk/protocol'

import { PATH_KEYS, shellCommandOf, toolCallVerb } from './group-items'
import { bareToolName, toolSentence } from './tool-names'

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
  cost: { unit: 'money' | 'turns'; value: number; estimated: boolean } | null
}

export interface NeedsYouItem {
  kind: 'card' | 'question' | 'approval'
  seat: string | null
  card: number | null
  summary: string
  since: number
}

export interface RunStrip {
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
  readonly unreadSince: number | null
  readonly approvals: readonly Approval[]
}

export interface TeamOverviewInput {
  readonly team: string
  readonly seats: readonly TeamOverviewSeat[]
  readonly cards: readonly Intent[]
  readonly run: { readonly execution: FlowExecution; readonly startedAt: number | null } | null
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

const costOf = (input: TeamOverviewInput, seat: TeamOverviewSeat): SeatRow['cost'] => {
  const amounts = input.report?.breakdowns.find((one) => one.dimension === 'seat')?.rows.find(
    (row) => row.seat === seat.record.id && row.goal === input.team,
  )?.amounts
  if (!amounts) return null
  const capabilities = seat.runtime?.capabilities ?? input.runtimeCapabilities?.get(seat.record.session.runtime)
  const money = moneyOf(amounts.usd, capabilities?.metered)
  if (money !== null) {
    return { unit: 'money', value: money, estimated: estimated(amounts.usd) }
  }
  const turns = observed(amounts.turns)
  return turns === null ? null : { unit: 'turns', value: turns, estimated: estimated(amounts.turns) }
}

/** A path is the only argument the overview may repeat. Reject prose and shell syntax. */
const safePath = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value || !/^[\w./\\-]+$/.test(value) || value.startsWith('//') || value.startsWith('\\\\')) return null
  return value
}

/** Summarise the action, never the transcript's command/query/description/result. */
const toolLine = (item: AgentItem, sentences: ReadonlyMap<string, string>): string | null => {
  // These sentences go through the same lookup as the transcript, without its command detail.
  const generic = (tool: string, sentence: string): string => toolSentence(tool, new Map([[tool, sentence]]))
  if (item.type === 'command') return generic('command', 'Running a command')
  if (item.type === 'webSearch') return generic('web_search', 'Searching the web')
  if (item.type === 'fileChange') {
    const path = safePath(item.changes[0]?.path)
    return path ? toolSentence('edit', sentences, { kind: 'fileChange', target: path }) : generic('edit', 'Editing files')
  }
  if (item.type !== 'toolCall') return null
  const bare = bareToolName(item.tool)
  const call = { ...item, tool: bare }
  const verb = toolCallVerb(call)
  if (verb === 'command' || shellCommandOf(item) !== null ||
      /^(?:exec_command|write_stdin|execute_command|run_terminal_cmd|bash|shell|terminal|exec|command)$/.test(bare)) {
    return generic('command', 'Running a command')
  }
  const args = typeof item.args === 'object' && item.args !== null && !Array.isArray(item.args)
    ? item.args as Record<string, unknown> : null
  // An ACP title may be "Read src/file.ts". Only recognised file verbs may
  // contribute a target; arbitrary titles (including shell commands) never do.
  const phrase = /^(Read|Edit|Write|Create)\s+(.+)$/i.exec(item.tool)
  const target = safePath(args && PATH_KEYS.map((key) => args[key]).find((value) => typeof value === 'string')) ?? safePath(phrase?.[2])
  if (verb === 'read' || /^read$/i.test(bare) || phrase?.[1]?.toLowerCase() === 'read') {
    return target ? toolSentence('read', sentences, { kind: 'read', target }) : generic('read', 'Reading a file')
  }
  if (verb === 'fileChange' || (phrase && phrase[1]?.toLowerCase() !== 'read')) {
    return target ? toolSentence(phrase?.[1] ?? bare, sentences, { kind: 'fileChange', target }) : generic('edit', 'Editing a file')
  }
  if (verb === 'search') return generic('search', 'Searching files')
  // toolSentence deliberately preserves phrases. Never give it an untrusted
  // title as a fallback here; only a wire identifier can become words.
  if (!/^[a-z][a-z0-9_-]*$/i.test(bare)) return generic('tool', 'Using a tool')
  const sentence = toolSentence(bare, sentences)
  return /[\n\r\x00-\x1f<>`$=]|:\/\//.test(sentence) ? generic('tool', 'Using a tool') : sentence
}

const approvalWords = (request: Approval): string => {
  switch (request.type) {
    case 'userInput': return request.questions.map((one) => one.question).join(' · ') || 'Answer a question'
    case 'elicitation': return request.message
    case 'permission': return request.summary
    case 'command': return 'Approve a command'
    case 'fileChange': return 'Approve file changes'
  }
}

export function teamOverview(input: TeamOverviewInput): { run: RunStrip | null; needsYou: NeedsYouItem[]; seats: SeatRow[] } {
  const execution = input.run?.execution.goal === input.team ? input.run.execution : null
  const rounds = execution?.rounds ?? []
  const activeCards = input.cards.filter((card) => card.state !== 'done' && card.state !== 'abandoned').sort((a, b) => a.id - b.id)
  const ownerOf = (card: Intent): TeamOverviewSeat | undefined => {
    if (card.claim) return input.seats.find((seat) =>
      seat.record.session.runtime === card.claim?.runtime && seat.record.session.sessionId === card.claim?.sessionId)
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
    const turn = session ? currentTurn(session) : undefined
    const waits: NeedsYouItem[] = seat.approvals.filter((request) => request.sessionId === seat.record.session.sessionId).map((request) => ({
      kind: request.type === 'userInput' || request.type === 'elicitation' ? 'question' : 'approval',
      seat: seat.record.id, card: card?.id ?? null, summary: approvalWords(request), since: request.requestedAt,
    }))
    needsYou.push(...waits)
    waits.push(...needsYou.filter((one) => one.kind === 'card' && one.seat === seat.record.id))
    waits.sort((a, b) => a.since - b.since)
    const waiting = waits[0]
    const blocked = card?.state === 'blocked' && card.blockedBy === 'hand' && card.blockedReason?.trim() ? card : null
    const busy = session ? isBusy(session) : false
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
    const latest = turn?.status === 'inProgress' ? [...turn.items].reverse().find((item) =>
      'status' in item && item.status === 'inProgress' && ['command', 'toolCall', 'fileChange', 'webSearch'].includes(item.type)) : undefined
    const held = input.cards.filter(one => ownerOf(one)?.record.id === seat.record.id)
    const done = state === 'idle' && held.length > 0 && held.every(one => one.state === 'done')
    return {
      done,
      seat: seat.record.id, name: seat.name, role: card?.role ?? round?.role ?? seat.record.role,
      card: card ? { id: card.id, title: card.title + (dependencies.length ? ` · after ${dependencies.map((id) => `#${id}`).join(', ')}` : '') } : null,
      round: round?.n ?? null, state, reason: blocked?.blockedReason ?? waiting?.summary ?? null,
      doing: latest ? toolLine(latest, sentences) : null,
      since: state === 'needs-you' ? waiting?.since ?? blocked?.updatedAt ?? null
        : state === 'unread' ? seat.unreadSince
          : state === 'working' ? busy ? turn?.startedAt ?? card?.claim?.at ?? null : card?.claim?.at ?? null
            : card?.state === 'blocked' ? card.updatedAt : turn?.completedAt ?? seat.record.openedAt,
      cost: costOf(input, seat),
    }
  })
  const precedence: Readonly<Record<SeatState, number>> = { 'needs-you': 0, unread: 1, working: 2, idle: 3 }
  seats.sort((a, b) => precedence[a.state] - precedence[b.state] || (a.card?.id ?? Infinity) - (b.card?.id ?? Infinity))
  needsYou.sort((a, b) => a.since - b.since || (a.card ?? Infinity) - (b.card ?? Infinity))
  const lastRound = rounds.at(-1)
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
  const run: RunStrip | null = execution && input.run ? {
    run: execution.id, state: execution.state, round: lastRound?.n ?? null, role: lastRound?.role ?? null,
    startedAt: input.run.startedAt,
    reviewRounds: execution.findings ? {
      used: execution.findings.closedRounds.length,
      of: Math.max(execution.findings.budget.rounds, execution.findings.extraRound
        ? execution.findings.extraRound.after + (execution.findings.extraRound.count ?? 1) : 0),
    } : null,
    total: { money, turns: totals ? observed(totals.turns) : null },
  } : null
  return { run, needsYou, seats }
}
