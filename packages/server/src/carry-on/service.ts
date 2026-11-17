import { randomUUID } from 'node:crypto'
import {
  CarryOnStaleError,
  itemId,
  runtimeId,
  sessionId as makeSessionId,
  type CarryOnCause,
  type CarryOnChoice,
  type CarryOnDecision,
  type CarryOnIncidentView,
  type CarryOnItem,
  type CarryOnKey,
  type CarryOnMode,
  type CarryOnOwner,
  type CarryOnPhase,
  type CarryOnScope,
  type CarryOnSide,
  type CarryOnTarget,
  type ModelInfo,
  type TurnError,
} from '@harnessdesk/protocol'

import {
  CARRY_ON_HOPS,
  CONTINUE_TEXT,
  chooseModel,
  decide,
  limitCauseOf,
  targetStateOf,
  type CarryOnAction,
  type CarryOnCandidate,
  type DecideInput,
} from './decide.js'
import {
  BACKOFF_MS,
  CarryOnIncidents,
  CarryOnCapacityError,
  markerReceiptCeiling,
  LIVE_STATES,
  HANDLED_LIMIT,
  RETRY_ATTEMPTS,
  UNWRITTEN_LIMIT,
  afterReset,
  carryOnKey,
  carryOnTurnKey,
  scheduleTimer,
  type CarryOnRecord,
  type CarryOnUnwritten,
} from './incidents.js'

/**
 * Carrying a conversation on past a usage limit: the host service.
 *
 * The host tells it when a turn ended and when the person sent something; it
 * decides (`decide.ts`), claims on disk before anything is sent, and acts
 * through the ports — close, resume, send, create — the way a window would,
 * but on the host's own path, so its sends are never mistaken for the
 * person's. Every move is announced: a marker in the transcript, which no
 * notice setting can mute, and `carryOn/changed` for the card.
 *
 * Ordinary chats and Team or Flow seats are carried here. A Lead chat keeps
 * the Lead's own recovery. A seat is never moved under its run: the flow
 * engine opens a replacement Seat for the same card (`ports.seat.replace`),
 * after its independence rules have had their say on every candidate, and the
 * Team's own notice carries the question instead of the composer card.
 */

/** One runtime, as the service needs to know it. Names only: no email, no path. */
export interface CarryOnRuntime {
  readonly id: string
  /** `slot.agent`, else its own id. */
  readonly agent: string
  /** `presentation.displayName`. */
  readonly name: string
  /** The account's nickname or ordinal, when the agent has several. */
  readonly account?: string
  readonly sessionStore: string | null
  readonly ownSessions: boolean
  readonly gateway: boolean
  /** Healthy and signed in, or a gateway, or an agent with no accounts at all. */
  readonly signedIn: boolean
  readonly resume: boolean
}

/** A Team or Flow seat, as the flow engine answers for it (piece D). */
export interface CarryOnSeatPorts {
  /** Null when no running run holds this seat: it is then left to its own recovery. */
  readonly of: (runtime: string, sessionId: string) => Promise<{ readonly blind: boolean; readonly overBudget: boolean } | null>
  /** Why `target` may not take this seat — its run's independence rules, either way — or null. */
  readonly refuse: (runtime: string, sessionId: string, target: string) => Promise<string | null>
  /** Opens the replacement Seat for the same card; the old one is closed with `limit`. */
  readonly replace: (from: { readonly runtime: string; readonly sessionId: string }, to: { readonly runtime: string; readonly mode: CarryOnMode; readonly model?: string }) =>
    Promise<{ readonly runtime: string; readonly sessionId: string } | { readonly refused: string; readonly beforeEffect?: true }>
  /** Carry-on let this seat go (stopped, or the replacement's first message failed): its own recovery runs now. */
  readonly recover: (runtime: string, sessionId: string) => void
}

/** A fresh reading of the stuck account. */
export interface CarryOnMeter {
  readonly reached: boolean
  readonly blocked: boolean
  readonly resetsAt: number | null
}

export interface CarryOnPorts {
  readonly file: string
  readonly now?: () => number
  readonly schedule?: (run: () => void, delay: number) => () => void
  readonly problem?: (reason: string) => void
  readonly capacityNotice?: (runtime: string, sessionId: string, reason: string, kind: 'capacity' | 'uncertain') => void
  readonly owner: (runtime: string, sessionId: string) => Promise<CarryOnOwner>
  /** The rule for this agent, already resolved: its own `whenOut`, else the desk's. */
  readonly policy: (agent: string) => { readonly choice: CarryOnChoice; readonly from: CarryOnScope; readonly otherAgents: boolean }
  readonly describe: (runtime: string) => CarryOnRuntime | null
  /** Every runtime, in the person's pool order. */
  readonly runtimes: () => readonly string[]
  /** The pacing tier and reset, from cached usage; never a vendor call. */
  readonly rank: (runtime: string) => { readonly tier: 0 | 1 | 2 | 3; readonly resetsAt: number | null }
  /** A fresh meter read of one account, null when it has none. */
  readonly meter: (runtime: string) => Promise<CarryOnMeter | null>
  readonly models: (runtime: string) => Promise<readonly ModelInfo[]>
  /** The model the conversation is on, when the host knows it. */
  readonly modelOf: (runtime: string, sessionId: string) => string | undefined
  readonly titleOf: (runtime: string, sessionId: string) => string
  /** A turn running or a send on its way. */
  readonly busy: (runtime: string, sessionId: string) => boolean
  /**
   * With `lease`, closes only while that lease still holds: the handle carry-on attached, with no other open of the
   * conversation since. A later handle, or another caller handed the same one, is somebody else's.
   */
  readonly close: (runtime: string, sessionId: string, lease?: string) => Promise<void>
  /**
   * Opens the conversation there. Returns carry-on's lease on what its own call attached, or null when it was
   * already open or being opened, or another caller opened it alongside: then it is not carry-on's.
   */
  readonly resume: (runtime: string, sessionId: string, model?: string) => Promise<string | null>
  /**
   * What has happened in a conversation, as one comparable string: its handle, its turns, what runs. Equal
   * before and after means nothing but carry-on touched it; null when it is not open.
   */
  readonly footprint: (runtime: string, sessionId: string) => string | null
  /** The currently attached handle generation, captured before dispatch. */
  readonly incarnation?: (runtime: string, sessionId: string) => string | null
  /**
   * On the host's path, never counted as the person's message. Both kinds go as the desk's own context: a `packet`
   * is already enveloped, and `continue` is the one line that asks the agent to go on, wrapped by the host.
   */
  readonly send: (runtime: string, sessionId: string, text: string, kind: 'continue' | 'packet', stillOurs: () => boolean,
    /** Called once the host has admitted the send at its effect boundary, right before it leaves, with the turns the conversation already had. */
    admitted?: (known: readonly string[]) => void,
    /** Into a Team or Flow Seat: the host must find the run's own gate for it, and refuses the send when it cannot. */
    seat?: boolean,
    /** The actual send's turn ID, never a queue ID or a guessed next turn. */
    accepted?: (turnId: string, incarnation: string) => void,
    unconfirmed?: () => void) => Promise<void>
  /**
   * A new conversation on `runtime` in the stuck conversation's own folder, with carry-on's lease on the handle its
   * creation attached, taken at the attachment (null when the host could not say).
   */
  readonly create: (runtime: string, from: { readonly runtime: string; readonly sessionId: string }, model?: string) => Promise<{ readonly sessionId: string; readonly handle: string | null }>
  /** The handoff packet, built on the host from the kept transcript. */
  readonly packet: (from: { readonly runtime: string; readonly sessionId: string }, meta: { readonly fromName: string; readonly fromAccount?: string; readonly at: number; readonly blind?: boolean }) => Promise<string>
  readonly record: (runtime: string, sessionId: string, item: CarryOnItem, turnId: string) => boolean | Promise<boolean>
  readonly publish: (key: CarryOnKey, incident: CarryOnIncidentView | null) => void
  /** "Always do this": the choice written at the level the rule was read from. */
  readonly writeRule: (scope: CarryOnScope, agent: string, choice: 'switch' | 'wait' | 'stop') => Promise<void>
  /** Team and Flow seats. Absent, a seat is never carried on. */
  readonly seat?: CarryOnSeatPorts
}

/** True while nothing the person sent has overtaken the operation that took it. */
type Fence = () => boolean

/** A conversation carry-on itself reopened or created, as it was the moment carry-on had it. */
interface Opened {
  readonly runtime: string
  readonly sessionId: string
  /** Carry-on's lease on what its own call attached: the only thing its cleanup may close. */
  readonly handle: string
  /** No message from the person into it since. */
  readonly untouched: Fence
  /** `CarryOnPorts.footprint` then; null when the host could not say, which never counts as untouched. */
  readonly footprint: string | null
}

const PERSON_FIRST = 'You sent a message first.'

