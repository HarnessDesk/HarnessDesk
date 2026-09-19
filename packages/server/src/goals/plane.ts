import { randomUUID } from 'node:crypto'

import {
  activityOf, checkedDependencies, flowRoleOf, placeCard,
  type BoardEvidence, type FlowPermission, type FlowRun, type FlowSeat,
  type Goal, type GoalCreateInput, type GoalSeatRequest, type GoalView,
  type SeatId, type SeatRecord, type SessionPointer, type TeamState,
} from '@harnessdesk/protocol'

import type { SeatOpening } from '../evidence/records.js'
import { Assignments, Serial } from './assignments.js'
import type { LaneAllocator } from './lanes.js'
import { goalMembers, memberProjection } from './members.js'
import { recoverOperation, type GoalOperationPort } from './operations.js'
import { GoalStore, type GoalDocument } from './store.js'

export interface GoalPlanePort extends GoalOperationPort {
  seats: {
    all(): readonly SeatRecord[]
    byId(id: SeatId): SeatRecord | null
  }
  confine(input: GoalCreateInput): Promise<{ root: string; cwd: string }>
  known(runtime: string, session: string): Promise<{ project: string; busy: boolean } | null>
  claimable(goal: string, card: number, session: SessionPointer): boolean
  opening(goal: string, session: SessionPointer, id: SeatId): Promise<SeatOpening>
  board(goal: string): TeamState
  evidence(goal: string): Promise<BoardEvidence>
  flow(goal: string): FlowRun | undefined
  busy(session: SessionPointer): boolean
  waits(session: SessionPointer): boolean
  stranded(goal: string, card: number): boolean
  held(goal: string): boolean
  changed(view: GoalView): void
  activity(goal: string, previous: NonNullable<GoalView['activity']>, activity: NonNullable<GoalView['activity']>, sentence: string): void
  ready(): { ok: true } | { ok: false; reason: string }
  seatAgent(input: GoalSeatRequest, goal: Goal): Promise<SeatRecord>
  openLegacySeat(input: {
    goal: string
    spec: FlowSeat
    permission: FlowPermission
    role: string
    isolate: boolean
    title: string
    lane?: string
  }, goal: Goal): Promise<SeatRecord>
}

/** Goals coordinate transactions; Team owns card and channel rules. */
export class GoalPlane {
  readonly #assignments: Assignments
  #lanes: LaneAllocator | null = null
  #lanePreferences: (() => import('@harnessdesk/protocol').LanePreferences) | null = null
  readonly #activity = new Map<string, NonNullable<GoalView['activity']>>()

