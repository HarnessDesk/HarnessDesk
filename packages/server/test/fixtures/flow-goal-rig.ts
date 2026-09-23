import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentEntry, Lane, RuntimeId, SeatRecord, TeamState } from '@harnessdesk/protocol'

import { ExecutionFiles, FlowExecutions, sourceDigest, type FlowExecutionPort, type StoredFlowExecution } from '../../src/flow-execution.js'
import { compileFlowPolicy, parseFlowPolicy } from '../../src/flow-policy.js'
import { Flows, type FlowPort } from '../../src/flows.js'
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
    id, name: id, ceiling: 'edit', ceilingFrom: 'ceiling', answers: [...answers], produces: [], skills: [],
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
  /** Asked of each opening before it happens; throw to refuse it. */
  beforeOpen: ((n: number, agent: string) => void) | null
  /** Asked after the conversation exists but before its card is claimed. */
  beforeClaim: ((n: number) => void) | null
  /** The runtime an opening actually lands on, when it is not the one asked for. */
  opensAs: ((asked: string) => string) | null
  /** Refuse every order after this many. */
  failOrder: boolean
  /** The lane a Seat gets when it asked for isolation. */
  laneFor: (n: number, seat: SeatRecord) => Lane | null
  dispatch: { ok: true } | { ok: false; reason: string }
  /** What a re-armed Seat comes back on, when not what it was opened on. */
  comesBackAs: string | null
  compile(source: string, agents: readonly AgentEntry[]): ReturnType<typeof compileFlowPolicy>
  start(source: string, agents: readonly AgentEntry[]): ReturnType<Flows['startGoal']>
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
    beforeOpen: null, beforeClaim: null, opensAs: null, failOrder: false, comesBackAs: null,
    dispatch: { ok: true } as GoalRig['dispatch'],
    laneFor: (n: number, seat: SeatRecord): Lane => ({
      id: `lane-${n}`, goal: seat.board!, seat: String(seat.id), cwd: seat.checkout.cwd, branch: `harnessdesk/lane-${n}`,
      ports: { start: 30000 + n * 20, end: 30019 + n * 20 }, browserProfile: `profile-${n}`, state: 'active', createdAt: 1,
    }),
  } as unknown as GoalRig & { executions: FlowExecutions; flows: Flows; files: FaultyFiles }
  let opened = 0
  const port: FlowExecutionPort = {
    providerOf: (runtime) => rig.providers.get(runtime) ?? null,
    canDispatch: () => rig.dispatch,
    createGoal: async (input) => {
      const room = await team.createRoom('/repo', input.sentence)
      if (input.origin?.kind === 'flow') rig.goals.set(room.id, input.origin.run)
      rig.events.push(`goal:${input.sentence}`)
      return { id: room.id }
    },
    goalsOf: (run) => [...rig.goals.entries()].filter(([, owner]) => owner === run).map(([goal]) => goal),
    seatOf: (id) => rig.seats.get(id) ?? null,
    seatsOn: (goal) => [...rig.seats.values()].filter((seat) => seat.board === goal && seat.closed === null),
    digestOf: async (_goal, id) => rig.digests.get(id) ?? `${id}-digest`,
    openSeat: async (input) => {
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
    },
    release: async (_goal, id) => {
      rig.events.push(`release:${id}`)
      const record = rig.seats.get(id)
      if (record) rig.seats.set(id, { ...record, closed: { at: Date.now(), why: 'released' } })
    },
    order: async (seat) => {
      if (rig.failOrder) throw new Error('the agent is not running')
      rig.events.push(`order:${seat.id}`)
    },
    laneOf: (seat) => rig.lanes.get(String(seat.id)) ?? null,
    reseat: async (seat) => rig.comesBackAs ?? seat.seatLabel,
    changed: () => {},
    log: () => {},
  }
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
    const executions = new FlowExecutions(files, team, port)
    const flows = new Flows(join(dir, 'flows'), team, legacy, undefined, executions)
    team.attachFlows(flows)
    return { files, executions, flows }
  }
  Object.assign(rig, build())
  rig.compile = (source, agents) => {
    const parsed = parseFlowPolicy(source)
    if (!parsed.document) throw new Error(JSON.stringify(parsed.problems))
    return compileFlowPolicy(parsed.document, agents)
  }
  rig.start = (source, agents) => rig.flows.startGoal({
    root: '/repo', sentence: 'Finish the change', source, sourcePath: null, compiled: rig.compile(source, agents),
    authorization: { sourceDigest: sourceDigest(source), commandDigest: sourceDigest(''), approvedAt: 1 },
  })
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
