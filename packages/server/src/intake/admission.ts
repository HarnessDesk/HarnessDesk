import { randomUUID } from 'node:crypto'

import type { TriggerDefinition, TriggerFact } from '@harnessdesk/protocol'

import { Serial } from '../goals/assignments.js'
import { consentMatches, type ArmBinding, type ArmedTrigger } from './consent.js'
import { applyAdmission } from './apply.js'
import { acceptsFact } from './definition.js'
import { dedupeKey, groupKey } from './keys.js'
import { fullness, GROUP_LIMIT, type IntakeFiring, type IntakeGroup, type IntakeOperation, type IntakePayload, type IntakeSnapshot, type IntakeStore } from './store.js'

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
 * - **A fault is scoped to its project.** An effect that fails for a reason
 *   that is not a refusal — a project folder that moved, a run that would
 *   not start — leaves its operation where it was and holds that project
 *   alone: its later firings wait behind it, and its new facts are not
 *   answered (their cursor kept), so a newer head never overtakes an older
 *   one that has not landed. Every other project keeps running. After a
 *   bounded number of attempts (`FAULT_ATTEMPTS`) the operation goes to the
 *   person: set aside with its tombstone and why, never retried or replayed,
 *   and its project admits again (review #898).
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
  /**
   * The arm as it reads now (`TriggerConsent.binding`), or null when it no
   * longer stands. Throws when something it reads cannot be read now — which
   * is no answer: the offer throws too, and the fact is offered again.
   */
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
  /** Lets go of runs a pause or the cap held, once their gate allows it again (`IntakeTargets.releaseHeld`). */
  releaseHeld?(): Promise<void>
}

export type AdmissionStep = 'prepared' | 'applied' | 'dispatched'

export interface AdmissionOptions {
  /** Told after each journaled step is durable: for the host's log, and for crash tests to stop the process there. */
  readonly onStep?: (step: AdmissionStep, operation: IntakeOperation) => void
  /**
   * Told when a firing's effects failed (`final` false: it is tried again,
   * and its project waits) and when they were set aside for the person after
   * the last attempt (`final` true), and with null when its project admits
   * again: what the plane names as a wait.
   */
  readonly onFault?: (fault: { readonly project: string; readonly trigger: string; readonly key: string; readonly goal: string; readonly reason: string; readonly final: boolean } | { readonly project: string; readonly cleared: true }) => void
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
export const SKIP_DESK = 'This comment was posted by this desk, so it does not fire a trigger.'
export const SKIP_AUTHOR_UNREAD = 'Who wrote this comment could not be read, so it did not fire.'
export const SKIP_NOT_ME = 'Only comments by the forge account this trigger was armed with fire it, and someone else wrote this one.'
export const SKIP_WRITES_UNREAD = 'Whether this comment’s author can write to the repository could not be read, so it did not fire.'
export const SKIP_NOT_COLLABORATOR = 'Only comments by people who can write to the repository fire this trigger, and this one’s author cannot.'

/**
 * Whether a comment may fire this trigger, by its `from` and stable account
 * ids alone: never a desk post, never an author that could not be read or
 * vouched for. Null lets it fire; anything else is why it is skipped.
 */
export const commentRefusal = (definition: TriggerDefinition, fact: TriggerFact, account: string): string | null => {
  if (fact.source !== 'issue' || fact.action !== 'commented') return null
  if (fact.desk === true) return SKIP_DESK
  const from = definition.from ?? 'me'
  if (from === 'anyone') return null
  if (typeof fact.author !== 'string') return SKIP_AUTHOR_UNREAD
  if (fact.author === account) return null
  if (from === 'me') return SKIP_NOT_ME
  if (fact.authorWrites === true) return null
  return fact.authorWrites === false ? SKIP_NOT_COLLABORATOR : SKIP_WRITES_UNREAD
}
export const skipConcurrency = (limit: number): string =>
  `This trigger already has ${limit} open ${limit === 1 ? 'Goal' : 'Goals'}, its limit, so this did not fire. Wrap one to make room; this is not replayed.`
export const PAUSED = 'Triggers are paused on this machine, so nothing is admitted until they resume.'
export const AGAIN_MISSING = 'New work arrived for this Goal, and this trigger opens no further round. It was recorded; decide what to do with it.'
/** How many times a firing's effects are tried before they go to the person. */
export const FAULT_ATTEMPTS = 3
export const faultWaiting = (reason: string): string =>
  `A firing could not be finished (${reason}). It is tried again on its own; until it lands, this project’s new events wait. Other projects keep running.`
export const faultSetAside = (reason: string): string =>
  `A firing could not be finished after ${FAULT_ATTEMPTS} tries (${reason}), so it was set aside for you and will not run on its own. Nothing else of this project waits on it.`

/** The token `again` compares: a pull request's head, an issue event's own immutable id, nothing for a schedule. */
const comparison = (fact: TriggerFact): string | null =>
  fact.source === 'pull-request' ? fact.head : fact.source === 'issue' ? fact.event : null

/** What a firing's history row keeps of its fact: validated scalars, never prose. */
const historyOf = (fact: TriggerFact): Pick<IntakeFiring, 'source' | 'subject' | 'head' | 'repository'> => ({
  source: fact.source, subject: fact.subject, head: fact.head, repository: fact.repository,
})

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
  /** Projects whose oldest unfinished firing failed and is being tried again: their new facts wait, every other project's do not. */
  readonly #faults = new Map<string, string>()
  /** Goals a firing claimed under the Goal plane's queue and has not yet journaled. */
  readonly #claiming = new Set<string>()

