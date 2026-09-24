import { open } from 'node:fs/promises'
import { join } from 'node:path'

import type { TriggerFact, TriggerSource, TriggerSourceStatus } from '@harnessdesk/protocol'

import { Serial } from '../goals/assignments.js'
import { atomicJson } from '../goals/store.js'
import type { ArmedTrigger } from './consent.js'
import { acceptsFact } from './definition.js'
import { ForgeReadError, type ForgeSource, type PollBatch, type SourceCursor } from './forge.js'
import { dueSlots, scheduleInventory } from './schedule.js'

/**
 * The intake monitor: the desk, not an agent, watching the sources armed
 * triggers name.
 *
 * - **Nothing without an arm.** No timer runs and no forge is read until at
 *   least one verified arm exists and the machine is not paused.
 * - **One read per project and source.** Every armed trigger on a project's
 *   pull requests (or issues, or schedules) shares one read, at most once a
 *   minute by the monotonic clock, one at a time per source and two at a time
 *   across the machine; each trigger then gets its own offer of each fact.
 * - **Coverage moves last.** A source's cursor is committed only after every
 *   fact the read produced has a durable answer from admission — fired,
 *   skipped or duplicate — so a crash, a failed offer or a failed save leaves
 *   the old cursor, and the facts are offered again and deduplicated by their
 *   stable keys. A read that could not cover its window is a gap: nothing is
 *   offered, the watermark stays, and the source waits for a person.
 * - **Failures are said, and paced.** Offline, signed out, rate limited and
 *   unreadable answers keep the cursor, name a fix, and back off 60, 120,
 *   240, 480, then 900 seconds; a complete read resets it.
 * - **The arm set is read when an offer is made**, not before the read: a
 *   trigger disarmed while its source was being read is offered nothing.
 *
 * Lock order: a source's queue (one per project and source) is taken first;
 * it offers facts to admission (task 4) and commits through `SourceCursors`,
 * whose own queue asks for nothing. Consent is only read, which takes no queue.
 */

export const POLL_INTERVAL_MS = 60_000
const BACKOFF_S = [60, 120, 240, 480, 900] as const
const MACHINE_READS = 2
const TIMER_MS = 15_000
const CURSOR_FILE = 'triggers-cursors.json'
const CURSOR_LIMIT = 16 * 1024 * 1024

/** One watched source: a project, a source kind and, for the forge, the repository its arms bound. */
export interface SourceGroup {
  readonly key: string
  readonly project: string
  readonly source: TriggerSource
  readonly repository: string | null
  readonly arms: readonly ArmedTrigger[]
}

export const groupKeyOf = (project: string, source: TriggerSource, repository: string | null): string =>
  JSON.stringify([project, source, repository])

const groupOf = (arm: Pick<ArmedTrigger, 'project' | 'definition' | 'binding'>): Omit<SourceGroup, 'arms'> => {
  const source = arm.definition.on.kind
  const repository = source === 'schedule' ? null : arm.binding.repository
  return { key: groupKeyOf(arm.project, source, repository), project: arm.project, source, repository }
}

/** The reads a monitor makes, per source kind. */
export interface IntakeSources {
  inventory(group: SourceGroup, signal: AbortSignal, now: number): Promise<SourceCursor>
  probe(group: SourceGroup, cursor: SourceCursor, signal: AbortSignal): Promise<void>
  poll(group: SourceGroup, cursor: SourceCursor, signal: AbortSignal, now: number): Promise<PollBatch>
}

/** The forge for pull requests and issues, the wall clock for schedules. */
export const intakeSources = (forge: ForgeSource): IntakeSources => ({
  inventory: async (group, signal, now) => {
    if (group.source === 'schedule') return scheduleInventory(now)
    if (group.repository === null) throw new ForgeReadError('unreadable', 'This source has no forge repository.')
    return forge.inventory(group.project, group.source, group.repository, signal)
  },
  probe: async (group, cursor, signal) => {
    if (group.source !== 'schedule') await forge.probe(group.project, cursor, signal)
  },
  poll: async (group, cursor, signal, now) =>
    group.source === 'schedule' ? dueSlots(group.project, group.arms, cursor, now) : forge.poll(group.project, cursor, signal),
})

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cursorOf = (value: unknown): SourceCursor | null => {
  if (!isMap(value) || value['version'] !== 1 || !['pull-request', 'issue', 'schedule'].includes(String(value['source']))) return null
  const { repository, baseline, observedThrough, continuation, subjects } = value
  if (!(repository === null || typeof repository === 'string') || !Number.isSafeInteger(baseline) || !Number.isSafeInteger(observedThrough) ||
    !(continuation === null || typeof continuation === 'string') || !isMap(subjects)) return null
  const clean: Record<string, { head: string | null; event: string }> = {}
  for (const [key, entry] of Object.entries(subjects)) {
    if (!isMap(entry) || !(entry['head'] === null || typeof entry['head'] === 'string') || typeof entry['event'] !== 'string') return null
    clean[key] = { head: entry['head'] as string | null, event: entry['event'] }
  }
  return {
    version: 1, source: value['source'] as TriggerSource, repository: repository as string | null,
    baseline: baseline as number, observedThrough: observedThrough as number, continuation: continuation as string | null, subjects: clean,
  }
}

