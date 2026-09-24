import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_TRIGGER_BUDGET, type AgentEntry, type Evidence, type EvidenceRecord, type EvidenceView, type FlowExecution, type GoalOrigin, type Lane, type RuntimeId, type SeatRecord, type TeamState, type TriggerDefinition } from '@harnessdesk/protocol'

import { FlowReview, type ReviewAppendOutcome, type ReviewSubjectPort } from '../../src/flow-evidence.js'
import { ExecutionFiles, FlowExecutions, sourceDigest, type FlowExecutionPort, type StoredFlowExecution } from '../../src/flow-execution.js'
import { compileFlowPolicy, parseFlowPolicy } from '../../src/flow-policy.js'
import { Flows, type FlowPort } from '../../src/flows.js'
import { Serial } from '../../src/goals/assignments.js'
import { Team, type TeamPeer, type TeamPort } from '../../src/team.js'

/**
 * Runs on Goals against a real board and a fake Goal plane.
 *
 * The fake opens a "conversation" per Seat, records its Seat, and claims the
 * card it was opened for the way the host's own assignment does: on the
 * host's authority, only while the run says that card's Seat is opening.
 * Nothing here spends; every step is recorded in `events`, in order.
 */

export class Crash extends Error {
  constructor(where: string) { super(`simulated crash ${where}`) }
}

/** Saves that can fail once, or die for good the way a process does. */
export class FaultyFiles extends ExecutionFiles {
  saves = 0
  failOnce: ((run: StoredFlowExecution) => boolean) | null = null
  dieWhen: ((run: StoredFlowExecution) => boolean) | null = null
  dead = false
  override async save(run: StoredFlowExecution): Promise<void> {
    if (this.dead) throw new Crash('(the desk is gone)')
    if (this.dieWhen?.(run)) {
      this.dead = true
      throw new Crash('at a save')
    }
    if (this.failOnce?.(run)) {
      this.failOnce = null
      throw new Error('the journal write failed')
    }
    this.saves += 1
    await super.save(run)
  }
}

export const agent = (id: string, answers: readonly string[], runtime = 'alpha', digest = `${id}-digest`): AgentEntry => ({
  id,
  origin: 'project',
  path: `.harnessdesk/agents/${id}/AGENT.md`,
  digest,
  shadows: [],
  problems: [],
  definition: {
    id, name: id, ceiling: 'edit', ceilingFrom: 'ceiling', answers: [...answers], produces: [], skills: [], mcp: [],
    prefer: [{ runtime }], brief: `${id} brief`,
  },
})