  constructor(store: IntakeStore, port: AdmissionPort, effects: AdmissionEffects, options: AdmissionOptions = {}) {
    this.#store = store
    this.#port = port
    this.#effects = effects
    this.#options = options
  }

  /** Why intake admits nothing now, anywhere: an unreadable journal. Null when it admits. */
  get problem(): string | null { return this.#store.problem }

  /** Why a project's facts wait now — a firing of it that has not landed and is tried again — or null. */
  fault(project: string): string | null {
    return this.#faults.get(project) ?? null
  }

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
  offer(arm: ArmedTrigger, fact: TriggerFact, options: { readonly binding?: () => Promise<ArmBinding | null> } = {}): Promise<OfferAnswer> {
    return this.#serial.run(async () => {
      if (this.#store.problem) throw new Error(this.#store.problem)
      if (this.#port.paused()) throw new Error(PAUSED)
      // A firing of this project has not landed: this fact waits behind it, its cursor kept. Other projects do not.
      const fault = this.#faults.get(arm.project)
      if (fault !== undefined) throw new Error(fault)
      const definition = arm.definition
      const key = dedupeKey(arm.binding.incarnation, definition, fact)
      const group = groupKey(arm.binding.incarnation, definition, fact)

      // Dedupe precedes every limit and every recheck.
      const known = this.#store.read().firings[key]
      if (known) {
        return { outcome: 'duplicate', firing: key, goal: known.goal, reason: known.reason }
      }
      if (!acceptsFact(definition, fact) || (fact.trigger !== null && fact.trigger !== definition.id) || fact.project !== arm.project) {
        return this.#skip(arm, key, SKIP_MISMATCH, fact)
      }
      if (fact.fork && definition.forks !== 'allow') return this.#skip(arm, key, SKIP_FORK, fact)
      // Throws when the arm cannot be read now: no answer, so the fact is kept and offered again.
      const binding = await (options.binding ? options.binding() : this.#port.binding(arm))
      if (!binding || !consentMatches(arm.binding, binding)) return this.#skip(arm, key, SKIP_CHANGED, fact)
      // Whose comment it is, against the account this arm is bound to — and never one the desk posted.
      const comment = commentRefusal(definition, fact, binding.account)
      if (comment !== null) return this.#skip(arm, key, comment, fact)

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
        if (!decided.operation) return await this.#skip(arm, key, skipConcurrency(definition.concurrency), fact)
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
          clock: Math.max(snapshot.clock, this.#port.now()),
          operations: [...snapshot.operations, operation],
          groups: prune({
            ...groups,
            [group]: { trigger: definition.id, project: arm.project, goal: operation.goal, run: operation.run, open: true, head: prepared.head, generation },
          }, group),
          firings: { ...snapshot.firings, [key]: { ...historyOf(fact), trigger: definition.id, project: arm.project, at: this.#port.now(), outcome: 'fired', goal: operation.goal, reason: null, run: operation.run, mode: operation.mode, attention: operation.attention } },
        }
        if (operation.mode === 'start' && this.#port.reserve) {
          const reserved = this.#port.reserve(next, operation, definition)
          if ('refused' in reserved) return await this.#skip(arm, key, reserved.refused, fact)
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
   * One change to the journal that is not a firing — a budget's meter, a
   * stop, a settlement — under the same queue every firing takes, so the
   * journal keeps one writer. `change` is handed the snapshot as it stands
   * inside the queue and answers the next one (or null to write nothing)
   * with a value; it must not await, so nothing it read goes stale.
   */
  transact<T>(change: (snapshot: IntakeSnapshot) => { readonly next: IntakeSnapshot | null; readonly value: T }): Promise<T> {
    return this.#serial.run(async () => {
      const decided = change(this.#store.read())
      if (decided.next) await this.#store.commit(decided.next)
      return decided.value
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
    // Recovery is what tries a failed firing again; an offer never does.
    await this.#finish(true)
    // Then what a pause or the cap held, with no firing of its own still pending: a resume continues it.
    await this.#effects.releaseHeld?.()
  }

  /**
   * Applies prepared operations and releases applied ones, oldest first.
   * A failure holds its own project only: that project's later operations
   * wait, every other project's go on. `retry` — recovery, never an offer —
   * tries a failed one again, and sets it aside for the person once it has
   * failed `FAULT_ATTEMPTS` times.
   */
  async #finish(retry = false): Promise<void> {
    const held = new Set<string>()
    for (const pending of this.#store.read().operations) {
      if (pending.dispatched || held.has(pending.project)) continue
      if (!retry && this.#faults.has(pending.project)) {
        held.add(pending.project)
        continue
      }
      try {
        await applyAdmission(pending, {
          ensureGoal: (operation) => this.#effects.ensureGoal(operation),
          observe: (operation) => this.#effects.observe(operation),
          ensureRound: (operation, evidence) => this.#effects.ensureRound(operation, evidence),
          applied: async (operation, attention) => {
            const applied = await this.#update(operation.key, (one) => ({ ...one, state: 'applied', attention, roundAttention: attention }))
            this.#options.onStep?.('applied', applied)
          },
          enableDispatch: async (operation) => {
            // Read back: the applied step above changed it.
            const current = this.#store.read().operations.find((one) => one.key === operation.key)!
            if (this.#port.paused()) return
            const released = await this.#effects.release(current)
            if (released.released) {
              // A gate's refusal passed: what stays is what the round's own opening said.
              const dispatched = await this.#update(current.key, (one) => ({ ...one, dispatched: true, payload: null, attention: one.roundAttention !== undefined ? one.roundAttention : one.attention }))
              this.#options.onStep?.('dispatched', dispatched)
            } else if (current.attention !== released.reason) {
              await this.#update(current.key, (one) => ({ ...one, attention: released.reason }))
            }
          },
        })
        if (this.#faults.delete(pending.project)) this.#options.onFault?.({ project: pending.project, cleared: true })
      } catch (error) {
        const reason = (error instanceof Error ? error.message : String(error)).replace(/\.$/, '')
        held.add(pending.project)
        await this.#failed(pending.key, reason)
      }
    }
    // Released operations keep only their tombstone: the firing record — with why it needed a person, if it did — and the group.
    const snapshot = this.#store.read()
    if (snapshot.operations.some((one) => one.dispatched)) {
      const firings = { ...snapshot.firings }
      for (const one of snapshot.operations) {
        const firing = firings[one.key]
        if (one.dispatched && firing && (firing.attention ?? null) !== one.attention) firings[one.key] = { ...firing, attention: one.attention }
      }
      await this.#store.commit({ ...snapshot, firings, operations: snapshot.operations.filter((one) => !one.dispatched) })
    }
  }

  /**
   * One failed attempt at a firing's effects, recorded. Under the bound its
   * project waits for the next recovery; at it, the operation is set aside
   * for the person — its firing's tombstone kept with why, its Goal and
   * whatever it already made left for them, nothing of it retried — and its
   * project admits again.
   */
  async #failed(key: string, reason: string): Promise<void> {
    const snapshot = this.#store.read()
    const operation = snapshot.operations.find((one) => one.key === key)
    if (!operation) return
    const attempts = (operation.attempts ?? 0) + 1
    if (attempts < FAULT_ATTEMPTS) {
      const waiting = faultWaiting(reason)
      await this.#update(key, (one) => ({ ...one, attempts, failure: reason }))
      this.#faults.set(operation.project, waiting)
      this.#options.onFault?.({ project: operation.project, trigger: operation.trigger, key, goal: operation.goal, reason: waiting, final: false })
      return
    }
    const aside = faultSetAside(reason)
    const firing = snapshot.firings[key]
    await this.#store.commit({
      ...snapshot,
      operations: snapshot.operations.filter((one) => one.key !== key),
      firings: firing ? { ...snapshot.firings, [key]: { ...firing, attention: aside } } : snapshot.firings,
    })
    this.#faults.delete(operation.project)
    this.#options.onFault?.({ project: operation.project, trigger: operation.trigger, key, goal: operation.goal, reason: aside, final: true })
  }

  async #update(key: string, change: (operation: IntakeOperation) => IntakeOperation): Promise<IntakeOperation> {
    const snapshot = this.#store.read()
    let changed: IntakeOperation | null = null
    const operations = snapshot.operations.map((one) => (one.key === key ? (changed = change(one)) : one))
    if (!changed) throw new Error('A trigger firing’s journal entry disappeared.')
    await this.#store.commit({ ...snapshot, operations })
    return changed
  }

  async #skip(arm: ArmedTrigger, key: string, reason: string, fact: TriggerFact): Promise<OfferAnswer> {
    const snapshot = this.#store.read()
    await this.#store.commit({
      ...snapshot,
      clock: Math.max(snapshot.clock, this.#port.now()),
      firings: { ...snapshot.firings, [key]: { ...historyOf(fact), trigger: arm.id, project: arm.project, at: this.#port.now(), outcome: 'skipped', goal: null, reason } },
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
