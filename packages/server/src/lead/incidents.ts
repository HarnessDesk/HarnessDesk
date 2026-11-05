import { randomInt } from 'node:crypto'
import type { AgentError, LeadChatIncident, RateLimits } from '@harnessdesk/protocol'
import { scrub } from '../phone-redact.js'
import { readBoundedJsonResult, writeAtomicJson } from './bounded-json.js'

export const LEAD_CHAT_RETRY_ATTEMPTS = 2
export const LEAD_CHAT_LIMIT = 64
const BACKOFF_MS = [60_000, 300_000] as const
const RESET_JITTER_MIN_MS = 250, RESET_JITTER_MAX_MS = 1250
interface StoredIncident extends LeadChatIncident {
  readonly turnId: string
  readonly nextAt: number | null
}
interface Ports {
  readonly file: string
  readonly project: string
  readonly now: () => number
  readonly schedule?: (run: () => void, delay: number) => () => void
  /** Includes holder, project, watch and lifecycle admission; rechecked at dispatch. */
  readonly allowed: (id: string) => Promise<boolean>
  readonly retry: (id: string, current: () => boolean) => Promise<void>
  readonly publish: (incident: LeadChatIncident) => Promise<void>
}
const schedule = (run: () => void, delay: number): (() => void) => {
  const timer = setTimeout(run, Math.min(delay, 2_147_483_647)); timer.unref()
  return () => clearTimeout(timer)
}
const kinds = ['quota', 'credits', 'transient', 'failed']
const states = ['waiting-reset', 'retrying', 'asked', 'moved', 'stopped', 'cleared']
const codes = ['auth', 'credits', 'rateLimit', 'versionGate', 'sandboxDenied', 'network', 'interrupted', 'runtimeUnavailable', 'protocol', 'unknown']
const fingerprint = (v: LeadChatIncident | undefined): string => v ? JSON.stringify([v.firstAt, v.state, v.kind, v.attempts, v.resetsAt, v.lastError]) : ''
const timestamp = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const valid = (v: any): v is StoredIncident => v && typeof v === 'object' && typeof v.chatId === 'string' && v.chatId.length <= 300 &&
  v.chatId.indexOf(':') > 0 && kinds.includes(v.kind) && states.includes(v.state) && Number.isInteger(v.attempts) && v.attempts >= 0 && v.attempts <= LEAD_CHAT_RETRY_ATTEMPTS &&
  timestamp(v.firstAt) && timestamp(v.lastAt) && (v.resetsAt === null || timestamp(v.resetsAt)) && (v.nextAt === null || timestamp(v.nextAt)) &&
  typeof v.turnId === 'string' && v.turnId.length <= 300 && codes.includes(v.lastError?.code) && typeof v.lastError?.message === 'string' && v.lastError.message.length <= 300 &&
  (v.movedTo === undefined || typeof v.movedTo === 'string' && v.movedTo.length <= 300)

/** A durable timer ledger, with no model or allowance port. Claim before sending:
 * a crash after a claim asks the person rather than replaying an uncertain send. */
