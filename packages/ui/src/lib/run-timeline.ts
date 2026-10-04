import { currentTurn, isBusy, sessionKey, type BoardEvidence, type FindingView, type FlowExecution, type Intent, type Session, type SessionKey, type TeamSignal } from '@harnessdesk/protocol'
import { lifecycleWords } from './findings'
import { wordOf } from './agents'

/**
 * Plain-data contract for the later client/views move: runTimeline(input)
 * returns { header: RunHeader, rows: RunTimelineRow[] }. Stable row ids are
 * scoped to this Run; the inspector owns the selected id, never a DOM node.
 * Unknown times/results stay null. Check history requires a separate read.
 */
export interface RunHeader {
  run: string
  flow: string
  state: FlowExecution['state']
  needsYou: boolean
  revision: string | null
  continues: string | null
}
export interface RunTimelineRow {
  id: string
  kind: 'start' | 'brief' | 'round' | 'card' | 'check' | 'person' | 'findings' | 'end'
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
}
export interface RunTimelineInput {
  execution: FlowExecution
  cards: readonly Intent[]
  /** Live conversations qualify a retained claim after the Run ends. */
  sessions?: ReadonlyMap<SessionKey, Session> | undefined
  signals?: readonly TeamSignal[]
  evidence?: BoardEvidence | null
  findings?: readonly FindingView[]
  origin?: string | null
}
const row = (id: string, kind: RunTimelineRow['kind'], title: string, rest: Partial<RunTimelineRow> = {}): RunTimelineRow => ({
  id, kind, title, detail: null, round: null, card: null, seat: null, status: null,
  attention: false, durationMs: null, since: null, working: false, ...rest,
})
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
  const endedAt = execution.state !== 'running' ? execution.currentEndedAt ?? null : null
  const needsYou = execution.state === 'stalled' || execution.end?.kind === 'unrouted' || execution.end?.kind === 'budget'
  const header: RunHeader = { run: execution.id, flow: execution.document.flow.name, state: execution.state, needsYou,
    revision: execution.revision ?? null, continues: execution.continues ?? null }
  const rows: RunTimelineRow[] = [row('start', 'start', 'Start', { detail: input.origin ?? null, since: execution.startedAt ?? null })]
  if (execution.brief) rows.push(row('brief', 'brief', 'Brief', { detail: execution.brief }))
  for (const round of [...execution.rounds].sort((a, b) => a.n - b.n)) {
    const cards = round.cards.map(id => input.cards.find(one => one.id === id))
    const finished = cards.filter(one => one && terminal(one)).length
    const starts = cards.flatMap(one => { const at = one ? claimAt(one, input.signals ?? []) : null; return at === null ? [] : [at] })
    const since = starts.length === cards.length && starts.length ? Math.min(...starts) : null
    const durationMs = round.state === 'closed' && since !== null && cards.every(Boolean)
      ? Math.max(0, Math.min(Math.max(...cards.map(one => one!.updatedAt)), endedAt ?? Infinity) - since) : null
    rows.push(row(`round-${round.n}`, 'round', `Round ${round.n} · ${round.role}`, {
      round: round.n, detail: `${finished} of ${round.cards.length} answered`, durationMs,
    }))
    const role = execution.document.flow.roles.find(one => one.id === round.role)
    round.cards.forEach((id, index) => {
      const card = cards[index]
      if (!card) { rows.push(row(`card-${round.n}-${id}`, 'card', `#${id} · Card unavailable`, { round: round.n, card: id })); return }
      const since = claimAt(card, input.signals ?? [])
      const operation = [...execution.operations].reverse().find(one => one.kind === 'check' && one.card === id)
      const uncertain = role?.kind === 'check' && operation?.state === 'uncertain'
      const inFlight = role?.kind === 'check' ? operation?.state === 'started' : card.state === 'claimed'
      const working = execution.state === 'running' && inFlight
      const stoppedWork = execution.state !== 'running' && !terminal(card) && (card.state === 'claimed' || inFlight)
      const until = terminal(card) ? Math.min(card.updatedAt, endedAt ?? Infinity) : stoppedWork ? endedAt : null
      const durationMs = since !== null && until !== null ? Math.max(0, until - since) : null
      const outcome = card.outcome == null ? null : wordOf(card.outcome)
      let status: string = outcome ?? (working ? 'Working' : card.state === 'done' ? 'Done' : card.state === 'abandoned' ? 'Abandoned' : card.state === 'blocked' ? 'Blocked' : 'Waiting')
      let title = `#${id} · ${card.title}`
      let kind: RunTimelineRow['kind'] = 'card'
      const personWaiting = role?.kind === 'person' && (execution.state === 'running' || execution.state === 'stalled') && round.state !== 'closed'
        && (card.state === 'open' || card.state === 'claimed' || (card.blockedBy === 'hand' && Boolean(card.blockedReason?.trim())))
      if (role?.kind === 'person') { kind = 'person'; if (personWaiting) status = 'Needs you' }
      if (role?.kind === 'check') {
        kind = 'check'
        title = role.check?.run ?? card.title
        const result = input.evidence?.cards.find(one => one.card === id)?.facts
          .map(one => one.record).filter(one => one.round === round.n && one.fact.kind === 'check' && one.fact.name === round.role && one.fact.run === title)
          .sort((a, b) => b.observedAt - a.observedAt)[0]?.fact
        status = uncertain ? 'Needs you' : working ? 'Working' : card.outcome && !['pass', 'fail', 'passed', 'failed'].includes(card.outcome)
          ? outcome! : result?.kind === 'check' ? result.timedOut ? 'Timed out' : result.exit === 0 ? 'Passed' : 'Failed' : outcome ?? 'Result unavailable'
      }
      if (stoppedWork) {
        const session = card.claim ? input.sessions?.get(sessionKey(card.claim.runtime, card.claim.sessionId)) : undefined
        const turn = session ? currentTurn(session) : undefined
        // A later follow-up in the same conversation is not this Run's turn.
        const live = session && isBusy(session) && endedAt !== null && (turn?.startedAt == null || turn.startedAt <= endedAt)
        status = live ? 'Stopping' : 'Stopped'
      }
      const attention = (!stoppedWork && (uncertain || personWaiting)) || (execution.end?.kind === 'unrouted' && execution.end.card === id)
      rows.push(row(`${kind}-${round.n}-${id}`, kind, title, { round: round.n, card: id,
        seat: [...execution.operations].reverse().find(one => one.kind === 'seat' && one.card === id && one.seat !== null)?.seat ?? null,
        status, attention, durationMs, since, working }))
    })
    const findings = (input.findings ?? []).filter(one => one.origin.run === execution.id && one.origin.round === round.n)
    if (findings.length) rows.push(row(`findings-${round.n}`, 'findings', `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}`, {
      round: round.n, detail: findings.map(one => `${one.title} · ${lifecycleWords(one)}${one.problem ? ` · ${one.problem}` : ''}`).join('\n'),
    }))
  }
  if (execution.state !== 'running') rows.push(row('end', 'end', endTitle(execution), { detail: execution.reason, attention: needsYou, since: endedAt }))
  return { header, rows }
}
