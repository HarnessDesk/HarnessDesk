import { createHash } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  DEFAULT_TRIGGER_DAILY_USD, TRIGGER_DAILY_USD_MAX, TRIGGER_HISTORY_PAGE,
  type FlowExecution, type FlowOrigin, type ForgeReference, type FlowPreview, type GoalOrigin, type SeatRecord, type TriggerArmPreview,
  type TriggerAttention, type TriggerFact, type TriggerFiring, type TriggerGoalStatus, type TriggerHistoryPage,
  type TriggerDefinition, type TriggerPreferences, type TriggerProjectView, type TriggerSource, type TriggerSourceStatus, type TriggerView,
  type WireNotification,
} from '@harnessdesk/protocol'

import type { CredentialCipher } from '../credentials.js'
import { projectOf } from '../evidence/revision.js'
import type { GhApiRunner } from '../findings/forge.js'
import { Serial } from '../goals/assignments.js'
import { atomicJson } from '../goals/store.js'
import type { UsageSample } from '../ledger/insight.js'
import { Admission, AGAIN_MISSING, SKIP_CHANGED, type AdmissionOptions, type GoalLifecycle, type OfferAnswer } from './admission.js'
import { IntakeEffects, type IntakeObservationPort, type TriggerExecutionPort, type TriggerGoalPort } from './apply.js'
import { AttentionOutbox, type AttentionInput } from './attention.js'
import { BudgetWatch, TriggerBudgets, utcDay, type BudgetVerdict } from './budget.js'
import { TriggerClosures, TriggerConsent, type ArmBinding, type ArmedTrigger, type TriggerClosure } from './consent.js'
import { usdMicros } from './definition.js'
import { ForgeSource } from './forge.js'
import { goalWaits, type HostWaits } from './waits.js'
import { IntakeMonitor, intakeSources, SourceCursors } from './poll.js'
import { readTriggerSource, type TriggerSourceFile } from './source.js'
import { IntakeStore, type IntakeFiring, type IntakeOperation } from './store.js'

/**
 * The intake plane: the one place the host meets its triggers.
 *
 * It composes what the earlier tasks built — consent, the monitor, the
 * admission journal and its effects, budgets and their watch — around the
 * host's own planes, and adds the two things only the host can do: carry the
 * machine's own controls (pause, the daily cap) and say, by name, every wait
 * on unattended work.
 *
 * - **Nothing without an arm.** Loading reads three files and finishes what
 *   the journal began; it starts no timer and reads no forge. Watching begins
 *   only when a verified arm exists and the machine is not paused.
 * - **Startup order.** `load` runs once the Goals, the runs and the evidence
 *   are back, with dispatch held: every journaled firing is finished to its
 *   held round. `ready` runs once the runtimes are up: held firings are
 *   released through their gates, and only then do flows resume and sources
 *   get read.
 * - **Shutdown order.** `close` refuses new admissions, stops the timers,
 *   abandons reads in flight (their cursors kept), then waits for the journal
 *   and the outbox to drain. Nothing of it runs after `close` resolves.
 * - **A failed load stops triggers, not the desk.** Its reason is on every
 *   trigger surface; plain conversations never see it.
 *
 * Lock order: the plane's own queues — preferences and the attention outbox —
 * ask for nothing. A monitor read (intake source) offers to admission, which
 * reaches everything to its right in host.ts's documented order.
 */

const PREFERENCES_FILE = 'triggers-preferences.json'
const DESK_POSTS_FILE = 'triggers-desk-posts.json'
/** The comment ids the desk remembers posting, per repository: the newest, never more. */
const DESK_POSTS_LIMIT = 5000
const ISSUE_COMMENT = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/[1-9][0-9]{0,15}#issuecomment-([1-9][0-9]{0,18})$/
const METER_MS = 30_000
const SKIP_WINDOW_MS = 5 * 60_000
const SUBJECT = /^[1-9][0-9]{0,15}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export interface IntakeTimers {
  every(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** Everything the plane reads or asks of the host, named for what it does. */
export interface IntakeHostPort {
  /** The desk's state folder: consent, the journal, cursors, preferences and the outbox live here, and nowhere else. */
  readonly home: string
  /** The machine's credential cipher: it seals the arm key. */
  readonly cipher: CredentialCipher
  /** Admits a project a person opened; its canonical path. */
  confine(root: string): Promise<string>
  /** The committed triggers file; `readTriggerSource` unless a test reads another way. */
  source?(root: string): Promise<TriggerSourceFile>
  /** `FlowCatalog.resolve`. */
  flowSource(root: string, id: string): Promise<{ readonly source: string; readonly origin: FlowOrigin; readonly path: string }>
  /** `FlowPreviews.freeze`. */
  preview(root: string, source: string): Promise<FlowPreview>
  readonly goals: TriggerGoalPort & {
    lifecycle(goal: string): GoalLifecycle
    claim(goal: string, claim: () => void): Promise<boolean>
    origin(goal: string): GoalOrigin | null
  }
  readonly flows: TriggerExecutionPort & {
    supersedeTriggered(run: string, why: string, next: 'round' | 'person'): Promise<void>
    /** Every run on a Goal. */
    runs(goal: string): readonly FlowExecution[]
    execution(run: string): FlowExecution | null
    /** Stops a run with the reason; its cards, answers and findings are kept, and every Seat it lets go is interrupted. */
    stopRun(run: string, why: string): Promise<void>
    /** Holds a run for a pause or the cap: nothing recorded as a stop; `resumeTriggered` lets it go. */
    holdTriggered(run: string, why: string): Promise<void>
    /** Stops every check running on the Goal now, without waiting for the run's queue; each is left for a person. */
    interruptChecks?(goal: string): void
    /** A firing of the run was set aside for the person: any hold on it is let go, and it waits on them with why. */
    setAsideTriggered(run: string, why: string): Promise<void>
  }
  readonly evidence: IntakeObservationPort
  /** The Seat book. */
  seats(): readonly SeatRecord[]
  /** Interrupts every live turn on the Goal's open Seats, keeping what each already said. */
  interrupt(goal: string): Promise<void>
  /** Whether the plan the Goal's Seats spend from has allowance left, as the usage service last read it. */
  lane(goal: string): 'available' | 'spent' | 'unknown'
  /** Drives a trigger Goal's postings again: what a pause or the cap held is sent once it lifts, never twice (`Publications.settleForWrap`). */
  republish?(goal: string): Promise<void>
  /** Asks the usage service again for the runtimes on these Goals, so `lane` reads a fresh figure. */
  refreshLanes?(goals: readonly string[]): Promise<void>
  /** Every usage sample recorded for a project in a window, and whether the read covered everything. */
  usage(project: string, from: number, to: number): Promise<{ readonly samples: readonly UsageSample[]; readonly complete: boolean }>
  /** What the host itself holds on a Goal for a person: messages, approvals, questions, person steps, members, postings. */
  waits(goal: string): HostWaits
  push(notification: WireNotification): void
  log(message: string, details?: Readonly<Record<string, unknown>>): void
  now(): number
  monotonic(): number
  /** The forge reader; `gh` itself when absent. */
  readonly gh?: GhApiRunner
  /** Timers the plane's watchers use; unref'd real ones when absent. */
  readonly timers?: IntakeTimers
}

interface Preferences {
  readonly revision: number
  readonly paused: boolean
  readonly dailyUsd: number
}

const DEFAULT_PREFERENCES: Preferences = { revision: 0, paused: false, dailyUsd: DEFAULT_TRIGGER_DAILY_USD }

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const realTimers: IntakeTimers = {
  every: (fn, ms) => {
    const handle = setInterval(fn, ms)
    handle.unref()
    return handle
  },
  clear: (handle) => clearInterval(handle as NodeJS.Timeout),
}

const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code })

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