/**
 * Every source's cursor, in `triggers-cursors.json` in the desk's state
 * folder: host state, never in a backup and never consent. One writer — this
 * class, through one queue — and each commit re-reads the file inside that
 * queue, so two sources committing at once never lose each other's cursor.
 */
export class SourceCursors {
  readonly #file: string
  readonly #write: (file: string, value: unknown) => Promise<void>
  readonly #serial = new Serial()

  constructor(home: string, options: { readonly write?: (file: string, value: unknown) => Promise<void> } = {}) {
    this.#file = join(home, CURSOR_FILE)
    this.#write = options.write ?? atomicJson
  }

  async #all(): Promise<Record<string, SourceCursor>> {
    let handle
    try {
      handle = await open(this.#file, 'r')
    } catch {
      return {}
    }
    let raw: string
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > CURSOR_LIMIT) return {}
      raw = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return {}
    }
    if (!isMap(parsed) || parsed['version'] !== 1 || !isMap(parsed['cursors'])) return {}
    const out: Record<string, SourceCursor> = {}
    for (const [key, value] of Object.entries(parsed['cursors'])) {
      const cursor = cursorOf(value)
      if (cursor) out[key] = cursor
    }
    return out
  }

  async read(key: string): Promise<SourceCursor | null> {
    return (await this.#all())[key] ?? null
  }

  commit(key: string, cursor: SourceCursor): Promise<void> {
    return this.#serial.run(async () => {
      const all = await this.#all()
      await this.#write(this.#file, { version: 1, cursors: { ...all, [key]: cursor } })
    })
  }
}

const SENTENCES: Readonly<Record<Exclude<TriggerSourceStatus['state'], 'watching'>, { readonly reason: string; readonly fix: string }>> = {
  paused: { reason: 'Watching is paused on this machine.', fix: 'Resume watching in Settings.' },
  offline: { reason: 'The forge could not be reached.', fix: 'Nothing is lost: it is read again on its own once the forge answers.' },
  'signed-out': { reason: 'The forge is not signed in, or its sign-in expired.', fix: 'Sign in with gh auth login; watching resumes on its own.' },
  'rate-limited': { reason: 'The forge’s rate limit was reached.', fix: 'Nothing is lost: it is read again on its own after a pause.' },
  unreadable: { reason: 'The forge answered with something the desk cannot read.', fix: 'It is read again on its own; if this persists, check the repository.' },
  gap: { reason: 'More changed than one read can cover, so watching this source stopped.', fix: 'Resume it to watch from now: what changed in the gap is skipped, not replayed.' },
}
const UNSAVED = { reason: 'The desk could not save how far this source was read.', fix: 'Free some disk space; nothing is lost, and it is read again on its own.' }

interface GroupState {
  project: string
  source: TriggerSource
  active: boolean
  gap: boolean
  failures: number
  nextAt: number
  lastPolledAt: number | null
  skipped: number
  state: TriggerSourceStatus['state']
  reason: string | null
  fix: string | null
}

