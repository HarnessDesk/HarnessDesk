import { randomUUID } from 'node:crypto'

import type { TriggerDefinition, TriggerFact } from '@harnessdesk/protocol'

import { Serial } from '../goals/assignments.js'
import { consentMatches, type ArmBinding, type ArmedTrigger } from './consent.js'
import { applyAdmission } from './apply.js'
import { acceptsFact } from './definition.js'
import { dedupeKey, groupKey } from './keys.js'
import { fullness, GROUP_LIMIT, type IntakeGroup, type IntakeOperation, type IntakePayload, type IntakeSnapshot, type IntakeStore } from './store.js'

/**
 * Admission: the one step that turns a fact into a firing.
 *
 * `offer(arm, fact)` answers only once the answer is durable — fired,
 * skipped or duplicate, by the fact's stable dedupe key — and a fired fact's
 * whole intent is journaled before any of it happens: the Goal and run ids
 * it reserves, which open Goal it joins or that it opens a new one, and
 * whether it opens a round. Then its effects run, each idempotent on those
 * reserved ids, in journal order; the round a firing opens is held until
 * the firing is recorded as applied and every gate lets it go. A crash
 * anywhere in that leaves the journal to finish it; nothing mints a
 * replacement id, and nothing fires twice.
 *
 * - **Dedupe first.** A key already answered is `duplicate` whatever else
 *   changed — a newly reached limit never undoes an accepted firing, which
 *   still finishes.
 * - **Consent again.** Before anything fires, the trigger's arm is read
 *   again (`TriggerConsent.binding`) and must match what the monitor was
 *   offered under: a changed file, flow, Agent, command, seating, sign-in,
 *   repository or clone skips the fact, recorded with why.
 * - **Forks.** A stranger's pull request is skipped unless the trigger says
 *   `forks: allow` — and that arm was already refused unless every role
 *   only reads.
 * - **Concurrency.** Open Goals count, including waiting and stopped ones
 *   and firings still being applied; a later fact about a subject already
 *   open joins its Goal without another slot. Wrapping releases a slot.
 * - **One lifecycle barrier.** Whether a firing joins an open Goal is
 *   decided under the Goal plane's own queue, which a wrap takes too: the
 *   firing lands first and the wrap waits, or the wrap has begun and the
 *   firing opens a new generation — never both.
 * - **A fault stops intake.** An effect that fails leaves its operation
 *   prepared, and no later fact is admitted until it is finished: a newer
 *   head never overtakes an older one that has not landed.
 *
 * Lock order: this queue is taken after an intake source's queue and before
 * everything its effects reach — publication, run, Team, Goal, project.
 * Consent and the journal file take no queue of their own here.
 */

// ------------------------------------------------------ the pure reducer

/** One trigger's view of the journal: its own operations and groups only. */
export interface TriggerJournal {
  readonly operations: readonly Pick<IntakeOperation, 'key'>[]
  readonly groups: Readonly<Record<string, Pick<IntakeGroup, 'goal' | 'run' | 'open' | 'head'>>>
}

export interface AdmissionInput {
  readonly key: string
  readonly group: string
  /** The comparison token `again` reads: a head, or an issue event's id. */
  readonly head: string | null
  readonly again: boolean
  readonly newGoal: string
  readonly newRun: string
  readonly maxOpen: number
}

export interface PreparedAdmission {
  readonly key: string
  readonly group: string
  readonly goal: string
  readonly run: string
  readonly head: string | null
  readonly roundKey: string
  readonly mode: 'start' | 'again' | 'record'
  readonly state: 'prepared'
}

/**
 * The decision, for one trigger, as a pure function of its journal: an
 * already-answered key is a duplicate; a subject whose Goal is open joins it
 * — a new comparison token with `again` opens a round, anything else is
 * recorded; a new subject opens a Goal under the reserved ids, or is refused
 * (null) when the trigger already has `maxOpen` Goals open.
 */
export function prepareAdmission(state: TriggerJournal, input: AdmissionInput): {
  state: TriggerJournal; operation: PreparedAdmission | null; duplicate: boolean
} {
  const prior = state.operations.find((operation) => operation.key === input.key)
  if (prior) return { state, operation: null, duplicate: true }
  const current = state.groups[input.group]
  const reuse = current?.open === true
  if (!reuse && Object.values(state.groups).filter((group) => group.open).length >= input.maxOpen) {
    return { state, operation: null, duplicate: false }
  }
  const operation: PreparedAdmission = {
    key: input.key, group: input.group,
    goal: reuse ? current.goal : input.newGoal,
    run: reuse ? current.run : input.newRun,
    head: input.head, roundKey: input.key,
    mode: !reuse ? 'start' : input.again && input.head !== current.head ? 'again' : 'record',
    state: 'prepared',
  }
  return {
    operation, duplicate: false,
    state: {
      operations: [...state.operations, operation],
      groups: { ...state.groups, [input.group]: { goal: operation.goal, run: operation.run, open: true, head: input.head } },
    },
  }
}

