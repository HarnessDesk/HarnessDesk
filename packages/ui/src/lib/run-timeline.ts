import { checkRetryRefusal, type BoardEvidence, type FindingRunView, type FindingView, type FlowCheckAttempt, type FlowExecution, type Intent, type TeamSignal } from '@harnessdesk/protocol'
import { lifecycleWords } from './findings'
import { reviewPublication, runPublication, type ReviewPublication } from './review-publication'
import { wordOf } from './agents'

/**
 * Plain-data contract for the later client/views move: runTimeline(input)
 * returns { header: RunHeader, rows: RunTimelineRow[] }. Stable row ids are
 * scoped to this Run; the inspector owns the selected id, never a DOM node.
 * Unknown times/results stay null. A check's earlier attempts come from a
 * separate read (`flow/check/attempts`), passed in as `attempts`.
 */
export interface RunHeader {
  run: string
  flow: string
  state: FlowExecution['state']
  needsYou: boolean
  publication: ReviewPublication | null
  revision: string | null
  continues: string | null
  end: FlowExecution['end']
  interruptedCheck: number | null
}
export interface RunTimelineRow {
  id: string
  kind: 'start' | 'brief' | 'round' | 'card' | 'check' | 'attempt' | 'person' | 'findings' | 'end'
  title: string
  detail: string | null
  round: number | null
  card: number | null
  seat: string | null
  status: string | null
  attention: boolean
  durationMs: number | null
  since: number | null
  working: boolean
  publication: ReviewPublication | null
  /**
   * A check row only: why the check cannot be run again from what its Run and
   * its operation say (`checkRetryRefusal`, the host's sentence), or null when
   * it may be asked. The host can still refuse for what only it sees, in the
   * consent dialog. Null on every other row, where it means nothing.
   */
  retryRefusal: string | null
}
export interface RunTimelineInput {
  execution: FlowExecution
  cards: readonly Intent[]
  signals?: readonly TeamSignal[]
  evidence?: BoardEvidence | null
  findings?: readonly FindingView[]
  origin?: string | null
  findingRun?: FindingRunView | null
  publicationOn?: boolean
  /** What the desk recorded each time a check card ran, by card: a check with more than one result draws each under it. */
  attempts?: ReadonlyMap<number, readonly FlowCheckAttempt[]>
  /** Cards whose readable evidence may omit earlier check results. */
  incompleteAttempts?: ReadonlySet<number>
}
const row = (id: string, kind: RunTimelineRow['kind'], title: string, rest: Partial<RunTimelineRow> = {}): RunTimelineRow => ({
  id, kind, title, detail: null, round: null, card: null, seat: null, status: null,
  attention: false, publication: null, durationMs: null, since: null, working: false, retryRefusal: null, ...rest,
})
const STANDARD_OUTCOMES = ['pass', 'fail', 'passed', 'failed']
/**
 * One result of a check in the words its row uses: the Flow's own word when the
 * Flow named one of its own (`no-pr`), and otherwise how the command ended.
 */
export const attemptWords = (attempt: Pick<FlowCheckAttempt, 'exit' | 'timedOut' | 'outcome'>): string =>
  !STANDARD_OUTCOMES.includes(attempt.outcome) ? wordOf(attempt.outcome)
    : attempt.timedOut ? 'Timed out' : attempt.exit === 0 ? 'Passed' : attempt.exit === null ? 'Did not finish' : 'Failed'
const terminal = (card: Intent): boolean => card.state === 'done' || card.state === 'abandoned'
const claimAt = (card: Intent, signals: readonly TeamSignal[]): number | null => card.claim?.at
  ?? [...signals].filter(one => one.intent === card.id && one.signal === 'claimed' && one.at <= card.updatedAt).sort((a, b) => b.at - a.at)[0]?.at ?? null
