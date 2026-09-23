import { randomUUID } from 'node:crypto'

import {
  activityOf, checkedDependencies, flowStepOf, placeCard,
  type BoardEvidence, type FlowExecution, type FlowPermission, type FlowRun, type FlowSeat,
  type Goal, type GoalCitation, type GoalCreateInput, type GoalReceipt, type GoalSeatRequest, type GoalView,
  type Intent, type SeatId, type SeatRecord, type SessionPointer, type TeamState,
  type WrapChoices, type WrapPreview,
} from '@harnessdesk/protocol'

import type { SeatOpening } from '../evidence/records.js'
import { Assignments, Serial } from './assignments.js'
import type { LaneAllocator } from './lanes.js'
import { goalMembers, memberProjection } from './members.js'
import { recoverOperation, type GoalOperationPort } from './operations.js'
import { GoalStore, type GoalDocument } from './store.js'
import { citationBlob, previewWrap, Wraps, type WrapInput } from './wrap.js'

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
  evidenceIds(goal: string, project: string): Promise<readonly string[]>
  flow(goal: string): FlowRun | undefined
  busy(session: SessionPointer): boolean
  waits(session: SessionPointer): boolean
  stranded(goal: string, card: number): boolean
  held(goal: string): boolean
  settledFor(goal: string): Promise<void>
  answer(seat: SeatRecord): Promise<{
    readonly answer: GoalReceipt['answers'][number] | null
    readonly gaps: readonly string[]
  }>
  revision(cwd: string): Promise<{ readonly head: string | null; readonly dirty: boolean | null }>
  /**
   * A Goal's view moved. `install: false` when the caller only wants windows
   * told — a flow run's own state changed and the Goal store did not — so a
   * view read before the board's own pending write lands is never installed
   * over the newer board the desk holds in memory.
   */
  changed(view: GoalView, options?: { readonly install: boolean }): void
  activity(goal: string, previous: NonNullable<GoalView['activity']>, activity: NonNullable<GoalView['activity']>, sentence: string): void
  ready(): { ok: true } | { ok: false; reason: string }
  /** Stops every flow run dispatching on this Goal, inside each run's own queue, before a wrap is taken. */
  stopFlows?(goal: string): Promise<void>
  /** Whether a run on this Goal (not only an old room's run) is still running or stalled. */
  flowLive?(goal: string): boolean
  /** The runs on this Goal, as the flow engine keeps them: which of its cards are a person's steps. */
  executions?(goal: string): readonly FlowExecution[]
  /** The Goal's cards as they stand — the board's one writer's copy — which a wrap reviews. Absent, the document's. */
  cards?(goal: string): readonly Intent[]
  /** Refuses every change to the Goal's board, with `reason`, until the answer is called. */
  holdBoard?(goal: string, reason: string): () => void
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

/** Why a Goal's board takes no change while it wraps. */
export const WRAPPING = 'This Goal is wrapping, so its board takes no new work. Start another Goal for it.'

/** Goals coordinate transactions; Team owns card and channel rules. */
export class GoalPlane {
  readonly #assignments: Assignments
  readonly #wraps: Wraps
  #lanes: LaneAllocator | null = null
  #lanePreferences: (() => import('@harnessdesk/protocol').LanePreferences) | null = null
  readonly #activity = new Map<string, NonNullable<GoalView['activity']>>()
  readonly #recoveryProblems = new Map<string, string>()