/** A history cursor: which project and trigger it pages, and where the last page ended. Checked, never trusted. */
const cursorOf = (project: string, id: string, at: number, key: string): string =>
  Buffer.from(JSON.stringify([hash(project).slice(0, 16), id, at, key])).toString('base64url')

export class IntakePlane {
  readonly #port: IntakeHostPort
  readonly #timers: IntakeTimers
  readonly #store: IntakeStore
  readonly #forge: ForgeSource
  readonly #consent: TriggerConsent
  readonly #monitor: IntakeMonitor
  readonly #admission: Admission
  readonly #budgets: TriggerBudgets
  readonly #watch: BudgetWatch
  readonly #attention: AttentionOutbox
  readonly #closures: TriggerClosures
  readonly #prefsSerial = new Serial()
  #prefs: Preferences = DEFAULT_PREFERENCES
  /** Why intake is off on this desk, or null. */
  #problem: string | null = null
  #loaded = false
  #dispatchReady = false
  #closed = false
  #meterTimer: unknown = null
  #metering: Promise<void> | null = null
  #reconciling: Promise<void> | null = null
  #dirty = false
  readonly #work = new Set<Promise<unknown>>()
  /** Turns a Seat began before its meter was opened, by Seat id: recorded as soon as it is. */
  readonly #early = new Map<string, { started?: number; ended?: number }>()
  /** The source groups a status has named, so a source back to watching resolves its wait. */
  readonly #sources = new Map<string, TriggerSourceStatus>()
  /** Comment ids the desk posted itself, by repository, read from `triggers-desk-posts.json` once. */
  #deskPosts: Map<string, string[]> | null = null
  readonly #deskSerial = new Serial()
  /** What each source read learned of its arms, by the read: gone with it. */
  readonly #batches = new WeakMap<object, Map<string, Promise<ArmBinding | null>>>()

