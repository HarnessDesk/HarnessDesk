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
  LIVE_STATES,
  RETRY_ATTEMPTS,
  afterReset,
  carryOnKey,
  scheduleTimer,
  type CarryOnRecord,
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
 * Only ordinary chats are carried here. A Lead chat keeps the Lead's own
 * recovery; a Team or Flow seat is the flow engine's to replace.
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
  readonly close: (runtime: string, sessionId: string) => Promise<void>
  readonly resume: (runtime: string, sessionId: string, model?: string) => Promise<void>
  /** On the host's path, never counted as the person's message. */
  readonly send: (runtime: string, sessionId: string, text: string) => Promise<void>
  /** A new conversation on `runtime` in the stuck conversation's own folder. */
  readonly create: (runtime: string, from: { readonly runtime: string; readonly sessionId: string }, model?: string) => Promise<string>
  /** The handoff packet, built on the host from the kept transcript. */
  readonly packet: (from: { readonly runtime: string; readonly sessionId: string }, meta: { readonly fromName: string; readonly fromAccount?: string; readonly at: number }) => Promise<string>
  readonly record: (runtime: string, sessionId: string, item: CarryOnItem) => boolean
  readonly publish: (key: CarryOnKey, incident: CarryOnIncidentView | null) => void
  /** "Always do this": the choice written at the level the rule was read from. */
  readonly writeRule: (scope: CarryOnScope, agent: string, choice: 'switch' | 'wait' | 'stop') => Promise<void>
}

/** How a turn ended, as far as carry-on cares. */
export interface EndedTurn {
  readonly id: string
  readonly status: string
  readonly error?: TurnError | null
}

const side = (runtime: CarryOnRuntime | null, fallback: string, model?: string): CarryOnSide => ({
  name: runtime?.name || fallback,
  ...(runtime?.account ? { account: runtime.account } : {}),
  ...(model ? { model } : {}),
})