const endTitle = (execution: FlowExecution): string => {
  switch (execution.end?.kind) {
    case 'unrouted': return 'Ended without a next step'
    case 'budget': return execution.end.which === 'rounds' ? 'Round budget reached' : 'Rounds without progress reached'
    case 'complete': return 'Settled'
    case 'stopped': return execution.end.by === 'person' ? 'Stopped by you' : 'Stopped by the desk'
    default: return execution.state === 'stalled' ? 'Needs you' : execution.state === 'stopped' ? 'Stopped' : 'Settled'
  }
}
export function runTimeline(input: RunTimelineInput): { header: RunHeader; rows: RunTimelineRow[] } {
  const execution = input.execution
  const findingRun = input.findingRun?.run === execution.id && input.findingRun.goal === execution.goal ? input.findingRun : null
  const publication = runPublication(findingRun, input.publicationOn !== false)
  const needsYou = publication?.needsYou === true || execution.state === 'stalled' || execution.end?.kind === 'unrouted' || execution.end?.kind === 'budget'
  const header: RunHeader = { run: execution.id, flow: execution.document.flow.name, state: execution.state, needsYou, publication,
    revision: execution.revision ?? null, continues: execution.continues ?? null, end: execution.end,
    interruptedCheck: execution.state === 'stalled' ? execution.operations.find(one => one.kind === 'check' && one.state === 'uncertain')?.card ?? null : null }
  const rows: RunTimelineRow[] = [row('start', 'start', 'Start', { detail: input.origin ?? null, since: execution.startedAt ?? null })]
  if (execution.brief) rows.push(row('brief', 'brief', 'Brief', { detail: execution.brief }))
  for (const round of [...execution.rounds].sort((a, b) => a.n - b.n)) {
    const cards = round.cards.map(id => input.cards.find(one => one.id === id))
    const finished = cards.filter(one => one && terminal(one)).length
    const starts = cards.flatMap(one => { const at = one ? claimAt(one, input.signals ?? []) : null; return at === null ? [] : [at] })
    const since = starts.length === cards.length && starts.length ? Math.min(...starts) : null
    const durationMs = round.state === 'closed' && since !== null && cards.every(Boolean)
      ? Math.max(0, Math.max(...cards.map(one => one!.updatedAt)) - since) : null
    rows.push(row(`round-${round.n}`, 'round', `Round ${round.n} · ${round.role}`, {
      round: round.n, detail: `${finished} of ${round.cards.length} answered`, durationMs,
    }))
    const roundFindings = (input.findings ?? []).filter(one => one.origin.run === execution.id && one.origin.round === round.n)
    const recorded = findingRun?.rounds.find(one => one.round === round.n)
    const roundPublication = recorded ? reviewPublication({ state: recorded.state,
      pr: recorded.state === 'local' ? findingRun?.boundPr?.pr ?? null : recorded.pr,
      postingOn: input.publicationOn !== false, hasFindings: recorded.state !== 'none' }) : null
    const role = execution.document.flow.roles.find(one => one.id === round.role)
    round.cards.forEach((id, index) => {
      const card = cards[index]
      if (!card) { rows.push(row(`card-${round.n}-${id}`, 'card', `#${id} · Card unavailable`, { round: round.n, card: id })); return }
      const since = claimAt(card, input.signals ?? [])
      const durationMs = terminal(card) && since !== null ? Math.max(0, card.updatedAt - since) : null
      const operation = [...execution.operations].reverse().find(one => one.kind === 'check' && one.card === id)
      const uncertain = role?.kind === 'check' && operation?.state === 'uncertain'
      const working = role?.kind === 'check' ? operation?.state === 'started' : card.state === 'claimed'
      const outcome = card.outcome == null ? null : wordOf(card.outcome)
      let status: string = outcome ?? (working ? 'Working' : card.state === 'done' ? 'Done' : card.state === 'abandoned' ? 'Abandoned' : card.state === 'blocked' ? 'Blocked' : 'Waiting')
      let title = `#${id} · ${card.title}`
      let kind: RunTimelineRow['kind'] = 'card'
      const personWaiting = role?.kind === 'person' && (execution.state === 'running' || execution.state === 'stalled') && round.state !== 'closed'
        && (card.state === 'open' || card.state === 'claimed' || (card.blockedBy === 'hand' && Boolean(card.blockedReason?.trim())))
      if (role?.kind === 'person') { kind = 'person'; if (personWaiting) status = 'Needs you' }
      let retryRefusal: string | null = null
      if (role?.kind === 'check') {
        kind = 'check'
        title = role.check?.run ?? card.title
        retryRefusal = checkRetryRefusal(execution.state, operation?.state ?? null)
        const result = input.evidence?.cards.find(one => one.card === id)?.facts
          .map(one => one.record).filter(one => one.round === round.n && one.fact.kind === 'check' && one.fact.name === round.role && one.fact.run === title)
          .sort((a, b) => b.observedAt - a.observedAt)[0]?.fact
        status = uncertain ? 'Needs you' : working ? 'Working' : result?.kind === 'check'
          ? attemptWords({ exit: result.exit, timedOut: result.timedOut, outcome: card.outcome ?? 'pass' }) : outcome ?? 'Result unavailable'
      }
      const attention = uncertain || personWaiting || (execution.end?.kind === 'unrouted' && execution.end.card === id)
      rows.push(row(`${kind}-${round.n}-${id}`, kind, title, { round: round.n, card: id,
        seat: [...execution.operations].reverse().find(one => one.kind === 'seat' && one.card === id && one.seat !== null)?.seat ?? null,
        status, attention, durationMs, since, working, publication: recorded?.cards.includes(id) ? roundPublication : null, retryRefusal }))
      // The check row says the latest result; once it has run more than once, each result is drawn under it.
      const results = kind === 'check' ? input.attempts?.get(id) ?? [] : []
      // A skipped evidence line may hide an earlier result. Show those results
      // in the inspector without claiming the readable subset's ordinals.
      if (results.length > 1 && !input.incompleteAttempts?.has(id) && results.every(one => one.n !== null)) for (const one of results) rows.push(row(`attempt-${round.n}-${id}-${one.n}`, 'attempt', `Attempt ${one.n}`, { round: round.n, card: id, status: attemptWords(one), since: one.at }))
    })
    const findings = roundFindings
    if (findings.length) rows.push(row(`findings-${round.n}`, 'findings', `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}`, {
      round: round.n, publication: roundPublication, detail: findings.map(one => `${one.title} · ${lifecycleWords(one)}${one.problem ? ` · ${one.problem}` : ''}`).join('\n'),
    }))
  }
  if (execution.state !== 'running') {
    const end = execution.end
    const detail = end?.kind === 'complete' ? 'Nothing waits.'
      : end?.kind === 'budget' ? `${execution.reason ?? ''}${execution.reason ? '\n' : ''}${end.used} round${end.used === 1 ? '' : 's'} ${end.which === 'rounds' ? 'used' : 'without progress'}.`
        : execution.reason ?? (end?.kind === 'unrouted' ? `Card #${end.card} answered ${wordOf(end.outcome)}; no rule follows it.` : publication?.needsYou ? findingRun?.reason ?? null : null)
    rows.push(row('end', 'end', endTitle(execution), { detail, publication, attention: needsYou, since: execution.endedAt ?? null }))
  }
  return { header, rows }
}