export interface GoalRig {
  readonly team: Team
  readonly flows: Flows
  readonly executions: FlowExecutions
  readonly files: FaultyFiles
  readonly dir: string
  readonly peers: TeamPeer[]
  readonly events: string[]
  readonly seats: Map<string, SeatRecord>
  readonly lanes: Map<string, Lane>
  readonly digests: Map<string, string>
  readonly providers: Map<string, string>
  readonly goals: Map<string, string>
  /** What `headOf` answers for a checkout's `cwd`, keyed by that path; unset cwds read as no repository. */
  readonly heads: Map<string, { readonly at: string | null; readonly dirty: boolean }>
  /** What `runCheck` answers for a command, keyed by its exact text; unset commands "pass" (exit 0). */
  readonly checkOutcomes: Map<string, { readonly exit: number | null; readonly timedOut: boolean; readonly tail: string }>
  /** When true, every check's evidence append reports as failed (`problem` set, `evidence` null). */
  checkEvidenceFails: boolean
  /** Checks run until their signal aborts, as a long command a pause or a stop kills; told when one starts. */
  checksRunUntilStopped: (() => void) | null
  /** Checkouts whose check evidence append fails, one check at a time: how one card of a fan-out is left uncertain. */
  readonly failEvidenceIn: Set<string>
  /** Every check's own `cwd`, in call order — how a fan-out's distinct checkouts are told apart. */
  readonly checkCwds: string[]
  /** Every check's own `flowContext`, in call order, undefined where none was sent. */
  readonly checkContexts: (string | undefined)[]
  /**
   * A minimal, real evidence store, wired into the run's own evidence guards
   * and into `review`, below — so a rule's `when.evidence` and a scripted
   * `record_review` are the real `evidenceGuard`/`FlowReview` logic, not a
   * second, test-only imitation of it. Every check step's own result is
   * appended here automatically; a scripted review is the test's own to add,
   * through `review.record(...)`.
   */
  readonly facts: Map<string, EvidenceRecord[]>
  /** Fact ids to report stale (`moved`) instead of fresh — the "the branch moved on" scenario. */
  readonly staleFacts: Set<string>
  /** The real guard/review logic, over `facts` above. */
  readonly review: FlowReview
  /**
   * The Goal queue, as the host's: every Seat opening and release takes it,
   * exactly as `GoalPlane.seat`/`release` do, so a test that holds it sees
   * what a run seating a card really waits on.
   */
  readonly goalSerial: Serial
  /** Told when a run asks for a Seat, before the opening waits for the Goal queue. */
  seatAsked: (() => void) | null
  /** Whether each opening asked for a held-only Seat, in order (phase 10). */
  readonly strictAsks: boolean[]
  /** False, a held-only opening is refused the way seating refuses a Seat that cannot hold (phase 10). */
  holdsCeilings: boolean
  /** An existing empty Goal's reservation, as the Goal plane decides it; throw to refuse (phase 10). */
  reserve: ((input: { goal: string; revision: number; run: string; operation: string; root: string }) => Promise<void>) | null
  /** Asked of each opening before it happens; throw to refuse it. */
  beforeOpen: ((n: number, agent: string) => void) | null
  /** Asked after the conversation exists but before its card is claimed. */
  beforeClaim: ((n: number) => void) | null
  /** The runtime an opening actually lands on, when it is not the one asked for. */
  opensAs: ((asked: string) => string) | null
  /** Refuse every order after this many. */
  failOrder: boolean
  /** Seats inside a turn now — their brief's, say — which an order would be refused by. */
  busySeats: Set<string>
  /**
   * A turn an interrupt asks to stop ends a moment later, as a real agent's
   * does, and a release refuses a Seat still inside its turn — as the host's
   * Goal plane refuses it.
   */
  turnsEndLater: boolean
  /** Called once an order is accepted — where a test says a turn has started. */
  onOrder: ((seat: SeatRecord) => void) | null
  /** Every accepted order's text, by Seat id, in order. */
  readonly orderTexts: Map<string, string[]>
  /** The lane a Seat gets when it asked for isolation. */
  laneFor: (n: number, seat: SeatRecord) => Lane | null
  dispatch: { ok: true } | { ok: false; reason: string }
  /** What a re-armed Seat comes back on, when not what it was opened on. */
  comesBackAs: string | null
  compile(source: string, agents: readonly AgentEntry[]): ReturnType<typeof compileFlowPolicy>
  start(source: string, agents: readonly AgentEntry[]): ReturnType<Flows['startGoal']>
  /**
   * Phase 8: a trigger's run on a Goal the rig makes with a trigger origin,
   * through the real `startTriggered` — held until `flows.resumeTriggered`.
   * The closure is frozen from `source` and `agents` exactly as a trigger's
   * arm would freeze it; `changed` makes the re-read closure differ.
   */
  startTriggered(source: string, agents: readonly AgentEntry[], options?: { readonly again?: string; readonly changed?: boolean; readonly key?: string; readonly budget?: TriggerDefinition['budget'] }): Promise<FlowExecution>
  /** The dispatch gate a trigger's run passes; null lets it go. A `transient` refusal (a pause, the cap) holds rather than stops. */
  triggerGate: ((run: FlowExecution) => string | { readonly reason: string; readonly transient: true } | null) | null
  /** Each trigger Goal's persisted origin, as the Goal store would answer it. */
  readonly origins: Map<string, GoalOrigin>
  /** A fresh engine over the same folder, board and Goal plane: a restart. */
  restart(): Promise<{ flows: Flows; executions: FlowExecutions; files: FaultyFiles }>
  board(goal: string): TeamState
  sessionOf(seat: string): { runtime: string; sessionId: string }
  kill(seat: string): void
}