  constructor(
    readonly store: GoalStore,
    private readonly port: GoalPlanePort,
    readonly serial = new Serial(),
    private readonly now: () => number = Date.now,
    private readonly citationCheck: typeof citationBlob = citationBlob,
  ) {
    this.#assignments = new Assignments({
      goal: (id) => { this.#dispatch(id); return this.store.read(id).goal },
      seats: () => port.seats.all(),
      known: (runtime, session) => port.known(runtime, session),
      claimable: (goal, card, session) => port.claimable(goal, card, session),
      commit: (goal, card, session) => this.#assign(goal, card, session),
    }, serial)
    this.#wraps = new Wraps({
      hold: (goal) => this.port.holdBoard?.(goal, WRAPPING) ?? (() => {}),
      read: (goal) => this.#wrapInput(goal),
      stage: (goal, receipt, stamp) => this.#stageWrap(goal, receipt, stamp),
      closeSeats: (goal, ids) => this.#closeWrapSeats(goal, ids),
      finish: (goal, receipt) => this.#finishWrap(goal, receipt),
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
    let problem = this.#recoveryProblems.get(id) ?? this.store.problem
    try {
      evidence = await this.port.evidence(id)
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }
    const run = this.port.flow(id)
    const executions = this.port.executions?.(id) ?? []
    const placements = board.intents.map((intent) => placeCard({
      intent,
      evidence: evidence?.cards.find((card) => card.card === intent.id),
      stranded: this.port.stranded(id, intent.id),
      holderWaits: intent.claim ? this.port.waits(intent.claim) : false,
      forPerson: flowStepOf(intent, run, executions)?.kind === 'person',
    }))
    const dependencies = this.store.list().map((one) => one.goal)
    const activity = document.restored ? null : activityOf(document.goal, {
      needsYou: this.port.held(id) || members.some((seat) => this.port.waits(seat.session)) ||
        placements.some((one) => one.column === 'needs'),
      busy: problem !== null || members.some((seat) => this.port.busy(seat.session)) ||
        placements.some((one) => one.column === 'review') ||
        (evidence?.cards.some((card) => card.running.length > 0) ?? false),
      liveFlow: run?.state === 'running' || run?.state === 'stalled' || (this.port.flowLive?.(id) ?? false),
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

  async refresh(id: string, options: { readonly install: boolean } = { install: true }): Promise<void> {
    const view = await this.view(id)
    const previous = this.#activity.get(id)
    if (view.activity === null) this.#activity.delete(id)
    else this.#activity.set(id, view.activity)
    this.port.changed(view, options)
    if (previous !== undefined && view.activity !== null && previous !== view.activity) {
      this.port.activity(id, previous, view.activity, view.goal.sentence)
    }
  }

  /**
   * Restores the comparison point for activity notifications after a host
   * restart. This deliberately publishes nothing: the first notification on a
   * new launch must describe a change that happened after the baseline, not
   * the state that was merely read back from disk.
   */
  async hydrateActivity(): Promise<void> {
    for (const document of this.store.list()) {
      const view = await this.view(document.goal.id)
      if (view.activity === null) this.#activity.delete(document.goal.id)
      else this.#activity.set(document.goal.id, view.activity)
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

  async preview(goal: string, choices: WrapChoices): Promise<WrapPreview> {
    await this.port.settledFor(goal)
    return this.serial.run(async () => previewWrap(await this.#wrapInput(goal), structuredClone(choices)))
  }

  async wrap(goal: string, stamp: string, choices: WrapChoices): Promise<GoalReceipt> {
    await this.port.settledFor(goal)
    /*
     * Validate before touching anything a refusal must leave alone. A stamp
     * from `preview` can only ever have been taken while flow dispatch read
     * as not live — `previewWrap` itself refuses otherwise — so checking as
     * if it were already stopped is exactly what redoing the same preview
     * would show once it is: every other input still has to match untouched.
     * A wrap stale for any other reason — the sentence changed, a card
     * moved — is refused right here, and this run was never stopped for it.
     */
    const approved = structuredClone(choices)
    const input = await this.#wrapInput(goal)
    const ready = previewWrap({ ...input, flow: false }, approved)
    if (ready.stamp !== stamp) throw new Error('This Goal changed while you reviewed its receipt. Review it again.')
    // Only now, with the wrap otherwise certain to proceed: the barrier — no
    // round opens and no Seat is sent work once wrapping has begun.
    await this.port.stopFlows?.(goal)
    return this.#wraps.commit(goal, stamp, choices, randomUUID(), this.now())
  }

  async receipt(goal: string): Promise<GoalReceipt | null> {
    return this.store.read(goal).receipt
  }

  cite(goal: string, citation: GoalCitation): Promise<void> {
    return this.serial.run(async () => {
      let target = this.store.read(goal)
      this.#editable(target)
      const source = this.store.read(citation.goal)
      if (source.goal.root !== target.goal.root || citation.project !== target.goal.root) {
        throw new Error('Citations must come from a wrapped Goal in this project.')
      }
      if (source.goal.state !== 'wrapped' || source.receipt?.id !== citation.receipt) {
        throw new Error('Choose an existing wrapped receipt.')
      }
      await this.citationCheck(target.goal.root, citation.path, citation.at)
      target = this.store.read(goal)
      this.#editable(target)
      const currentSource = this.store.read(citation.goal)
      if (currentSource.goal.state !== 'wrapped' || currentSource.receipt?.id !== citation.receipt ||
          currentSource.goal.root !== target.goal.root) throw new Error('Choose an existing wrapped receipt.')
      const exact = JSON.stringify(citation)
      if (target.citations.some((one) => JSON.stringify(one) === exact)) return
      const dependsOn = checkedDependencies(target.goal,
        target.goal.dependsOn.includes(citation.goal) ? target.goal.dependsOn : [...target.goal.dependsOn, citation.goal],
        this.store.list().map((one) => one.goal))
      await this.store.save({
        ...target,
        citations: [...target.citations, structuredClone(citation)],
        goal: { ...target.goal, dependsOn, revision: target.goal.revision + 1, updatedAt: this.now() },
      }, target.goal.revision)
    })
  }

  seat(input: GoalSeatRequest): Promise<SeatRecord> {
    return this.serial.run(async () => {
      this.#dispatch(input.goal)
      const goal = this.store.read(input.goal).goal
      const record = await this.#withLane(goal, input.isolate ?? goal.checkout === 'isolated', (where) => this.port.seatAgent(input, where))
      if (input.card !== undefined) {
        try {
          await this.port.claim(input.goal, input.card, record)
        } catch (error) {
          await this.port.closeId(record.id, 'released')
          throw error
        }
      }
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
        if (document.restored || !document.operation) continue
        try {
          await recoverOperation(document.operation, this.port)
          this.#recoveryProblems.delete(document.goal.id)
        } catch (error) {
          if (document.operation.kind !== 'wrap') throw error
          this.#recoveryProblems.set(document.goal.id,
            `Wrapping could not finish: ${error instanceof Error ? error.message : String(error)}. Restart to retry recovery.`)
        }
      }
      if (this.#lanes) await this.#lanes.recover(this.port.seats.all())
    })
  }

  async #wrapInput(id: string): Promise<WrapInput> {
    const document = this.store.read(id)
    const evidence = await this.port.evidence(id)
    if (evidence.unreadable) throw new Error(`This Goal's evidence cannot be read: ${evidence.unreadable}`)
    const seats = this.port.seats.all()
      .filter((seat) => seat.board === id && !seat.restored)
      .sort((left, right) => left.openedAt - right.openedAt || String(left.id).localeCompare(String(right.id)))
    const answersRead = await Promise.all(seats.map((seat) => this.port.answer(seat)))
    const lanes = (this.#lanes?.list() ?? []).filter((lane) => lane.goal === id && lane.state !== 'released')
    const folders = [...new Set([document.goal.cwd, ...seats.map((seat) => seat.checkout.cwd), ...lanes.map((lane) => lane.cwd)].filter(Boolean))].sort()
    const revisions = await Promise.all(folders.map(async (cwd) => ({ cwd, ...await this.port.revision(cwd) })))
    const revisionByCwd = new Map(revisions.map((revision) => [revision.cwd, revision]))
    const evidenceIds = [...await this.port.evidenceIds(id, document.goal.root)].sort()
    const gaps = [
      ...answersRead.flatMap((read) => read.gaps),
      ...(evidenceIds.length === 0 ? ['No evidence was recorded for this Goal.'] : []),
      ...revisions.filter((revision) => revision.head === null || revision.dirty === null)
        .map((revision) => `Revision state was unavailable for ${revision.cwd}.`),
    ]
    return structuredClone({
      goal: document.goal,
      cards: (this.port.cards?.(id) ?? document.board.intents).map((card) => ({ id: card.id, state: card.state })),
      dependencies: this.store.list().map((one) => ({ id: one.goal.id, state: one.goal.state })),
      busy: goalMembers(document, this.port.seats.all()).some((seat) => this.port.busy(seat.session)) ||
        evidence.cards.some((card) => card.running.length > 0),
      flow: ['running', 'stalled'].includes(this.port.flow(id)?.state ?? '') || (this.port.flowLive?.(id) ?? false),
      pending: document.board.channel.some((entry) => entry.kind === 'message' && ['queued', 'held'].includes(entry.state)) ||
        goalMembers(document, this.port.seats.all()).some((seat) => this.port.waits(seat.session)),
      seats: seats.map((seat) => seat.id),
      evidence: evidenceIds,
      answers: answersRead.flatMap((read) => read.answer ? [read.answer] : []),
      lanes: lanes.map((lane) => ({
        lane: lane.id,
        cwd: lane.cwd,
        dirty: revisionByCwd.get(lane.cwd)?.dirty ?? null,
        retained: true as const,
      })).sort((left, right) => left.lane.localeCompare(right.lane)),
      citations: [...document.citations].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      gaps: [...new Set(gaps)].sort(),
      revisions,
    } satisfies WrapInput)
  }

  async #stageWrap(goal: string, receipt: GoalReceipt, stamp: string): Promise<void> {
    const document = this.store.read(goal)
    this.#editable(document)
    const operation = { kind: 'wrap', id: randomUUID(), goal, stamp, receipt } as const
    await this.store.save({
      ...document,
      operation,
      goal: { ...document.goal, state: 'wrapping', revision: document.goal.revision + 1, updatedAt: this.now() },
    }, document.goal.revision)
  }

  async #closeWrapSeats(goal: string, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const seat = this.port.seats.byId(id)
      if (!seat || seat.board !== goal || seat.restored) throw new Error('A reviewed Seat no longer belongs to this Goal. Finish recovery before wrapping again.')
      if (!seat.closed) await this.port.closeId(id, 'wrapped')
      await this.port.releaseClaim(goal, id)
      await this.port.refuseMail(goal, id)
      await this.port.retainLane(id)
    }
  }

  async #finishWrap(goal: string, receipt: GoalReceipt): Promise<void> {
    const document = this.store.read(goal)
    const operation = document.operation
    if (operation?.kind !== 'wrap' || operation.receipt.id !== receipt.id) {
      throw new Error('Another Goal operation replaced this wrap. Finish recovery first.')
    }
    await this.port.finishWrap(operation)
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