  constructor(
    readonly store: GoalStore,
    private readonly port: GoalPlanePort,
    readonly serial = new Serial(),
    private readonly now: () => number = Date.now,
  ) {
    this.#assignments = new Assignments({
      goal: (id) => { this.#dispatch(id); return this.store.read(id).goal },
      seats: () => port.seats.all(),
      known: (runtime, session) => port.known(runtime, session),
      claimable: (goal, card, session) => port.claimable(goal, card, session),
      commit: (goal, card, session) => this.#assign(goal, card, session),
    }, serial)
  }

  attachLanes(lanes: LaneAllocator, preferences: () => import('@harnessdesk/protocol').LanePreferences): void {
    if (this.#lanes && this.#lanes !== lanes) throw new Error('This Goal plane already has its lane allocator.')
    this.#lanes = lanes
    this.#lanePreferences = preferences
  }

  laneFor(seat: SeatId): import('@harnessdesk/protocol').Lane | null {
    if (!this.#lanes) throw new Error('Read the lane registry before opening a Goal Seat.')
    return this.#lanes.forSeat(seat)
  }

  async list(root?: string): Promise<readonly GoalView[]> {
    return Promise.all(this.store.list().filter((one) => root === undefined || one.goal.root === root)
      .map((one) => this.view(one.goal.id)))
  }

  async view(id: string): Promise<GoalView> {
    const document = this.store.read(id)
    const members = goalMembers(document, this.port.seats.all())
    const board = { ...this.port.board(id), ...memberProjection(document, this.port.seats.all()) }
    let evidence: BoardEvidence | null = null
    let problem = this.store.problem
    try {
      evidence = await this.port.evidence(id)
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }
    const run = this.port.flow(id)
    const placements = board.intents.map((intent) => placeCard({
      intent,
      evidence: evidence?.cards.find((card) => card.card === intent.id),
      stranded: this.port.stranded(id, intent.id),
      holderWaits: intent.claim ? this.port.waits(intent.claim) : false,
      forPerson: flowRoleOf(intent, run)?.kind === 'person',
    }))
    const dependencies = this.store.list().map((one) => one.goal)
    const activity = document.restored ? null : activityOf(document.goal, {
      needsYou: this.port.held(id) || members.some((seat) => this.port.waits(seat.session)) ||
        placements.some((one) => one.column === 'needs'),
      busy: problem !== null || members.some((seat) => this.port.busy(seat.session)) ||
        placements.some((one) => one.column === 'review') ||
        (evidence?.cards.some((card) => card.running.length > 0) ?? false),
      liveFlow: run?.state === 'running' || run?.state === 'stalled',
      cards: board.intents,
      dependencies,
    })
    return {
      goal: document.goal,
      activity,
      waitingOn: document.goal.dependsOn.flatMap((dependency) => {
        const found = dependencies.find((one) => one.id === dependency)
        return found?.state === 'wrapped' ? [] : [{ id: dependency, sentence: found?.sentence ?? 'A missing Goal' }]
      }),
      members, board, receipt: document.receipt,
      problem: document.restored ? 'This Goal came from a backup. Start a new Goal to continue its work.' : problem,
    }
  }

  async refresh(id: string): Promise<void> {
    const view = await this.view(id)
    const previous = this.#activity.get(id)
    if (view.activity === null) this.#activity.delete(id)
    else this.#activity.set(id, view.activity)
    this.port.changed(view)
    if (previous !== undefined && view.activity !== null && previous !== view.activity) {
      this.port.activity(id, previous, view.activity, view.goal.sentence)
    }
  }

  async create(input: GoalCreateInput): Promise<GoalView> {
    return this.serial.run(async () => {
      const ready = this.port.ready()
      if (!ready.ok) throw new Error(ready.reason)
      const sentence = input.sentence.trim()
      if (!sentence || sentence.length > 2000) throw new Error('Write a Goal in 1 to 2000 characters.')
      const { root, cwd } = await this.port.confine(input)
      const at = this.now()
      const goal: Goal = {
        id: `goal-${randomUUID()}`, root, cwd, sentence,
        state: 'open', revision: 0, checkout: input.checkout ?? 'shared',
        dependsOn: [], origin: input.origin ?? { kind: 'person' },
        createdAt: at, updatedAt: at, receipt: null,
      }
      const dependsOn = checkedDependencies(goal, input.dependsOn ?? [], this.store.list().map((one) => one.goal))
      await this.store.save({
        version: 1, goal: { ...goal, dependsOn },
        board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
        citations: [], receipt: null, operation: null,
      }, null)
      const view = await this.view(goal.id)
      this.#rememberAndPublish(view)
      return view
    })
  }

  update(id: string, revision: number, patch: { sentence?: string; dependsOn?: readonly string[] }): Promise<GoalView> {
    return this.serial.run(async () => {
      const document = this.store.read(id)
      this.#editable(document)
      if (document.goal.revision !== revision) throw new Error('This Goal changed. Read it again before saving.')
      if (patch.dependsOn !== undefined && goalMembers(document, this.port.seats.all()).some((seat) => this.port.busy(seat.session))) {
        throw new Error('Wait for this Goal’s turns to finish before changing its dependencies.')
      }
      const sentence = patch.sentence?.trim() ?? document.goal.sentence
      if (!sentence || sentence.length > 2000) throw new Error('Write a Goal in 1 to 2000 characters.')
      const dependsOn = checkedDependencies(document.goal, patch.dependsOn ?? document.goal.dependsOn,
        this.store.list().map((one) => one.goal))
      await this.store.save({ ...document, goal: {
        ...document.goal, sentence, dependsOn, revision: revision + 1, updatedAt: this.now(),
      } }, revision)
      const view = await this.view(id)
      this.#rememberAndPublish(view)
      return view
    })
  }

  dependenciesReady(id: string): boolean {
    const documents = this.store.list()
    return this.store.read(id).goal.dependsOn.every((dependency) =>
      documents.find((one) => one.goal.id === dependency)?.goal.state === 'wrapped',
    )
  }

  canDispatch(id: string): { ok: true } | { ok: false; reason: string } {
    const ready = this.port.ready()
    if (!ready.ok) return ready
    if (this.store.problem) return { ok: false, reason: this.store.problem }
    const document = this.store.read(id)
    if (document.restored) return { ok: false, reason: 'This Goal came from a backup. Start a new Goal to continue its work.' }
    if (document.goal.state !== 'open') return { ok: false, reason: 'This Goal is closing or wrapped. Start another Goal for new work.' }
    if (document.operation) return { ok: false, reason: 'This Goal has an unfinished operation. Finish recovery before starting work.' }
    if (!this.dependenciesReady(id)) return { ok: false, reason: 'This Goal is waiting for its dependencies to wrap.' }
    return { ok: true }
  }

  assign(goal: string, card: number, session: SessionPointer): Promise<SeatRecord> {
    return this.#assignments.assign(goal, card, session)
  }

  async #assign(goal: string, card: number, session: SessionPointer): Promise<SeatRecord> {
    const document = this.store.read(goal)
    const opening = await this.port.opening(goal, session, randomUUID())
    const close = this.port.seats.all().filter((seat) => !seat.closed && !seat.restored && seat.board === null &&
      seat.session.runtime === session.runtime && seat.session.sessionId === session.sessionId).map((seat) => seat.id)
    const operation = { kind: 'assignment', id: randomUUID(), goal, card, opening, close } as const
    await this.#stage(document, operation)
    await recoverOperation(operation, this.port)
    const kept = this.port.seats.byId(opening.id)
    if (!kept) throw new Error('The assigned Seat could not be read back. Finish recovery before starting work.')
    await this.refresh(goal)
    return kept
  }

  release(goal: string, id: SeatId): Promise<void> {
    return this.serial.run(async () => {
      const document = this.store.read(goal)
      this.#editable(document)
      const record = this.port.seats.byId(id)
      if (!record || record.board !== goal || record.restored) throw new Error('That Seat is not kept on this Goal.')
      if (record.closed) return
      if (this.port.busy(record.session)) throw new Error("Stop this Seat's current turn before releasing it")
      const operation = { kind: 'release', id: randomUUID(), goal, seat: id, reason: 'released' } as const
      await this.#stage(document, operation)
      await recoverOperation(operation, this.port)
      await this.refresh(goal)
    })
  }

  seat(input: GoalSeatRequest): Promise<SeatRecord> {
    return this.serial.run(async () => {
      this.#dispatch(input.goal)
      const goal = this.store.read(input.goal).goal
      const record = await this.#withLane(goal, input.isolate ?? goal.checkout === 'isolated', (where) => this.port.seatAgent(input, where))
      await this.refresh(input.goal)
      return record
    })
  }

  openLegacySeat(input: Parameters<GoalPlanePort['openLegacySeat']>[0]): Promise<SeatRecord> {
    return this.serial.run(async () => {
      this.#dispatch(input.goal)
      const goal = this.store.read(input.goal).goal
      const record = await this.#withLane(goal, input.isolate, (where) => this.port.openLegacySeat(input, where))
      await this.refresh(input.goal)
      return record
    })
  }

  async recover(): Promise<void> {
    await this.serial.run(async () => {
      for (const document of this.store.list()) {
        if (!document.restored && document.operation) await recoverOperation(document.operation, this.port)
      }
      if (this.#lanes) await this.#lanes.recover(this.port.seats.all())
    })
  }

  async #withLane(goal: Goal, isolate: boolean, open: (where: Goal) => Promise<SeatRecord>): Promise<SeatRecord> {
    if (!isolate) return open(goal)
    if (!this.#lanes || !this.#lanePreferences) throw new Error('Read the lane settings before seating this Goal.')
    const lane = await this.#lanes.allocate(goal.id, randomUUID(), this.#lanePreferences())
    try {
      const seat = await open({ ...goal, cwd: lane.cwd })
      if (seat.board !== goal.id || seat.checkout.cwd !== lane.cwd) throw new Error('The recorded Seat did not use its allocated checkout. Finish recovery before dispatching work.')
      await this.#lanes.bind(lane.id, seat.id)
      return seat
    } catch (error) {
      await this.#lanes.retain(lane.id)
      throw new Error(`${error instanceof Error ? error.message : String(error)} Lane ${lane.id} was retained for review; its checkout and ports were kept.`)
    }
  }

  async #stage(document: GoalDocument, operation: NonNullable<GoalDocument['operation']>): Promise<void> {
    await this.store.save({ ...document, operation, goal: {
      ...document.goal, revision: document.goal.revision + 1, updatedAt: this.now(),
    } }, document.goal.revision)
  }

  #editable(document: GoalDocument): void {
    const ready = this.port.ready()
    if (!ready.ok) throw new Error(ready.reason)
    if (document.restored || document.goal.state !== 'open' || document.operation) {
      throw new Error('This Goal is read-only or is finishing an operation. Start another Goal for new work.')
    }
  }

  #dispatch(id: string): void {
    const ready = this.canDispatch(id)
    if (!ready.ok) throw new Error(ready.reason)
  }

  #rememberAndPublish(view: GoalView): void {
    if (view.activity === null) this.#activity.delete(view.goal.id)
    else this.#activity.set(view.goal.id, view.activity)
    this.port.changed(view)
  }
}