export class CarryOnService {
  readonly #incidents: CarryOnIncidents
  readonly #timers = new Map<string, () => void>()
  #closed = false
  constructor(private readonly ports: CarryOnPorts) {
    this.#incidents = new CarryOnIncidents({
      file: ports.file,
      ...(ports.problem ? { problem: ports.problem } : {}),
      evicted: key => this.#cancelTimer(key),
    })
  }

  #now(): number { return (this.ports.now ?? Date.now)() }

  // ------------------------------------------------------------ reading

  /** Whether an incident still holds this conversation: the host leaves its own re-arms alone while one does. */
  live(runtime: string, sessionId: string): boolean {
    const record = this.#incidents.get(runtime, sessionId)
    return !!record && LIVE_STATES.has(record.state)
  }

  /** What a reconnecting window loads: every live incident the composer shows. */
  list(): readonly CarryOnIncidentView[] {
    return this.#incidents.all().filter(record => record.owner === 'chat' && !record.throttle && LIVE_STATES.has(record.state)).map(record => this.#view(record))
  }

  idle(): Promise<void> { return this.#incidents.idle() }

  close(): void {
    this.#closed = true
    for (const cancel of this.#timers.values()) cancel()
    this.#timers.clear()
  }

  // ------------------------------------------------------------ candidates

  #candidates(record: Pick<CarryOnRecord, 'runtime' | 'agent'>): CarryOnCandidate[] {
    const stuck = this.ports.describe(record.runtime)
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
      }]
    })
  }

  #input(record: CarryOnRecord, choice: CarryOnChoice, from: CarryOnScope, otherAgents: boolean, target?: string): DecideInput {
    return {
      choice, from, otherAgents, stuck: { runtime: record.runtime, agent: record.agent }, resetsAt: record.resetsAt,
      candidates: this.#candidates(record), tried: record.tried, hops: record.hops, ...(target !== undefined ? { target } : {}),
    }
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
    if (record.owner !== 'chat' || record.throttle) return
    const key = { runtime: runtimeId(record.runtime), sessionId: makeSessionId(record.sessionId) }
    this.ports.publish(key, record.state === 'cleared' ? null : this.#view(record))
  }

  #mark(record: CarryOnRecord, at: { readonly runtime: string; readonly sessionId: string }, phase: CarryOnPhase,
    extra: { readonly to?: CarryOnSide; readonly mode?: CarryOnMode; readonly note?: string; readonly link?: { readonly runtime: string; readonly sessionId: string } } = {}): void {
    try {
      const { link, ...rest } = extra
      this.ports.record(at.runtime, at.sessionId, {
        id: itemId(`carry-on-${randomUUID()}`), type: 'carryOn', phase, cause: record.cause, from: record.from,
        ...(record.resetsAt !== null && (phase === 'waiting' || phase === 'stopped' || phase === 'exhausted') ? { resetsAt: record.resetsAt } : {}),
        ...rest, ...(link ? { link: { runtime: runtimeId(link.runtime), sessionId: makeSessionId(link.sessionId) } } : {}),
      })
    } catch { /* A marker that cannot be written never stops the move it describes. */ }
  }

  // ------------------------------------------------------------ timers

  #cancelTimer(key: string): void { this.#timers.get(key)?.(); this.#timers.delete(key) }

  #arm(record: CarryOnRecord): void {
    const key = carryOnKey(record.runtime, record.sessionId)
    this.#cancelTimer(key)
    if (this.#closed || record.nextAt === null) return
    if (record.state !== 'waiting-reset' && record.state !== 'asked') return
    const incident = record.incidentId
    const cancel = (this.ports.schedule ?? scheduleTimer)(() => {
      this.#timers.delete(key)
      void this.#incidents.serial(() => this.#due(record.runtime, record.sessionId, incident)).catch(() => {})
    }, record.nextAt - this.#now())
    this.#timers.set(key, cancel)
  }

  /** A timer came due: the retry at the reset, or an unanswered card resolving as "Wait until reset". */
  async #due(runtime: string, sessionId: string, incident: string): Promise<void> {
    const record = this.#incidents.get(runtime, sessionId)
    if (!record || record.incidentId !== incident || (record.state !== 'waiting-reset' && record.state !== 'asked')) return
    // Someone is already using the conversation: their message is the continuation.
    if (this.ports.busy(runtime, sessionId)) { await this.#settle(record, { state: 'cleared', nextAt: null }); return }
    await this.#retry(record)
  }

  // ------------------------------------------------------------ writing

  async #put(record: CarryOnRecord, replaces?: { readonly runtime: string; readonly sessionId: string }): Promise<CarryOnRecord> {
    await this.#incidents.put(record, replaces)
    if (replaces) this.#cancelTimer(carryOnKey(replaces.runtime, replaces.sessionId))
    return record
  }

  async #settle(record: CarryOnRecord, patch: Partial<CarryOnRecord>, replaces?: { readonly runtime: string; readonly sessionId: string }): Promise<CarryOnRecord> {
    const next = await this.#put({ ...record, ...patch, lastAt: this.#now() } as CarryOnRecord, replaces)
    this.#arm(next)
    this.#publish(next)
    return next
  }

  // ------------------------------------------------------------ events

  /**
   * A turn ended. Opens an incident when it ended on a usage limit, follows a
   * move whose continuing turn this was, and backs a throttle off on the same
   * account before it ever becomes one.
   */
  async ended(runtime: string, sessionId: string, turn: EndedTurn): Promise<void> {
    if (this.#closed) return
    const failed = turn.status === 'failed' || !!turn.error
    if (turn.status === 'inProgress') return
    // Read the meter before the queue: it is a vendor call, and nothing else should wait on it.
    const meter = failed && !turn.error?.retrying && (turn.error?.code === undefined || turn.error.code === 'rateLimit' || turn.error.code === 'credits' || turn.error.code === 'unknown')
      ? await this.ports.meter(runtime).catch(() => null) : null
    await this.#incidents.serial(async () => {
      const cause = failed ? limitCauseOf(turn.error ?? { code: 'unknown' }, meter) : null
      const own = this.#incidents.get(runtime, sessionId)
      const watched = this.#incidents.watching(runtime, sessionId)
      // A throttle's own retry is followed below, by its backoff; a move's continuation here.
      const prior = own && !own.throttle && own.watch?.runtime === runtime && own.watch.sessionId === sessionId ? own : watched?.throttle ? undefined : watched
      if (prior && !LIVE_STATES.has(prior.state)) {
        if (!failed || !cause || cause === 'throttle') {
          // The continuing turn went through, or failed for a reason of its own: the move held. A throttle there is
          // that conversation's own, backed off below.
          if (prior.watch) { const { watch: _, ...rest } = prior; await this.#put({ ...rest, lastAt: this.#now() } as CarryOnRecord) }
          if (cause !== 'throttle') return
        } else {
          if (prior.turnId === turn.id) return
          // The continuation hit a limit too: the same incident goes on, in the conversation that now carries it.
          await this.#reopen(prior, runtime, sessionId, turn.id, cause, meter)
          return
        }
      }
      if (!failed || !cause) {
        // A throttle whose retry went through is over.
        if (own?.throttle && !failed) await this.#put({ ...own, state: 'cleared', throttle: undefined, nextAt: null, lastAt: this.#now() } as CarryOnRecord).then(() => this.#cancelTimer(carryOnKey(runtime, sessionId)))
        return
      }
      if (own && own.turnId === turn.id) return
      if (own && LIVE_STATES.has(own.state) && !own.throttle) return
      const owner = await this.ports.owner(runtime, sessionId)
      // A Lead chat keeps the Lead's recovery; a seat is the flow engine's to replace.
      if (owner !== 'chat') return
      if (cause === 'throttle') { await this.#throttle(own, runtime, sessionId, turn.id); return }
      await this.#open(runtime, sessionId, turn.id, cause, meter, own?.throttle ? own : undefined)
    })
  }

  /** The person sent something into the conversation: their message wins over any incident. */
  personSent(runtime: string, sessionId: string): Promise<void> {
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
        'This question has already been answered or has changed.', { incident: current && current.owner === 'chat' ? this.#view(current) : null })
      if (!record || record.state !== 'asked' || record.owner !== 'chat') throw stale(record)
      const { otherAgents } = this.ports.policy(record.agent)
      if (decision.choice === 'switch' && decision.target !== undefined) {
        const action = decide(this.#input(record, 'ask', record.alwaysScope, otherAgents), this.#now())
        const offered = action.kind === 'ask' ? [action.target, ...action.others].filter(Boolean) as CarryOnCandidate[] : []
        const pick = offered.find(candidate => candidate.runtime === decision.target)
        if (!pick || !pick.signedIn) throw stale(record)
      }
      if (decision.choice === 'wait' && !(record.resetsAt !== null && record.resetsAt > this.#now())) throw stale(record)
      if (decision.always) {
        try { await this.ports.writeRule(record.alwaysScope, record.agent, decision.choice) }
        catch { this.ports.problem?.('The carry-on rule could not be saved.') }
      }
      this.#cancelTimer(carryOnKey(record.runtime, record.sessionId))
      const action: CarryOnAction = decision.choice === 'stop' ? { kind: 'stop', phase: 'stopped', note: 'stopped at the person’s answer' }
        : decide(this.#input(record, decision.choice, record.alwaysScope, otherAgents, decision.target), this.#now())
      const next = await this.#act(record, action)
      return this.#view(next)
    })
  }

  /**
   * After a restart. A claim that was sending is never replayed: it is asked
   * again, saying the message may already have gone. A wait re-arms its timer.
   */
  async restore(): Promise<void> {
    await this.#incidents.serial(async () => {
      for (const record of this.#incidents.all()) {
        if (record.state === 'sending' || record.state === 'deciding') {
          if (record.throttle) { await this.#put({ ...record, state: 'cleared', throttle: undefined, nextAt: null, lastAt: this.#now() } as CarryOnRecord); continue }
          await this.#settle(record, {
            state: 'asked', nextAt: record.resetsAt !== null && record.resetsAt > this.#now() ? afterReset(record.resetsAt) : null,
            ...(record.state === 'sending' ? { note: 'The desk restarted while continuing this conversation; the message may already have been sent.' } : {}),
          })
        } else if (record.state === 'waiting-reset' || record.state === 'asked') this.#arm(record)
      }
    })
  }

  // ------------------------------------------------------------ the steps

  async #throttle(own: CarryOnRecord | undefined, runtime: string, sessionId: string, turnId: string): Promise<void> {
    const spent = own?.throttle ? own.backoff ?? 0 : 0
    if (spent >= RETRY_ATTEMPTS) {
      // Backed off twice and still refused: a limit after all.
      await this.#open(runtime, sessionId, turnId, 'rateLimit', null, own)
      return
    }
    const described = this.ports.describe(runtime)
    const now = this.#now()
    const record: CarryOnRecord = {
      incidentId: own?.throttle ? own.incidentId : randomUUID(), runtime, sessionId, owner: 'chat', state: 'waiting-reset', cause: 'rateLimit', turnId,
      agent: described?.agent ?? runtime, from: side(described, runtime), resetsAt: null, nextAt: now + BACKOFF_MS[spent]!,
      openedAt: own?.throttle ? own.openedAt : now, lastAt: now, tried: [], hops: 0, backoff: spent + 1, throttle: true, alwaysScope: 'desk',
    }
    await this.#put(record)
    this.#arm(record)
  }

  async #open(runtime: string, sessionId: string, turnId: string, cause: CarryOnCause, meter: { readonly resetsAt: number | null } | null, throttled?: CarryOnRecord): Promise<void> {
    const described = this.ports.describe(runtime)
    const agent = described?.agent ?? runtime
    const model = this.ports.modelOf(runtime, sessionId)
    const rule = this.ports.policy(agent)
    const now = this.#now()
    const resetsAt = meter?.resetsAt ?? this.ports.rank(runtime).resetsAt ?? null
    // Claim first: on disk before anything is sent.
    const claimed = await this.#put({
      incidentId: randomUUID(), runtime, sessionId, owner: 'chat', state: 'deciding', cause, turnId, agent,
      from: side(described, runtime, model), ...(model ? { model } : {}),
      resetsAt: resetsAt !== null && resetsAt > now ? resetsAt : null, nextAt: null, openedAt: now, lastAt: now,
      tried: [], hops: 0, ...(throttled?.backoff ? { backoff: throttled.backoff } : {}), alwaysScope: rule.from,
    })
    await this.#act(claimed, decide(this.#input(claimed, rule.choice, rule.from, rule.otherAgents), now))
  }

  /** A continuation hit a limit too: try the next candidate, with what was tried carried over. */
  async #reopen(prior: CarryOnRecord, runtime: string, sessionId: string, turnId: string, cause: CarryOnCause, meter: CarryOnMeter | null): Promise<void> {
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
    } as CarryOnRecord, moved ? { runtime: prior.runtime, sessionId: prior.sessionId } : undefined)
    // A person who chose for this incident has already answered: the same rule goes on, without a second card.
    const choice = rule.choice === 'ask' && prior.hops > 0 ? 'switch' : rule.choice
    await this.#act(claimed, decide(this.#input(claimed, choice, rule.from, rule.otherAgents), now))
  }

  async #act(record: CarryOnRecord, action: CarryOnAction): Promise<CarryOnRecord> {
    const at = { runtime: record.runtime, sessionId: record.sessionId }
    switch (action.kind) {
      case 'ask': {
        // An unanswered card never spends another account; at a known reset it resolves as "Wait until reset".
        const nextAt = action.wait && record.resetsAt !== null ? afterReset(record.resetsAt) : null
        return this.#settle(record, { state: 'asked', nextAt })
      }
      case 'stop': {
        this.#mark(record, at, action.phase, { note: action.note })
        return this.#settle(record, { state: 'stopped', nextAt: null, note: action.note })
      }
      case 'wait': {
        const nextAt = afterReset(action.resetsAt)
        this.#mark(record, at, 'waiting')
        return this.#settle(record, { state: 'waiting-reset', nextAt, resetsAt: action.resetsAt })
      }
      case 'move':
        if (record.hops >= CARRY_ON_HOPS) return this.#act(record, { kind: 'stop', phase: 'exhausted', note: 'no other account or agent has room' })
        return this.#move(record, action.target, action.mode)
    }
  }

  /** One retry on the same account: at the reset, or when an unanswered card's reset came. */
  async #retry(record: CarryOnRecord): Promise<void> {
    const at = { runtime: record.runtime, sessionId: record.sessionId }
    const sending = await this.#settle(record, { state: 'sending', nextAt: null, turnStartedAt: this.#now() })
    try {
      await this.ports.resume(at.runtime, at.sessionId)
      await this.ports.send(at.runtime, at.sessionId, CONTINUE_TEXT)
    } catch {
      await this.#settle(sending, { state: 'asked', note: 'The retry at the reset did not go through.' })
      return
    }
    if (!record.throttle) this.#mark(record, at, 'resumed')
    await this.#settle(sending, { state: 'cleared', watch: at, throttle: record.throttle })
  }

  async #move(record: CarryOnRecord, target: CarryOnCandidate, mode: CarryOnMode): Promise<CarryOnRecord> {
    const from = { runtime: record.runtime, sessionId: record.sessionId }
    const destination = this.ports.describe(target.runtime)
    const models = await this.ports.models(target.runtime).catch((): readonly ModelInfo[] => [])
    const chosen = chooseModel(record.model, models, target.agent === record.agent)
    const to = side(destination, target.name, chosen.model)
    // The account it leaves is tried too, so a continuation that hits a limit never bounces straight back.
    const tried = [...new Set([...record.tried, record.runtime, target.runtime])].slice(-16)
    // The send is guarded: on disk before it leaves, so a restart asks rather than resends.
    let current = await this.#settle(record, {
      state: 'sending', to, toRuntime: target.runtime, mode, turnStartedAt: this.#now(), tried, hops: record.hops + 1,
      ...(chosen.note ? { note: chosen.note } : {}),
    })
    let note = chosen.note
    if (mode === 'sameThread') {
      try {
        // One live writer per thread: the stuck account lets go before its sibling takes it.
        await this.ports.close(from.runtime, from.sessionId)
        await this.ports.resume(target.runtime, from.sessionId, chosen.model)
      } catch {
        // The sibling could not reopen it: a handoff to the same account instead, and the marker says so.
        mode = 'handoff'
        note = `${to.name} could not reopen the conversation; continued in a new one`
      }
      if (mode === 'sameThread') {
        const moved = { runtime: target.runtime, sessionId: from.sessionId }
        this.#mark(current, moved, 'switched', { to, mode, ...(note ? { note } : {}) })
        try { await this.ports.send(moved.runtime, moved.sessionId, CONTINUE_TEXT) }
        catch { return this.#settle(current, { state: 'asked', note: 'The switch did not go through.' }) }
        // The incident follows the conversation to the account that now holds it.
        return this.#settle(current, { state: 'moved', runtime: target.runtime, mode, watch: moved, ...(note ? { note } : {}) }, from)
      }
    }
    try {
      const text = await this.ports.packet(from, { fromName: record.from.name, ...(record.from.account ? { fromAccount: record.from.account } : {}), at: record.openedAt })
      const created = await this.ports.create(target.runtime, from, chosen.model)
      const link = { runtime: target.runtime, sessionId: created }
      current = await this.#settle(current, { mode: 'handoff', link, ...(note ? { note } : {}) })
      this.#mark(current, from, 'left', { to, mode: 'handoff', link, ...(note ? { note } : {}) })
      await this.ports.send(link.runtime, link.sessionId, text)
      this.#mark(current, link, 'arrived', { to, mode: 'handoff', link: from })
      return this.#settle(current, { state: 'moved', watch: link })
    } catch {
      return this.#settle(current, { state: 'asked', note: 'The handoff did not go through.' })
    }
  }
}
