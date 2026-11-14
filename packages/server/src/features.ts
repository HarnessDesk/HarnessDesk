import { readFileSync } from 'node:fs'
import type { DeskFeatureState } from '@harnessdesk/protocol'
import { atomicJson } from './goals/store.js'

type Feature = keyof DeskFeatureState
/** One queue owns persistence and service transitions; saved choices never become launch defaults. */
export class DeskFeatures {
  #choices: Partial<DeskFeatureState> = {}
  #state: DeskFeatureState
  #tail: Promise<unknown> = Promise.resolve()
  #closed = false
  constructor(private readonly file: string, defaults: DeskFeatureState,
    private readonly transition: (feature: Feature, enabled: boolean) => Promise<void>,
    private readonly changed: (state: DeskFeatureState) => void) {
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid desk feature choices')
      const pending = (value as Record<string, unknown>)['pending']
      if (pending !== undefined) {
        if (!pending || typeof pending !== 'object' || Array.isArray(pending)) throw new Error('Invalid pending feature change')
        const previous = (pending as { previous?: unknown }).previous
        if (!previous || typeof previous !== 'object' ||
          typeof (previous as DeskFeatureState).lead !== 'boolean' || typeof (previous as DeskFeatureState).mobile !== 'boolean')
          throw new Error('Invalid pending feature state')
        // An interrupted transition was never acknowledged. Restore the prior *effective* state,
        // even when a different launch default would otherwise skip Lead recovery.
        this.#choices = { lead: (previous as DeskFeatureState).lead, mobile: (previous as DeskFeatureState).mobile }
      }
      for (const feature of ['lead', 'mobile'] as const) {
        const enabled = (value as Record<string, unknown>)[feature]
        if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('Invalid desk feature choice')
        if (pending === undefined && typeof enabled === 'boolean') this.#choices = { ...this.#choices, [feature]: enabled }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.#state = { ...defaults, ...this.#choices }
  }
  read(): DeskFeatureState { return { ...this.#state } }
  set(feature: Feature, enabled: boolean): Promise<DeskFeatureState> {
    const next = this.#tail.then(async () => {
      if (this.#closed) throw new Error('The desk is closing.')
      const previous = this.#choices, choices = { ...previous, [feature]: enabled }
      // Prepare durably without committing the requested choice. A crash while stopping must
      // retain the old effective Lead state, so next boot still enters its recovery fences.
      await atomicJson(this.file, { ...previous, pending: { previous: this.#state, feature, enabled } })
      let transitioned = false
      try {
        await this.transition(feature, enabled)
        transitioned = true
        await atomicJson(this.file, choices)
      } catch (error) {
        if (transitioned) {
          try { await this.transition(feature, this.#state[feature]) }
          catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Feature change failed; service rollback remains pending. Retry the feature change.')
          }
        }
        try { await atomicJson(this.file, previous) }
        catch (saveError) { throw new AggregateError([error, saveError], 'Feature change failed and its saved choice could not be restored') }
        throw error
      }
      this.#choices = choices
      this.#state = { ...this.#state, [feature]: enabled }
      this.changed(this.read())
      return this.read()
    })
    this.#tail = next.catch(() => {})
    return next
  }
  async close(): Promise<void> { this.#closed = true; await this.#tail }
}