export const goalRig = async (t: { after(fn: () => Promise<void>): void }): Promise<GoalRig> => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-flow-goal-'))
  const peers: TeamPeer[] = []
  const teamPort: TeamPort = {
    peers: () => peers,
    rootOf: async (cwd) => (cwd.startsWith('/repo') ? '/repo' : null),
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  }
  const team = new Team(join(dir, 'team'), teamPort)
  const rig = {
    team, dir, peers, events: [] as string[], seats: new Map<string, SeatRecord>(), lanes: new Map<string, Lane>(),
    digests: new Map<string, string>(), providers: new Map<string, string>(), goals: new Map<string, string>(),
    heads: new Map<string, { at: string | null; dirty: boolean }>(),
    checkOutcomes: new Map<string, { exit: number | null; timedOut: boolean; tail: string }>(),
    checkEvidenceFails: false,
    checksRunUntilStopped: null,
    failEvidenceIn: new Set<string>(),
    checkCwds: [] as string[],
    checkContexts: [] as (string | undefined)[],
    facts: new Map<string, EvidenceRecord[]>(),
    staleFacts: new Set<string>(),
    goalSerial: new Serial(), seatAsked: null, strictAsks: [] as boolean[], holdsCeilings: true, reserve: null,
    beforeOpen: null, beforeClaim: null, opensAs: null, failOrder: false, turnsEndLater: false, comesBackAs: null, busySeats: new Set<string>(), onOrder: null,
    orderTexts: new Map<string, string[]>(),
    origins: new Map<string, GoalOrigin>(),
    triggerGate: null,
    dispatch: { ok: true } as GoalRig['dispatch'],
    laneFor: (n: number, seat: SeatRecord): Lane => ({
      id: `lane-${n}`, goal: seat.board!, seat: String(seat.id), cwd: seat.checkout.cwd, branch: `harnessdesk/lane-${n}`,
      ports: { start: 30000 + n * 20, end: 30019 + n * 20 }, browserProfile: `profile-${n}`, state: 'active', createdAt: 1,
    }),
  } as unknown as GoalRig & { executions: FlowExecutions; flows: Flows; files: FaultyFiles }
  let opened = 0
  let factSeq = 0
  const viewsFor = (goal: string): EvidenceView[] =>
    (rig.facts.get(goal) ?? []).map((record) => ({
      record,
      freshness: rig.staleFacts.has(record.id) ? { state: 'moved' as const } : { state: 'fresh' as const },
      by: null,
    }))
  const pushFact = (goal: string, fact: Evidence, extra: Partial<EvidenceRecord> = {}): EvidenceRecord => {
    factSeq += 1
    const record: EvidenceRecord = { id: `fact-${factSeq}`, fact, observedAt: Date.now(), ...extra }
    rig.facts.set(goal, [...(rig.facts.get(goal) ?? []), record])
    return record
  }
  /* Inside the Goal queue, as `GoalPlane.seat` and `GoalPlane.release` run: the host's own order. */
  const openSeat = async (input: Parameters<FlowExecutionPort['openSeat']>[0]): Promise<SeatRecord> => {
    rig.strictAsks.push(input.requireHeld === true)
    if (input.requireHeld === true && !rig.holdsCeilings) throw new Error('This seat cannot hold the previewed ceiling. Choose a seat that can.')
    opened += 1
    const n = opened
    rig.beforeOpen?.(n, input.agent)
    const asked = input.seats?.[0]?.runtime ?? 'alpha'
    const runtime = rig.opensAs?.(asked) ?? asked
    const sessionId = `s${n}`
    const cwd = input.isolate ? `/repo/.lanes/${n}` : '/repo'
    const record: SeatRecord = {
      id: `seat-${n}` as SeatRecord['id'], agent: { id: input.agent, name: input.agent, origin: 'project' },
      briefDigest: rig.digests.get(input.agent) ?? `${input.agent}-digest`, seat: { runtime }, seatLabel: runtime, passedOver: [],
      standing: { kind: 'ceiling', level: input.grant?.kind === 'ceiling' ? input.grant.level : 'read' }, ceiling: null,
      checkout: { cwd, project: '/repo', branch: null, head: null }, session: { runtime, sessionId },
      board: input.goal, role: null, openedAt: n, closed: null,
    }
    peers.push({ runtime: runtime as RuntimeId, sessionId, title: null, cwd, agent: runtime, busy: true, canSteer: false, queuedByUser: 0, model: runtime, here: true })
    await team.joinRoom(input.goal, runtime as RuntimeId, sessionId)
    rig.seats.set(String(record.id), record)
    if (input.isolate) {
      const lane = rig.laneFor(n, record)
      if (lane) rig.lanes.set(String(record.id), lane)
    }
    rig.events.push(`open:${record.id}`)
    rig.beforeClaim?.(n)
    if (input.card !== undefined) {
      // The host's own claim, on its authority: allowed only while this card's Seat is opening.
      const bound = rig.flows.bindingFor(input.goal, input.card)
      if (bound && !bound.opening) throw new Error('This card cannot be assigned now.')
      const state = team.stateFor(input.goal)
      team.installProjection({
        ...state,
        intents: state.intents.map((card) => card.id === input.card
          ? { ...card, state: 'claimed', claim: { runtime: runtime as RuntimeId, sessionId, at: Date.now() } }
          : card),
      })
    }
    return record
  }
  const release = async (_goal: string, id: string): Promise<void> => {
    if (rig.turnsEndLater && rig.busySeats.has(id)) {
      rig.events.push(`refused:${id}`)
      throw new Error("Stop this Seat's current turn before releasing it")
    }
    rig.events.push(`release:${id}`)
    const record = rig.seats.get(id)
    if (record) rig.seats.set(id, { ...record, closed: { at: Date.now(), why: 'released' } })
  }
  const port: FlowExecutionPort = {
    providerOf: async (runtime) => rig.providers.get(runtime) ?? null,
    canDispatch: () => rig.dispatch,
    createGoal: async (input) => {
      const room = await team.createRoom('/repo', input.sentence)
      if (input.origin?.kind === 'flow') rig.goals.set(room.id, input.origin.run)
      rig.events.push(`goal:${input.sentence}`)
      return { id: room.id }
    },
    reserveGoal: async (input) => {
      if (!rig.reserve) throw new Error('This rig reserves no Goal.')
      await rig.reserve(input)
      rig.events.push(`reserve:${input.goal}:${input.run}`)
      // Found again by `goalsOf`, the way the host's store answers for a reservation.
      rig.goals.set(input.goal, input.run)
    },
    goalsOf: (run) => [...rig.goals.entries()].filter(([, owner]) => owner === run).map(([goal]) => goal),
    seatOf: (id) => rig.seats.get(id) ?? null,
    seatsOn: (goal) => [...rig.seats.values()].filter((seat) => seat.board === goal && seat.closed === null),
    digestOf: async (_goal, id) => rig.digests.get(id) ?? `${id}-digest`,
    openSeat: async (input) => {
      rig.seatAsked?.()
      return rig.goalSerial.run(() => openSeat(input))
    },
    release: (goal, id) => rig.goalSerial.run(() => release(goal, id)),
    order: async (seat, text) => {
      if (rig.failOrder) throw new Error('the agent is not running')
      if (rig.busySeats.has(String(seat.id))) throw new Error('still working on the last message')
      rig.events.push(`order:${seat.id}`)
      rig.orderTexts.set(String(seat.id), [...(rig.orderTexts.get(String(seat.id)) ?? []), text])
      rig.onOrder?.(seat)
    },
    busy: (seat) => rig.busySeats.has(String(seat.id)),
    interrupt: async (seat) => {
      rig.events.push(`interrupt:${seat.id}`)
      if (rig.turnsEndLater) setTimeout(() => rig.busySeats.delete(String(seat.id)), 120)
      else rig.busySeats.delete(String(seat.id))
    },
    laneOf: (seat) => rig.lanes.get(String(seat.id)) ?? null,
    reseat: async (seat) => rig.comesBackAs ?? seat.seatLabel,
    changed: () => {},
    log: () => {},
    headOf: async (cwd) => rig.heads.get(cwd) ?? { at: null, dirty: false },
    runCheck: async (command, where, card) => {
      rig.events.push(`check:${command}`)
      if (rig.checksRunUntilStopped) {
        const started = rig.checksRunUntilStopped
        const stopped = new Promise<void>((resolve) => where.signal?.addEventListener('abort', () => resolve(), { once: true }))
        started()
        await stopped
        rig.events.push(`check-stopped:${command}`)
        return { result: { exit: null, timedOut: false, tail: 'stopped' }, evidence: null, problem: null }
      }
      rig.checkCwds.push(where.cwd)
      rig.checkContexts.push(where.flowContext)
      const outcome = rig.checkOutcomes.get(command) ?? { exit: 0, timedOut: false, tail: '' }
      const fails = rig.checkEvidenceFails || rig.failEvidenceIn.delete(where.cwd)
      if (!fails) {
        const head = rig.heads.get(where.cwd) ?? { at: null, dirty: false }
        if (head.at) {
          pushFact(
            card.goal,
            { kind: 'check', name: card.name, run: command, exit: outcome.exit, timedOut: outcome.timedOut, at: head.at, dirty: head.dirty, tail: outcome.tail },
            { card: { board: card.goal, id: card.card }, round: card.round },
          )
        }
      }
      return { result: outcome, evidence: fails ? null : 'fact-check', problem: fails ? 'evidence could not be saved' : null }
    },
  }
  const goalOfIntent = (intent: number): string | null => {
    for (const goal of rig.goals.keys()) {
      if (team.stateFor(goal).intents.some((one) => one.id === intent)) return goal
    }
    return null
  }
  const reviewPort: ReviewSubjectPort = {
    bindingFor: async (intent, scope) => {
      if (!scope.runtime || !scope.sessionId) return null
      const goal = goalOfIntent(intent)
      if (!goal) return null
      const bound = await rig.flows.reviewBindingFor(goal, intent, { runtime: scope.runtime, sessionId: scope.sessionId })
      if (!bound) return null
      return { goal, seat: bound.seat as SeatRecord['id'], answers: bound.answers, round: bound.round, subjects: bound.subjects, unsettled: bound.unsettled }
    },
    facts: async (goal) => viewsFor(goal),
    // The same compare-and-merge `FakePort` in flow-review.test.ts proves against a bare port: an
    // identical repeat is a no-op, a different verdict for the same (round,card,seat,at) conflicts.
    append: async (goal, record): Promise<ReviewAppendOutcome> => {
      const list = rig.facts.get(goal) ?? []
      const existing = list.filter((one) =>
        one.fact.kind === 'review' && record.fact.kind === 'review' &&
        one.fact.by === record.fact.by && one.fact.at === record.fact.at &&
        one.card?.id === record.card?.id && one.round === record.round)
      const matching = existing.find((one) => one.fact.kind === 'review' && record.fact.kind === 'review' && one.fact.verdict === record.fact.verdict)
      if (matching) return { outcome: 'duplicate', record: matching }
      if (existing.length > 0) return { outcome: 'conflict' }
      rig.facts.set(goal, [...list, record])
      return { outcome: 'added', record }
    },
    now: () => Date.now(),
  }
  const review = new FlowReview(reviewPort)
  const legacy: FlowPort = {
    openLegacySeat: async () => { throw new Error('no old flows here') },
    releaseGoalSeat: async () => {},
    order: async () => {},
    reseat: async () => '',
    retire: async () => {},
    confine: async () => {},
    run: async () => ({ status: 0 }),
    changed: () => {},
    log: () => {},
    recovery: { goal: () => ({ exists: true, writable: true }), seats: () => [] },
  }
  const build = () => {
    const files = new FaultyFiles(join(dir, 'flows-v2'))
    const executions: FlowExecutions = new FlowExecutions(files, team, port, {
      facts: async (goal) => viewsFor(goal),
      triggered: {
        freeze: async () => {
          const frozen = triggerSource
          if (!frozen) throw new Error('No trigger closure was staged.')
          const compiled = rig.compile(frozen.source, frozen.agents)
          return {
            source: frozen.source, digest: sourceDigest(`${frozen.source}${frozen.changed ? '#changed' : ''}`), bindings: [], problems: [], availability: [],
            preview: { token: null, compiled, seats: [], commands: [], guards: [], messaging: 'board-only', problems: [] },
          }
        },
        originOf: (goal) => rig.origins.get(goal) ?? null,
        gate: async (run) => {
          const verdict = rig.triggerGate?.(run) ?? null
          if (verdict === null) return { ok: true as const }
          return typeof verdict === 'string' ? { ok: false as const, reason: verdict } : { ok: false as const, reason: verdict.reason, transient: true as const }
        },
      },
    })
    const flows = new Flows(join(dir, 'flows'), team, legacy, undefined, executions, review)
    team.attachFlows(flows)
    return { files, executions, flows }
  }
  Object.assign(rig, build(), { review })
  rig.compile = (source, agents) => {
    const parsed = parseFlowPolicy(source)
    if (!parsed.document) throw new Error(JSON.stringify(parsed.problems))
    return compileFlowPolicy(parsed.document, agents)
  }
  rig.start = (source, agents) => rig.flows.startGoal({
    root: '/repo', sentence: 'Finish the change', source, sourcePath: null, compiled: rig.compile(source, agents),
    authorization: { sourceDigest: sourceDigest(source), commandDigest: sourceDigest(''), approvedAt: 1 },
  })
  let triggerSource: { source: string; agents: readonly AgentEntry[]; changed: boolean } | null = null
  let triggered = 0
  rig.startTriggered = async (source, agents, options = {}) => {
    triggered += 1
    const key = options.key ?? triggered.toString(16).padStart(64, '0')
    const room = await team.createRoom('/repo', `Pull request #${triggered}, from trigger review`)
    rig.origins.set(room.id, { kind: 'trigger', trigger: 'review', event: key })
    const definition: TriggerDefinition = {
      id: 'review', on: { kind: 'pull-request', events: ['opened', 'pushed'] }, opens: { flow: 'review-pr' }, goal: ['pr'],
      again: options.again ? { role: options.again, title: 'Continue this work', detail: null } : null,
      dedupe: ['pr', 'head', 'event'], concurrency: 1, forks: 'never', budget: options.budget ?? DEFAULT_TRIGGER_BUDGET,
    }
    triggerSource = { source, agents, changed: false }
    const digest = sourceDigest(source)
    triggerSource = { source, agents, changed: options.changed ?? false }
    return rig.flows.startTriggered({
      key, id: `flow-trigger-${triggered.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, goal: room.id, root: '/repo',
      closureDigest: digest, definition,
      fact: {
        source: 'pull-request', project: '/repo', repository: 'acme/widgets', subject: String(triggered), event: key, action: 'opened',
        at: 1, head: 'a'.repeat(40), fork: false, title: '', body: '', url: null, trigger: null,
      },
      evidence: [],
    })
  }
  rig.restart = async () => {
    await rig.flows.flush().catch(() => {})
    const next = build()
    Object.assign(rig, next)
    await next.flows.load()
    return next
  }
  rig.board = (goal) => team.stateFor(goal)
  rig.sessionOf = (seat) => rig.seats.get(seat)!.session
  rig.kill = (seat) => {
    const session = rig.sessionOf(seat)
    const peer = peers.find((one) => one.runtime === session.runtime && one.sessionId === session.sessionId)
    if (peer) Object.assign(peer, { busy: false })
  }
  t.after(async () => {
    await rig.flows.flush().catch(() => {})
    await team.flush()
    await rm(dir, { recursive: true, force: true })
  })
  return rig
}