// ------------------------------------------------------------- the port

export type GoalLifecycle = 'open' | 'closing' | 'wrapped' | 'missing'

export interface AdmissionPort {
  /** The arm as it reads now (`TriggerConsent.binding`), or null when it no longer stands. */
  binding(arm: ArmedTrigger): Promise<ArmBinding | null>
  /** The machine is paused: nothing is admitted, and facts wait. */
  paused(): boolean
  now(): number
  /** How a Goal stands (`GoalPlane.lifecycle`). */
  lifecycle(goal: string): GoalLifecycle
  /** The lifecycle barrier (`GoalPlane.intakeClaim`): whether this open Goal takes a firing, `claim` run under its queue when it does. */
  claim(goal: string, claim: () => void): Promise<boolean>
  /** A money reservation for a new Goal, decided inside this same transaction; absent, none is kept (task 5 adds it). */
  reserve?(snapshot: IntakeSnapshot, operation: IntakeOperation, definition: TriggerDefinition): { readonly snapshot: IntakeSnapshot } | { readonly refused: string }
}

/** The effects a firing's operation has, each idempotent on its reserved ids (`apply.ts`). */
export interface AdmissionEffects {
  ensureGoal(operation: IntakeOperation): Promise<void>
  observe(operation: IntakeOperation): Promise<readonly string[]>
  /** Opens (held) the round the operation intends; a reason for a person when the run could not take it. */
  ensureRound(operation: IntakeOperation, evidence: readonly string[]): Promise<string | null>
  /** Releases an applied operation's dispatch when every gate allows it; the reason it waits otherwise. */
  release(operation: IntakeOperation): Promise<{ readonly released: true } | { readonly released: false; readonly reason: string }>
}

export type AdmissionStep = 'prepared' | 'applied' | 'dispatched'

export interface AdmissionOptions {
  /** Told after each journaled step is durable: for the host's log, and for crash tests to stop the process there. */
  readonly onStep?: (step: AdmissionStep, operation: IntakeOperation) => void
  /** Reserved ids; random by default. */
  readonly mint?: () => string
}

export interface OfferAnswer {
  readonly outcome: 'fired' | 'skipped' | 'duplicate'
  readonly firing: string
  readonly goal: string | null
  readonly reason: string | null
}

export const SKIP_FORK = 'This pull request comes from another repository, and this trigger does not allow forks.'
export const SKIP_CHANGED = 'The trigger or what it runs changed since it was armed, so this did not fire. Arm it again to watch from now.'
export const SKIP_MISMATCH = 'This trigger does not read this kind of fact.'
export const skipConcurrency = (limit: number): string =>
  `This trigger already has ${limit} open ${limit === 1 ? 'Goal' : 'Goals'}, its limit, so this did not fire. Wrap one to make room; this is not replayed.`
export const PAUSED = 'Triggers are paused on this machine, so nothing is admitted until they resume.'
export const AGAIN_MISSING = 'New work arrived for this Goal, and this trigger opens no further round. It was recorded; decide what to do with it.'

/** The token `again` compares: a pull request's head, an issue event's own immutable id, nothing for a schedule. */
const comparison = (fact: TriggerFact): string | null =>
  fact.source === 'pull-request' ? fact.head : fact.source === 'issue' ? fact.event : null

/** The Goal's sentence, from validated scalars only: no title, body or comment from outside. */
const sentenceOf = (definition: TriggerDefinition, fact: TriggerFact): string => {
  switch (fact.source) {
    case 'pull-request':
      return `Pull request #${fact.subject}, from trigger ${definition.id}`
    case 'issue':
      return `Issue #${fact.subject}, from trigger ${definition.id}`
    case 'schedule':
      return `Scheduled run at ${new Date(Number(fact.subject)).toISOString()}, from trigger ${definition.id}`
  }
}

export class Admission {
  readonly #store: IntakeStore
  readonly #port: AdmissionPort
  readonly #effects: AdmissionEffects
  readonly #options: AdmissionOptions
  readonly #serial = new Serial()
  /** Why no new fact is admitted until recovery finishes, or null. */
  #fault: string | null = null
  /** Goals a firing claimed under the Goal plane's queue and has not yet journaled. */
  readonly #claiming = new Set<string>()

  constructor(store: IntakeStore, port: AdmissionPort, effects: AdmissionEffects, options: AdmissionOptions = {}) {
    this.#store = store
    this.#port = port
    this.#effects = effects
    this.#options = options
  }