  constructor(port: IntakeHostPort) {
    this.#port = port
    this.#timers = port.timers ?? realTimers
    this.#store = new IntakeStore(port.home)
    this.#forge = new ForgeSource({ ...(port.gh ? { run: port.gh } : {}), now: () => port.now() })
    const closures = this.#closures = new TriggerClosures({ flowSource: (root, id) => port.flowSource(root, id), preview: (root, source) => port.preview(root, source) })
    this.#consent = new TriggerConsent(port.home, port.cipher, {
      confine: (root) => port.confine(root),
      source: (root) => port.source ? port.source(root) : readTriggerSource(root),
      closure: closures,
      account: (project) => this.#forge.account(project),
      repository: (project) => this.#forge.repository(project),
      // The first observation baselines the source before the arm is written: the monitor's own.
      baseline: (arm) => this.#monitor.baseline(arm),
      now: () => port.now(),
    })
    this.#monitor = new IntakeMonitor({
      armed: () => this.#consent.armed(),
      sources: intakeSources(this.#forge),
      cursors: new SourceCursors(port.home),
      offer: async (arm, fact, batch) => { await this.#offer(arm, fact, batch) },
      wall: () => port.now(),
      monotonic: () => port.monotonic(),
      timers: this.#timers,
      changed: (status) => this.#sourceChanged(status),
    })
    this.#budgets = new TriggerBudgets(() => this.#store.read(), (change) => this.#admission.transact(change), {
      paused: () => this.#prefs.paused,
      capMicros: () => usdMicros(this.#prefs.dailyUsd),
      lane: (goal) => port.lane(goal),
      run: (goal) => this.#runOf(goal),
      now: () => port.now(),
    })
    this.#watch = new BudgetWatch(this.#budgets, (goal) => this.#runOf(goal), {
      interrupt: (goal) => port.interrupt(goal),
      stopRun: async (goal, reason) => {
        // A running check holds the run's queue: it is stopped first, so the stop never waits on it.
        port.flows.interruptChecks?.(goal)
        const run = this.#runOf(goal)
        if (run) await port.flows.stopRun(run.id, reason)
        this.#schedule()
      },
      hold: async (goal, reason) => {
        port.flows.interruptChecks?.(goal)
        const run = this.#runOf(goal)
        if (run) await port.flows.holdTriggered(run.id, reason)
        await port.interrupt(goal)
        this.#schedule()
      },
      timers: this.#timers,
    })
    this.#admission = new Admission(this.#store, {
      binding: (arm) => this.#consent.binding(arm.project, arm.id),
      // Closed, paused, or not yet past startup: nothing is admitted, and nothing is released.
      paused: () => this.#closed || this.#prefs.paused || !this.#dispatchReady,
      now: () => port.now(),
      lifecycle: (goal) => port.goals.lifecycle(goal),
      claim: (goal, claim) => port.goals.claim(goal, claim),
      reserve: (snapshot, operation, definition) => this.#budgets.reserve(snapshot, operation, definition),
    }, new IntakeEffects({
      goals: port.goals,
      flows: port.flows,
      evidence: port.evidence,
      gate: async (operation) => {
        const run = port.flows.execution(operation.run)
        if (!run) return 'This firing’s run is missing, so nothing of it was sent.'
        const verdict = this.#budgets.check(run)
        if (!verdict.ok) return verdict.reason
        return this.#seatsNow(operation)
      },
      supersede: (operation) => this.#supersede(operation),
      releaseHeld: () => this.#releaseHeld(),
      setAside: async (operation, reason) => {
        if (port.flows.execution(operation.run)) await port.flows.setAsideTriggered(operation.run, reason)
        this.#schedule()
      },
    }), {
      onStep: () => this.#schedule(),
      onFault: (fault) => { void this.#track(this.#faulted(fault)).catch(() => {}) },
    })
    this.#attention = new AttentionOutbox(port.home, {
      announce: (attention) => port.push({ method: 'trigger/attention', params: { attention } }),
      now: () => port.now(),
      log: (message, details) => port.log(message, details),
    })
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * At start, after the Goals, runs and evidence are back and before any
   * runtime is asked for anything: reads the machine's controls, the
   * journal and the outbox, and finishes every journaled firing to its held
   * round. Releases nothing, reads no source and starts no timer.
   */
  async load(): Promise<void> {
    try {
      this.#prefs = await this.#readPreferences()
      await this.#store.load()
      await this.#attention.load()
      this.#problem = this.#store.problem
      if (this.#problem === null) await this.#admission.recover()
    } catch (error) {
      this.#problem = `Triggers are off on this desk: ${error instanceof Error ? error.message : String(error)}`
      this.#port.log('intake could not recover its journal', { error: this.#problem })
    }
    this.#loaded = true
  }

  /**
   * Once the runtimes are up: held firings are released through their gates,
   * then — unless the machine is paused — sources are watched and budgets
   * swept. Every unresolved wait is announced again by its own id.
   */
  async ready(): Promise<void> {
    if (this.#closed) return
    this.#dispatchReady = true
    if (this.#problem === null) {
      await this.#admission.recover().catch((error: unknown) => {
        this.#port.log('a trigger firing could not be released', { error: error instanceof Error ? error.message : String(error) })
      })
    }
    if (this.#closed) return
    await this.#startWatching()
    this.#attention.replay()
    this.#schedule()
  }

  async #startWatching(): Promise<void> {
    if (this.#closed || this.#prefs.paused || this.#problem !== null) return
    await this.#monitor.start()
    await this.#syncTimers()
  }

  /**
   * The budget sweep and the meter run only while there is something to
   * watch — an arm on this machine, or a trigger Goal whose budget is live —
   * and never while paused or closed: a desk with no triggers runs nothing.
   */
  async #syncTimers(): Promise<void> {
    const armed = this.#closed ? 0 : (await this.#consent.armed().catch(() => [])).length
    // A close or a pause that landed during the read above leaves no timer behind.
    const want = !this.#closed && !this.#prefs.paused && this.#problem === null && (armed > 0 || this.#budgets.live().length > 0)
    if (want) {
      this.#watch.start()
      if (this.#meterTimer === null) {
        this.#meterTimer = this.#timers.every(() => {
          void this.meter().catch(() => {})
          void this.#track(this.#retryHeld())
        }, METER_MS)
      }
    } else {
      this.#watch.close()
      if (this.#meterTimer !== null) {
        this.#timers.clear(this.#meterTimer)
        this.#meterTimer = null
      }
    }
  }

  async #stopWatching(): Promise<void> {
    this.#watch.close()
    if (this.#meterTimer !== null) {
      this.#timers.clear(this.#meterTimer)
      this.#meterTimer = null
    }
    await this.#monitor.pause()
  }

  /**
   * Stops for good: no new admission, no timer, reads in flight abandoned
   * with their cursors kept; resolves once the journal and the outbox have
   * drained. Idempotent.
   */
  async close(): Promise<void> {
    this.#closed = true
    this.#watch.close()
    if (this.#meterTimer !== null) {
      this.#timers.clear(this.#meterTimer)
      this.#meterTimer = null
    }
    await this.#monitor.close()
    await Promise.allSettled([...this.#work])
    await this.#metering?.catch(() => {})
    await this.#reconciling?.catch(() => {})
    if (this.#store.problem === null) await this.#admission.transact(() => ({ next: null, value: undefined })).catch(() => {})
    await this.#attention.idle()
    await this.#prefsSerial.run(async () => {})
    await this.#deskSerial.run(async () => {})
  }

  #track<T>(work: Promise<T>): Promise<T> {
    this.#work.add(work)
    void work.finally(() => this.#work.delete(work)).catch(() => {})
    return work
  }

  /** Why triggers do nothing on this desk now, or null. */
  get problem(): string | null {
    return this.#loaded ? this.#problem ?? this.#admission.problem : null
  }

  #refuseWhenOff(): void {
    if (this.#closed) throw coded('The desk is closing, so triggers are not changed now.', 'HD_TRIGGER_REFUSED')
    const problem = this.problem
    if (problem !== null) throw coded(problem, 'HD_TRIGGER_REFUSED')
  }

  // ------------------------------------------------------------ admission

  async #offer(arm: ArmedTrigger, fact: TriggerFact, batch?: object): Promise<OfferAnswer> {
    if (this.#closed) throw new Error('The desk is closing.')
    // A comment whose id the desk recorded posting is the desk's own, marker or not: it never fires.
    if (fact.action === 'commented' && fact.desk !== true && await this.#postedHere(fact)) fact = { ...fact, desk: true }
    const answer = await this.#admission.offer(arm, fact, batch ? { binding: () => this.#bindingOnce(batch, arm) } : {})
    this.#changed(arm.project)
    if (answer.outcome === 'fired') await this.#syncTimers()
    if (answer.outcome === 'skipped' && answer.reason !== null) {
      // Recorded in history either way; said once in five minutes per trigger and reason, never a storm.
      await this.#attention.notice(`skip:${arm.project}:${arm.id}`, {
        key: `skip:${arm.project}:${arm.id}:${hash(answer.reason).slice(0, 16)}`,
        goal: null, trigger: arm.id, kind: 'skipped',
        waitingOn: { kind: 'person', label: 'You' },
        sentence: answer.reason === SKIP_CHANGED ? `Trigger ${arm.id} stopped firing: ${answer.reason}` : `Trigger ${arm.id} skipped a ${sourceWords(fact.source)}: ${answer.reason}`,
        action: 'open-trigger',
      }, SKIP_WINDOW_MS)
    }
    this.#schedule()
    return answer
  }

  async #readDeskPosts(): Promise<Map<string, string[]>> {
    if (this.#deskPosts) return this.#deskPosts
    const posts = new Map<string, string[]>()
    try {
      const parsed = JSON.parse(await readFile(join(this.#port.home, DESK_POSTS_FILE), 'utf8')) as unknown
      if (isMap(parsed) && parsed['version'] === 1 && isMap(parsed['comments'])) {
        for (const [repository, ids] of Object.entries(parsed['comments'])) {
          if (REPO.test(repository) && Array.isArray(ids)) posts.set(repository, ids.filter((one): one is string => typeof one === 'string' && /^[1-9][0-9]{0,18}$/.test(one)).slice(-DESK_POSTS_LIMIT))
        }
      }
    } catch { /* none yet, or unreadable: the marker still guards every post */ }
    this.#deskPosts = posts
    return posts
  }

  async #postedHere(fact: TriggerFact): Promise<boolean> {
    const match = ISSUE_COMMENT.exec(fact.url ?? '')
    if (!match || match[1] !== fact.repository) return false
    return (await this.#readDeskPosts()).get(match[1]!)?.includes(match[2]!) ?? false
  }

  /**
   * The desk posted a comment to the forge (a tool's `issue_comment`,
   * `pr_comment`): its id is recorded, and kept across a restart, so the
   * comment never fires a trigger even if its marker were lost. Reads and
   * writes one small file; a desk with no trigger still records, for the
   * trigger armed tomorrow over the same issue.
   */
  deskPosted(reference: ForgeReference): Promise<void> {
    const match = reference.kind === 'comment' ? ISSUE_COMMENT.exec(reference.url) : null
    if (!match || match[1] !== reference.repo) return Promise.resolve()
    return this.#deskSerial.run(async () => {
      const posts = await this.#readDeskPosts()
      const ids = posts.get(match[1]!) ?? []
      if (ids.includes(match[2]!)) return
      posts.set(match[1]!, [...ids, match[2]!].slice(-DESK_POSTS_LIMIT))
      await atomicJson(join(this.#port.home, DESK_POSTS_FILE), { version: 1, comments: Object.fromEntries(posts) })
    })
  }

  /**
   * The arm as it reads now, read once per source read: a backlog of facts
   * asks who is signed in and which repository once, not once each. A read
   * that failed fails every offer of that batch the same way — no answer.
   */
  #bindingOnce(batch: object, arm: ArmedTrigger): Promise<ArmBinding | null> {
    let reads = this.#batches.get(batch)
    if (!reads) this.#batches.set(batch, (reads = new Map()))
    const key = JSON.stringify([arm.project, arm.id])
    let read = reads.get(key)
    if (!read) reads.set(key, (read = this.#consent.binding(arm.project, arm.id)))
    return read
  }

  /**
   * A firing whose effects failed is named, never silent: while it is tried
   * again its project's new events wait, and the wait is on the desk; once
   * set aside it is the person's, until they arm or disarm that trigger.
   * Other projects are untouched either way.
   */
  async #faulted(fault: Parameters<NonNullable<AdmissionOptions['onFault']>>[0]): Promise<void> {
    if ('cleared' in fault) {
      await this.#attention.sync(`fault:${fault.project}`, [])
      this.#changed(fault.project)
      return
    }
    const wait: AttentionInput = {
      key: `fault:${fault.project}:${fault.key}:${fault.final ? 'aside' : 'retry'}`,
      goal: null, trigger: fault.trigger, kind: 'source',
      waitingOn: fault.final ? { kind: 'person', label: 'You' } : { kind: 'service', label: 'This desk' },
      sentence: `Trigger ${fault.trigger}: ${fault.reason}`, action: 'open-trigger',
    }
    await this.#attention.sync(`fault:${fault.project}`, fault.final ? [] : [wait])
    /* Set aside: the person's. When its Goal exists the Goal names it — its
       firing's tombstone carries why, until the Goal is wrapped; when none
       was made, the trigger does, until they arm or disarm it again. */
    const lifecycle = this.#port.goals.lifecycle(fault.goal)
    if (fault.final && (lifecycle === 'missing' || lifecycle === 'wrapped')) {
      await this.#attention.sync(`aside:${fault.project}:${fault.trigger}:${fault.key}`, [wait])
    }
    this.#changed(fault.project)
    this.#schedule()
  }

  /** A new head reached an open Goal: its old work stops, through the host's own interrupt. */
  async #supersede(operation: IntakeOperation): Promise<void> {
    const run = this.#port.flows.execution(operation.run)
    if (!run?.intake) return
    const next = operation.mode === 'again' ? 'round' : 'person'
    await this.#port.flows.supersedeTriggered(operation.run, AGAIN_MISSING, next)
    await this.#port.interrupt(operation.goal)
  }

  /**
   * Whether this firing's Seats can be taken now — the availability an arm
   * never binds, read again at dispatch (plan decision 4). A runtime that is
   * down or signed out holds the firing with a named wait, never stalls or
   * consumes it; the next pass releases it once a seat can be taken.
   */
  async #seatsNow(operation: IntakeOperation): Promise<string | { readonly reason: string; readonly final: true } | null> {
    const payload = operation.payload
    if (!payload) return null
    let closure: TriggerClosure
    try {
      closure = await this.#closures.freeze(operation.project, payload.definition)
    } catch (error) {
      return `Its Seats could not be read now (${error instanceof Error ? error.message : String(error)}), so nothing was sent. It starts on its own once they can.`
    }
    if (closure.availability.length === 0) return null
    const seat = closure.preview.seats.find((one) => one.plan.blocked === null && one.plan.winner === null)
    const who = seat ? `“${seat.agent}”` : 'its Agent'
    /* Every candidate passed over for a reason that does not lift on its own
       — this Mac refuses an unattended seat whose ceiling is only asked, or
       the runtime is one nothing here can run — is not a wait: nothing will
       ever let it go, so it is the person's now, with the change it needs,
       and its slot and reservation are given back. */
    const reasons = seat?.plan.candidates.map((one) => one.reason?.kind ?? null) ?? []
    if (reasons.length > 0 && reasons.every((kind) => kind === 'unheld' || kind === 'unknownRuntime')) {
      const fix = reasons.includes('unheld')
        ? 'This Mac refuses an unattended Seat whose ceiling can only be asked; choose to seat it in Permissions › Ceilings, or prefer a runtime that holds it, then arm the trigger again.'
        : 'None of the runtimes it prefers can run here; change the Agent’s seats, then arm the trigger again.'
      return { reason: `No seat can ever be opened for ${who} as things stand, so this firing was set aside. ${fix}`, final: true }
    }
    return `No seat can be opened for ${who} right now, so this firing waits. It starts on its own once one can.`
  }

  /** The runs a pause or the cap holds now, and whether any firing is still waiting for its release. */
  #heldRuns(): readonly FlowExecution[] {
    return this.#budgets.live().map((goal) => this.#runOf(goal))
      .filter((run): run is FlowExecution => run !== null && run.state === 'running' && (run.intake?.heldFor ?? null) !== null)
  }

  /**
   * Lets go of every run a pause or the cap held whose gate now allows it,
   * unless a firing of its own is still pending — that firing's release lets
   * it go. Inside admission's queue (`Admission.recover`), which is to the
   * run queue's left.
   */
  async #releaseHeld(): Promise<void> {
    if (this.#closed || !this.#dispatchReady) return
    const pending = new Set(this.#store.read().operations.map((one) => one.goal))
    for (const run of this.#heldRuns()) {
      if (pending.has(run.goal) || !this.#budgets.check(run).ok) continue
      await this.#port.flows.resumeTriggered(run.id)
    }
  }

  /** After a pause or the cap lifted: every live trigger Goal's postings that waited are driven again, outside admission's queue. */
  async #republish(): Promise<void> {
    for (const goal of this.#budgets.live()) {
      if (this.#closed) return
      await this.#port.republish?.(goal).catch((error: unknown) => {
        this.#port.log('a trigger Goal’s held postings could not be sent', { goal, error: error instanceof Error ? error.message : String(error) })
      })
    }
  }

  /**
   * The intake gate by Goal, for a dispatch outside a run's own queue — a
   * closed round's review, a finding's post. Ok for a Goal no trigger opened.
   */
  async beforeDispatch(goal: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string; readonly detail: string }> {
    if (this.#port.goals.origin(goal)?.kind !== 'trigger') return { ok: true }
    if (this.#closed) return { ok: false, reason: 'needs a person', detail: 'The desk is closing, so nothing more is sent.' }
    return this.#budgets.beforeDispatch(goal)
  }

  /**
   * Firings applied and not yet let go — waiting on a seat, a pause or the
   * cap — and runs a pause or the cap held are offered their release again:
   * what a pass of the timers does, so a runtime coming back or a raised cap
   * needs nobody to press anything.
   */
  async #retryHeld(): Promise<void> {
    if (this.#closed || this.#prefs.paused || !this.#dispatchReady || this.#problem !== null) return
    let waiting: boolean
    try {
      waiting = this.#store.read().operations.length > 0 || this.#heldRuns().length > 0
    } catch {
      return
    }
    if (!waiting) return
    await this.#admission.recover().catch((error: unknown) => {
      this.#port.log('a held trigger firing could not be released', { error: error instanceof Error ? error.message : String(error) })
    })
  }

  /** What a trigger would run, frozen from the same reads its arm consented to: a run's start re-reads it. */
  freeze(root: string, definition: TriggerDefinition): Promise<TriggerClosure> {
    return this.#closures.freeze(root, definition)
  }

  /** The gate every dispatch of a trigger's run passes: its budget, read from the journal alone. */
  gate(run: FlowExecution): BudgetVerdict {
    if (this.#closed) return { ok: false, reason: 'The desk is closing, so nothing more is sent.' }
    return this.#budgets.check(run)
  }

  /** Whether a firing is being recorded into this Goal now: a wrap waits for it. */
  held(goal: string): boolean {
    return this.#admission.held(goal)
  }

  #runOf(goal: string): FlowExecution | null {
    return this.#port.flows.runs(goal).find((run) => run.intake) ?? null
  }

  #changed(project: string): void {
    let revision = 0
    try {
      revision = this.#store.read().revision
    } catch { /* an unreadable journal still invalidates */ }
    this.#port.push({ method: 'trigger/changed', params: { project, revision } })
  }

  // --------------------------------------------------------------- arming

  /** A project's triggers as this machine stands on each. Reads only; lists an arm gone bad as a wait. */
  async list(root: string): Promise<TriggerProjectView> {
    const view = await this.#consent.list(root)
    const triggers = view.triggers.map((one) => this.#decorate(view.project, one))
    for (const trigger of triggers) await this.#armWait(view.project, trigger)
    return { ...view, triggers }
  }

  preview(root: string, id: string): Promise<TriggerArmPreview> {
    return this.#consent.preview(root, id)
  }

  async arm(root: string, id: string, token: string): Promise<TriggerView> {
    this.#refuseWhenOff()
    const armed = await this.#consent.arm(root, id, token)
    await this.#monitor.refresh()
    await this.#syncTimers()
    const project = await this.#project(root)
    // A firing set aside for the person was theirs until they acted on its trigger: arming it again is that act.
    await this.#attention.resolveScopes(`aside:${project}:${id}:`)
    const view = this.#decorate(project, armed)
    await this.#armWait(project, view)
    this.#changed(project)
    return view
  }

  async disarm(root: string, id: string): Promise<TriggerView> {
    if (this.#closed) throw coded('The desk is closing, so triggers are not changed now.', 'HD_TRIGGER_REFUSED')
    const off = await this.#consent.disarm(root, id)
    await this.#monitor.refresh()
    await this.#syncTimers()
    const project = await this.#project(root)
    await this.#attention.resolveScopes(`aside:${project}:${id}:`)
    const view = this.#decorate(project, off)
    await this.#armWait(project, view)
    this.#changed(project)
    return view
  }

  /**
   * A person resumes a trigger's source that stopped at a gap: it is read
   * again from now, and what changed in the gap is skipped, never replayed.
   * Refused for a trigger that is not armed here, or a source not at a gap.
   */
  async rebaseline(root: string, id: string): Promise<TriggerView> {
    this.#refuseWhenOff()
    const project = await this.#project(root)
    const arm = (await this.#consent.armed()).find((one) => one.project === project && one.id === id)
    if (!arm) throw coded('This trigger is not armed on this machine, so there is nothing to watch from now.', 'HD_TRIGGER_REFUSED')
    const kind = arm.definition.on.kind
    if (this.#monitor.status(project, kind)?.state !== 'gap') {
      throw coded('Its source is not stopped at a gap, so it keeps reading from where it was.', 'HD_TRIGGER_REFUSED')
    }
    await this.#monitor.rebaseline(project, kind)
    this.#changed(project)
    const view = (await this.list(root)).triggers.find((one) => one.id === id)
    if (!view) throw coded(`There is no committed trigger called "${id}".`, 'HD_TRIGGER_REFUSED')
    return view
  }

  /** The canonical project a root a person opened belongs to: what arms and firings are keyed by. */
  async #project(root: string): Promise<string> {
    return projectOf(await this.#port.confine(root))
  }

  /** An arm that was on and no longer stands is a wait on the person; one off, or armed and standing, is none. */
  async #armWait(project: string, view: TriggerView): Promise<void> {
    const bad = view.state === 'changed' || view.state === 'refused'
    await this.#attention.sync(`arm:${project}:${view.id}`, bad && view.reason ? [{
      key: `arm:${project}:${view.id}:${hash(view.reason).slice(0, 16)}`,
      goal: null, trigger: view.id, kind: 'source', waitingOn: { kind: 'person', label: 'You' },
      sentence: `Trigger ${view.id} stopped: ${view.reason}`, action: 'open-trigger',
    }] : [])
  }

  #decorate(project: string, view: TriggerView): TriggerView {
    let snapshot
    try {
      snapshot = this.#store.read()
    } catch {
      return view
    }
    const mine = Object.entries(snapshot.firings)
      .filter(([, firing]) => firing.project === project && firing.trigger === view.id)
      .sort((a, b) => b[1].at - a[1].at || a[0].localeCompare(b[0]))
    const latest = mine[0]
    const openGoals = new Set(Object.values(snapshot.groups)
      .filter((group) => group.project === project && group.trigger === view.id && group.open && this.#port.goals.lifecycle(group.goal) !== 'wrapped' && this.#port.goals.lifecycle(group.goal) !== 'missing')
      .map((group) => group.goal)).size
    const paused = view.state === 'armed' && this.#prefs.paused
    // A firing of this project that has not landed holds its new events: said on every armed trigger it holds.
    const fault = view.state === 'armed' && !paused ? this.#admission.fault(project) : null
    const source = view.armed && view.definition ? this.#monitor.status(project, view.definition.on.kind) : null
    return {
      ...view,
      ...(paused ? { state: 'paused' as const, reason: 'Triggers are paused on this machine.', fix: 'Resume triggers in Settings.' } : {}),
      ...(fault ? { reason: fault, fix: null } : {}),
      source,
      last: latest ? this.#row(latest[0], latest[1], view.definition?.on.kind ?? null, snapshot.operations) : null,
      openGoals,
    }
  }

  // -------------------------------------------------------------- history

  #row(key: string, firing: IntakeFiring, fallback: TriggerSource | null, operations: readonly IntakeOperation[]): TriggerFiring {
    const pending = operations.find((one) => one.key === key && !one.dispatched)
    const run = firing.run ? this.#port.flows.execution(firing.run) : null
    const round = run?.rounds.find((one) => one.cause === `cause:intake:${key}`)?.n ?? (firing.mode === 'start' && run?.rounds[0] ? run.rounds[0].n : null)
    const outcome: TriggerFiring['outcome'] = firing.outcome === 'skipped' ? 'skipped' : firing.setAside ? 'set-aside' : pending ? 'pending' : firing.mode === 'record' ? 'recorded' : 'fired'
    // A Goal that was never made — its firing set aside before — is never linked.
    const made = firing.goal !== null && this.#port.goals.lifecycle(firing.goal) !== 'missing'
    return {
      id: key, trigger: firing.trigger, source: firing.source ?? fallback ?? 'pull-request', subject: firing.subject ?? '',
      at: firing.at, outcome,
      reason: firing.outcome === 'skipped' ? firing.reason : pending?.attention ?? firing.attention ?? firing.reason,
      goal: made ? firing.goal : null, run: made ? firing.run ?? null : null, round: made ? round : null, head: firing.head ?? null,
    }
  }

  /** One trigger's firings, newest first, at most fifty a page; a cursor answers only for the trigger it came from. */
  async history(root: string, id: string, cursor?: string): Promise<TriggerHistoryPage> {
    const project = await this.#project(root)
    const snapshot = this.#store.read()
    let after: { at: number; key: string } | null = null
    if (cursor !== undefined) {
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
      } catch {
        parsed = null
      }
      if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== hash(project).slice(0, 16) || parsed[1] !== id ||
        !Number.isSafeInteger(parsed[2]) || typeof parsed[3] !== 'string') {
        throw coded('This history page belongs to another trigger. Open the trigger again.', 'HD_TRIGGER_REFUSED')
      }
      after = { at: parsed[2] as number, key: parsed[3] as string }
    }
    const source = (await this.#consent.armed()).find((arm) => arm.project === project && arm.id === id)?.definition.on.kind ?? null
    const rows = Object.entries(snapshot.firings)
      .filter(([, firing]) => firing.project === project && firing.trigger === id)
      .sort((a, b) => b[1].at - a[1].at || a[0].localeCompare(b[0]))
      .filter(([key, firing]) => after === null || firing.at < after.at || (firing.at === after.at && key.localeCompare(after.key) > 0))
    const page = rows.slice(0, TRIGGER_HISTORY_PAGE)
    const last = page.at(-1)
    return {
      items: page.map(([key, firing]) => this.#row(key, firing, source, snapshot.operations)),
      next: rows.length > TRIGGER_HISTORY_PAGE && last ? cursorOf(project, id, last[1].at, last[0]) : null,
    }
  }

  // ---------------------------------------------------------- preferences

  async #readPreferences(): Promise<Preferences> {
    let handle
    try {
      handle = await open(join(this.#port.home, PREFERENCES_FILE), 'r')
    } catch {
      return DEFAULT_PREFERENCES
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > 64 * 1024) throw new Error('unreadable')
      const parsed = JSON.parse(await handle.readFile('utf8')) as unknown
      if (!isMap(parsed) || parsed['version'] !== 1 || !Number.isSafeInteger(parsed['revision']) || (parsed['revision'] as number) < 0 ||
        typeof parsed['paused'] !== 'boolean' || typeof parsed['dailyUsd'] !== 'number' || !Number.isFinite(parsed['dailyUsd']) ||
        (parsed['dailyUsd'] as number) < 0 || (parsed['dailyUsd'] as number) > TRIGGER_DAILY_USD_MAX) throw new Error('unreadable')
      return { revision: parsed['revision'] as number, paused: parsed['paused'] as boolean, dailyUsd: parsed['dailyUsd'] as number }
    } catch {
      // Fail closed: a controls file nobody can read pauses triggers rather than guessing a cap.
      return { revision: 0, paused: true, dailyUsd: 0 }
    } finally {
      await handle.close()
    }
  }

  async preferences(): Promise<TriggerPreferences> {
    const now = this.#port.now()
    let charged: number | null = 0
    let reserved = 0
    let day = utcDay(now)
    try {
      const snapshot = this.#store.read()
      day = utcDay(Math.max(now, snapshot.clock))
      charged = (snapshot.days[day] ?? 0) / 1_000_000
      reserved = Object.values(snapshot.budgets).reduce((sum, one) => sum + (one.settled ? 0 : one.reservedMicros), 0) / 1_000_000
    } catch {
      charged = null
    }
    return { revision: this.#prefs.revision, paused: this.#prefs.paused, dailyUsd: this.#prefs.dailyUsd, day, chargedUsd: charged, reservedUsd: reserved }
  }

  /**
   * A person's pause and daily cap, compared on the revision they read and
   * saved before anything acts on them. Pausing stops watching and holds
   * every live trigger run — its turns and checks interrupted, its work
   * kept, nothing recorded as a stop; resuming watches again and continues
   * what the pause held, replaying no uncertain effect. A cap lowered below
   * what is committed holds work the same way, and raising it continues it.
   */
  async setPreferences(revision: number, paused: boolean, dailyUsd: number): Promise<TriggerPreferences> {
    if (this.#closed) throw coded('The desk is closing, so triggers are not changed now.', 'HD_TRIGGER_REFUSED')
    if (!Number.isFinite(dailyUsd) || dailyUsd < 0 || dailyUsd > TRIGGER_DAILY_USD_MAX) {
      throw coded(`Set a daily cap from $0 to $${TRIGGER_DAILY_USD_MAX}.`, 'HD_TRIGGER_REFUSED')
    }
    const before = await this.#prefsSerial.run(async () => {
      if (revision !== this.#prefs.revision) throw coded('These trigger settings changed. Read them again before saving.', 'HD_TRIGGER_STALE')
      const was = this.#prefs
      const next: Preferences = { revision: Math.max(was.revision + 1, this.#port.now()), paused, dailyUsd }
      await atomicJson(join(this.#port.home, PREFERENCES_FILE), { version: 1, ...next })
      this.#prefs = next
      return was
    })
    if (paused && !before.paused) {
      await this.#stopWatching()
      // Every live run is held now, its turns and checks interrupted — never left dispatching while paused, never stopped for good.
      await this.#watch.tick()
    } else if (!paused && before.paused) {
      // What the pause held continues, and what waited to be released is let go; then watching resumes.
      if (this.#problem === null && this.#dispatchReady) {
        await this.#admission.recover().catch(() => {})
        await this.#republish()
      }
      await this.#startWatching()
    } else if (!paused && dailyUsd !== before.dailyUsd) {
      // Lowered: work past it holds. Raised: what it held continues.
      await this.#watch.tick()
      if (this.#problem === null && this.#dispatchReady) {
        await this.#admission.recover().catch(() => {})
        await this.#republish()
      }
    }
    this.#port.push({ method: 'trigger/changed', params: { project: '', revision: this.#prefs.revision } })
    this.#schedule()
    return this.preferences()
  }

  // ---------------------------------------------------------------- Goals

  /** A trigger Goal's origin, budget and named waits; null for every other Goal. */
  async goal(goal: string): Promise<TriggerGoalStatus | null> {
    const origin = this.#port.goals.origin(goal)
    if (origin?.kind !== 'trigger') return null
    let snapshot
    try {
      snapshot = this.#store.read()
    } catch {
      return null
    }
    const firing = snapshot.firings[origin.event]
    const source: TriggerSource = firing?.source ?? 'schedule'
    const subject = firing?.subject && SUBJECT.test(firing.subject) ? firing.subject : null
    const label = source === 'pull-request' && subject ? `from PR #${subject}` : source === 'issue' && subject ? `from issue #${subject}` : 'from a schedule'
    const repository = firing?.repository && REPO.test(firing.repository) ? firing.repository : null
    const url = repository && subject && source !== 'schedule'
      ? `https://github.com/${repository}/${source === 'pull-request' ? 'pull' : 'issues'}/${subject}`
      : null
    return {
      goal, trigger: origin.trigger, source, label, url,
      budget: this.#budgets.state(goal),
      waits: this.#attention.list({ goal, open: true }),
    }
  }

  /**
   * A trigger Goal's Seat opened: its meter starts, at zero for the session
   * the desk opened for it. A turn the Seat began before its meter existed —
   * its brief, handed over while it was being seated — is recorded right
   * after, with a usage read, never lost.
   */
  seated(record: SeatRecord, delegation: 'none' | 'some' | 'unknown'): void {
    const goal = record.board
    if (!goal || this.#closed || !this.#hasBudget(goal)) return
    void this.#track((async () => {
      await this.#budgets.seated(goal, {
        seat: record.id, runtime: record.session.runtime, sessionId: record.session.sessionId, project: record.checkout.project,
        openedAt: record.openedAt, fresh: true, delegation,
      })
      const early = this.#early.get(record.id)
      this.#early.delete(record.id)
      if (early) await this.#meterGoal(goal, { seat: record.id, ...early })
    })()).catch((error: unknown) => this.#port.log('a trigger Seat’s meter could not start', { error: String(error) }))
  }

  /**
   * A turn started or ended on a trigger Goal's Seat. Its end is recorded in
   * the same save as a usage read made after it, so a finished turn is
   * metered — or, when the read had gaps, unknown — never read as zero.
   */
  turn(record: SeatRecord, change: 'started' | 'ended'): void {
    const goal = record.board
    if (!goal || this.#closed || !this.#hasBudget(goal)) return
    const at = this.#port.now()
    if (!this.#hasMeter(goal, record.id)) {
      // Its meter is still being opened: the turn waits for it rather than being dropped.
      const early = this.#early.get(record.id) ?? {}
      this.#early.set(record.id, change === 'started' ? { ...early, started: at } : { ...early, ended: at })
      return
    }
    void this.#track(this.#meterGoal(goal, { seat: record.id, ...(change === 'started' ? { started: at } : { ended: at }) }))
      .catch((error: unknown) => this.#port.log('a trigger Seat’s turn could not be metered', { error: String(error) }))
  }

  /** A Goal wrapped: its reservation settles against its final spend — only a known, complete one — and its waits end. */
  wrapped(goal: string): void {
    if (this.#closed || !this.#hasBudget(goal)) return
    void this.#track((async () => {
      await this.#meterGoal(goal)
      await this.#budgets.settle(goal)
      await this.#syncTimers()
      this.#schedule()
    })()).catch((error: unknown) => this.#port.log('a trigger Goal’s budget could not settle', { error: String(error) }))
  }

  #hasMeter(goal: string, seat: string): boolean {
    return this.#store.metered(goal, seat)
  }

  #hasBudget(goal: string): boolean {
    return this.#store.metered(goal)
  }

  // --------------------------------------------------------------- meters

  /** One usage read for one Goal, folded with a turn when one is given. */
  async #meterGoal(goal: string, turn?: { readonly seat: string; readonly started?: number; readonly ended?: number }): Promise<void> {
    const budget = this.#store.read().budgets[goal]
    if (!budget) return
    const at = this.#port.now()
    let read: { readonly samples: readonly UsageSample[]; readonly complete: boolean }
    try {
      read = await this.#port.usage(budget.project, Math.max(0, budget.startedAt - 60_000), at + 1)
    } catch {
      read = { samples: [], complete: false }
    }
    await this.#budgets.read(goal, read.samples, this.#port.seats().filter((seat) => seat.board === goal), { at, complete: read.complete }, turn)
  }

  /** Every live budget read once: what keeps a Seat inside a turn under a minute stale. */
  meter(): Promise<void> {
    this.#metering ??= (async () => {
      const live = this.#budgets.live()
      if (live.length === 0 || this.#closed) return
      await this.#port.refreshLanes?.(live).catch(() => {})
      for (const goal of live) {
        if (this.#closed) return
        await this.#meterGoal(goal).catch((error: unknown) => this.#port.log('a trigger Goal could not be metered', { error: String(error) }))
      }
    })().finally(() => { this.#metering = null })
    return this.#metering
  }

  /**
   * One pass of everything the timers do, in order: read the sources, read
   * the meters, sweep the budgets, name the waits. What a test drives
   * instead of a clock.
   */
  async tick(): Promise<void> {
    if (this.#closed) return
    // Meters first: an offer's release reads a spend no older than this pass.
    await this.meter()
    await this.#monitor.tick(this.#port.now())
    await this.meter()
    await this.#watch.tick()
    await this.#retryHeld()
    await this.reconcile()
  }

  // ------------------------------------------------------------ attention

  /** Something a trigger Goal's waits are made of moved: they are named again, once the current pass ends. */
  noticed(notification: WireNotification): void {
    // A desk with no trigger Goal and no open wait has nothing to name: the plain path pays nothing.
    if (this.#closed || !this.#loaded || (!this.#store.busy && !this.#attention.open)) return
    switch (notification.method) {
      case 'goal/changed':
        if (notification.params.view.goal.origin.kind === 'trigger') this.#schedule()
        return
      case 'flow/execution-changed':
        if (notification.params.execution.intake) this.#schedule()
        return
      case 'team/changed':
        if (this.#hasBudget(notification.params.state.id)) this.#schedule()
        return
      case 'event': {
        const type = notification.params.event.type
        if (type === 'approval/requested' || type === 'approval/resolved' || type === 'turn/completed') this.#schedule()
        return
      }
      default:
    }
  }

  #schedule(): void {
    if (this.#closed || !this.#loaded) return
    if (this.#reconciling) {
      this.#dirty = true
      return
    }
    void this.reconcile().catch(() => {})
  }

  /** Names every wait on every trigger Goal, and ends the ones that are gone. One pass at a time. */
  reconcile(): Promise<void> {
    if (this.#reconciling) {
      this.#dirty = true
      return this.#reconciling
    }
    this.#reconciling = (async () => {
      do {
        this.#dirty = false
        if (this.#closed) return
        await this.#reconcileOnce()
      } while (this.#dirty && !this.#closed)
    })().finally(() => { this.#reconciling = null })
    return this.#reconciling
  }

  async #reconcileOnce(): Promise<void> {
    let snapshot
    try {
      snapshot = this.#store.read()
    } catch {
      return
    }
    const goals = new Set<string>([...Object.keys(snapshot.budgets), ...snapshot.operations.map((one) => one.goal)])
    for (const entry of this.#attention.list({ open: true })) if (entry.goal) goals.add(entry.goal)
    for (const goal of goals) {
      if (this.#closed) return
      const lifecycle = this.#port.goals.lifecycle(goal)
      if (lifecycle === 'wrapped' || lifecycle === 'missing') {
        await this.#attention.sync(`goal:${goal}`, [])
        continue
      }
      const trigger = snapshot.budgets[goal]?.trigger ?? snapshot.operations.find((one) => one.goal === goal)?.trigger ??
        Object.values(snapshot.groups).find((group) => group.goal === goal)?.trigger
      if (!trigger) continue
      const firings = [
        ...snapshot.operations.filter((one) => one.goal === goal && one.attention !== null)
          .map((one) => ({ key: one.key, attention: one.attention! })),
        ...Object.entries(snapshot.firings)
          .filter(([key, firing]) => firing.goal === goal && firing.attention && !snapshot.operations.some((one) => one.key === key))
          .map(([key, firing]) => ({ key, attention: firing.attention! })),
      ]
      let host: HostWaits
      try {
        host = this.#port.waits(goal)
      } catch {
        continue
      }
      const run = this.#runOf(goal)
      await this.#attention.sync(`goal:${goal}`, goalWaits({
        goal, trigger, host,
        run: run ? { id: run.id, state: run.state, reason: run.reason, held: run.intake?.heldFor ?? null } : null,
        stop: snapshot.budgets[goal]?.stop ?? null,
        firings,
      }))
    }
  }

  #sourceChanged(status: TriggerSourceStatus): void {
    const scope = `source:${status.project}:${status.source}`
    this.#sources.set(scope, status)
    if (this.#closed || !this.#loaded) return
    void this.#track((async () => {
      const arms = (await this.#consent.armed()).filter((arm) => arm.project === status.project && arm.definition.on.kind === status.source)
        .map((arm) => arm.id).sort()
      const trigger = arms[0]
      const waiting = status.state !== 'watching' && status.state !== 'paused' && trigger !== undefined
      const onService = status.state === 'offline' || status.state === 'rate-limited' || status.state === 'unreadable'
      const wanted: AttentionInput[] = waiting ? [{
        key: `${scope}:${status.state}`, goal: null, trigger: trigger!, kind: 'source',
        waitingOn: onService ? { kind: 'service', label: 'The forge' } : { kind: 'person', label: 'You' },
        sentence: `${status.reason ?? 'This source stopped.'} ${status.fix ?? ''}`.trim(), action: 'open-trigger',
      }] : []
      await this.#attention.sync(scope, wanted)
      this.#changed(status.project)
    })()).catch(() => {})
  }

  /** What the desktop answered for one attention. */
  notified(id: string, status: 'delivered' | 'unavailable'): Promise<boolean> {
    return this.#attention.notified(id, status)
  }

  /** Every unresolved wait again, by its own id: after a window reconnects. */
  replay(): void {
    this.#attention.replay()
  }

  attention(filter: { readonly goal?: string; readonly open?: boolean } = {}): readonly TriggerAttention[] {
    return this.#attention.list(filter)
  }

  /** Test and diagnostics reads: the journal as it stands. */
  get journal(): IntakeStore {
    return this.#store
  }

  get budgets(): TriggerBudgets {
    return this.#budgets
  }
}

const sourceWords = (source: TriggerSource): string =>
  source === 'pull-request' ? 'pull request' : source === 'issue' ? 'issue event' : 'scheduled run'