export class LeadChatIncidents {
  #records = new Map<string, StoredIncident>()
  #timers = new Map<string, () => void>()
  #tail: Promise<unknown> = Promise.resolve()
  #effects = new Set<Promise<void>>()
  #retryTail: Promise<void> = Promise.resolve()
  #claims = new Map<string, { active: boolean }>()
  #loaded = false
  #closed = false
  #generation = 0
  constructor(private readonly ports: Ports) {}
  get(id: string): LeadChatIncident | undefined { return this.#records.get(id) }
  waiting(id: string): boolean { return ['waiting-reset', 'retrying'].includes(this.#records.get(id)?.state ?? '') }
  async idle(): Promise<void> {
    do { await this.#tail; await Promise.allSettled([...this.#effects]) } while (this.#effects.size)
    await this.#tail
  }
  #effect(task: Promise<void>): void {
    this.#effects.add(task)
    void task.catch(() => {}).finally(() => this.#effects.delete(task))
  }
  #queue<T>(run: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(run); this.#tail = task.catch(() => {}); return task
  }
  async #load(): Promise<void> {
    if (this.#loaded) return
    const read = await readBoundedJsonResult(this.ports.file, 256 * 1024)
    if (read.kind === 'missing') { this.#loaded = true; return }
    if (read.kind !== 'value') throw new Error('Lead incidents cannot be read safely.')
    const v = read.value as { version?: unknown; project?: unknown; records?: unknown }
    if (!v || v.version !== 1 || typeof v.project !== 'string' || !Array.isArray(v.records) || v.records.length > LEAD_CHAT_LIMIT ||
      !v.records.every(valid) || new Set(v.records.map(one => one.chatId)).size !== v.records.length) throw new Error('Invalid Lead incidents.')
    if (v.project === this.ports.project) this.#records = new Map(v.records.map(one => [one.chatId, one]))
    this.#loaded = true
  }
  async #save(record: StoredIncident): Promise<void> {
    const next = new Map(this.#records); next.delete(record.chatId); next.set(record.chatId, record)
    while (next.size > LEAD_CHAT_LIMIT) { const id = next.keys().next().value!; next.delete(id); this.#claims.delete(id); this.#timers.get(id)?.(); this.#timers.delete(id) }
    await writeAtomicJson(this.ports.file, { version: 1, project: this.ports.project, records: [...next.values()] }, async () => {})
    this.#records = next
    if (record.state !== 'retrying') this.#claims.delete(record.chatId)
  }
  #arm(record: StoredIncident): void {
    this.#timers.get(record.chatId)?.(); this.#timers.delete(record.chatId)
    if (this.#closed || record.state !== 'waiting-reset' || record.nextAt === null) return
    const generation = this.#generation
    this.#timers.set(record.chatId, (this.ports.schedule ?? schedule)(() => {
      this.#timers.delete(record.chatId)
      const claimed = this.#queue(async () => {
        if (this.#closed || generation !== this.#generation || this.#records.get(record.chatId) !== record) return false
        if (this.ports.now() < record.nextAt!) { this.#arm(record); return false }
        if (!await this.ports.allowed(record.chatId) || generation !== this.#generation) {
          await this.#save({ ...record, state: 'stopped', nextAt: null }); return false
        }
        const claim: StoredIncident = { ...record, state: 'retrying', nextAt: null, attempts: record.attempts + 1, lastAt: this.ports.now() }
        await this.#save(claim)
        return claim
      })
      // Release the ledger before taking the ordinary chat mutation tail. Stop
      // and move acquire those in the opposite order. A claim still fences replay.
      const previous = this.#retryTail
      const token = { active: true }; this.#claims.set(record.chatId, token)
      const effect = claimed.then(async claim => {
        await previous
        const current = () => !!claim && token.active && !this.#closed && generation === this.#generation && this.#claims.get(record.chatId) === token && this.#records.get(record.chatId) === claim
        if (!current()) return
        try { await this.ports.retry(record.chatId, current) }
        catch {
          const asked = await this.#queue(async () => {
            const current = this.#records.get(record.chatId)
            return current?.state === 'retrying' && current.firstAt === record.firstAt ? this.#ask(current) : null
          })
          if (asked && !this.#closed && generation === this.#generation && await this.ports.allowed(record.chatId)) await this.ports.publish(asked)
        }
      })
      this.#retryTail = effect.catch(() => {})
      this.#effect(effect)
    }, Math.max(0, record.nextAt - this.ports.now())))
  }
  async #ask(record: StoredIncident): Promise<StoredIncident> {
    const next = { ...record, state: 'asked' as const, nextAt: null }
    await this.#save(next)
    return next
  }
  restore(): Promise<void> {
    return this.#queue(async () => {
      await this.#load()
      const asked: StoredIncident[] = []
      for (const record of this.#records.values()) {
        if (record.state === 'retrying') asked.push(await this.#ask(record))
        else this.#arm(record)
      }
      return asked
    }).then(async asked => {
      for (const record of asked) if (!this.#closed && await this.ports.allowed(record.chatId)) await this.ports.publish(record)
    })
  }
  ended(chatId: string, turnId: string, error: AgentError | null, limits?: RateLimits | null): Promise<void> {
    return this.#queue(async () => {
      await this.#load()
      if (this.#closed || !await this.ports.allowed(chatId)) return
      const previous = this.#records.get(chatId)
      if (previous?.turnId === turnId) return
      if (error?.retrying && ['rateLimit', 'network', 'interrupted'].includes(error.code)) return
      this.#timers.get(chatId)?.(); this.#timers.delete(chatId)
      if (!error) { if (previous) await this.#save({ ...previous, turnId, state: 'cleared', nextAt: null, lastAt: this.ports.now() }); return }
      if (previous?.state === 'moved' || previous?.state === 'stopped') return
      const kind = error.code === 'rateLimit' ? 'quota' : error.code === 'credits' ? 'credits' : ['network', 'interrupted'].includes(error.code) ? 'transient' : 'failed'
      const active = previous && previous.state !== 'cleared' ? previous : undefined
      const reset = kind === 'quota' && limits?.reached ? limits.windows?.find(window => window.label === limits.reached)?.resetsAt : null
      const resetsAt = reset != null && timestamp(reset) ? reset : null, now = this.ports.now(), attempts = active?.attempts ?? 0
      const automatic = (kind === 'quota' || kind === 'transient') && attempts < LEAD_CHAT_RETRY_ATTEMPTS
      const record: StoredIncident = { chatId, turnId: turnId.slice(0, 300), kind, attempts, firstAt: active?.firstAt ?? now, lastAt: now, resetsAt,
        lastError: { code: error.code, message: scrub(error.message, 300) }, state: automatic ? 'waiting-reset' : 'asked',
        nextAt: automatic ? resetsAt !== null ? Math.max(now, resetsAt) + randomInt(RESET_JITTER_MIN_MS, RESET_JITTER_MAX_MS + 1) : now + BACKOFF_MS[attempts]! : null }
      await this.#save(record)
      if (automatic) this.#arm(record)
      else if (fingerprint(previous) !== fingerprint(record)) return record
      return undefined
    }).then(async record => {
      if (record && !this.#closed && await this.ports.allowed(record.chatId)) await this.ports.publish(record)
    })
  }
  /** Reserve the single move before creation, including an uncertain first send. */
  claimMove(id: string): Promise<void> {
    return this.#queue(async () => {
      await this.#load(); const record = this.#records.get(id)
      if (!record || record.state !== 'asked' || record.movedTo) throw new Error('That incident was already moved or stopped.')
      this.#timers.get(id)?.(); this.#timers.delete(id)
      await this.#save({ ...record, state: 'moved', nextAt: null })
    })
  }
  moved(id: string, movedTo: string): Promise<void> {
    return this.#queue(async () => {
      await this.#load(); const record = this.#records.get(id)
      if (!record || !['asked', 'moved'].includes(record.state) || record.movedTo) throw new Error('That incident was moved or is no longer waiting for an answer.')
      await this.#save({ ...record, state: 'moved', movedTo, nextAt: null })
    })
  }
  invalidateRetry(id: string): void { const claim = this.#claims.get(id); if (claim) claim.active = false }
  stop(id: string): Promise<boolean> {
    this.invalidateRetry(id)
    this.#timers.get(id)?.(); this.#timers.delete(id)
    return this.#queue(async () => { await this.#load(); const record = this.#records.get(id); if (record) {
      this.#timers.get(id)?.(); this.#timers.delete(id); await this.#save({ ...record, state: 'stopped', nextAt: null })
      return ['waiting-reset', 'retrying', 'asked'].includes(record.state)
    }
    return false })
  }
  cancel(): void {
    this.#generation++; this.#claims.clear()
    for (const cancel of this.#timers.values()) cancel()
    this.#timers.clear()
    void this.#queue(async () => { await this.#load(); for (const record of this.#records.values()) if (this.waiting(record.chatId)) await this.#save({ ...record, state: 'stopped', nextAt: null }) }).catch(() => {})
  }
  close(): void { this.#closed = true; this.#generation++; this.#claims.clear(); for (const cancel of this.#timers.values()) cancel(); this.#timers.clear() }
}