export interface IntakeMonitorOptions {
  /** Every verified arm on this machine: `TriggerConsent.armed`. */
  readonly armed: () => Promise<readonly ArmedTrigger[]>
  readonly sources: IntakeSources
  readonly cursors: SourceCursors
  /** Admission: resolves only once the fact has a durable fired, skipped or duplicate answer. */
  readonly offer: (arm: ArmedTrigger, fact: TriggerFact) => Promise<void>
  readonly wall: () => number
  readonly monotonic: () => number
  readonly timers?: { every(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
  /** A source's status changed: for windows, and for a signed-out forge to be asked again. */
  readonly changed?: (status: TriggerSourceStatus) => void
}

const realTimers = {
  every: (fn: () => void, ms: number): unknown => {
    const handle = setInterval(fn, ms)
    handle.unref()
    return handle
  },
  clear: (handle: unknown): void => clearInterval(handle as NodeJS.Timeout),
}

/** Whether an arm reads a fact: its source, its events and labels, its own slot, and nothing from before it was armed. */
const accepts = (arm: ArmedTrigger, fact: TriggerFact): boolean =>
  acceptsFact(arm.definition, fact) && (fact.trigger === null || fact.trigger === arm.id) && fact.at >= arm.baseline

export class IntakeMonitor {
  readonly #options: IntakeMonitorOptions
  readonly #timers: NonNullable<IntakeMonitorOptions['timers']>
  readonly #groups = new Map<string, GroupState>()
  readonly #queues = new Map<string, Serial>()
  readonly #controllers = new Set<AbortController>()
  readonly #inflight = new Set<Promise<unknown>>()
  #reading = 0
  #paused = false
  #closed = false
  #timer: unknown = null

  constructor(options: IntakeMonitorOptions) {
    this.#options = options
    this.#timers = options.timers ?? realTimers
  }

  #queue(key: string): Serial {
    let queue = this.#queues.get(key)
    if (!queue) this.#queues.set(key, (queue = new Serial()))
    return queue
  }

  #state(group: Omit<SourceGroup, 'arms'>): GroupState {
    let state = this.#groups.get(group.key)
    if (!state) {
      state = {
        project: group.project, source: group.source, active: false, gap: false, failures: 0, nextAt: 0,
        lastPolledAt: null, skipped: 0, state: 'watching', reason: null, fix: null,
      }
      this.#groups.set(group.key, state)
    }
    return state
  }

