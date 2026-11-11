import type { AgentError, LeadChatIncident, RateLimits } from '@harnessdesk/protocol'
import { scrub } from '../phone-redact.js'
import { BACKOFF_MS, INCIDENT_LIMIT, IncidentLedger, RETRY_ATTEMPTS, afterReset, isTimestamp as timestamp, scheduleTimer as schedule } from '../carry-on/incidents.js'

export const LEAD_CHAT_RETRY_ATTEMPTS = RETRY_ATTEMPTS
export const LEAD_CHAT_LIMIT = INCIDENT_LIMIT
interface StoredIncident extends LeadChatIncident {
  readonly turnId: string
  readonly nextAt: number | null
  readonly blocked?: number
  readonly personRevision?: number
}
interface Ports {
  readonly file: string
  readonly project: string
  readonly now: () => number
  readonly schedule?: (run: () => void, delay: number) => () => void
  /** Includes holder, project, watch and lifecycle admission; rechecked at dispatch. */
  readonly allowed: (id: string) => Promise<boolean>
  /** The mutation gate may be briefly closed while observations remain readable. */
  readonly admit?: (id: string) => Promise<boolean>
  readonly busy?: (id: string) => boolean
  readonly personRevision?: () => number
  readonly goalStartedSeq?: () => number
  readonly problem?: (reason: string) => void
  readonly retry: (id: string, current: () => boolean, started: () => void) => Promise<void | 'not-started' | 'busy'>
  readonly publish: (incident: LeadChatIncident) => Promise<void>
}
const kinds = ['quota', 'credits', 'transient', 'failed']
const states = ['waiting-reset', 'retrying', 'asked', 'moved', 'stopped', 'cleared']
const codes = ['auth', 'credits', 'rateLimit', 'versionGate', 'sandboxDenied', 'network', 'interrupted', 'runtimeUnavailable', 'protocol', 'unknown']
const valid = (v: any): v is StoredIncident => !! v && typeof v === 'object' && typeof v.chatId === 'string' && v.chatId.length <= 300 &&
  v.chatId.indexOf(':') > 0 && kinds.includes(v.kind) && states.includes(v.state) && Number.isInteger(v.attempts) && v.attempts >= 0 && v.attempts <= LEAD_CHAT_RETRY_ATTEMPTS &&
  timestamp(v.firstAt) && timestamp(v.lastAt) && (v.resetsAt === null || timestamp(v.resetsAt)) && (v.nextAt === null || timestamp(v.nextAt)) &&
  typeof v.turnId === 'string' && v.turnId.length > 0 && v.turnId.length <= 300 && codes.includes(v.lastError?.code) && typeof v.lastError?.message === 'string' && v.lastError.message.length <= 300 &&
  (v.blocked === undefined || Number.isInteger(v.blocked) && v.blocked >= 0 && v.blocked <= LEAD_CHAT_RETRY_ATTEMPTS) &&
  (v.personRevision === undefined || timestamp(v.personRevision)) &&
  (v.movedTo === undefined || typeof v.movedTo === 'string' && v.movedTo.length <= 300)

/** A durable timer ledger, with no model or allowance port. Claim before sending:
 * a crash after a claim asks the person rather than replaying an uncertain send.
 * The file, its cap, the backoff and the reset jitter are carry-on's (`../carry-on/incidents.ts`);
 * what stays here is the Lead's own: the person's answer, the retry claim and its receipt. */
