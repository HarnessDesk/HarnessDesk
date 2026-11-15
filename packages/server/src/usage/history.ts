import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RuntimeId, UsageCredits, UsageLane } from '@harnessdesk/protocol'

/** Anonymous prior quota facts. This is never account or allowance authority. */
export interface HistoricalUsage {
  readonly lanes: readonly UsageLane[]
  readonly credits: UsageCredits | null
  readonly fetchedAt: number
}
const MAX_BYTES = 1_048_576, MAX_RUNTIMES = 128, MAX_LANES = 32
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const maybeNumber = (value: unknown): value is number | null => value === null || finite(value)
const unit = (value: unknown): UsageLane['unit'] | undefined =>
  value === 'percent' || value === 'requests' || value === 'credits' || value === 'acu' || value === 'usd' ? value : undefined

/** No source-authored string, account label, credential, plan or error reaches disk. */
const normalize = (raw: HistoricalUsage, now: number): HistoricalUsage | null => {
  if (!raw || !finite(raw.fetchedAt) || raw.fetchedAt <= 0 || raw.fetchedAt > now || !Array.isArray(raw.lanes) || raw.lanes.length > MAX_LANES) return null
  const lanes: UsageLane[] = []
  for (const [index, lane] of raw.lanes.entries()) {
    if (!lane || !finite(lane.usedPercent) || !maybeNumber(lane.windowMinutes) || !maybeNumber(lane.resetsAt)) return null
    if (lane.windowMinutes !== null && lane.windowMinutes < 0 || lane.resetsAt !== null && lane.resetsAt < 0) return null
    if (lane.usageKnown !== undefined && typeof lane.usageKnown !== 'boolean' || lane.placeholder !== undefined && typeof lane.placeholder !== 'boolean') return null
    if (lane.used !== undefined && !maybeNumber(lane.used) || lane.limit !== undefined && !maybeNumber(lane.limit)) return null
    if (lane.layer !== undefined && lane.layer !== 'plan' && lane.layer !== 'overage') return null
    const knownUnit = unit(lane.unit)
    lanes.push({ id: `saved-${index + 1}`, label: `Window ${index + 1}`, usedPercent: lane.usedPercent, windowMinutes: lane.windowMinutes, resetsAt: lane.resetsAt,
      ...(lane.usageKnown !== undefined ? { usageKnown: lane.usageKnown } : {}), ...(lane.placeholder !== undefined ? { placeholder: lane.placeholder } : {}),
      ...(knownUnit ? { unit: knownUnit } : {}), ...(lane.used !== undefined ? { used: lane.used } : {}),
      ...(lane.limit !== undefined ? { limit: lane.limit } : {}), ...(lane.layer !== undefined ? { layer: lane.layer } : {}) })
  }
  let credits: UsageCredits | null = null
  if (raw.credits !== null) {
    const c = raw.credits
    if (!c || !maybeNumber(c.remaining) || c.used !== undefined && !maybeNumber(c.used) || c.unlimited !== undefined && typeof c.unlimited !== 'boolean') return null
    const creditUnit = ['USD', 'EUR', 'GBP', 'credits', 'requests'].includes(c.unit) ? c.unit : 'units'
    credits = { unit: creditUnit, remaining: c.remaining, ...(c.used !== undefined ? { used: c.used } : {}), ...(c.unlimited !== undefined ? { unlimited: c.unlimited } : {}) }
  }
  return lanes.length || credits ? { lanes, credits, fetchedAt: raw.fetchedAt } : null
}