  #say(state: GroupState, kind: TriggerSourceStatus['state'], sentence?: { reason: string; fix: string }): void {
    state.state = kind
    const words = sentence ?? (kind === 'watching' ? null : SENTENCES[kind])
    state.reason = words?.reason ?? null
    state.fix = words?.fix ?? null
    this.#options.changed?.(this.#statusOf(state))
  }

  #statusOf(state: GroupState): TriggerSourceStatus {
    const paused = this.#paused && state.state !== 'gap'
    return {
      project: state.project, source: state.source,
      state: paused ? 'paused' : state.state,
      reason: paused ? SENTENCES.paused.reason : state.reason,
      fix: paused ? SENTENCES.paused.fix : state.fix,
      lastPolledAt: state.lastPolledAt, skipped: state.skipped,
    }
  }

  /** How every source this monitor has seen stands. */
  statuses(): readonly TriggerSourceStatus[] {
    return [...this.#groups.values()].map((state) => this.#statusOf(state))
  }

  #track<T>(work: Promise<T>): Promise<T> {
    this.#inflight.add(work)
    void work.finally(() => this.#inflight.delete(work)).catch(() => {})
    return work
  }

  /** Starts, or resumes, watching: a timer only while a verified arm exists. */
  async start(): Promise<void> {
    if (this.#closed) return
    this.#paused = false
    await this.refresh()
  }

  /** Re-reads the arms and starts or stops the timer to match; call after an arm or disarm. */
  async refresh(): Promise<void> {
    const want = !this.#closed && !this.#paused && (await this.#options.armed()).length > 0
    if (want && this.#timer === null) this.#timer = this.#timers.every(() => { void this.tick(this.#options.wall()).catch(() => {}) }, TIMER_MS)
    if (!want && this.#timer !== null) {
      this.#timers.clear(this.#timer)
      this.#timer = null
    }
  }

  #stop(): void {
    if (this.#timer !== null) {
      this.#timers.clear(this.#timer)
      this.#timer = null
    }
    for (const controller of this.#controllers) controller.abort()
  }

  /** Machine pause: no new read, reads in flight abandoned with their cursors kept. Waits for them. */
  async pause(): Promise<void> {
    this.#paused = true
    this.#stop()
    await Promise.allSettled([...this.#inflight])
  }

  /** Stops for good: the timer, every read in flight, and waits for them in the foreground. */
  async close(): Promise<void> {
    this.#closed = true
    this.#stop()
    await Promise.allSettled([...this.#inflight])
  }

  /** Reads every due source: paced, one at a time per source, two across the machine. */
  async tick(now: number): Promise<void> {
    if (this.#paused || this.#closed) return
    const arms = await this.#options.armed()
    if (this.#paused || this.#closed) return
    const groups = new Map<string, SourceGroup>()
    for (const arm of arms) {
      const group = groupOf(arm)
      const existing = groups.get(group.key)
      groups.set(group.key, { ...group, arms: [...(existing?.arms ?? []), arm] })
    }
    const launched: Promise<void>[] = []
    for (const group of [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))) {
      const state = this.#state(group)
      if (state.active || state.gap || this.#reading >= MACHINE_READS || this.#options.monotonic() < state.nextAt) continue
      state.active = true
      this.#reading += 1
      launched.push(this.#track(this.#queue(group.key).run(() => this.#read(group, state, now)).finally(() => {
        state.active = false
        this.#reading -= 1
      })))
    }
    await Promise.all(launched)
  }

  async #read(group: SourceGroup, state: GroupState, now: number): Promise<void> {
    const controller = new AbortController()
    this.#controllers.add(controller)
    const { signal } = controller
    try {
      if (this.#closed || this.#paused) return
      let cursor = await this.#options.cursors.read(group.key)
      if (cursor?.continuation) {
        state.gap = true
        this.#say(state, 'gap')
        return
      }
      if (!cursor) {
        // A source read for the first time — restored, or its cursor lost — baselines first and fires nothing.
        // A schedule has nothing to inventory: each arm's own baseline guards its first slot.
        cursor = await this.#options.sources.inventory(group, signal, now)
        if (group.source !== 'schedule') {
          if (signal.aborted) return
          await this.#options.cursors.commit(group.key, cursor)
          this.#done(state, 0)
          return
        }
      }
      const batch = await this.#options.sources.poll(group, cursor, signal, now)
      if (signal.aborted) return
      if (!batch.complete) {
        state.gap = true
        await this.#options.cursors.commit(group.key, { ...cursor, continuation: batch.problem ?? 'gap' })
        this.#say(state, 'gap')
        return
      }
      // Who to offer to is read now, not before the read: an arm removed meanwhile gets nothing.
      const before = new Set(group.arms.map((arm) => arm.id))
      const current = (await this.#options.armed()).filter((arm) => groupOf(arm).key === group.key && before.has(arm.id))
      for (const fact of batch.facts) {
        for (const arm of current) {
          if (!accepts(arm, fact)) continue
          if (signal.aborted) return
          await this.#options.offer(arm, fact)
        }
      }
      if (signal.aborted) return
      await this.#options.cursors.commit(group.key, batch.next)
      this.#done(state, batch.skipped.reduce((sum, one) => sum + one.count, 0))
    } catch (error) {
      if (signal.aborted) return
      state.failures += 1
      state.nextAt = this.#options.monotonic() + BACKOFF_S[Math.min(state.failures, BACKOFF_S.length) - 1]! * 1000
      if (error instanceof ForgeReadError) this.#say(state, error.kind)
      else this.#say(state, 'unreadable', UNSAVED)
    } finally {
      state.lastPolledAt = this.#options.wall()
      this.#controllers.delete(controller)
    }
  }

  #done(state: GroupState, skipped: number): void {
    state.failures = 0
    state.nextAt = this.#options.monotonic() + POLL_INTERVAL_MS
    state.skipped = skipped
    this.#say(state, 'watching')
  }

  /**
   * The first observation for a new arm, which consent persists only after
   * it succeeds: a forge source never read before is inventoried without
   * firing; one already watched is read once to prove it still reads. A
   * schedule reads nothing. Returns the arm's baseline instant.
   */
  async baseline(arm: Pick<ArmedTrigger, 'project' | 'id' | 'definition' | 'binding'>): Promise<number> {
    const group = groupOf(arm)
    if (group.source === 'schedule') return this.#options.wall()
    return this.#track(this.#queue(group.key).run(async () => {
      const signal = new AbortController().signal
      const full: SourceGroup = { ...group, arms: [] }
      const cursor = await this.#options.cursors.read(group.key)
      if (!cursor || cursor.continuation) {
        await this.#options.cursors.commit(group.key, await this.#options.sources.inventory(full, signal, this.#options.wall()))
        const state = this.#state(group)
        state.gap = false
        this.#done(state, 0)
      } else {
        await this.#options.sources.probe(full, cursor, signal)
      }
      return this.#options.wall()
    }))
  }

  /** A person resumes a source that stopped at a gap: it watches from now, and the gap is skipped, not replayed. */
  async rebaseline(project: string, source: TriggerSource): Promise<void> {
    const arm = (await this.#options.armed()).find((one) => one.project === project && one.definition.on.kind === source)
    if (!arm) return
    const group = groupOf(arm)
    await this.#track(this.#queue(group.key).run(async () => {
      const cursor = await this.#options.sources.inventory({ ...group, arms: [] }, new AbortController().signal, this.#options.wall())
      await this.#options.cursors.commit(group.key, cursor)
      const state = this.#state(group)
      state.gap = false
      this.#done(state, 0)
    }))
  }
}
