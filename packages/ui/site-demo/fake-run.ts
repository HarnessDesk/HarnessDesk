/** The preview's Run, replayed over the same store verbs as the production Team pane. */
import { itemId, runtimeId, sessionKey, turnId, type BoardEvidence, type FindingRunView, type FlowCheckAttempt, type FlowExecution, type Intent, type Session, type TeamSignal } from '@harnessdesk/protocol'
import { flowOverlayFixture, flowOverlayRig, OVERLAY_SEATS } from '../src/preview/flow-overlay-fixture'
import { overviewReport } from '../src/preview/team-overview-fixture'
import { runFixture } from '../src/preview/run-view-fixture'
import { emptyFindingsState } from '../src/lib/findings'
import type { AppSnapshot, AppStore } from '../src/state/store'

export const RUN_STAGES = ['write', 'check', 'changes', 'fix', 'check-again', 'approve', 'land', 'you', 'done'] as const
export type RunStage = typeof RUN_STAGES[number]
export const RUN_TEAM = 'overlay-team'
const MINUTES = [2, 12, 16, 22, 23, 27, 28.5, 29.5, 30]
const TITLES: Record<string, string> = { write: 'Retry the checkout call on a 502', check: 'Verify the retry change', review: 'Review the retry change', fix: 'Cap the retry attempts', land: 'Check the change is ready to land', you: 'Decide whether the retry change ships' }
const TIME_KEYS = new Set(['at', 'openedAt', 'createdAt', 'updatedAt', 'startedAt', 'endedAt', 'currentEndedAt'])
const shift = <T,>(value: T, delta: number): T => {
  if (Array.isArray(value)) return value.map(one => shift(one, delta)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, one]) => [key,
    TIME_KEYS.has(key) && typeof one === 'number' ? one + delta : shift(one, delta)])) as T
  return value
}

/** Wall time, once per round. Two parallel review Seats do not double its width. */
export const runTimeSegments = (execution: FlowExecution, cards: readonly Intent[], now: number) => execution.rounds.map(round => {
  const held = cards.filter(card => round.cards.includes(card.id))
  const start = Math.min(...held.map(card => card.createdAt))
  const end = round.state === 'closed' ? Math.max(...held.map(card => card.updatedAt)) : now
  return { round: round.n, role: round.role, ms: Math.max(0, end - start), live: round.state !== 'closed' }
})

export class StagedRun {
  readonly store: AppStore
  readonly #base: AppStore
  readonly #seed: AppSnapshot
  #stage: RunStage
  #timer: ReturnType<typeof setTimeout> | null = null
  #played = false
  #disposed = false
  #answer: { outcome: string; note: string } | null = null
  #now = Date.now()
  #attempts = new Map<number, { complete: boolean; attempts: FlowCheckAttempt[] }>()

  constructor(initial: RunStage = 'write') {
    this.#stage = initial
    this.#base = flowOverlayRig('fix').store
    this.#seed = this.#base.getSnapshot()
    this.store = new Proxy(this.#base, { get: (target, key) => {
      if (key === 'teamIntent') return this.#answerStep
      if (key === 'stopFlowExecution') return async () => {
        throw new Error('Stopping is not available in this staged Run.')
      }
      if (key === 'readGoalInsight') return async () => {
        const report = overviewReport()
        return { ...report, goal: RUN_TEAM, breakdowns: report.breakdowns.map(group => ({ ...group,
          rows: group.rows.map((row, i) => ({ ...row, goal: RUN_TEAM, key: OVERLAY_SEATS[i]!.id, seat: OVERLAY_SEATS[i]!.id, session: OVERLAY_SEATS[i]!.session })) })) }
      }
      if (key === 'readCheckAttempts') return async (_run: string, card: number) => ({ attempts: this.#attempts.get(card)?.attempts ?? [], complete: true })
      if (key === 'loadTeamRuns' || key === 'loadBoardEvidence' || key === 'loadFindings' || key === 'loadFindingRun') return async () => undefined
      if (key === 'teamPeers') return async () => []
      if (key === 'flowCatalog') return async () => []
      return Reflect.get(target, key)
    } })
    this.#render()
  }

