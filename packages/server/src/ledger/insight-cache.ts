import { InsightBudgetExceededError, type UsageSample } from './insight.js'
import { scanFile, wholeFile, type ScanTarget } from './scan.js'

interface Entry {
  readonly target: ScanTarget
  readonly offset: number
  readonly tail: readonly string[]
  readonly samples: readonly UsageSample[]
  readonly limited: boolean
}

/** Host-lifetime cache of parsed observations, never raw transcript text. */
export class InsightCache {
  readonly #files = new Map<string, Entry>()

  async read(target: ScanTarget, byteLimit: number, signal?: AbortSignal): Promise<{ samples: readonly UsageSample[]; bytesRead: number; limited: boolean }> {
    const key = JSON.stringify([target.runtime, target.kind, target.path])
    const prior = this.#files.get(key)
    const sameFile = prior?.target.identity === target.identity
    const unchanged = sameFile && prior?.target.size === target.size && prior.target.mtime === target.mtime && prior.target.changedAt === target.changedAt
    if (unchanged && !prior.limited) return { samples: prior.samples, bytesRead: 0, limited: false }
    const resume = prior && sameFile && !wholeFile(target.kind) && (unchanged || target.size > prior.target.size) ? prior : undefined
    if (byteLimit <= 0) return { samples: resume?.samples ?? [], bytesRead: 0, limited: true }
    const samples: UsageSample[] = []
    try {
      const result = await scanFile(target, resume?.offset ?? 0, resume?.tail ?? [], {
        emit: (sample) => samples.push(sample), byteLimit, incremental: true, ...(signal ? { signal } : {}),
      })
      const merged = [...(resume?.samples ?? []), ...samples]
      const limited = result.limited ?? false
      this.#files.delete(key)
      this.#files.set(key, { target, offset: result.offset, tail: result.tail, samples: merged, limited })
      // Discovery has the same file ceiling; retain no vanished history forever.
      while (this.#files.size > 10_000) this.#files.delete(this.#files.keys().next().value!)
      return { samples: merged, bytesRead: result.bytesRead, limited }
    } catch (error) {
      if (error instanceof InsightBudgetExceededError) return { samples: [], bytesRead: byteLimit, limited: true }
      this.#files.delete(key)
      throw error
    }
  }
}
