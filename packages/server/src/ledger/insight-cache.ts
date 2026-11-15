import { join } from 'node:path'
import { InsightSnapshot } from './insight-snapshot.js'
import { PersistentInsight } from './insight-persistent.js'
import { InsightBudgetExceededError, InsightCacheUnavailableError, type UsageSample } from './insight.js'
export { InsightCacheUnavailableError } from './insight.js'
import { scanFile, wholeFile, type ScanTarget } from './scan.js'

interface Entry {
  readonly target: ScanTarget
  readonly offset: number
  readonly tail: readonly string[]
  readonly samples: readonly UsageSample[]
  readonly limited: boolean
}

export interface InsightReference { readonly target: ScanTarget; readonly generation?: string; readonly samples?: readonly UsageSample[] }
/** Disposable source index; a legacy in-memory cache is used when its lease is unavailable. */
export class InsightCache {
  readonly #files = new Map<string, Entry>()
  readonly #persistent: PersistentInsight
  #leased = false
  readonly #fileLimit: number
  readonly #stateDir: string
  constructor(stateDir: string, limit?: number, fileLimit = 10_000) { this.#stateDir = stateDir; this.#persistent = new PersistentInsight(stateDir, limit); this.#fileLimit = fileLimit }
  snapshot(refs: readonly InsightReference[]): InsightSnapshot | null {
    if (!this.#leased || refs.length === 0 || refs.some((ref) => !ref.generation)) return null
    return new InsightSnapshot(join(this.#stateDir, 'insight-cache-v2.sqlite'), refs.map((ref) => ({ target: ref.target, generation: ref.generation! })))
  }
  #remember(key: string, entry: Entry): void {
    this.#files.delete(key)
    this.#files.set(key, entry)
    while (this.#files.size > this.#fileLimit) this.#files.delete(this.#files.keys().next().value!)
  }
  async withLease<T>(run: () => Promise<T>): Promise<T> {
    this.#leased = this.#persistent.acquire()
    try { return await run() } finally { this.#persistent.release(); this.#leased = false }
  }
  close(): void { this.#persistent.close() }

  async reference(target: ScanTarget, byteLimit: number, signal?: AbortSignal): Promise<{ ref: InsightReference | null; bytesRead: number; limited: boolean }> {
    const result = await this.read(target, byteLimit, signal, () => false)
    if (result.priorRef) return { ref: result.priorRef, bytesRead: result.bytesRead, limited: result.limited }
    const key = JSON.stringify([target.runtime, target.kind, target.path])
    const compatible = (entry: Entry): boolean => entry.target.identity === target.identity && (
      (entry.target.size === target.size && entry.target.mtime === target.mtime && entry.target.changedAt === target.changedAt) ||
      // A grown JSONL source can still supply its previously parsed prefix when no budget remains.
      (result.limited && result.bytesRead === 0 && !wholeFile(target.kind) && target.size > entry.target.size)
    )
    const memory = this.#files.get(key)
    if (memory && compatible(memory)) {
      return { ref: { target, samples: memory.samples }, bytesRead: result.bytesRead, limited: result.limited }
    }
    const disk = this.#leased ? this.#persistent.get(target, () => false) : null
    if (disk && compatible(disk.entry)) {
      return { ref: { target, generation: disk.generation }, bytesRead: result.bytesRead, limited: result.limited }
    }
    if (result.noData) return { ref: null, bytesRead: result.bytesRead, limited: true }
    throw new InsightCacheUnavailableError()
  }

  resolve(ref: InsightReference, selected: (project: string | null) => boolean): readonly UsageSample[] {
    if (ref.samples) return ref.samples.filter((sample) => selected(sample.project))
    const entry = ref.generation ? this.#persistent.get(ref.target, selected, ref.generation) : null
    if (!entry) throw new InsightCacheUnavailableError()
    return entry.entry.samples
  }

  async read(target: ScanTarget, byteLimit: number, signal?: AbortSignal,
    selected: (project: string | null) => boolean = () => true): Promise<{ samples: readonly UsageSample[]; bytesRead: number; limited: boolean; noData?: boolean; priorRef?: InsightReference }> {
    const key = JSON.stringify([target.runtime, target.kind, target.path])
    const disk = this.#leased ? this.#persistent.get(target, selected) : null
    const memory = this.#files.get(key)
    const matches = (entry: Entry | undefined): boolean => entry?.target.identity === target.identity && entry?.target.size === target.size &&
      entry.target.mtime === target.mtime && entry.target.changedAt === target.changedAt
    // A failed publication can leave a newer complete observation in memory than on disk.
    const fromMemory = memory && (matches(memory) || !disk || !matches(disk.entry)) ? memory : undefined
    const fromDisk = fromMemory ? null : disk
    const prior = fromMemory ?? fromDisk?.entry
    const priorRef: InsightReference | undefined = fromMemory ? { target, samples: fromMemory.samples } : fromDisk ? { target, generation: fromDisk.generation } : undefined
    const sameFile = prior?.target.identity === target.identity
    const unchanged = sameFile && prior?.target.size === target.size && prior.target.mtime === target.mtime && prior.target.changedAt === target.changedAt
    const priorSamples = fromMemory ? fromMemory.samples.filter((sample) => selected(sample.project)) : prior?.samples ?? []
    if (unchanged && !prior.limited) return { samples: priorSamples, bytesRead: 0, limited: false, ...(priorRef ? { priorRef } : {}) }
    const resume = prior && sameFile && !wholeFile(target.kind) && (unchanged || target.size > prior.target.size) ? prior : undefined
    if (byteLimit <= 0) return { samples: resume ? priorSamples : [], bytesRead: 0, limited: true, ...(resume && priorRef ? { priorRef } : {}), ...(!resume ? { noData: true } : {}) }
    const samples: UsageSample[] = []
    try {
      const result = await scanFile(target, resume?.offset ?? 0, resume?.tail ?? [], {
        emit: (sample) => samples.push(sample), byteLimit, incremental: true, ...(signal ? { signal } : {}),
      })
      const selectedSamples = [...(resume ? priorSamples : []), ...samples.filter((sample) => selected(sample.project))]
      const limited = result.limited ?? false
      if (this.#leased && !fromMemory) {
        const saved = this.#persistent.put({ target, offset: result.offset, tail: result.tail, samples, limited }, resume ? fromDisk?.generation : undefined)
        if (!saved) {
          // Admission failure uses the old host-lifetime path without spending source bytes again.
          const previous = resume && fromDisk ? this.#persistent.get(target, () => true)?.entry.samples : []
          if (!resume || previous) {
            const merged = [...(previous ?? []), ...samples]
            this.#remember(key, { target, offset: result.offset, tail: result.tail, samples: merged, limited })
          }
        }
      } else {
        const merged = [...(resume?.samples ?? []), ...samples]
        const entry = { target, offset: result.offset, tail: result.tail, samples: merged, limited }
        this.#remember(key, entry)
        if (this.#leased && this.#persistent.put(entry)) this.#files.delete(key)
      }
      return { samples: selectedSamples, bytesRead: result.bytesRead, limited }
    } catch (error) {
      if (error instanceof InsightBudgetExceededError) return { samples: [], bytesRead: byteLimit, limited: true, noData: true }
      this.#files.delete(key)
      throw error
    }
  }
}