export class LeadChatIncidents {
  readonly #records: IncidentLedger<StoredIncident>
  #timers = new Map<string, () => void>()
  #tail: Promise<unknown> = Promise.resolve()
  #effects = new Set<Promise<void>>()
  #retryTail: Promise<void> = Promise.resolve()
  #claims = new Map<string, { active: boolean; started: boolean }>()
  #revisions = new Map<string, { revoked: number; dispatch: number }>()
  #closed = false
  #generation = 0
  constructor(private readonly ports: Ports) {
    this.#records = new IncidentLedger<StoredIncident>({
      file: ports.file, label: 'Lead incidents', recordLabel: 'Lead incident', keyOf: record => record.chatId, valid,
      header: () => ({ project: ports.project }), accepts: file => file['project'] === ports.project,
      adopt: record => record.personRevision === undefined && ports.personRevision ? { ...record, personRevision: ports.personRevision() } : record,
      evicted: id => { this.#claims.delete(id); this.#revisions.delete(id); this.#timers.get(id)?.(); this.#timers.delete(id) },
      ...(ports.problem ? { problem: ports.problem } : {}),
    })
  }
  get(id: string): LeadChatIncident | undefined { return this.#records.get(id) }
  waiting(id: string): boolean { return ['waiting-reset', 'retrying'].includes(this.#records.get(id)?.state ?? '') }
  observationRevision(id: string): number { return this.#revisions.get(id)?.dispatch ?? 0 }
  #revision(id: string): { revoked: number; dispatch: number } {
    let revision = this.#revisions.get(id)
    if (!revision) this.#revisions.set(id, revision = { revoked: 0, dispatch: 0 })
    return revision
  }
  /** The receipt belongs to the exact incident and dispatch, not a later turn or retry. */
  unconfirmedReceipt(id: string, current: (() => boolean) | undefined, manual: boolean): () => Promise<void> {
    const record = this.#records.get(id), revision = this.#revision(id), revoked = revision.revoked
    // Turn observations captured before this dispatch belong to the earlier turn.
    if (record?.state === 'retrying' && (!current || current())) revision.dispatch++
    return async () => {
      if (!record || record.state !== 'retrying' || this.#records.get(id) !== record || revision.revoked !== revoked || current && !current()) return
      const asked = await this.#queue(async () => {
        if (this.#closed || this.#records.get(id) !== record || revision.revoked !== revoked || current && !current()) return null
        return this.#ask({ ...record, kind: 'failed', attempts: Math.min(LEAD_CHAT_RETRY_ATTEMPTS, record.attempts + (manual ? 1 : 0)), resetsAt: null,
          lastError: { code: 'unknown', message: 'The retry could not be confirmed. Check the conversation before retrying.' } })
      })
      if (asked && !this.#closed && await this.ports.allowed(id)) await this.ports.publish(asked)
    }
  }
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
  #load(): Promise<void> { return this.#records.load() }
  async #save(record: StoredIncident): Promise<void> {
    await this.#records.save(record)
    if (record.state !== 'retrying') this.#claims.delete(record.chatId)
  }
  #arm(record: StoredIncident): void {
    this.#timers.get(record.chatId)?.(); this.#timers.delete(record.chatId)
    if (this.#closed || record.state !== 'waiting-reset' || record.nextAt === null) return
    const generation = this.#generation
    this.#timers.set(record.chatId, (this.ports.schedule ?? schedule)(() => {
      this.#timers.delete(record.chatId)
      // Admission can await host lookups. It must not hold the ledger writer needed by Stop.
      const admission = Promise.resolve().then(() => (this.ports.admit ?? this.ports.allowed)(record.chatId)).catch(() => false)
      const claimed = admission.then(allowed => this.#queue(async () => {
        if (this.#closed || generation !== this.#generation || this.#records.get(record.chatId) !== record) return false
        if (this.ports.now() < record.nextAt!) { this.#arm(record); return false }
        if (this.ports.busy?.(record.chatId) || !allowed) {
          return this.#defer(record, !allowed)
        }
        const claim: StoredIncident = { ...record, state: 'retrying', nextAt: null, attempts: record.attempts + 1, lastAt: this.ports.now(), personRevision: this.ports.personRevision?.() }
        await this.#save(claim)
        return claim
      }))
      // Release the ledger before taking the ordinary chat mutation tail. Stop
      // and move acquire those in the opposite order. A claim still fences replay.
      const previous = this.#retryTail
      const token = { active: true, started: false }; this.#claims.set(record.chatId, token)
      const effect = claimed.then(async claim => {
        if (claim && claim.state === 'asked') { if (!this.#closed && generation === this.#generation) await this.ports.publish(claim); return }
        await previous
        const current = () => !!claim && token.active && !this.#closed && generation === this.#generation && this.#claims.get(record.chatId) === token && this.#records.get(record.chatId) === claim
        if (!current()) return
        try {
          const result = await this.ports.retry(record.chatId, current, () => { token.started = true })
          if (result === 'not-started' || result === 'busy') {
            const asked = await this.#queue(async () => current() ? this.#defer(claim as StoredIncident, result !== 'busy', true) : false)
            if (asked && !this.#closed && generation === this.#generation) await this.ports.publish(asked)
          }
        } catch {
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
  async #defer(record: StoredIncident, admissionFailed: boolean, notStarted = false): Promise<StoredIncident | false> {
    const blocked = (record.blocked ?? 0) + (admissionFailed ? 1 : 0)
    const attempts = record.attempts - (notStarted ? 1 : 0)
    const next = { ...record, blocked, attempts }
    if (blocked >= LEAD_CHAT_RETRY_ATTEMPTS) return this.#ask(next)
    const deferred = { ...next, state: 'waiting-reset' as const, nextAt: this.ports.now() + BACKOFF_MS[Math.min(attempts, 1)]! }
    await this.#save(deferred); this.#arm(deferred); return false
  }
  async #ask(record: StoredIncident): Promise<StoredIncident> {
    const next = { ...record, state: 'asked' as const, nextAt: null, lastAt: this.ports.now(), personRevision: this.ports.personRevision?.() }
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
  ended(chatId: string, turnId: string, error: AgentError | null, limits?: RateLimits | null, current?: () => boolean): Promise<void> {
    return this.#queue(async () => {
      await this.#load()
      if (this.#closed || current && !current() || !await this.ports.allowed(chatId) || current && !current()) return
      const previous = this.#records.get(chatId)
      if (previous?.turnId === turnId) return
      if (error?.retrying && ['rateLimit', 'network', 'interrupted'].includes(error.code)) return
      this.#timers.get(chatId)?.(); this.#timers.delete(chatId)
      if (!error) { if (previous) await this.#save({ ...previous, turnId, state: 'cleared', nextAt: null, lastAt: this.ports.now() }); return }
      if (previous?.state === 'moved') return
      const kind = error.code === 'rateLimit' ? 'quota' : error.code === 'credits' ? 'credits' : ['network', 'interrupted'].includes(error.code) ? 'transient' : 'failed'
      const active = previous && !['cleared', 'stopped'].includes(previous.state) ? previous : undefined
      const reset = kind === 'quota' && limits?.reached ? limits.windows?.find(window => window.label === limits.reached)?.resetsAt : null
      const resetsAt = reset != null && timestamp(reset) ? reset : null, now = this.ports.now()
      // A different turn can end while the host is still admitting the claimed retry.
      // Only a retry that crossed the host effect boundary belongs to that successor.
      const pending = this.#claims.get(chatId)
      const undispatched = active?.state === 'retrying' && pending && !pending.started
      if (undispatched) pending.active = false // Revoke before the successor's durable write can yield.
      const attempts = (active?.attempts ?? 0) - (undispatched ? 1 : 0)
      const automatic = previous?.state !== 'asked' && (kind === 'quota' || kind === 'transient') && attempts < LEAD_CHAT_RETRY_ATTEMPTS
      const record: StoredIncident = { chatId, personRevision: this.ports.personRevision?.(), turnId: turnId.slice(0, 300), kind, attempts, firstAt: active?.firstAt ?? now, lastAt: now, resetsAt,
        lastError: { code: error.code, message: scrub(error.message, 300) }, state: automatic ? 'waiting-reset' : 'asked',
        nextAt: automatic ? resetsAt !== null && resetsAt > now ? afterReset(resetsAt) : now + BACKOFF_MS[attempts]! : null }
      await this.#save(record)
      if (automatic) this.#arm(record)
      else return record
      return undefined
    }).then(async record => {
      if (record && !this.#closed && await this.ports.allowed(record.chatId)) await this.ports.publish(record)
    })
  }
  /** A journal revision is a durable happens-after receipt, even within one clock tick. */
  hasPersonAnswer(id: string): boolean {
    const record = this.#records.get(id)
    return record?.personRevision !== undefined && (this.ports.personRevision?.() ?? 0) > Math.max(record.personRevision, this.ports.goalStartedSeq?.() ?? 0)
  }
  beginRetry(id: string, atReset = false): Promise<{ rollback(): Promise<void>; stop(): Promise<void> } | null> {
    return this.#queue(async () => {
      await this.#load(); const record = this.#records.get(id)
      if (!record || record.state !== 'asked' || !this.hasPersonAnswer(id)) return null
      const now = this.ports.now()
      const next: StoredIncident = { ...record, attempts: 0, blocked: 0, firstAt: now, lastAt: now, personRevision: this.ports.personRevision?.(),
        state: atReset ? 'waiting-reset' : 'retrying', nextAt: atReset ? record.resetsAt !== null && record.resetsAt > now
          ? afterReset(record.resetsAt) : now + BACKOFF_MS[0] : null }
      await this.#save(next); this.#arm(next)
      const settle = (stopped: boolean) => this.#queue(async () => {
        if (this.#records.get(id) !== next) return
        this.invalidateRetry(id)
        await this.#save(stopped ? { ...next, state: 'stopped', nextAt: null } : record)
      })
      return { rollback: () => settle(false), stop: () => settle(true) }
    })
  }
  releaseMove(id: string): Promise<void> {
    return this.#queue(async () => {
      const record = this.#records.get(id)
      if (record?.state === 'moved' && !record.movedTo) await this.#save({ ...record, state: 'asked', lastAt: this.ports.now(), personRevision: this.ports.personRevision?.() })
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
  invalidateRetry(id: string): void {
    if (this.#records.has(id)) this.#revision(id).revoked++
    const claim = this.#claims.get(id); if (claim) claim.active = false
    this.#timers.get(id)?.(); this.#timers.delete(id)
  }
  stop(id: string, current?: () => boolean): Promise<boolean> {
    if (current && !current()) return Promise.resolve(false)
    this.invalidateRetry(id)
    this.#timers.get(id)?.(); this.#timers.delete(id)
    return this.#queue(async () => { await this.#load(); if (current && !current()) return false; const record = this.#records.get(id); if (record) {
      this.#timers.get(id)?.(); this.#timers.delete(id); await this.#save({ ...record, state: 'stopped', nextAt: null })
      return ['waiting-reset', 'retrying', 'asked'].includes(record.state)
    }
    return false })
  }
  cancel(): void {
    this.#generation++; this.#claims.clear()
    for (const cancel of this.#timers.values()) cancel()
    this.#timers.clear()
    void this.#queue(async () => { await this.#load(); for (const record of this.#records.values()) if (this.waiting(record.chatId) || record.state === 'asked') await this.#save({ ...record, state: 'stopped', nextAt: null }) }).catch(() => {})
  }
  close(): void { this.#closed = true; this.#generation++; this.#claims.clear(); for (const cancel of this.#timers.values()) cancel(); this.#timers.clear() }
}
