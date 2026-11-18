import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readBoundedJsonResult, writeAtomicJson } from './bounded-json.js'
import { mentionPriceSchedule, priceMentionUsage, quoteMentionHold, type MentionPriceSchedule } from './mention-observer-pricing.js'
import type { AssessCharge, AssessUsage } from '../intake/assess.js'

// 1,024 records, each with a 128-byte ASCII id, at most 1 KiB schedule and
// bounded numeric/day fields, fit comfortably in 2 MiB. Both limits are
// checked before each write; pending evidence is never evicted for space.
const owners = new Set<string>()
const MAX_RECORDS = 1024
const MAX_BYTES = 2 * 1024 * 1024
const MAX_SCHEDULE_BYTES = 1024
const ID = /^[A-Za-z0-9:_-]{1,128}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0
const dayOf = (time: number): string => {
  const d = new Date(time)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
type RecordState = 'pending' | 'settled' | 'uncertain'
interface Receipt { id: string; nonce: string; day: string; chargedDay: string; model: string; schedule: MentionPriceSchedule; inputUpper: number; maxOutput: number; hold: number; state: RecordState; amount: number }
interface Period { day: string; spentUsdMicros: number; uncertainUsdMicros: number }
interface Stored { version: 1; cap: number; day: string; receipts: Receipt[]; compacted: { spentUsdMicros: number; uncertainUsdMicros: number; periods: Period[] } }
export interface MentionObserverBudgetView { dailyCapUsdMicros: number; enabled: boolean; day: string; spentUsdMicros: number; reservedUsdMicros: number; uncertainUsdMicros: number; remainingUsdMicros: number; compacted: Stored['compacted']; problem?: string }
const empty = (): Stored => ({ version: 1, cap: 0, day: '', receipts: [], compacted: { spentUsdMicros: 0, uncertainUsdMicros: 0, periods: [] } })
const digest = (data: string): string => createHash('sha256').update(data).digest('hex')
const bad = (): Error => new Error('Mention observer budget is unavailable; automatic assessments wait for you.')
const parse = (value: unknown): Stored => {
  if (!value || typeof value !== 'object') throw bad()
  const s = value as Stored
  if (s.version !== 1 || !integer(s.cap) || typeof s.day !== 'string' || (s.day !== '' && !DAY.test(s.day)) || !Array.isArray(s.receipts) || s.receipts.length > MAX_RECORDS) throw bad()
  if (!s.compacted || !integer(s.compacted.spentUsdMicros) || !integer(s.compacted.uncertainUsdMicros) || !Array.isArray(s.compacted.periods) || s.compacted.periods.length > 30 || s.compacted.periods.some(p => !p || !DAY.test(p.day) || !integer(p.spentUsdMicros) || !integer(p.uncertainUsdMicros))) throw bad()
  const ids = new Set<string>()
  for (const r of s.receipts) {
    if (!r || typeof r !== 'object' || !ID.test(r.id) || typeof r.nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(r.nonce) || ids.has(r.id) || !DAY.test(r.day) || !DAY.test(r.chargedDay) || typeof r.model !== 'string' || !ID.test(r.model) || r.schedule?.model !== r.model || r.chargedDay !== r.day || r.day > s.day || !integer(r.inputUpper) || !integer(r.maxOutput) || !integer(r.hold) || !integer(r.amount) || r.amount > r.hold || !['pending', 'settled', 'uncertain'].includes(r.state) || (r.state !== 'settled' && r.amount !== r.hold) || !r.schedule || typeof r.schedule !== 'object' || Buffer.byteLength(JSON.stringify(r.schedule)) > MAX_SCHEDULE_BYTES || quoteMentionHold(r.schedule, r.inputUpper, r.maxOutput) !== r.hold) throw bad()
    ids.add(r.id)
  }
  return s
}

/** Serialized and durable accounting for mention assessments. No Lead goal or journal is involved. */
export class MentionObserverBudget {
  readonly #file: string
  readonly #now: () => number
  readonly #onProblem?: (message: string) => void
  #state: Stored = empty()
  #loaded = false
  #fault: string | undefined
  #diskDigest: string | null = null
  #queue: Promise<unknown> = Promise.resolve()
  #closed = false
  #lease: DatabaseSync | null = null
  #leaseIdentity: { dev: number; ino: number } | null = null
  #ownerKey: string | null = null
  constructor(options: { file: string; now?: () => number; problem?: (message: string) => void }) {
    this.#file = options.file; this.#now = options.now ?? Date.now; this.#onProblem = options.problem
  }
  #fail(): void { this.#fault = bad().message; try { this.#onProblem?.(this.#fault) } catch { /* reporting cannot grant credit */ } }
  #run<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work)
    this.#queue = run.catch(() => {})
    return run
  }
  async #readBytes(): Promise<string | null> {
    try {
      const handle = await open(this.#file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_BYTES) throw bad(); const bytes = Buffer.alloc(MAX_BYTES + 1); let length = 0; while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); if (part.bytesRead === 0) break; length += part.bytesRead }; if (length > MAX_BYTES) throw bad(); return bytes.subarray(0, length).toString('utf8') } finally { await handle.close() }
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  }
  async #acquire(): Promise<void> {
    const requested = resolve(`${this.#file}.lock.sqlite`)
    await mkdir(dirname(requested), { recursive: true, mode: 0o700 })
    const file = join(await realpath(dirname(requested)), basename(requested))
    if (owners.has(file)) throw bad()
    owners.add(file); this.#ownerKey = file
    // Never open and close a separate descriptor after acquiring SQLite's
    // POSIX lock: doing so can release process-wide locks on the same inode.
    try { const created = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await created.close() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const before = await lstat(file)
    if (!before.isFile() || before.nlink !== 1) throw bad()
    const lease = new DatabaseSync(file)
    try {
      lease.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE')
      const after = await lstat(file)
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1) throw bad()
      this.#lease = lease; this.#leaseIdentity = { dev: before.dev, ino: before.ino }
    } catch (error) { try { lease.close() } catch {} ; throw error }
  }
  async #checkLease(): Promise<void> {
    const stat = await lstat(`${this.#file}.lock.sqlite`)
    if (!this.#lease || !this.#leaseIdentity || !stat.isFile() || stat.nlink !== 1 || stat.dev !== this.#leaseIdentity.dev || stat.ino !== this.#leaseIdentity.ino) throw bad()
  }
  #release(): void {
    if (this.#lease) { try { this.#lease.exec('ROLLBACK') } catch {} ; try { this.#lease.close() } catch {} }
    this.#lease = null; this.#leaseIdentity = null
    if (this.#ownerKey) owners.delete(this.#ownerKey)
    this.#ownerKey = null
  }
  async #load(): Promise<void> {
    if (this.#loaded || this.#closed) return
    this.#loaded = true
    try {
      await this.#acquire()
      const read = await readBoundedJsonResult(this.#file, MAX_BYTES)
      if (read.kind === 'missing') return
      if (read.kind !== 'value') throw bad()
      const bytes = await this.#readBytes()
      if (bytes === null) throw bad()
      this.#state = parse(JSON.parse(bytes)); this.#diskDigest = digest(bytes)
      // Only this owner can observe these after acquiring the lease: the
      // former owner is gone, so no pending effect may be resent or refunded.
      if (this.#state.receipts.some(r => r.state === 'pending')) {
        for (const r of this.#state.receipts) if (r.state === 'pending') { r.state = 'uncertain'; r.amount = r.hold }
        await this.#save()
      }
    } catch { this.#fail(); this.#release() }
  }
  #roll(): void {
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) { this.#fail(); return }
    const day = dayOf(now)
    if (!DAY.test(day)) { this.#fail(); return }
    if (day > this.#state.day) this.#state.day = day
    // A retired receipt can never be recreated by a late callback. Preserve
    // cumulative totals and the latest 30 days of compacted daily totals.
    const retired = this.#state.receipts.filter(r => r.state !== 'pending' && r.chargedDay < this.#state.day)
    for (const r of retired) {
      const totals = this.#state.compacted
      const key = r.state === 'uncertain' ? 'uncertainUsdMicros' : 'spentUsdMicros'
      const next = totals[key] + r.amount
      if (!Number.isSafeInteger(next)) { this.#fail(); return }
      let period = totals.periods.find(p => p.day === r.chargedDay)
      if (!period) { period = { day: r.chargedDay, spentUsdMicros: 0, uncertainUsdMicros: 0 }; totals.periods.push(period) }
      const periodNext = period[key] + r.amount
      if (!Number.isSafeInteger(periodNext)) { this.#fail(); return }
      totals[key] = next; period[key] = periodNext
    }
    if (retired.length) {
      this.#state.compacted.periods.sort((a, b) => a.day.localeCompare(b.day))
      this.#state.compacted.periods = this.#state.compacted.periods.slice(-30)
      const ids = new Set(retired.map(r => r.id))
      this.#state.receipts = this.#state.receipts.filter(r => !ids.has(r.id))
    }
  }
  async #save(): Promise<void> {
    const serialized = JSON.stringify(this.#state)
    if (Buffer.byteLength(serialized) > MAX_BYTES || this.#state.receipts.length > MAX_RECORDS) { this.#fail(); throw bad() }
    try {
      await this.#checkLease()
      await writeAtomicJson(this.#file, this.#state, async () => {
        await this.#checkLease()
        const bytes = await this.#readBytes()
        if ((bytes === null ? null : digest(bytes)) !== this.#diskDigest) throw bad()
      })
      this.#diskDigest = digest(serialized)
    } catch (e) { this.#fail(); throw e }
  }
  #view(): MentionObserverBudgetView {
    let spent = 0, reserved = 0, uncertain = 0
    for (const r of this.#state.receipts) {
      if (r.state === 'pending') reserved += r.hold
      else if (r.chargedDay === this.#state.day) { if (r.state === 'uncertain') uncertain += r.amount; else spent += r.amount }
    }
    if (![spent, reserved, uncertain, spent + reserved + uncertain].every(Number.isSafeInteger)) this.#fail()
    return { dailyCapUsdMicros: this.#state.cap, enabled: this.#state.cap > 0 && !this.#fault, day: this.#state.day,
      spentUsdMicros: spent, reservedUsdMicros: reserved, uncertainUsdMicros: uncertain,
      remainingUsdMicros: this.#fault ? 0 : Math.max(0, this.#state.cap - spent - reserved - uncertain), compacted: structuredClone(this.#state.compacted), ...(this.#fault ? { problem: this.#fault } : {}) }
  }
  async view(): Promise<MentionObserverBudgetView> { return this.#run(async () => { await this.#load(); if (!this.#fault) this.#roll(); return this.#view() }) }
  async configure(dailyCapUsdMicros: number): Promise<void> { return this.#run(async () => {
    await this.#load(); if (this.#closed || this.#fault || !integer(dailyCapUsdMicros)) throw bad()
    this.#roll(); if (this.#fault) throw bad(); this.#state.cap = dailyCapUsdMicros; await this.#save()
  }) }
  async reserve(requestId: string, inputUpper: number, maxOutput: number, model: string): Promise<AssessCharge | null> { return this.#run(async () => {
    await this.#load(); if (this.#closed || this.#fault || !ID.test(requestId) || !integer(inputUpper) || !integer(maxOutput) || typeof model !== 'string' || !ID.test(model)) return null
    this.#roll(); if (this.#fault) return null
    const schedule = mentionPriceSchedule(model), hold = schedule ? quoteMentionHold(schedule, inputUpper, maxOutput) : null
    const available = this.#view().remainingUsdMicros
    if (this.#fault || !schedule || hold === null || !integer(hold) || Buffer.byteLength(JSON.stringify(schedule)) > MAX_SCHEDULE_BYTES || this.#state.receipts.length >= MAX_RECORDS || this.#state.receipts.some(r => r.id === requestId) || this.#state.cap === 0 || hold > available) return null
    const frozen = JSON.parse(JSON.stringify(schedule)) as MentionPriceSchedule
    const nonce = randomUUID()
    this.#state.receipts.push({ id: requestId, nonce, day: this.#state.day, chargedDay: this.#state.day, model, schedule: frozen, inputUpper, maxOutput, hold, state: 'pending', amount: hold })
    try { await this.#save() } catch { return null }
    return { settle: (usage: AssessUsage) => this.#settle(requestId, nonce, usage), unknown: () => this.#settle(requestId, nonce, null) }
  }) }
  #settle(id: string, nonce: string, usage: AssessUsage | null): Promise<void> { return this.#run(async () => {
    await this.#load(); if (this.#closed || this.#fault) return
    this.#roll(); if (this.#fault) return
    const receipt = this.#state.receipts.find(r => r.id === id)
    if (!receipt || receipt.nonce !== nonce || receipt.state !== 'pending') return
    const input = usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : NaN
    const amount = usage && Number.isSafeInteger(input) && input <= receipt.inputUpper && usage.outputTokens <= receipt.maxOutput ? priceMentionUsage(receipt.schedule, usage) : null
    receipt.chargedDay = receipt.day
    if (amount === null || !integer(amount) || amount > receipt.hold) { receipt.state = 'uncertain'; receipt.amount = receipt.hold }
    else { receipt.state = 'settled'; receipt.amount = amount }
    await this.#save()
  }) }
  async storageIdle(): Promise<void> { await this.#queue }
  async close(): Promise<void> { await this.#run(async () => {
    if (this.#closed) return
    this.#closed = true
    try {
      if (this.#loaded && !this.#fault && this.#state.receipts.some(r => r.state === 'pending')) {
        for (const r of this.#state.receipts) if (r.state === 'pending') { r.state = 'uncertain'; r.amount = r.hold }
        await this.#save()
      }
    } finally { this.#release() }
  }) }
}
