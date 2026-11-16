/** An open cannot safely proceed while an earlier operation is being retired. */
export class OpenUnavailableError extends Error {
  readonly code = 'notRunning'
  constructor() { super('This conversation is still finishing an earlier open. Try again when the agent is ready.'); this.name = 'OpenUnavailableError' }
}

/** Retirement owns this exact attempt, never a session id or a possibly shared handle. */
export interface OpenAttempt<T> {
  readonly result: Promise<T>
  readonly ownsHandle?: (handle: T) => boolean
  /** Must preserve any handle already transferred to a caller; resolves only when this attempt cannot affect a later open. */
  readonly retire: (state: { readonly published: boolean }) => Promise<void>
}
export interface OpenAuthority {
  readonly current: () => boolean
  /** Call synchronously at the point a handle is published, before any later await can fail. */
  readonly published: () => void
  /** Seal against new callers only while this flight has one owner. */
  readonly exclusive: () => boolean
  /** Preserve the already-known failure if a close event revokes this flight during cleanup. */
  readonly closeFailure: (error: Error) => void
}
type Caller = { active: boolean; reject: (reason: unknown) => void; deliver: (value: unknown) => void }
type Flight = {
  readonly authority: { active: boolean }
  readonly callers: Set<Caller>
  readonly hasValue: () => boolean
  readonly value: () => unknown
  readonly setValue: (value: unknown) => void
  cancelTimer: () => void
  retire: ((state: { readonly published: boolean }) => Promise<void>) | null
  retirementStarted: boolean
  quarantine: object | null
  published: boolean
  sealed: boolean
  closeFailure: Error | null
  active: boolean
}
type Entry = { pending: Set<Caller>; flight: Flight | null; quarantine: object | null }

/**
 * The owner key is an exact runtime process/connection generation, never an adapter object reused on restart.
 * The optional lifetime key is stable across those generations and holds the monotonic opened count.
 * Attempt authority is distinct from a published handle's normal event ownership. This coordinator never closes handles.
 */