/** Whether a turn ended in a way carry-on may take: failed on a limit, or failed saying nothing, and not being retried. */
export const carryOnMayTake = (turn: { readonly status: string; readonly error?: TurnError | null }): boolean => {
  const failed = turn.status === 'failed' || !!turn.error
  const code = turn.error?.code
  return failed && !turn.error?.retrying && (code === undefined || code === 'rateLimit' || code === 'credits' || code === 'unknown')
}

/** How a turn ended, as far as carry-on cares. */
export interface EndedTurn {
  readonly id: string
  readonly status: string
  readonly error?: TurnError | null
}

const joinNotes = (...notes: readonly (string | undefined)[]): string | undefined => {
  const kept = notes.filter((one): one is string => !!one)
  return kept.length ? kept.join('; ') : undefined
}

const side = (runtime: CarryOnRuntime | null, fallback: string, model?: string): CarryOnSide => ({
  name: runtime?.name || fallback,
  ...(runtime?.account ? { account: runtime.account } : {}),
  ...(model ? { model } : {}),
})

export class CarryOnService {
  readonly #incidents: CarryOnIncidents
  readonly #timers = new Map<string, () => void>()
  /**
   * Per conversation, how many times the person has sent into it. Advanced synchronously on every send, incident or
   * not, and read again after every await of an operation that might send, so a message typed while carry-on was
   * reading a meter, listing models or reopening a thread always wins.
   */
  readonly #generations = new Map<string, number>()
  /** Per seat incident, the candidates its run refused and why: read by the card and the marker note. */
  readonly #refusals = new Map<string, ReadonlyMap<string, string>>()
  /** Per seat incident, the candidates whose replacement refused to open: they stay refused for that incident. */
  readonly #unopened = new Map<string, ReadonlyMap<string, string>>()
  readonly #capacityNotified = new Set<string>()
  #closed = false
  readonly #markerWrites = new Set<Promise<boolean>>()
  constructor(private readonly ports: CarryOnPorts) {
    this.#incidents = new CarryOnIncidents({
      file: ports.file,
      ...(ports.problem ? { problem: ports.problem } : {}),
      evicted: key => this.#cancelTimer(key),
    })
  }

  #now(): number { return (this.ports.now ?? Date.now)() }

  #fence(runtime: string, sessionId: string): Fence {
    return this.#fenceAt(runtime, sessionId, this.#generations.get(carryOnKey(runtime, sessionId)) ?? 0)
  }

  #fenceAt(runtime: string, sessionId: string, at: number): Fence {
    const key = carryOnKey(runtime, sessionId)
    return () => !this.#closed && (this.#generations.get(key) ?? 0) === at
  }

  /** A destination carry-on opened is still only carry-on's: nobody sent into it, nothing runs, nothing else changed it. */
  #untouched(opened: Opened): boolean {
    return opened.untouched() && !this.ports.busy(opened.runtime, opened.sessionId) &&
      opened.footprint !== null && this.ports.footprint(opened.runtime, opened.sessionId) === opened.footprint
  }

  // ------------------------------------------------------------ reading

  /** The incidents read from disk: a reader outside the queue (a restart's own recovery) waits for this, never for the queue. */
  loaded(): Promise<void> { return this.#incidents.loaded() }

  /** Whether an incident still holds this conversation: the host leaves its own re-arms alone while one does. */
  live(runtime: string, sessionId: string): boolean {
    const record = this.#incidents.get(runtime, sessionId)
    return !!record && LIVE_STATES.has(record.state)
  }

  /** What a reconnecting window loads: every live incident the composer shows. */
  list(): readonly CarryOnIncidentView[] {
    // A seat's question is listed too (its Team notice answers it); a Lead's never is. And one whose marker the
    // conversation could not take yet: until it is written, the card is the only record.
    return this.#incidents.all().filter(record => record.owner !== 'lead' && !record.throttle &&
      (LIVE_STATES.has(record.state) || !!record.unwritten?.length || !!record.reservation)).map(record => this.#view(record))
  }

  idle(): Promise<void> { return this.#incidents.idle() }

  /** Drain only storage work; a hung native send must not hold shutdown open. */
  async storageIdle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([...this.#markerWrites])
      await this.#incidents.storageIdle()
      if (this.#markerWrites.size === 0) return
    }
  }

  close(): void {
    this.#closed = true
    for (const cancel of this.#timers.values()) cancel()
    this.#timers.clear()
  }

  // ------------------------------------------------------------ candidates

  #candidates(record: Pick<CarryOnRecord, 'runtime' | 'agent'> & { readonly incidentId?: string }): CarryOnCandidate[] {
    const stuck = this.ports.describe(record.runtime)
    const refusals = record.incidentId ? this.#refusals.get(record.incidentId) : undefined
    return this.ports.runtimes().flatMap(id => {
      if (id === record.runtime) return []
      const runtime = this.ports.describe(id)
      if (!runtime) return []
      const { tier, resetsAt } = this.ports.rank(id)
      return [{
        runtime: id, agent: runtime.agent, name: runtime.name, ...(runtime.account ? { account: runtime.account } : {}),
        tier, resetsAt,
        sameThread: !!stuck?.sessionStore && stuck.sessionStore === runtime.sessionStore && !runtime.ownSessions,
        gateway: runtime.gateway, signedIn: runtime.signedIn, resume: runtime.resume,
        ...(refusals?.has(id) ? { refused: refusals.get(id)! } : {}),
      }]
    })
  }

  #input(record: CarryOnRecord, choice: CarryOnChoice, from: CarryOnScope, otherAgents: boolean, target?: string): DecideInput {
    return {
      choice, from, otherAgents, stuck: { runtime: record.runtime, agent: record.agent }, resetsAt: record.resetsAt,
      candidates: this.#candidates(record), tried: record.tried, hops: record.hops, ...(target !== undefined ? { target } : {}),
    }
  }

  /**
   * The input for a decision, read fresh. A seat's run has its say first: each
   * candidate its independence rules refuse is skipped, with the reason kept
   * for the marker, and a run at its budget gets no switch at all.
   */
  async #inputFor(record: CarryOnRecord, choice: CarryOnChoice, from: CarryOnScope, otherAgents: boolean, target?: string): Promise<DecideInput> {
    if (record.owner !== 'seat') return this.#input(record, choice, from, otherAgents, target)
    const seat = this.ports.seat
    const facts = seat ? await seat.of(record.runtime, record.sessionId).catch(() => null) : null
    const refusals = new Map<string, string>(this.#unopened.get(record.incidentId) ?? [])
    for (const candidate of this.#candidates({ runtime: record.runtime, agent: record.agent })) {
      if (refusals.has(candidate.runtime)) continue
      const refused = facts && seat ? await seat.refuse(record.runtime, record.sessionId, candidate.runtime).catch((error: unknown) => error instanceof Error ? error.message : String(error))
        : 'this seat no longer belongs to a running run'
      if (refused) refusals.set(candidate.runtime, refused)
    }
    this.#refusals.set(record.incidentId, refusals)
    return { ...this.#input(record, choice, from, otherAgents, target), ...(facts?.overBudget ? { overBudget: true } : {}) }
  }

  /** The candidates a seat's run refused, said once for the marker. */
  #skipped(record: CarryOnRecord): string | undefined {
    const refusals = this.#refusals.get(record.incidentId)
    if (!refusals?.size) return undefined
    return [...refusals].map(([runtime, why]) => {
      const named = this.ports.describe(runtime)
      return `skipped ${named ? named.account ? `${named.name} · ${named.account}` : named.name : runtime}: ${why}`
    }).join('; ')
  }

  #target(candidate: CarryOnCandidate, mode: CarryOnMode | null, stuckAgent: string): CarryOnTarget {
    const state = targetStateOf(candidate)
    return {
      runtime: runtimeId(candidate.runtime), name: candidate.name, ...(candidate.account ? { account: candidate.account } : {}),
      mode: mode ?? (candidate.agent === stuckAgent && candidate.sameThread ? 'sameThread' : 'handoff'),
      tier: candidate.tier, ...(state ? { state } : {}),
    }
  }

  #view(record: CarryOnRecord): CarryOnIncidentView {
    let target: CarryOnTarget | undefined, others: CarryOnTarget[] = [], wait = record.resetsAt !== null && record.resetsAt > this.#now()
    if (record.state === 'asked') {
      const { otherAgents } = this.ports.policy(record.agent)
      const action = decide(this.#input(record, 'ask', record.alwaysScope, otherAgents), this.#now())
      if (action.kind === 'ask') {
        target = action.target ? this.#target(action.target, action.mode, record.agent) : undefined
        others = action.others.map(candidate => this.#target(candidate, null, record.agent))
        wait = action.wait
      }
    }
    return {
      incidentId: record.incidentId, runtime: runtimeId(record.runtime), sessionId: makeSessionId(record.sessionId), owner: record.owner,
      state: record.state, cause: record.cause, from: record.from,
      ...(record.to ? { to: record.to } : {}), ...(record.mode ? { mode: record.mode } : {}),
      ...(record.link ? { link: { runtime: runtimeId(record.link.runtime), sessionId: makeSessionId(record.link.sessionId) } } : {}),
      ...(record.resetsAt !== null ? { resetsAt: record.resetsAt } : {}),
      ...(record.nextAt !== null && record.state === 'waiting-reset' ? { nextAt: record.nextAt } : {}),
      openedAt: record.openedAt, choices: { ...(target ? { target } : {}), wait }, others, alwaysScope: record.alwaysScope,
      ...(record.note ? { note: record.note } : {}),
    }
  }

  #publish(record: CarryOnRecord): void {
    if (record.owner === 'lead' || record.throttle) return
    const key = { runtime: runtimeId(record.runtime), sessionId: makeSessionId(record.sessionId) }
    this.ports.publish(key, record.state === 'cleared' && !record.unwritten?.length && !record.reservation ? null : this.#view(record))
  }

  async #markNow(record: CarryOnRecord, at: { readonly runtime: string; readonly sessionId: string }, phase: CarryOnPhase,
    extra: { readonly to?: CarryOnSide; readonly mode?: CarryOnMode; readonly note?: string; readonly link?: { readonly runtime: string; readonly sessionId: string } } = {}, id = `carry-on-${randomUUID()}`,
    anchor?: CarryOnUnwritten['anchor'], snapshot?: CarryOnUnwritten['snapshot']): Promise<boolean> {
    if (!anchor || anchor.kind !== 'turn' || !snapshot) return false
    try {
      const { link, ...rest } = extra
      return await this.ports.record(at.runtime, at.sessionId, {
        id: itemId(id), type: 'carryOn', phase, cause: snapshot.cause, from: snapshot.from,
        ...(snapshot.resetsAt !== null && (phase === 'waiting' || phase === 'stopped' || phase === 'exhausted') ? { resetsAt: snapshot.resetsAt } : {}),
        ...rest, ...(link ? { link: { runtime: runtimeId(link.runtime), sessionId: makeSessionId(link.sessionId) } } : {}),
      }, anchor.turnId)
    } catch { return false }
  }

  #mark(record: CarryOnRecord, at: { readonly runtime: string; readonly sessionId: string }, phase: CarryOnPhase,
    extra: { readonly to?: CarryOnSide; readonly mode?: CarryOnMode; readonly note?: string; readonly link?: { readonly runtime: string; readonly sessionId: string } } = {},
    id?: string, anchor?: CarryOnUnwritten['anchor'], snapshot?: CarryOnUnwritten['snapshot']): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false)
    const write = this.#markNow(record, at, phase, extra, id, anchor, snapshot)
    this.#markerWrites.add(write)
    void write.finally(() => this.#markerWrites.delete(write)).catch(() => {})
    return write
  }

  /** Retry only a marker whose exact destination turn is already durable. */
  reachable(runtime: string, sessionId: string): Promise<void> {
    const here = (one: CarryOnUnwritten) => one.runtime === runtime && one.sessionId === sessionId
    if (this.#closed || !this.#incidents.all().some(record => record.unwritten?.some(here))) return Promise.resolve()
    return this.#incidents.serial(async () => {
      for (let record of this.#incidents.all()) {
        if (!record.unwritten?.some(here)) continue
        if (record.unwritten.some(one => !one.id)) {
          record = { ...record, unwritten: record.unwritten.map(one => one.id ? one : { ...one, id: `carry-on-${randomUUID()}` }) }
          await this.#put(record)
        }
        const waiting = record.unwritten!, still: CarryOnUnwritten[] = []
        let blocked = false
        for (const one of waiting) {
          if (!here(one) || blocked) { still.push(one); continue }
          const { id, runtime: _r, sessionId: _s, phase, anchor, prospective, receipt: _receipt, snapshot, ...extra } = one
          if (!prospective && await this.#mark(record, one, phase, extra, id, anchor, snapshot)) continue
          blocked = true; still.push(one)
        }
        if (still.length === waiting.length) continue
        const { unwritten: _, ...rest } = record
        const clearedIds = waiting.filter(one => !still.includes(one)).flatMap(one => one.id ? [one.id] : [])
        const releaseReservation = !still.length && record.reservation?.slots === 0 ? record.reservation.id : undefined
        const next = await this.#put({ ...rest, ...(still.length ? { unwritten: still } : {}), ...(releaseReservation ? { reservation: undefined } : {}), lastAt: this.#now() } as CarryOnRecord, undefined, { clearedIds, releaseReservation })
        if (!LIVE_STATES.has(next.state) && !next.unwritten?.length && !next.reservation) {
          this.ports.publish({ runtime: runtimeId(next.runtime), sessionId: makeSessionId(next.sessionId) }, null)
        } else this.#publish(next)
      }
    })
  }

  // ------------------------------------------------------------ timers

  #cancelTimer(key: string): void { this.#timers.get(key)?.(); this.#timers.delete(key) }

  #arm(record: CarryOnRecord): void {
    const key = carryOnKey(record.runtime, record.sessionId)
    this.#cancelTimer(key)
    if (this.#closed || record.nextAt === null || record.uncertain) return
    if (record.state !== 'waiting-reset' && record.state !== 'asked') return
    const incident = record.incidentId
    const cancel = (this.ports.schedule ?? scheduleTimer)(() => {
      this.#timers.delete(key)
      const fence = this.#fence(record.runtime, record.sessionId)
      void this.#incidents.serial(() => this.#due(record.runtime, record.sessionId, incident, fence)).catch(() => {})
    }, record.nextAt - this.#now())
    this.#timers.set(key, cancel)
  }

  /** A timer came due: the retry at the reset, or an unanswered card resolving as "Wait until reset". */
  async #due(runtime: string, sessionId: string, incident: string, fence: Fence): Promise<void> {
    const record = this.#incidents.get(runtime, sessionId)
    if (!record || record.incidentId !== incident || (record.state !== 'waiting-reset' && record.state !== 'asked') || record.uncertain) return
    if (!fence()) return
    // Someone is already using the conversation: their message is the continuation.
    if (this.ports.busy(runtime, sessionId)) { await this.#settle(record, { state: 'cleared', nextAt: null }); return }
    await this.#retry(record, fence)
  }

  // ------------------------------------------------------------ writing

  async #put(record: CarryOnRecord, replaces?: { readonly runtime: string; readonly sessionId: string }, authority?: { readonly clearedIds?: readonly string[]; readonly releaseReservation?: string; readonly receiptOperation?: string; readonly bindMarkerId?: string; readonly cancelOperation?: string; readonly cancelledIds?: readonly string[] }): Promise<CarryOnRecord> {
    if (this.#closed) throw new Error('Carry-on is closed.')
    await this.#incidents.put(record, replaces, authority)
    if (replaces) this.#cancelTimer(carryOnKey(replaces.runtime, replaces.sessionId))
    return record
  }

  async #settle(record: CarryOnRecord, patch: Partial<CarryOnRecord>, replaces?: { readonly runtime: string; readonly sessionId: string }, authority?: { readonly clearedIds?: readonly string[]; readonly releaseReservation?: string; readonly receiptOperation?: string; readonly bindMarkerId?: string; readonly cancelOperation?: string; readonly cancelledIds?: readonly string[] }): Promise<CarryOnRecord> {
    const next = await this.#put({ ...record, ...patch, lastAt: this.#now() } as CarryOnRecord, replaces, authority)
    this.#arm(next)
    this.#publish(next)
    // A seat carry-on let go goes back to its own recovery, which waited while the incident was live.
    if (next.owner === 'seat' && next.state === 'stopped' && LIVE_STATES.has(record.state)) this.#recover(next.runtime, next.sessionId)
    if (!LIVE_STATES.has(next.state)) { this.#refusals.delete(next.incidentId); this.#unopened.delete(next.incidentId) }
    return next
  }

  #notice(record: Pick<CarryOnRecord, 'runtime' | 'sessionId'>, kind: string, reason: string): void {
    const key = `${carryOnKey(record.runtime, record.sessionId)}\0${kind}`
    if (this.#capacityNotified.has(key)) return
    this.#capacityNotified.add(key)
    if (this.#capacityNotified.size > 512) this.#capacityNotified.delete(this.#capacityNotified.values().next().value!)
    this.ports.capacityNotice?.(record.runtime, record.sessionId, reason, kind === 'capacity' ? 'capacity' : 'uncertain')
  }

  #capacity(record: Pick<CarryOnRecord, 'runtime' | 'sessionId'>): void {
    this.#notice(record, 'capacity', 'Carry-on could not reserve protected space for its transcript markers. Existing markers were kept.')
  }

  async #reserve(record: CarryOnRecord, slots: 1 | 2, action: 'move' | 'retry' | 'stop' | 'wait'): Promise<CarryOnRecord | null> {
    if (this.#closed) return null
    if (record.reservation) {
      if (!record.uncertain && record.reservation.stage === 'reserved' && record.reservation.slots >= slots) return record
      this.#capacity(record); return null
    }
    try {
      const next = await this.#incidents.reserve(record, slots, action)
      this.#capacityNotified.delete(`${carryOnKey(record.runtime, record.sessionId)}\0capacity`)
      return next
    } catch (error) {
      if (!(error instanceof CarryOnCapacityError)) this.ports.problem?.('Carry-on could not preserve its marker reservation.')
      this.#capacity(record); return null
    }
  }

  /** Persist prospective intents before the effect boundary; their IDs come from the reservation. */
  async #stage(record: CarryOnRecord, entries: readonly Omit<CarryOnUnwritten, 'id' | 'prospective'>[], incarnation?: string): Promise<{ record: CarryOnRecord; markers: CarryOnUnwritten[] }> {
    const reservation = record.reservation!
    if (!reservation || reservation.slots < entries.length) throw new CarryOnCapacityError('Carry-on marker reservation is unavailable.')
    const first = reservation.markerIds.length - reservation.slots
    const markers = entries.map((one, at): CarryOnUnwritten => {
      const marker: CarryOnUnwritten = { ...one, id: reservation.markerIds[first + at]!, prospective: true,
        snapshot: { cause: record.cause, from: { name: record.from.name, ...(record.from.account ? { account: record.from.account } : {}), ...(record.from.model ? { model: record.from.model } : {}) }, resetsAt: record.resetsAt },
        ...(incarnation ? { receipt: { operationId: reservation.id, incidentId: record.incidentId, incarnation, ceilingBytes: 245_760 } } : {}) }
      if (!marker.receipt) return marker
      return { ...marker, receipt: { ...marker.receipt, ceilingBytes: markerReceiptCeiling(marker) } }
    })
    const next = await this.#put({ ...record, unwritten: [...(record.unwritten ?? []), ...markers], reservation: {
      ...reservation, slots: reservation.slots - markers.length, stage: 'effect', ...(incarnation ? { incarnation } : {}),
    } })
    return { record: next, markers }
  }

  /** Release unused slots only after the action is settled and all pending intents are materialized. */
  async #settleReserved(record: CarryOnRecord, patch: Partial<CarryOnRecord>, replaces?: { readonly runtime: string; readonly sessionId: string }, clearedIds: readonly string[] = [], keep = false): Promise<CarryOnRecord> {
    const reservation = record.reservation
    const nextReservation = keep && reservation ? { ...reservation, slots: 0, stage: 'awaitingReceipt' as const } : undefined
    return this.#settle(record, { ...patch, reservation: nextReservation }, replaces, {
      clearedIds, ...(!keep && reservation ? { releaseReservation: reservation.id } : {}),
    })
  }

  /** Bind only the receipt for this materialized slot, destination and handle incarnation. */
  #arrivalReceipt(incidentId: string, operationId: string, markerId: string, destination: { runtime: string; sessionId: string }, incarnation: string, knownTurns: () => readonly string[] | undefined, boundary?: () => string | undefined): (turn: string, owner: string) => void {
    return (turn, owner) => {
      if (this.#closed || owner !== incarnation) return
      void this.#incidents.serial(async () => {
        if (this.#closed) return
        const matches = this.#incidents.all().flatMap(record => (record.unwritten ?? []).filter(one => one.id === markerId &&
          one.runtime === destination.runtime && one.sessionId === destination.sessionId && one.receipt?.incidentId === incidentId &&
          one.receipt.operationId === operationId && one.receipt.incarnation === incarnation &&
          one.anchor?.kind === 'continuation' && one.anchor.operationId === operationId).map(marker => ({ record, marker })))
        if (matches.length !== 1) return
        const { record, marker } = matches[0]!
        const known = knownTurns()
        const anchorTurn = boundary ? boundary() : turn
        if (typeof turn !== 'string' || turn.length === 0 || turn.length > 300 || !anchorTurn || anchorTurn.length > 300 || !known || known.some(id => !id || id.length > 300)) {
          const pending = record.unwritten!.map(one => one.id === markerId ? { ...one, receipt: { ...one.receipt!, uncertain: true as const } } : one)
          const updated = await this.#put({ ...record, unwritten: pending, ...(record.incidentId === incidentId
            ? { state: 'asked' as const, uncertain: true as const, nextAt: null, note: 'The continuation was sent but its turn could not be identified. Its marker remains protected.' } : {}) }, undefined, { receiptOperation: operationId })
          this.#cancelTimer(carryOnKey(updated.runtime, updated.sessionId)); this.#publish(updated)
          this.#notice(updated, `receipt:${operationId}`, 'The continuation was sent but its turn could not be identified. Its marker remains protected.')
          return
        }
        const markers = record.unwritten!.map(one => {
          if (one.receipt?.operationId !== operationId || one.receipt.incidentId !== incidentId || one.receipt.incarnation !== incarnation) return one
          const { prospective: _prospective, ...rest } = one
          if (one.id !== markerId || one.anchor?.kind !== 'continuation') return rest
          const { kind: _kind, operationId: _operationId, ...unknownAnchor } = one.anchor
          return { ...rest, anchor: { ...unknownAnchor, kind: 'turn' as const, turnId: anchorTurn } }
        })
        const watch = record.incidentId === incidentId && record.watch?.pending && record.watch.runtime === destination.runtime && record.watch.sessionId === destination.sessionId
          ? { ...destination, skip: known.slice(-32), turnId: turn } : record.watch
        await this.#put({ ...record, unwritten: markers, watch }, undefined, { receiptOperation: operationId, bindMarkerId: markerId })
        void this.reachable(destination.runtime, destination.sessionId)
        for (const one of markers) if (one.id !== markerId && one.receipt?.operationId === operationId && one.receipt.incidentId === incidentId) void this.reachable(one.runtime, one.sessionId)
      }).catch(() => { this.ports.problem?.('A carry-on marker receipt could not be saved; it remains pending.') })
    }
  }

  #unconfirmedReceipt(incidentId: string, operationId: string, markerId: string): () => void {
    return () => {
      if (this.#closed) return
      void this.#incidents.serial(async () => {
        if (this.#closed) return
        const matches = this.#incidents.all().flatMap(record => (record.unwritten ?? []).filter(marker => marker.id === markerId &&
          marker.receipt?.incidentId === incidentId && marker.receipt.operationId === operationId).map(marker => ({ record, marker })))
        if (matches.length !== 1) return
        const { record } = matches[0]!
        const pending = record.unwritten!.map(marker => marker.id === markerId ? { ...marker, receipt: { ...marker.receipt!, uncertain: true as const } } : marker)
        const updated = await this.#put({ ...record, unwritten: pending, ...(record.incidentId === incidentId
          ? { state: 'asked' as const, uncertain: true as const, nextAt: null, note: 'The continuation may already have been sent; its marker remains protected.' } : {}) }, undefined, { receiptOperation: operationId })
        this.#cancelTimer(carryOnKey(updated.runtime, updated.sessionId)); this.#publish(updated)
        this.#notice(updated, `uncertain:${operationId}`, 'A continuation may already have been sent. Its marker remains protected.')
      }).catch(() => {})
    }
  }

  /** Called only when the synchronous admission fence proves these intents never crossed dispatch. */
  async #cancelStaged(record: CarryOnRecord): Promise<CarryOnRecord> {
    const reservation = record.reservation
    if (!reservation) return record
    const cancelled = (record.unwritten ?? []).filter(one => one.prospective && one.receipt?.operationId === reservation.id)
    if (!cancelled.length) return record
    const ids = cancelled.flatMap(one => one.id ? [one.id] : [])
    const unwritten = (record.unwritten ?? []).filter(one => !ids.includes(one.id ?? ''))
    return this.#put({ ...record, unwritten: unwritten.length ? unwritten : undefined,
      reservation: { ...reservation, slots: reservation.slots + ids.length, stage: 'reserved' } }, undefined,
      { cancelOperation: reservation.id, cancelledIds: ids })
  }

  /** Save a source marker before trying its transcript write; retain it if acknowledgement fails. */
  async #oneMarker(record: CarryOnRecord, phase: CarryOnPhase, extra: Omit<CarryOnUnwritten, 'id' | 'runtime' | 'sessionId' | 'phase' | 'anchor'>,
    patch: Partial<CarryOnRecord>): Promise<CarryOnRecord> {
    const reservation = record.reservation!
    const id = reservation.markerIds[reservation.markerIds.length - reservation.slots]!
    const anchor = { kind: 'turn' as const, turnId: record.turnId }
    const marker: CarryOnUnwritten = { id, runtime: record.runtime, sessionId: record.sessionId, phase, ...extra, anchor,
      snapshot: { cause: record.cause, from: { name: record.from.name, ...(record.from.account ? { account: record.from.account } : {}), ...(record.from.model ? { model: record.from.model } : {}) }, resetsAt: record.resetsAt } }
    const staged = await this.#put({ ...record, unwritten: [...(record.unwritten ?? []), marker],
      reservation: { ...reservation, slots: reservation.slots - 1, stage: 'effect' } })
    const written = await this.#mark(staged, marker, phase, extra, id, anchor, marker.snapshot)
    const unwritten = written ? staged.unwritten!.filter(one => one.id !== id) : staged.unwritten
    return this.#settle(staged, { ...patch, unwritten: unwritten?.length ? unwritten : undefined, reservation: undefined }, undefined,
      { ...(written ? { clearedIds: [id] } : {}), releaseReservation: reservation.id })
  }

  #recover(runtime: string, sessionId: string): void {
    try { this.ports.seat?.recover(runtime, sessionId) } catch { /* Its own recovery reports its own failures. */ }
  }

  // ------------------------------------------------------------ events

  /**
   * A turn ended. Opens an incident when it ended on a usage limit, follows a
   * move whose continuing turn this was, and backs a throttle off on the same
   * account before it ever becomes one.
   *
   * True when carry-on took this turn: a seat's own recovery (its re-arm, its
   * release) then waits, and runs through `seat.recover` if the incident is
   * let go — never both at once.
   */
  async ended(runtime: string, sessionId: string, turn: EndedTurn): Promise<boolean> {
    if (this.#closed) return false
    const failed = turn.status === 'failed' || !!turn.error
    if (turn.status === 'inProgress') return false
    // Anything the person sends from here on is the continuation, not this failure.
    const fence = this.#fence(runtime, sessionId)
    // Read the meter before the queue: it is a vendor call, and nothing else should wait on it.
    const meter = carryOnMayTake(turn)
      ? await this.ports.meter(runtime).catch(() => null) : null
    return this.#incidents.serial(async (): Promise<boolean> => {
      const cause = failed ? limitCauseOf(turn.error ?? { code: 'unknown' }, meter) : null
      if (failed && !fence()) return false
      // A turn already answered stays answered, even after its incident moved to another account.
      if (failed && this.#incidents.handled(runtime, sessionId, turn.id)) return this.live(runtime, sessionId)
      const own = this.#incidents.get(runtime, sessionId)
      const watched = this.#incidents.watching(runtime, sessionId)
      // A legacy watch has no accepted-turn receipt, so no later failure can be attributed to it.
      if (watched?.watch && !watched.throttle && !watched.watch.turnId) return false
      // A throttle's own retry is followed below, by its backoff; a move's continuation here.
      const prior = own && !own.throttle && own.watch?.runtime === runtime && own.watch.sessionId === sessionId ? own : watched?.throttle ? undefined : watched
      if (prior && !LIVE_STATES.has(prior.state)) {
        // A turn before the continuation — a replacement Seat's brief — says nothing about whether the move held.
        const before = !!prior.watch && (prior.watch.pending === true || !!prior.watch.skip?.includes(turn.id) || !!prior.watch.turnId && prior.watch.turnId !== turn.id)
        if (before) return false
        if (!failed || !cause || cause === 'throttle') {
          // The continuing turn went through, or failed for a reason of its own: the move held. A throttle there is
          // that conversation's own, backed off below.
          if (prior.watch && !before) { const { watch: _, ...rest } = prior; await this.#put({ ...rest, lastAt: this.#now() } as CarryOnRecord) }
          if (cause !== 'throttle') return false
        } else {
          if (prior.turnId === turn.id) return true
          // The continuation hit a limit too: the same incident goes on, in the conversation that now carries it.
          await this.#reopen(prior, runtime, sessionId, turn.id, cause, meter, fence)
          return true
        }
      }
      if (!failed || !cause) {
        // A throttle whose retry went through is over.
        if (own?.throttle && !failed) await this.#put({ ...own, state: 'cleared', throttle: undefined, nextAt: null, lastAt: this.#now() } as CarryOnRecord).then(() => this.#cancelTimer(carryOnKey(runtime, sessionId)))
        return false
      }
      if (own && own.turnId === turn.id) return LIVE_STATES.has(own.state)
      if (own && LIVE_STATES.has(own.state) && !own.throttle) return true
      const owner = await this.ports.owner(runtime, sessionId)
      // A Lead chat keeps the Lead's recovery. A seat no running run holds (an old room's flow) keeps its own.
      if (owner === 'lead') return false
      if (owner === 'seat' && !(this.ports.seat && await this.ports.seat.of(runtime, sessionId).catch(() => null))) return false
      if (cause === 'throttle') { await this.#throttle(own, runtime, sessionId, turn.id, fence, owner); return true }
      await this.#open(runtime, sessionId, turn.id, cause, meter, fence, owner, own?.throttle ? own : undefined)
      return true
    }).catch(error => { if (!(error instanceof CarryOnCapacityError)) throw error; this.#capacity({ runtime, sessionId }); return true })
  }

  /** The person sent something into the conversation: their message wins over any incident. */
  personSent(runtime: string, sessionId: string): Promise<void> {
    // First and synchronously, incident or not: whatever carry-on is in the middle of sees it at its next step.
    const key = carryOnKey(runtime, sessionId)
    this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1)
    if (this.#closed) return Promise.resolve()
    const record = this.#incidents.get(runtime, sessionId)
    if (!record || !LIVE_STATES.has(record.state)) return Promise.resolve()
    // Settled at once in memory order: the timer must not fire behind the person's message.
    this.#cancelTimer(carryOnKey(runtime, sessionId))
    return this.#incidents.serial(async () => {
      const current = this.#incidents.get(runtime, sessionId)
      if (!current || current.incidentId !== record.incidentId || !LIVE_STATES.has(current.state)) return
      await this.#settle(current, { state: 'cleared', nextAt: null, throttle: undefined })
    })
  }

  /** The person's answer to the card. */
  decide(decision: CarryOnDecision): Promise<CarryOnIncidentView> {
    return this.#incidents.serial(async () => {
      const record = this.#incidents.byId(decision.incidentId)
      const stale = (current: CarryOnRecord | undefined) => new CarryOnStaleError(
        'This question has already been answered or has changed.', { incident: current && current.owner !== 'lead' ? this.#view(current) : null })
      if (!record || record.state !== 'asked' || record.owner === 'lead') throw stale(record)
      const fence = this.#fence(record.runtime, record.sessionId)
      const { otherAgents } = this.ports.policy(record.agent)
      if (decision.choice === 'switch' && decision.target !== undefined) {
        const action = decide(await this.#inputFor(record, 'ask', record.alwaysScope, otherAgents), this.#now())
        const offered = action.kind === 'ask' ? [action.target, ...action.others].filter(Boolean) as CarryOnCandidate[] : []
        const pick = offered.find(candidate => candidate.runtime === decision.target)
        // Checked against now, not the card: one that has since run out, or signed out, is not there to take.
        if (!pick || !pick.signedIn || pick.tier >= 3) throw stale(record)
      }
      if (decision.choice === 'wait' && !(record.resetsAt !== null && record.resetsAt > this.#now())) throw stale(record)
      const action: CarryOnAction = decision.choice === 'stop' ? { kind: 'stop', phase: 'stopped', note: 'stopped at your answer' }
        : decide(await this.#inputFor(record, decision.choice, record.alwaysScope, otherAgents, decision.target), this.#now())
      const kind = action.kind === 'move' ? 'move' : action.kind === 'wait' ? 'wait' : action.kind === 'stop' ? 'stop' : undefined
      const reserved = kind ? await this.#reserve(record, kind === 'move' ? 2 : 1, kind) : record
      if (!reserved) return this.#view(record)
      if (decision.always) {
        try { await this.ports.writeRule(record.alwaysScope, record.agent, decision.choice) }
        catch { this.ports.problem?.('The carry-on rule could not be saved.') }
      }
      this.#cancelTimer(carryOnKey(record.runtime, record.sessionId))
      const { uncertain: _uncertain, ...answered } = reserved
      const next = await this.#act(answered as CarryOnRecord, action, fence)
      return this.#view(next)
    })
  }

  /**
   * After a restart. A claim that was sending is never replayed: it is asked
   * again, saying the message may already have gone. A wait re-arms its timer.
   */
  async restore(): Promise<void> {
    await this.#incidents.serial(async () => {
      for (let record of this.#incidents.all()) {
        const unresolved = (record.unwritten ?? []).filter(marker => marker.receipt && (marker.prospective || marker.anchor?.kind === 'continuation'))
        for (const operationId of new Set(unresolved.flatMap(marker => marker.receipt ? [marker.receipt.operationId] : []))) {
          const markers = record.unwritten!.map(marker => marker.receipt?.operationId === operationId && !marker.receipt.uncertain
            ? { ...marker, receipt: { ...marker.receipt, uncertain: true as const } } : marker)
          if (markers.some((marker, at) => marker !== record.unwritten![at])) record = await this.#put({ ...record, unwritten: markers }, undefined, { receiptOperation: operationId })
        }
        if (unresolved.some(marker => marker.receipt?.incidentId === record.incidentId) && !record.reservation) {
          if (!record.uncertain || record.state !== 'asked' || record.nextAt !== null) await this.#settle(record, { state: 'asked', nextAt: null, uncertain: true, note: 'The continuation could not be confirmed after restart. Its markers remain protected.' })
          continue
        }
        if (unresolved.length) this.#notice(record, 'unresolved', 'An earlier continuation could not be confirmed after restart. Its markers remain protected.')
        if (record.watch && !record.watch.turnId && !record.reservation && !record.throttle) {
          if (!record.uncertain || record.state !== 'asked' || record.nextAt !== null) await this.#settle(record, { state: 'asked', nextAt: null, uncertain: true, note: 'The continuation could not be identified. Its outcome remains unconfirmed.' })
          continue
        }
        if (record.reservation) {
          const there = record.to ? ` to ${record.to.account ? `${record.to.name} · ${record.to.account}` : record.to.name}` : ''
          await this.#settle(record, { state: 'asked', nextAt: null, uncertain: true, note: `The desk restarted while continuing this conversation; the message may already have been sent${there}. Its markers remain protected.`.slice(0, 300) })
          continue
        }
        if (record.state === 'sending' || record.state === 'deciding') {
          if (record.throttle) { await this.#put({ ...record, state: 'cleared', throttle: undefined, nextAt: null, lastAt: this.#now() } as CarryOnRecord); continue }
          // A send that may have gone out waits for the person: no timer, now or after a later restart, may send again.
          // The account it was going to stays off the card (it is in `tried`); the note says where to look instead.
          const there = record.to ? ` to ${record.to.account ? `${record.to.name} · ${record.to.account}` : record.to.name}` : ''
          await this.#settle(record, record.state === 'sending'
            ? { state: 'asked', nextAt: null, uncertain: true, note: `The desk restarted while continuing this conversation; the message may already have been sent${there}.`.slice(0, 300) }
            : { state: 'asked', nextAt: record.resetsAt !== null && record.resetsAt > this.#now() ? afterReset(record.resetsAt) : null })
        } else if (record.state === 'waiting-reset' || record.state === 'asked') this.#arm(record)
      }
    })
  }

  // ------------------------------------------------------------ the steps

  async #throttle(own: CarryOnRecord | undefined, runtime: string, sessionId: string, turnId: string, fence: Fence, owner: CarryOnOwner): Promise<void> {
    const spent = own?.throttle ? own.backoff ?? 0 : 0
    if (spent >= RETRY_ATTEMPTS) {
      // Backed off twice and still refused: a limit after all.
      await this.#open(runtime, sessionId, turnId, 'rateLimit', null, fence, owner, own)
      return
    }
    const described = this.ports.describe(runtime)
    const now = this.#now()
    const record: CarryOnRecord = {
      ...(own?.unwritten?.length ? { unwritten: own.unwritten } : {}),
      incidentId: own?.throttle ? own.incidentId : randomUUID(), runtime, sessionId, owner, state: 'waiting-reset', cause: 'rateLimit', turnId,
      agent: described?.agent ?? runtime, from: side(described, runtime), resetsAt: null, nextAt: now + BACKOFF_MS[spent]!,
      openedAt: own?.throttle ? own.openedAt : now, lastAt: now, tried: [], hops: 0, backoff: spent + 1, throttle: true, alwaysScope: 'desk',
      handled: [...(own?.throttle ? own.handled ?? [] : []), carryOnTurnKey(runtime, sessionId, turnId)].slice(-HANDLED_LIMIT),
    }
    await this.#put(record)
    this.#arm(record)
  }

  async #open(runtime: string, sessionId: string, turnId: string, cause: CarryOnCause, meter: { readonly resetsAt: number | null } | null, fence: Fence, owner: CarryOnOwner, throttled?: CarryOnRecord): Promise<void> {
    const described = this.ports.describe(runtime)
    const agent = described?.agent ?? runtime
    const model = this.ports.modelOf(runtime, sessionId)
    const rule = this.ports.policy(agent)
    const now = this.#now()
    const resetsAt = meter?.resetsAt ?? this.ports.rank(runtime).resetsAt ?? null
    // Markers an earlier incident here still waits to write go on with this one.
    const previous = this.#incidents.get(runtime, sessionId)
    const waiting = previous?.unwritten
    // Preserve unknown accepted legacy fields; explicitly reset the previous incident's known transient fields.
    const claimed = await this.#put({
      ...previous, to: undefined, toRuntime: undefined, mode: undefined, link: undefined, watch: undefined,
      turnStartedAt: undefined, note: undefined, uncertain: undefined, throttle: undefined, backoff: undefined, model: undefined,
      ...(waiting?.length ? { unwritten: waiting } : {}),
      incidentId: randomUUID(), runtime, sessionId, owner, state: 'deciding', cause, turnId, agent,
      from: side(described, runtime, model), ...(model ? { model } : {}),
      resetsAt: resetsAt !== null && resetsAt > now ? resetsAt : null, nextAt: null, openedAt: now, lastAt: now,
      tried: [], hops: 0, ...(throttled?.backoff ? { backoff: throttled.backoff } : {}), alwaysScope: rule.from,
      handled: [...(throttled?.handled ?? []), carryOnTurnKey(runtime, sessionId, turnId)].slice(-HANDLED_LIMIT),
    })
    await this.#act(claimed, decide(await this.#inputFor(claimed, rule.choice, rule.from, rule.otherAgents), now), fence)
  }

  /** A continuation hit a limit too: try the next candidate, with what was tried carried over. */
  async #reopen(prior: CarryOnRecord, runtime: string, sessionId: string, turnId: string, cause: CarryOnCause, meter: CarryOnMeter | null, fence: Fence): Promise<void> {
    const described = this.ports.describe(runtime)
    const agent = described?.agent ?? runtime
    const rule = this.ports.policy(agent)
    const now = this.#now()
    const model = this.ports.modelOf(runtime, sessionId)
    const resetsAt = meter?.resetsAt ?? this.ports.rank(runtime).resetsAt ?? null
    const tried = [...new Set([...prior.tried, prior.runtime, runtime])].slice(-16)
    const { watch: _w, to: _t, toRuntime: _r, mode: _m, link: _l, note: _n, turnStartedAt: _s, ...kept } = prior
    const moved = runtime !== prior.runtime || sessionId !== prior.sessionId
    const claimed = await this.#put({
      ...kept, runtime, sessionId, state: 'deciding', cause, turnId, agent, from: side(described, runtime, model), ...(model ? { model } : {}),
      resetsAt: resetsAt !== null && resetsAt > now ? resetsAt : null, nextAt: null, lastAt: now, tried,
      handled: [...(prior.handled ?? [carryOnTurnKey(prior.runtime, prior.sessionId, prior.turnId)]), carryOnTurnKey(runtime, sessionId, turnId)].slice(-HANDLED_LIMIT),
    } as CarryOnRecord, moved ? { runtime: prior.runtime, sessionId: prior.sessionId } : undefined)
    // A person who chose for this incident has already answered: the same rule goes on, without a second card.
    const choice = rule.choice === 'ask' && prior.hops > 0 ? 'switch' : rule.choice
    await this.#act(claimed, decide(await this.#inputFor(claimed, choice, rule.from, rule.otherAgents), now), fence)
  }

  async #act(record: CarryOnRecord, action: CarryOnAction, fence: Fence): Promise<CarryOnRecord> {
    const at = { runtime: record.runtime, sessionId: record.sessionId }
    switch (action.kind) {
      case 'ask': {
        // An unanswered card never spends another account; at a known reset it resolves as "Wait until reset".
        const nextAt = action.wait && record.resetsAt !== null ? afterReset(record.resetsAt) : null
        return this.#settle(record, { state: 'asked', nextAt })
      }
      case 'stop': {
        // A seat says which accounts its run refused: the reason it stayed stopped.
        const note = record.owner === 'seat' ? joinNotes(action.note, this.#skipped(record))! : action.note
        const reserved = await this.#reserve(record, 1, 'stop')
        return reserved ? this.#oneMarker(reserved, action.phase, { note }, { state: 'stopped', nextAt: null, note }) : record
      }
      case 'wait': {
        const nextAt = afterReset(action.resetsAt)
        const reserved = await this.#reserve(record, 1, 'wait')
        return reserved ? this.#oneMarker(reserved, 'waiting', {}, { state: 'waiting-reset', nextAt, resetsAt: action.resetsAt }) : record
      }
      case 'move':
        if (record.hops >= CARRY_ON_HOPS) return this.#act(record, { kind: 'stop', phase: 'exhausted', note: 'no other account or agent has room' }, fence)
        if (!fence()) return this.#settle(record, { state: 'cleared', nextAt: null, note: PERSON_FIRST })
        {
          const reserved = await this.#reserve(record, 2, 'move')
          if (!reserved) return record
          return reserved.owner === 'seat' ? this.#moveSeat(reserved, action.target, action.mode, fence) : this.#move(reserved, action.target, action.mode, fence)
        }
    }
  }

  /** One retry on the same account: at the reset, or when an unanswered card's reset came. */
  async #retry(record: CarryOnRecord, fence: Fence): Promise<void> {
    const at = { runtime: record.runtime, sessionId: record.sessionId }
    const reserved = record.throttle ? record : await this.#reserve(record, 1, 'retry')
    if (!reserved) return
    let sending = await this.#settle(reserved, { state: 'sending', nextAt: null, turnStartedAt: this.#now() })
    if (!fence()) { await this.#settleReserved(sending, { state: 'cleared', nextAt: null, throttle: undefined, note: PERSON_FIRST }); return }
    let admitted = false
    try {
      await this.ports.resume(at.runtime, at.sessionId)
      if (!fence()) { await this.#settleReserved(sending, { state: 'cleared', nextAt: null, throttle: undefined, note: PERSON_FIRST }); return }
      if (record.throttle) {
        await this.ports.send(at.runtime, at.sessionId, CONTINUE_TEXT, 'continue', fence, undefined, record.owner === 'seat')
        await this.#settle(sending, { state: 'cleared', watch: at, throttle: true })
        return
      }
      const reservation = sending.reservation!
      const incarnation = this.ports.incarnation ? this.ports.incarnation(at.runtime, at.sessionId) : 'fixture-owner'
      if (!incarnation || incarnation.length > 300) throw new Error('The continuation owner could not be identified.')
      const staged = await this.#stage(sending, [{ ...at, phase: 'resumed', anchor: { kind: 'continuation', operationId: reservation.id } }], incarnation)
      sending = staged.record
      const marker = staged.markers[0]!
      let known: readonly string[] | undefined
      const onAdmitted = (turns: readonly string[]) => { admitted = true; known = turns }
      const accepted = this.#arrivalReceipt(sending.incidentId, reservation.id, marker.id!, at, incarnation, () => known)
      const unconfirmed = this.#unconfirmedReceipt(sending.incidentId, reservation.id, marker.id!)
      await this.ports.send(at.runtime, at.sessionId, CONTINUE_TEXT, 'continue', fence, onAdmitted, record.owner === 'seat', accepted, unconfirmed)
      await this.#settleReserved(sending, { state: 'cleared', watch: { ...at, pending: true }, throttle: undefined })
    } catch {
      if (!fence() && !admitted) {
        sending = await this.#cancelStaged(sending)
        await this.#settleReserved(sending, { state: 'cleared', nextAt: null, throttle: undefined, note: PERSON_FIRST }); return
      }
      await this.#settle(sending, { state: 'asked', nextAt: null, uncertain: true,
        note: admitted ? 'The retry may have been sent; its marker remains protected.' : 'The retry could not be confirmed; its marker remains protected.' })
    }
  }

  async #move(record: CarryOnRecord, target: CarryOnCandidate, mode: CarryOnMode, fence: Fence): Promise<CarryOnRecord> {
    const from = { runtime: record.runtime, sessionId: record.sessionId }
    const destination = this.ports.describe(target.runtime)
    const models = await this.ports.models(target.runtime).catch((): readonly ModelInfo[] => [])
    // Nothing has been touched yet: a message the person sent meanwhile simply wins.
    if (!fence()) return this.#settle(record, { state: 'cleared', nextAt: null, note: PERSON_FIRST })
    const collision = mode === 'sameThread' ? this.#incidents.get(target.runtime, from.sessionId) : undefined
    if (collision && collision.incidentId !== record.incidentId && (collision.unwritten?.length || collision.reservation)) {
      this.#capacity(record)
      return this.#settleReserved(record, { state: 'asked', nextAt: null, note: 'The destination has protected carry-on history.' })
    }
    const chosen = chooseModel(record.model, models, target.agent === record.agent)
    const to = side(destination, target.name, chosen.model)
    // The account it leaves is tried too, so a continuation that hits a limit never bounces straight back.
    const tried = [...new Set([...record.tried, record.runtime, target.runtime])].slice(-16)
    // The send is guarded: on disk before it leaves, so a restart asks rather than resends.
    let current = await this.#settle(record, {
      state: 'sending', to, toRuntime: target.runtime, mode, turnStartedAt: this.#now(), tried, hops: record.hops + 1,
      ...(chosen.note ? { note: chosen.note } : {}),
    })
    /**
     * The person's message went first: carry-on stands down. A destination it opened is let go only while nothing
     * but carry-on has happened in it — no message, no turn, no other handle. One the person has started using
     * stays open, and the note says where.
     */
    let dispatched = false
    const yieldTo = async (opened?: Opened): Promise<CarryOnRecord> => {
      if (this.#closed) return current
      if (dispatched) return this.#settle(current, { state: 'asked', nextAt: null, uncertain: true, note: 'The continuation may already have been sent; its markers remain protected.' })
      current = await this.#cancelStaged(current)
      if (opened && this.#untouched(opened)) {
        await this.ports.close(opened.runtime, opened.sessionId, opened.handle).catch(() => {})
        opened = undefined
      }
      if (!opened) return this.#settleReserved(current, { state: 'cleared', nextAt: null, note: PERSON_FIRST })
      // Left open: the incident stops, and a marker in the conversation the person is in says where the work went.
      // The marker is the record that outlives a reconnect. One the conversation cannot take yet — its body let go
      // while the person's reopen is still on its way — is kept, and the incident stays listed until it is written.
      const note = `${PERSON_FIRST} The conversation is also open on ${to.account ? `${to.name} · ${to.account}` : to.name}, where it was in use.`.slice(0, 300)
      const link = { runtime: opened.runtime, sessionId: opened.sessionId }
      return this.#oneMarker(current, 'stopped', { to, note, link }, { state: 'stopped', nextAt: null, note, link })
    }
    // Every await above may have let the person in: checked again right before each effect.
    if (!fence()) return yieldTo()
    let note = chosen.note
    if (mode === 'sameThread') {
      let opened: Opened | undefined
      try {
        // One live writer per thread: the stuck account lets go before its sibling takes it.
        await this.ports.close(from.runtime, from.sessionId)
        // Closed but not yet reopened elsewhere: the person's message reopens it where they sent it.
        if (!fence()) return yieldTo()
        const untouched = this.#fence(target.runtime, from.sessionId)
        const handle = await this.ports.resume(target.runtime, from.sessionId, chosen.model)
        // No handle of its own means someone else holds it, or attached alongside: never carry-on's to close.
        if (handle !== null) opened = { runtime: target.runtime, sessionId: from.sessionId, handle, untouched, footprint: this.ports.footprint(target.runtime, from.sessionId) }
        if (!fence()) return yieldTo(opened)
      } catch {
        // Close or reopen may already have taken effect; retain the reservation rather than start another action.
        return this.#settle(current, { state: 'asked', nextAt: null, uncertain: true, note: 'The conversation may have moved; its carry-on reservation remains protected.' })
      }
      if (mode === 'sameThread') {
        const moved = { runtime: target.runtime, sessionId: from.sessionId }
        // Keep a stable prospective intent before the admitted send can write a marker.
        const switched = { to, mode, ...(note ? { note } : {}) }
        const reservation = current.reservation!
        const incarnation = this.ports.incarnation ? this.ports.incarnation(moved.runtime, moved.sessionId) : 'fixture-owner'
        if (!incarnation || incarnation.length > 300) return this.#settle(current, { state: 'asked', uncertain: true, note: 'The continuation owner could not be identified.' })
        const staged = await this.#stage(current, [{ ...moved, phase: 'switched', ...switched, anchor: { kind: 'continuation', operationId: reservation.id } }], incarnation)
        current = staged.record
        const marker = staged.markers[0]!
        let known: readonly string[] | undefined, boundary: string | undefined
        const markSwitched = (turns: readonly string[]) => {
          dispatched = true
          known = turns
          boundary = turns.at(-1)
        }
        const receipt = this.#arrivalReceipt(current.incidentId, reservation.id, marker.id!, moved, incarnation, () => known, () => boundary)
        if (!fence()) return yieldTo(opened)
        try { await this.ports.send(moved.runtime, moved.sessionId, CONTINUE_TEXT, 'continue', fence, markSwitched, false, receipt, this.#unconfirmedReceipt(current.incidentId, reservation.id, marker.id!)) }
        catch {
          if (!fence()) return yieldTo(opened)
          return this.#settle(current, { state: 'asked', uncertain: true, note: 'The switch may have been sent; its marker remains protected.' })
        }
        return this.#settleReserved(current, { state: 'moved', runtime: target.runtime, mode, watch: { ...moved, pending: true }, ...(note ? { note } : {}) }, from)

      }
    }
    let opened: Opened | undefined
    try {
      const text = await this.ports.packet(from, { fromName: record.from.name, ...(record.from.account ? { fromAccount: record.from.account } : {}), at: record.openedAt })
      if (!fence()) return yieldTo()
      const made = await this.ports.create(target.runtime, from, chosen.model)
      const created = made.sessionId
      // A brand-new conversation has had nothing sent into it but what carry-on sends: its generation starts at zero.
      if (made.handle !== null) opened = { runtime: target.runtime, sessionId: created, handle: made.handle, untouched: this.#fenceAt(target.runtime, created, 0), footprint: this.ports.footprint(target.runtime, created) }
      if (!fence()) return yieldTo(opened)
      const link = { runtime: target.runtime, sessionId: created }
      current = await this.#settle(current, { mode: 'handoff', link, ...(note ? { note } : {}) })
      if (!fence()) return yieldTo(opened)
      // Persist both intents before the packet may cross the effect boundary.
      const leaving = { to, mode: 'handoff' as const, link, ...(note ? { note } : {}) }
      const reservation = current.reservation!
      const incarnation = this.ports.incarnation ? this.ports.incarnation(link.runtime, link.sessionId) : 'fixture-owner'
      if (!incarnation || incarnation.length > 300) throw new Error('The continuation owner could not be identified.')
      const staged = await this.#stage(current, [
        { ...from, phase: 'left', ...leaving, anchor: { kind: 'turn', turnId: record.turnId } },
        { ...link, phase: 'arrived', to, mode: 'handoff', link: from, anchor: { kind: 'continuation', operationId: reservation.id } },
      ], incarnation)
      current = staged.record
      const [, arrival] = staged.markers as [CarryOnUnwritten, CarryOnUnwritten]
      let known: readonly string[] | undefined
      const markLeft = (turns: readonly string[]) => { dispatched = true; known = turns }
      const receipt = this.#arrivalReceipt(current.incidentId, reservation.id, arrival.id!, link, incarnation, () => known)
      await this.ports.send(link.runtime, link.sessionId, text, 'packet', fence, markLeft, false, receipt, this.#unconfirmedReceipt(current.incidentId, reservation.id, arrival.id!))
      // Queue admission may precede the actual send; leave both intents prospective until its receipt.
      return this.#settleReserved(current, { state: 'moved', watch: { ...link, pending: true } })

    } catch {
      if (!fence()) return yieldTo(opened)
      return this.#settle(current, { state: 'asked', nextAt: null, uncertain: true, note: 'The handoff may already have taken effect; its markers remain protected.' })
    }
  }

  /**
   * A seat moves by replacement (§9.2): the flow engine opens a new Seat for
   * the same card and closes this one with `limit`. A sibling account reopens
   * the same thread, which then goes on; anything else is a new conversation
   * whose first work message is the packet — the request and the instruction
   * only, for a seat whose role reads blind. A candidate the run refuses now is
   * skipped, and the next is decided as if it had been tried.
   */
  async #moveSeat(record: CarryOnRecord, target: CarryOnCandidate, mode: CarryOnMode, fence: Fence): Promise<CarryOnRecord> {
    const seat = this.ports.seat
    const from = { runtime: record.runtime, sessionId: record.sessionId }
    if (!seat) return this.#act(record, { kind: 'stop', phase: 'stopped', note: 'this desk cannot replace a seat' }, fence)
    const destination = this.ports.describe(target.runtime)
    const models = await this.ports.models(target.runtime).catch((): readonly ModelInfo[] => [])
    if (!fence()) return this.#settle(record, { state: 'cleared', nextAt: null, note: PERSON_FIRST })
    const collision = mode === 'sameThread' ? this.#incidents.get(target.runtime, from.sessionId) : undefined
    if (collision && collision.incidentId !== record.incidentId && (collision.unwritten?.length || collision.reservation)) {
      this.#capacity(record)
      return this.#settleReserved(record, { state: 'asked', nextAt: null, note: 'The destination has protected carry-on history.' })
    }
    const chosen = chooseModel(record.model, models, target.agent === record.agent)
    const to = side(destination, target.name, chosen.model)
    const tried = [...new Set([...record.tried, record.runtime, target.runtime])].slice(-16)
    let note = joinNotes(chosen.note, this.#skipped(record))
    const blind = (await seat.of(from.runtime, from.sessionId).catch(() => null))?.blind === true
    let current = await this.#settle(record, {
      state: 'sending', to, toRuntime: target.runtime, mode, turnStartedAt: this.#now(), tried, hops: record.hops + 1, ...(note ? { note } : {}),
    })
    const ask = (how: CarryOnMode) => seat.replace(from, { runtime: target.runtime, mode: how, ...(chosen.model ? { model: chosen.model } : {}) })
      .catch((error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }))
    let opened = await ask(mode)
    if ('refused' in opened && !('beforeEffect' in opened && opened.beforeEffect === true)) return this.#settle(current, { state: 'asked', nextAt: null, uncertain: true, note: 'The seat replacement may already have taken effect; its markers remain protected.' })
    if ('refused' in opened && mode === 'sameThread') {
      // The sibling could not reopen it: the same account seats the agent again, and the marker says so.
      mode = 'handoff'
      note = joinNotes(note, `${to.name} could not reopen the conversation; continued in a new one`)
      opened = await ask('handoff')
      if ('refused' in opened && !('beforeEffect' in opened && opened.beforeEffect === true)) return this.#settle(current, { state: 'asked', nextAt: null, uncertain: true, note: 'The seat replacement may already have taken effect; its markers remain protected.' })
    }
    if ('refused' in opened) {
      // Skipped, as if tried, and the next candidate decided: the reason goes on the marker. No hop is spent.
      this.#unopened.set(record.incidentId, new Map([...this.#unopened.get(record.incidentId) ?? [], [target.runtime, opened.refused]]))
      const { to: _t, toRuntime: _r, mode: _m, turnStartedAt: _s, ...kept } = current
      current = await this.#put({ ...kept, state: 'deciding', hops: record.hops, note: undefined, lastAt: this.#now() } as CarryOnRecord)
      const rule = this.ports.policy(record.agent)
      const choice = rule.choice === 'ask' ? 'switch' : rule.choice
      return this.#act(current, decide(await this.#inputFor(current, choice, rule.from, rule.otherAgents), this.#now()), fence)
    }
    const moved = { runtime: opened.runtime, sessionId: opened.sessionId }
    try {
      const reservation = current.reservation!
      const incarnation = this.ports.incarnation ? this.ports.incarnation(moved.runtime, moved.sessionId) : 'fixture-owner'
      if (!incarnation || incarnation.length > 300 || moved.runtime.length > 300 || moved.sessionId.length > 300) {
        return this.#settle(current, { state: 'asked', uncertain: true, note: 'The replacement was opened but its identity could not be safely recorded.' })
      }
      let known: readonly string[] | undefined
      if (mode === 'sameThread') {
        const switched = { to, mode, ...(note ? { note } : {}) }
        const staged = await this.#stage(current, [{ ...moved, phase: 'switched', ...switched, anchor: { kind: 'continuation', operationId: reservation.id } }], incarnation)
        current = staged.record
        const marker = staged.markers[0]!
        let boundary: string | undefined
        const mark = (turns: readonly string[]) => {
          known = turns; boundary = turns.at(-1)
        }
        const receipt = this.#arrivalReceipt(current.incidentId, reservation.id, marker.id!, moved, incarnation, () => known, () => boundary)
        await this.ports.send(moved.runtime, moved.sessionId, CONTINUE_TEXT, 'continue', fence, mark, true, receipt, this.#unconfirmedReceipt(current.incidentId, reservation.id, marker.id!))
        return this.#settleReserved(current, { state: 'moved', runtime: moved.runtime, sessionId: moved.sessionId, mode, watch: { ...moved, pending: true }, ...(note ? { note } : {}) }, from)
      }
      const text = await this.ports.packet(from, { fromName: record.from.name, ...(record.from.account ? { fromAccount: record.from.account } : {}), at: record.openedAt, ...(blind ? { blind } : {}) })
      current = await this.#settle(current, { mode: 'handoff', link: moved, ...(note ? { note } : {}) })
      const leaving = { to, mode: 'handoff' as const, link: moved, ...(note ? { note } : {}) }
      const staged = await this.#stage(current, [
        { ...from, phase: 'left', ...leaving, anchor: { kind: 'turn', turnId: record.turnId } },
        { ...moved, phase: 'arrived', to, mode: 'handoff', link: from, anchor: { kind: 'continuation', operationId: reservation.id } },
      ], incarnation)
      current = staged.record
      const [, arrival] = staged.markers as [CarryOnUnwritten, CarryOnUnwritten]
      const markLeft = (turns: readonly string[]) => { known = turns }
      const receipt = this.#arrivalReceipt(current.incidentId, reservation.id, arrival.id!, moved, incarnation, () => known)
      await this.ports.send(moved.runtime, moved.sessionId, text, 'packet', fence, markLeft, true, receipt, this.#unconfirmedReceipt(current.incidentId, reservation.id, arrival.id!))
      return this.#settleReserved(current, { state: 'moved', watch: { ...moved, pending: true } })

    } catch {
      // The new Seat holds the card already: its own recovery hands the card to it, rather than the old one.
      const settled = await this.#settle(current, { state: 'asked', uncertain: true, nextAt: null, watch: { ...moved, pending: true }, link: moved, note: joinNotes(note, 'the first message may have been sent; its marker remains protected')?.slice(0, 300) })
      this.#recover(moved.runtime, moved.sessionId)
      return settled
    }
  }
}