/** A global generation fences stale writers; a leftover lock after a crash fails closed. */
export class UsageHistory {
  #queue: Promise<void> = Promise.resolve()
  readonly #epochs = new Map<RuntimeId, number>()
  readonly #suppressed = new Set<RuntimeId>()
  constructor(readonly path: string, readonly now: () => number = Date.now, readonly warning: (id: RuntimeId) => void = () => {}) {}
  epoch(id: RuntimeId): string { return String(this.#epochs.get(id) ?? 0) }
  async flush(): Promise<void> { await this.#queue }
  #file(id: RuntimeId): string { return join(`${this.path}.d`, `${createHash('sha256').update(id).digest('hex')}.json`) }
  async #locked<T>(mutating: boolean, action: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true })
    const lock = `${this.path}.lock`, handle = await open(lock, 'wx', 0o600)
    let success = false
    try { const result = await action(); success = true; return result }
    finally { await handle.close(); if (success || !mutating) await rm(lock, { force: true }) }
  }
  async #read(path: string): Promise<string | null> {
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > MAX_BYTES) throw new Error('invalid history')
        const buffer = Buffer.alloc(MAX_BYTES + 1); let used = 0
        while (used < buffer.length) { const result = await file.read(buffer, used, buffer.length - used, null); if (!result.bytesRead) break; used += result.bytesRead }
        if (used > MAX_BYTES) throw new Error('invalid history')
        return buffer.toString('utf8', 0, used)
      } finally { await file.close() }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  async #generation(): Promise<string> {
    const raw = await this.#read(`${this.path}.epoch`)
    if (raw === null) return 'initial'
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/.test(value)) throw new Error('invalid history generation')
    return value
  }
  async #atomic(path: string, data: string): Promise<void> {
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('oversized history')
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      const file = await open(temp, 'wx', 0o600)
      try { await file.writeFile(data); await file.sync() } finally { await file.close() }
      await rename(temp, path)
      const directory = await open(dirname(path), 'r')
      try { await directory.sync() } finally { await directory.close() }
    } finally { await rm(temp, { force: true }) }
  }
  /** Called before the provider read, so a later forget fences its old result. */
  async begin(id: RuntimeId, allowed: () => boolean = () => true): Promise<string | null> {
    if (this.#suppressed.has(id) || !allowed()) return null
    const local = this.epoch(id)
    try {
      const generation = await this.#locked(false, () => allowed() ? this.#generation() : Promise.resolve(null))
      return generation !== null && allowed() && this.epoch(id) === local && !this.#suppressed.has(id) ? `${local}:${generation}` : null
    } catch { return null }
  }
  async read(id: RuntimeId, allowed: () => boolean = () => true): Promise<HistoricalUsage | null> {
    await this.#queue
    if (this.#suppressed.has(id) || !allowed()) return null
    try {
      return await this.#locked(false, async () => {
        if (!allowed()) return null
        const raw = await this.#read(this.#file(id)); if (raw === null) return null
        const doc: unknown = JSON.parse(raw)
        if (!doc || typeof doc !== 'object' || (doc as { version?: unknown }).version !== 1) return null
        return normalize((doc as { observation: HistoricalUsage }).observation, this.now())
      })
    } catch { return null }
  }
  async write(id: RuntimeId, token: string | null, observation: HistoricalUsage, allowed: () => boolean = () => true): Promise<void> {
    const clean = normalize(observation, this.now())
    if (!clean || !token || this.#suppressed.has(id) || !allowed()) return
    const local = this.epoch(id)
    const operation = this.#queue.then(() => this.#locked(true, async () => {
      if (!allowed() || this.#suppressed.has(id) || this.epoch(id) !== local || token !== `${local}:${await this.#generation()}` || !allowed()) return
      const folder = `${this.path}.d`; await mkdir(folder, { recursive: true })
      if (!allowed()) return
      const entries = (await readdir(folder)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      if (!allowed()) return
      const file = this.#file(id)
      const prior = await this.#read(file)
      if (prior !== null) {
        const parsed: unknown = JSON.parse(prior)
        if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) throw new Error('invalid history')
        const previous = normalize((parsed as { observation: HistoricalUsage }).observation, this.now())
        if (!previous) throw new Error('invalid history')
        if (previous.fetchedAt > clean.fetchedAt) return
      }
      const name = file.slice(folder.length + 1)
      const data = JSON.stringify({ version: 1, observation: clean }) + '\n'
      const dated = await Promise.all(entries.filter(entry => entry !== name).map(async entry => {
        const info = await stat(join(folder, entry)); return { name: entry, at: info.mtimeMs, size: info.size }
      }))
      if (!allowed()) return
      dated.sort((a, b) => a.at - b.at)
      let total = dated.reduce((sum, entry) => sum + entry.size, Buffer.byteLength(data))
      while (dated.length >= MAX_RUNTIMES || total > MAX_BYTES) {
        const oldest = dated.shift()
        if (!oldest) throw new Error('oversized history')
        await rm(join(folder, oldest.name)); total -= oldest.size
      }
      await this.#atomic(file, data)
    }))
    this.#queue = operation.catch(() => {})
    await operation.catch(() => {})
  }
  async forget(id: RuntimeId): Promise<void> {
    this.#epochs.set(id, (this.#epochs.get(id) ?? 0) + 1)
    const local = this.epoch(id); this.#suppressed.add(id)
    const operation = this.#queue.then(() => this.#locked(true, async () => {
      await this.#atomic(`${this.path}.epoch`, JSON.stringify(randomUUID()))
      await rm(this.#file(id), { force: true })
      const directory = await open(dirname(this.#file(id)), 'r').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (directory) try { await directory.sync() } finally { await directory.close() }
    }))
    this.#queue = operation.catch(() => {})
    try { await operation } catch { try { this.warning(id) } catch {} return }
    if (this.epoch(id) === local) this.#suppressed.delete(id)
  }
  /** Forget uses only the known opaque filename; no other runtime's reading is opened. */
  async forgetWithoutRead(id: RuntimeId): Promise<void> { await this.forget(id) }
}