export class OpenCoordinator {
  readonly #entries = new WeakMap<object, Map<string, Entry>>()
  readonly #opened = new WeakMap<object, Map<string, number>>()
  readonly #deadlineMs: number
  readonly #schedule: (callback: () => void, delayMs: number) => () => void
  constructor(options: { deadlineMs: number; schedule: (callback: () => void, delayMs: number) => () => void }) {
    this.#deadlineMs = options.deadlineMs; this.#schedule = options.schedule
  }
  #entry(owner: object, id: string): Entry {
    let map = this.#entries.get(owner)
    if (!map) { map = new Map(); this.#entries.set(owner, map) }
    let entry = map.get(id)
    if (!entry) { entry = { pending: new Set(), flight: null, quarantine: null }; map.set(id, entry) }
    return entry
  }
  counts(owner: object, id: string, lifetime: object = owner): { opened: number; pending: number } {
    return { opened: this.#opened.get(lifetime)?.get(id) ?? 0, pending: this.#entries.get(owner)?.get(id)?.pending.size ?? 0 }
  }
  open<T, U = T>(owner: object, id: string, start: (authority: OpenAuthority) => OpenAttempt<T>,
    complete?: (handle: T, authority: OpenAuthority) => Promise<U>, lifetime: object = owner): Promise<U> {
    const entry = this.#entry(owner, id)
    if (entry.quarantine || entry.flight?.sealed) return Promise.reject(new OpenUnavailableError())
    let counts = this.#opened.get(lifetime)
    if (!counts) { counts = new Map(); this.#opened.set(lifetime, counts) }
    counts.set(id, (counts.get(id) ?? 0) + 1)
    let flight = entry.flight
    let created: Flight | null = null
    if (!flight) {
      let value: unknown, hasValue = false
      created = { authority: { active: true }, callers: new Set(), hasValue: () => hasValue, value: () => value,
        setValue: next => { value = next; hasValue = true }, cancelTimer: () => {}, retire: null,
        retirementStarted: false, quarantine: null, published: false, sealed: false, closeFailure: null, active: true }
      flight = created; entry.flight = created
    }
    const held = flight
    let resolve!: (value: U) => void, reject!: (reason: unknown) => void
    const output = new Promise<U>((yes, no) => { resolve = yes; reject = no })
    const caller: Caller = {
      active: true, reject,
      deliver: value => {
        if (!caller.active || !held.active) return
        const authority: OpenAuthority = { current: () => caller.active && held.active,
          published: () => { if (caller.active && held.active) held.published = true },
          closeFailure: error => { if (caller.active && held.active) held.closeFailure = error },
          exclusive: () => { if (!caller.active || !held.active || held.callers.size !== 1) return false; held.sealed = true; return true } }
        void Promise.resolve().then(() => {
          if (!authority.current()) throw new OpenUnavailableError()
          return complete ? complete(value as T, authority) : value as U
        }).then(answer => {
          if (!caller.active || !held.active) return
          held.published = true; this.#finishCaller(entry, held, caller); resolve(answer)
        }, error => {
          if (!caller.active || !held.active) return
          this.#finishCaller(entry, held, caller); reject(error)
        })
      },
    }
    entry.pending.add(caller); held.callers.add(caller)
    if (held.hasValue()) caller.deliver(held.value())
    if (created) {
      created.cancelTimer = this.#schedule(() => this.#invalidate(entry, created!, new OpenUnavailableError()), this.#deadlineMs)
      // A scheduler may fire synchronously; no adapter effect has started in that case.
      if (!created.active) { if (entry.quarantine === created.quarantine) entry.quarantine = null; return output }
      try {
        const attempt = start({ current: () => created!.authority.active, published: () => { if (created!.active) created!.published = true },
          closeFailure: error => { if (created!.active) created!.closeFailure = error },
          exclusive: () => { if (!created!.active || created!.callers.size !== 1) return false; created!.sealed = true; return true } })
        created.retire = attempt.retire
        if (!created.active) this.#retire(entry, created)
        void attempt.result.then(value => {
          if (!created!.active || entry.flight !== created) return
          created!.setValue(value)
          for (const one of [...created!.callers]) one.deliver(value)
        }, error => this.#invalidate(entry, created!, error))
      } catch (error) { this.#invalidate(entry, created, error) }
    }
    return output
  }
  #finishCaller(entry: Entry, flight: Flight, caller: Caller): void {
    caller.active = false; entry.pending.delete(caller); flight.callers.delete(caller)
    if (flight.callers.size || !flight.active) return
    if (!flight.published) { this.#invalidate(entry, flight, new OpenUnavailableError()); return }
    flight.active = false; flight.authority.active = false; flight.cancelTimer()
    if (entry.flight === flight) entry.flight = null
  }
  #retire(entry: Entry, flight: Flight): void {
    if (!flight.retire || flight.retirementStarted) return
    flight.retirementStarted = true
    const quarantine = flight.quarantine
    let retirement: Promise<void>
    try { retirement = flight.retire({ published: flight.published }) } catch { return }
    void retirement.then(() => { if (entry.quarantine === quarantine) entry.quarantine = null }, () => {})
  }
  #invalidate(entry: Entry, flight: Flight, reason: unknown): void {
    if (!flight.active || entry.flight !== flight) return
    flight.active = false; flight.authority.active = false; flight.cancelTimer(); entry.flight = null
    flight.quarantine = {}; entry.quarantine = flight.quarantine
    for (const caller of flight.callers) { caller.active = false; entry.pending.delete(caller); caller.reject(reason) }
    flight.callers.clear(); this.#retire(entry, flight)
  }
  detach(owner: object, id?: string): void {
    const map = this.#entries.get(owner)
    if (!map) return
    for (const [key, entry] of map) if ((id === undefined || id === key) && entry.flight) this.#invalidate(entry, entry.flight, entry.flight.closeFailure ?? new OpenUnavailableError())
  }
  /** Only after the exact owner generation is confirmed dead; never reuse it for a new generation. */
  runtimeDied(owner: object): void {
    const map = this.#entries.get(owner)
    if (!map) return
    this.detach(owner)
    for (const entry of map.values()) entry.quarantine = null
  }
}
