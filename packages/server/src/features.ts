import { lstatSync, readFileSync } from 'node:fs'
import { cp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { DeskFeature, DeskFeatureProblem, DeskFeatureState } from '@harnessdesk/protocol'
import { atomicJson } from './goals/store.js'

type Choices = Pick<DeskFeatureState, 'lead' | 'mobile'>
const OFF: Choices = { lead: false, mobile: false }
const preferenceProblem: DeskFeatureProblem = { kind: 'preferences', message: 'Feature settings could not be read. Repair feature settings to keep both features off and use these controls again.' }
const transitionProblem = (feature?: DeskFeature): DeskFeatureProblem => ({ kind: 'transition',
  message: 'A feature change did not finish safely. Repair feature settings to stop both features and use these controls again.', ...(feature ? { feature } : {}) })
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid feature settings')
  return value as Record<string, unknown>
}
const choicesOf = (value: unknown, complete = false): Partial<Choices> => {
  const input = object(value), choices: Partial<Choices> = {}
  for (const key of ['lead', 'mobile'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean' || complete && typeof input[key] !== 'boolean') throw Error('Invalid feature choice')
    if (typeof input[key] === 'boolean') Object.assign(choices, { [key]: input[key] })
  }
  return choices
}
const exists = (file: string): boolean => {
  try { lstatSync(file); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
const read = (file: string): unknown => {
  try { return JSON.parse(readFileSync(file, 'utf8')) as unknown }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

/** A separate durable intent survives even a final snapshot write that throws after rename.
 * Any uncertain result stays latched until repair; unrelated changes never erase its evidence. */
export class DeskFeatures {
  #choices: Partial<Choices> = {}
  #state: Choices = OFF
  #problem: DeskFeatureProblem | undefined
  #tail: Promise<unknown> = Promise.resolve()
  #closed = false
  #changing = false
  readonly #pending: string
  readonly #repairMarker: string
  constructor(private readonly file: string, defaults: Choices,
    private readonly transition: (feature: DeskFeature, enabled: boolean) => Promise<void>,
    private readonly changed: (state: DeskFeatureState) => void,
    private readonly io: { write: typeof atomicJson } = { write: atomicJson }) {
    this.#pending = `${file}.pending`
    this.#repairMarker = `${file}.repair`
    try {
      if (exists(this.#repairMarker)) { this.#state = OFF; this.#problem = transitionProblem(); return }
      const saved = read(file), record = saved === undefined ? undefined : object(saved)
      const pending = read(this.#pending) ?? record?.['pending']
      if (pending !== undefined) {
        const intent = object(pending)
        this.#state = choicesOf(intent['previous'], true) as Choices
        this.#choices = intent['choices'] === undefined ? this.#state : choicesOf(intent['choices'])
        this.#problem = transitionProblem(intent['feature'] === 'lead' || intent['feature'] === 'mobile' ? intent['feature'] : undefined)
      } else {
        this.#choices = saved === undefined ? {} : choicesOf(saved)
        this.#state = { ...defaults, ...this.#choices }
      }
    } catch { this.#state = OFF; this.#problem = preferenceProblem }
  }
  read(): DeskFeatureState { return { ...this.#state, ...(this.#problem ? { problem: this.#problem } : {}) } }
  /** Portable explicit choices only. Unknown or transitional preferences never enter a backup. */
  choices(): Partial<Choices> | null { return this.#problem || this.#changing ? null : { ...this.#choices } }
  #queue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(async () => {
      if (this.#closed) throw Error('The desk is closing.')
      this.#changing = true
      try { return await operation() }
      finally { this.#changing = false }
    })
    this.#tail = next.catch(() => {})
    return next
  }
  #latch(problem: DeskFeatureProblem): void { this.#problem = problem; this.changed(this.read()) }
  /** Activate defaults and acknowledged choices without turning defaults into preferences.
   * Failed optional restoration is recoverable from Settings, never a failed desk startup. */
  initialize(): Promise<void> {
    return this.#queue(async () => {
      if (this.#problem) return
      for (const feature of ['lead', 'mobile'] as const) {
        if (!this.#state[feature]) continue
        try { await this.transition(feature, true) }
        catch {
          this.#latch({ kind: 'transition', feature, message: `${feature === 'lead' ? 'Lead' : 'Mobile'} could not start. Repair feature settings to turn both features off. Retained service files, history and pairings are left unchanged. Check the service configuration or seek diagnostic support before enabling it again.` })
          // Preserve the acknowledged partial choices. The intent keeps failure visible after restart.
          try { await this.io.write(this.#pending, { version: 1, previous: this.#state, choices: this.#choices, feature, enabled: true }) }
          catch { /* The live latch still fences admission; repair preserves whatever reached disk. */ }
          break
        }
      }
    })
  }
  set(feature: DeskFeature, enabled: boolean): Promise<DeskFeatureState> {
    return this.#queue(async () => {
      if (this.#problem) throw Error('Repair feature settings before changing features.')
      const choices = { ...this.#choices, [feature]: enabled }, before = this.#state
      let transitioned = false, saved = false
      try {
        await this.io.write(this.#pending, { version: 1, previous: before, choices: this.#choices, feature, enabled })
        await this.transition(feature, enabled)
        transitioned = true
        await this.io.write(this.file, choices)
        saved = true
        this.#choices = choices
        this.#state = { ...before, [feature]: enabled }
        await rm(this.#pending)
      } catch (error) {
        // Latch before compensation: service admission must stop even when compensation also fails.
        this.#latch(transitionProblem(feature))
        if (transitioned && !saved) {
          try { await this.transition(feature, before[feature]) }
          catch (rollbackError) { throw new AggregateError([error, rollbackError], this.#problem!.message) }
        }
        throw new Error(this.#problem!.message, { cause: error })
      }
      this.changed(this.read())
      return this.read()
    })
  }
  repair(): Promise<DeskFeatureState> {
    return this.#queue(async () => {
      this.#latch(this.#problem ?? transitionProblem())
      try {
        // Copy before replacement, including a directory accidentally put at either path.
        // If preserving an unreadable artifact is refused, repair fails without destroying it.
        const suffix = `.preserved-${randomUUID()}`
        for (const file of [this.file, this.#pending, this.#repairMarker]) {
          try { await cp(file, `${file}${suffix}`, { recursive: true, force: false, errorOnExist: true }) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
        // This barrier also covers replacing a damaged intent directory: deleting that path must
        // never expose an old enabled snapshot to startup before the new Off intent exists.
        if (!exists(this.#repairMarker)) await this.io.write(this.#repairMarker, { version: 1 })
        await rm(this.#pending, { recursive: true, force: true })
        await this.io.write(this.#pending, { version: 1, previous: OFF, choices: {}, repair: true })
        await this.transition('lead', false)
        await this.transition('mobile', false)
        // A directory is preserved above and cannot be replaced by rename; remove only after safe shutdown.
        await rm(this.file, { recursive: true, force: true })
        await this.io.write(this.file, OFF)
        await rm(this.#pending)
        await rm(this.#repairMarker, { recursive: true })
      } catch (error) { throw new Error('Feature settings could not be repaired. Both features remain unavailable; retry repair.', { cause: error }) }
      this.#choices = OFF; this.#state = OFF; this.#problem = undefined
      this.changed(this.read())
      return this.read()
    })
  }
  async close(): Promise<void> { this.#closed = true; await this.#tail }
}