  /** Why intake admits nothing now: an unreadable journal, or an effect that has not finished. Null when it admits. */
  get problem(): string | null { return this.#store.problem ?? this.#fault }

  /** How full the journal is, as a sentence, or null. */
  get warning(): string | null {
    try {
      return fullness(this.#store.read())
    } catch {
      return null
    }
  }

  /**
   * Whether a firing is being recorded into this Goal now — claimed under
   * the Goal plane's queue, or journaled and not yet applied. A wrap waits
   * for it (`GoalPlanePort.intakeHeld`).
   */
  held(goal: string): boolean {
    if (this.#claiming.has(goal)) return true
    try {
      return this.#store.read().operations.some((operation) => operation.goal === goal && operation.state === 'prepared')
    } catch {
      return false
    }
  }

  /**
   * One fact, offered to one arm. Resolves only with a durable answer; throws
   * — so the monitor keeps its cursor and offers it again — when nothing can
   * be answered durably yet: an unreadable journal, a pause, an unfinished
   * earlier firing, or a save that failed.
   */
  offer(arm: ArmedTrigger, fact: TriggerFact): Promise<OfferAnswer> {
    return this.#serial.run(async () => {
      if (this.#store.problem) throw new Error(this.#store.problem)
      if (this.#fault) await this.#recover()
      if (this.#port.paused()) throw new Error(PAUSED)
      const definition = arm.definition
      const key = dedupeKey(arm.binding.incarnation, definition, fact)
      const group = groupKey(arm.binding.incarnation, definition, fact)

      // Dedupe precedes every limit and every recheck.
      const known = this.#store.read().firings[key]
      if (known) {
        return { outcome: 'duplicate', firing: key, goal: known.goal, reason: known.reason }
      }
      if (!acceptsFact(definition, fact) || (fact.trigger !== null && fact.trigger !== definition.id) || fact.project !== arm.project) {
        return this.#skip(arm, key, SKIP_MISMATCH)
      }
      if (fact.fork && definition.forks !== 'allow') return this.#skip(arm, key, SKIP_FORK)
      const binding = await this.#port.binding(arm)
      if (!binding || !consentMatches(arm.binding, binding)) return this.#skip(arm, key, SKIP_CHANGED)

      // Read again after the awaits above: only this queue writes the journal, and what is decided is what is on disk now.
      let snapshot = this.#store.read()
      const mine = (one: { readonly trigger: string; readonly project: string }): boolean =>
        one.trigger === definition.id && one.project === arm.project
      const pending = new Set(snapshot.operations.filter((one) => one.state === 'prepared').map((one) => one.group))
      const groups: Record<string, IntakeGroup> = { ...snapshot.groups }
      for (const [id, entry] of Object.entries(groups)) {
        if (!mine(entry) || !entry.open || pending.has(id)) continue
        // A wrapped, missing or wrapping Goal no longer holds a slot; stopping alone does not release one.
        if (this.#port.lifecycle(entry.goal) !== 'open') groups[id] = { ...entry, open: false }
      }
      let current = groups[group]
      if (current?.open && !pending.has(group)) {
        const joined = await this.#port.claim(current.goal, () => this.#claiming.add(current!.goal))
        if (!joined) groups[group] = current = { ...current, open: false }
      }
      try {
        const own = Object.fromEntries(Object.entries(groups).filter(([, entry]) => mine(entry)))
        const decided = prepareAdmission(
          { operations: [], groups: own },
          {
            key, group, head: comparison(fact), again: definition.again !== null,
            newGoal: `goal-${this.#mint()}`, newRun: `flow-trigger-${this.#mint()}`, maxOpen: definition.concurrency,
          },
        )
        if (!decided.operation) return await this.#skip(arm, key, skipConcurrency(definition.concurrency))
        const prepared = decided.operation
        const payload: IntakePayload = { definition, fact, binding: arm.binding, sentence: sentenceOf(definition, fact) }
        const generation = prepared.mode === 'start' ? (current?.generation ?? 0) + 1 : current!.generation
        const operation: IntakeOperation = {
          ...prepared, trigger: definition.id, project: arm.project, dispatched: false, generation, payload,
          attention: prepared.mode === 'record' && definition.again === null && current && comparison(fact) !== current.head ? AGAIN_MISSING : null,
          preparedAt: this.#port.now(),
        }
        let next: IntakeSnapshot = {
          ...snapshot,
          operations: [...snapshot.operations, operation],
          groups: prune({
            ...groups,
            [group]: { trigger: definition.id, project: arm.project, goal: operation.goal, run: operation.run, open: true, head: prepared.head, generation },
          }, group),
          firings: { ...snapshot.firings, [key]: { trigger: definition.id, project: arm.project, at: this.#port.now(), outcome: 'fired', goal: operation.goal, reason: null } },
        }
        if (operation.mode === 'start' && this.#port.reserve) {
          const reserved = this.#port.reserve(next, operation, definition)
          if ('refused' in reserved) return await this.#skip(arm, key, reserved.refused)
          next = reserved.snapshot
        }
        await this.#store.commit(next)
        snapshot = next
        this.#options.onStep?.('prepared', operation)
      } finally {
        if (current) this.#claiming.delete(current.goal)
      }
      // Durable: the firing is answered whatever its effects do now. They run in journal order.
      await this.#finish()
      const fired = this.#store.read().firings[key]!
      return { outcome: 'fired', firing: key, goal: fired.goal, reason: null }
    })
  }

  /**
   * At start, before any flow resumes or any source is read: finishes every
   * prepared operation in the order it was journaled and releases every
   * applied one whose gates now allow it. Also how a pause lifting, a rearm
   * or a failed effect is picked up again.
   */
  recover(): Promise<void> {
    return this.#serial.run(() => this.#recover())
  }

  async #recover(): Promise<void> {
    if (this.#store.problem) throw new Error(this.#store.problem)
    this.#fault = null
    await this.#finish()
  }

  /** Applies prepared operations and releases applied ones, oldest first; the first failure stops the rest and is the fault. */
  async #finish(): Promise<void> {
    for (const pending of this.#store.read().operations) {
      if (pending.dispatched) continue
      try {
        await applyAdmission(pending, {
          ensureGoal: (operation) => this.#effects.ensureGoal(operation),
          observe: (operation) => this.#effects.observe(operation),
          ensureRound: (operation, evidence) => this.#effects.ensureRound(operation, evidence),
          applied: async (operation, attention) => {
            const applied = await this.#update(operation.key, (one) => ({ ...one, state: 'applied', attention }))
            this.#options.onStep?.('applied', applied)
          },
          enableDispatch: async (operation) => {
            // Read back: the applied step above changed it.
            const current = this.#store.read().operations.find((one) => one.key === operation.key)!
            if (this.#port.paused()) return
            const released = await this.#effects.release(current)
            if (released.released) {
              const dispatched = await this.#update(current.key, (one) => ({ ...one, dispatched: true, payload: null }))
              this.#options.onStep?.('dispatched', dispatched)
            } else if (current.attention !== released.reason) {
              await this.#update(current.key, (one) => ({ ...one, attention: released.reason }))
            }
          },
        })
      } catch (error) {
        this.#fault = `A trigger firing could not be finished: ${error instanceof Error ? error.message : String(error)}. Nothing more fires until it is.`
        throw new Error(this.#fault)
      }
    }
    // Released operations keep only their tombstone: the firing record and the group.
    const snapshot = this.#store.read()
    if (snapshot.operations.some((one) => one.dispatched)) {
      await this.#store.commit({ ...snapshot, operations: snapshot.operations.filter((one) => !one.dispatched) })
    }
  }

  async #update(key: string, change: (operation: IntakeOperation) => IntakeOperation): Promise<IntakeOperation> {
    const snapshot = this.#store.read()
    let changed: IntakeOperation | null = null
    const operations = snapshot.operations.map((one) => (one.key === key ? (changed = change(one)) : one))
    if (!changed) throw new Error('A trigger firing’s journal entry disappeared.')
    await this.#store.commit({ ...snapshot, operations })
    return changed
  }

  async #skip(arm: ArmedTrigger, key: string, reason: string): Promise<OfferAnswer> {
    const snapshot = this.#store.read()
    await this.#store.commit({
      ...snapshot,
      firings: { ...snapshot.firings, [key]: { trigger: arm.id, project: arm.project, at: this.#port.now(), outcome: 'skipped', goal: null, reason } },
    })
    return { outcome: 'skipped', firing: key, goal: null, reason }
  }

  #mint(): string {
    return this.#options.mint?.() ?? randomUUID()
  }
}

/** Closed groups are forgotten, oldest generation first, once the map nears its limit: open ones and firings never are. */
const prune = (groups: Record<string, IntakeGroup>, keep: string): Record<string, IntakeGroup> => {
  const entries = Object.entries(groups)
  if (entries.length < GROUP_LIMIT * 0.9) return groups
  const closed = entries.filter(([id, entry]) => !entry.open && id !== keep).sort((a, b) => a[1].generation - b[1].generation)
  const drop = new Set(closed.slice(0, entries.length - Math.floor(GROUP_LIMIT * 0.8)).map(([id]) => id))
  return Object.fromEntries(entries.filter(([id]) => !drop.has(id)))
}