  get stage(): RunStage { return this.#stage }
  read() {
    const snapshot = this.store.getSnapshot()
    return { execution: snapshot.flowExecutions.get('overlay-run')!, cards: snapshot.teams.get(RUN_TEAM)!.intents,
      attempts: this.#attempts, findingRun: snapshot.findingRuns.get('overlay-run')!, now: this.#now }
  }

  /** Once, when visible. Reduced motion keeps explicit Next step controls. */
  play(reduced = false): void {
    if (reduced || this.#played || this.#disposed) return
    this.#played = true
    const tick = () => {
      this.#timer = null
      if (this.#disposed || this.stage === 'you' || this.stage === 'done') return
      this.next()
      this.#timer = setTimeout(tick, 3500)
    }
    this.#timer = setTimeout(tick, 3500)
  }
  next(): void {
    if (this.#disposed || this.stage === 'you' || this.stage === 'done') return
    this.#stage = RUN_STAGES[RUN_STAGES.indexOf(this.stage) + 1]!
    this.#render()
  }
  pause(): void { if (this.#timer !== null) clearTimeout(this.#timer); this.#timer = null; this.#played = false }
  dispose(): void { this.pause(); this.#disposed = true }

  #answerStep = async (room: string, id: number, action: string, _reason?: string, outcome?: string, note?: string): Promise<void> => {
    if (room !== RUN_TEAM || id !== 80 || action !== 'done') throw new Error('Only the person step is answerable in this staged Run.')
    if (this.stage !== 'you') throw new Error('This card was already answered or is not waiting yet.')
    if (outcome !== 'merged' && outcome !== 'dropped') throw new Error('Choose one of the person step’s declared answers.')
    this.#answer = { outcome, note: note ?? '' }
    this.#stage = 'done'
    this.#render()
  }

  #patch(partial: Partial<AppSnapshot>): void {
    ;(this.#base as unknown as { patch: (partial: Partial<AppSnapshot>) => void }).patch(partial)
  }
  #render(): void {
    const source = flowOverlayFixture('you')
    const index = RUN_STAGES.indexOf(this.stage)
    const count = Math.min(index + 1, 8)
    this.#now = Date.now()
    const delta = this.#now - (source.execution.startedAt! + MINUTES[index]! * 60_000)
    const done = this.stage === 'done'
    const rounds = source.execution.rounds.slice(0, count).map((round, i) => ({ ...round, state: i === count - 1 && !done ? 'running' as const : 'closed' as const }))
    const ids = new Set(rounds.flatMap(round => round.cards))
    const live = rounds.at(-1)!
    const cards: Intent[] = shift(source.cards.filter(card => ids.has(card.id)).map(card => {
      const round = rounds.find(round => round.cards.includes(card.id))!
      const current = round === live && !done
      const seat = OVERLAY_SEATS.find(seat => seat.id === round.seats[round.cards.indexOf(card.id)])
      return { ...card, title: TITLES[round.role]!, role: round.role, state: current ? round.role === 'you' ? 'open' as const : 'claimed' as const : 'done' as const,
        updatedAt: current ? card.createdAt : round.role === 'you' ? source.execution.startedAt! + 30 * 60_000 : card.updatedAt,
        outcome: current ? null : round.role === 'you' ? this.#answer?.outcome ?? 'merged' : card.outcome,
        ...(round.role === 'you' && this.#answer ? { note: this.#answer.note } : {}),
        claim: current && seat ? { runtime: runtimeId(seat.session.runtime), sessionId: seat.session.sessionId, at: card.createdAt } : null }
    }), delta)
    const execution: FlowExecution = shift({ ...source.execution, rounds, operations: source.execution.operations.filter(operation => ids.has(operation.card!)).map(operation => ({ ...operation,
      state: live.cards.includes(operation.card!) && operation.kind === 'check' && !done ? 'started' as const : 'finished' as const })),
      state: done ? 'settled' : 'running',
      ...(done ? { endedAt: source.execution.startedAt! + 30 * 60_000, currentEndedAt: source.execution.startedAt! + 30 * 60_000, end: { kind: 'complete' as const } } : {}),
    }, delta)
    this.#attempts = new Map([...source.attempts].filter(([id]) => ids.has(id)).map(([id, history]) => [id, { complete: true,
      attempts: history.attempts.filter(attempt => attempt.at + delta <= this.#now).map((attempt, i): FlowCheckAttempt => ({ ...shift(attempt, delta), n: i + 1, commit: '3f9a1c', exit: 0, timedOut: false, outcome: id === 70 ? 'landed' : 'passes', tail: 'Passed' })),
    }]))
    const sessions = new Map([...this.#seed.sessions].map(([key, session]) => {
      const seat = OVERLAY_SEATS.find(seat => sessionKey(seat.session.runtime, seat.session.sessionId) === key)!
      const active = !done && live.seats.includes(seat.id)
      const next: Session = { ...session, createdAt: execution.startedAt!, updatedAt: this.#now, status: { type: active ? 'active' : 'idle' },
        turns: active ? [{ id: turnId(`round-${live.n}`), startedAt: cards.find(card => live.cards.includes(card.id))!.createdAt, status: 'inProgress',
          items: seat.ceiling?.level === 'read' ? [{ id: itemId('read'), type: 'toolCall', tool: 'read', source: { kind: 'builtin' }, status: 'inProgress', args: { path: 'src/checkout/retry.ts' } }]
            : [{ id: itemId('edit'), type: 'fileChange', status: 'inProgress', changes: [{ path: 'src/checkout/retry.ts', kind: { type: 'update', movePath: null }, diff: '' }] }] }] : [] }
      return [key, next]
    }))
    const signals: TeamSignal[] = rounds.flatMap(round => round.seats.map((seatId, i) => {
      const seat = OVERLAY_SEATS.find(seat => seat.id === seatId)!
      const card = cards.find(card => card.id === round.cards[i])!
      return { id: `claim-${card.id}`, kind: 'signal', signal: 'claimed', intent: card.id, title: card.title, at: card.createdAt,
        by: { kind: 'agent', runtime: runtimeId(seat.session.runtime), sessionId: seat.session.sessionId, title: seat.agent!.name } }
    }))
    const board = { ...this.#seed.teams.get(RUN_TEAM)!, intents: cards, channel: signals }
    const goal = { ...this.#seed.goals.get(RUN_TEAM)!, board, activity: this.stage === 'you' ? 'needs-you' as const : done ? 'ready-to-wrap' as const : 'working' as const }
    const reviews = rounds.filter(round => round.role === 'review' && round.state === 'closed')
    const findingRun: FindingRunView = { run: execution.id, goal: RUN_TEAM, round: live.n, finished: reviews.length, total: reviews.length, embargoed: false,
      open: count >= 4 && count < 7 ? 1 : 0, blocking: count >= 4 && count < 7 ? 1 : 0, reason: null, ceilingStop: false, stamp: `staged-${this.stage}`,
      publication: reviews.length ? 'posted' : 'local', rounds: reviews.map(round => ({ round: round.n, cards: round.cards, state: 'posted', reason: null, pr: 42 })),
      reviewersFinished: live.role === 'review' ? 0 : null, reviewersTotal: live.role === 'review' ? 2 : null, pendingExceptions: [], repair: null,
      boundPr: { repo: 'acme/storefront', pr: 42 }, unbound: null, undecidable: done ? 'This Run is finished.' : null }
    const findings = count < 4 ? [] : runFixture('running').findings.map(finding => ({ ...finding, ownerGoal: RUN_TEAM,
      origin: { ...finding.origin, goal: RUN_TEAM, run: execution.id, round: 3, card: 31, seat: 'beta' },
      lifecycle: count >= 7 ? { state: 'repaired' as const, confirmed: true, repairs: ['3f9a1c'] } : finding.lifecycle }))
    const evidenceSeed = runFixture('running').evidence
    const factSeed = evidenceSeed.cards[0]!.facts[0]!
    const evidence: BoardEvidence = { ...evidenceSeed, room: RUN_TEAM, stamp: this.#now, cards: [...this.#attempts].map(([card, history]) => ({ card, running: [],
      facts: history.attempts.map(attempt => ({ ...factSeed, record: { ...factSeed.record, id: attempt.id, observedAt: attempt.at,
        round: rounds.find(round => round.cards.includes(card))!.n,
        fact: { kind: 'check', name: card === 70 ? 'land' : 'verify', run: card === 70 ? 'pnpm land' : 'pnpm verify', exit: attempt.exit!, timedOut: false, dirty: false, at: attempt.commit!, tail: attempt.tail! } } })) })) }
    this.#patch({ teams: new Map([[RUN_TEAM, board]]), goals: new Map([[RUN_TEAM, goal]]), sessions, history: [...sessions.values()],
      flowExecutions: new Map([[execution.id, execution]]), findingRuns: new Map([[execution.id, findingRun]]), boardEvidence: new Map([[RUN_TEAM, evidence]]),
      findings: new Map([[RUN_TEAM, { ...emptyFindingsState(), rows: findings, totals: { all: findings.length, open: findingRun.open, blocking: findingRun.blocking } }]]) })
  }
}
