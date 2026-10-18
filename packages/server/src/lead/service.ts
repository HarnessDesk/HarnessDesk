import type { LeadAcceptanceContract, LeadPermissionPolicy, LeadProject, LeadControlRefusal } from '@harnessdesk/protocol'
import type { LeadAcceptanceEvidence, LeadJournal, LeadMessagesRequest, LeadMessagesResult, LeadPermissionCall, LeadResolvedTool, MessagesPrice, MessagesUsage, MessagesTransport, MessagesHttpResponse } from '@harnessdesk/lead'
import { LEAD_MESSAGES_DEFAULTS, parseLeadMessagesBody } from '@harnessdesk/lead'
import { LeadSupervisor, type LeadSupervisorOptions } from '@harnessdesk/lead/supervisor'
import type { CredentialBroker } from '../credentials.js'
import type { ClientDoor } from '../client-door.js'
import type { LeadAdmission } from './admission.js'
import { leadProviderTransport } from './provider-transport.js'
import { loadLeadProjectPolicy } from './project-policy.js'
import { admitLeadCard } from './projection.js'
import { leadContainsSecret } from './secrets.js'

const publicRefusal = (wireCode: LeadControlRefusal) => Object.assign(new Error(wireCode), { wireCode })

export interface LeadProcess {
  readonly live: boolean
  ensure(): Promise<void>
  send(input: LeadMessagesRequest): Promise<LeadMessagesResult>
  stop(reason?: string): Promise<void>
  ownershipWithdrawn(runId: string): void
}
export interface LeadServiceOptions {
  readonly journal: LeadJournal
  readonly project: LeadProject
  readonly broker: Pick<CredentialBroker, 'leadStatus' | 'resolveLead' | 'storeLead' | 'deleteLead'>
  readonly messagesTransport?: MessagesTransport
  readonly model?: string
  readonly prices: Readonly<Record<string, MessagesPrice>>
  readonly resolveTool: (call: LeadPermissionCall) => Promise<LeadResolvedTool>
  readonly freezePlan: (proposal: LeadAcceptanceContract) => Promise<LeadAcceptanceContract>
  readonly readEvidence: (runId: string, read: (call: LeadPermissionCall) => Promise<unknown>) => Promise<LeadAcceptanceEvidence>
  readonly register: () => { readonly admission: LeadAdmission; close(): void }
  readonly childStarted: () => () => void
  readonly recover: () => Promise<void>
  readonly openDoor: (admission: LeadAdmission) => Promise<ClientDoor | null>
  readonly stopOwned: (reason: string) => Promise<void>
  readonly createSupervisor?: (options: LeadSupervisorOptions) => LeadProcess
}
/** The host owns this lifecycle and its only journal writer. This service never
 * stores a plaintext key: resolution is transient and host-only.
 * Lifecycle operations serialize; a long model send does not hold that queue. */
export class LeadService {
  readonly #supervisor: LeadProcess
  #publicProjection: { revision: number; generation: number; clean: true } | null = null
  #publicScans: Promise<void> = Promise.resolve()
  #enabled = false
  #closed = false
  #generation = 0
  #changingKeys = 0
  readonly #providerSends = new Set<string>()
  readonly #reservedHere = new Set<string>()
  // Final admission is synchronous; the journal's durable settlement may still
  // be queued when the next child frame arrives. Request ids cannot be reused.
  readonly #providerFinalized = new Set<string>()
  // Absent means no send in this lifetime; null means unproven billing. Never erase
  // ambiguity with a later retry's usage or an unprocessed response.
  readonly #providerUsage = new Map<string, MessagesUsage | null>()
  #cleanupFailed = false
  #tail: Promise<unknown> = Promise.resolve()
  #registration: ReturnType<LeadServiceOptions['register']> | null = null
  #door: ClientDoor | null = null
  #endLive: (() => void) | null = null
  #policy: LeadPermissionPolicy | null = null
  #exiting: Promise<void> | null = null
  constructor(private readonly options: LeadServiceOptions) {
    this.#supervisor = (options.createSupervisor ?? (settings => new LeadSupervisor(settings)))({
      journal: options.journal,
      bootstrap: async (signal?: AbortSignal) => {
        this.#assertOpen()
        const checkStartup = () => { if (signal?.aborted) throw new Error('lead-start-cancelled') }
        checkStartup()
        const generation = this.#generation
        const desk = options.journal.state.policy
        if (!desk) throw new Error('lead-policy-unavailable')
        this.#policy = await loadLeadProjectPolicy(options.project.path, desk)
        checkStartup()
        this.#registration = options.register()
        try {
          await this.#recoverRequests()
          await options.recover()
          checkStartup()
          this.#door = await options.openDoor(this.#registration.admission)
          if (!this.#door) throw new Error('lead-client-unavailable')
          const key = await options.broker.resolveLead('anthropic')
          checkStartup()
          this.#assertOpen()
          if (generation !== this.#generation) throw new Error('lead-lifecycle-changed')
          return { key, descriptor: this.#door.descriptor,
            project: options.project, prices: options.prices, ...(options.model === undefined ? {} : { model: options.model }), projectPolicy: this.#policy }
        } catch (error) { await this.#release(); throw error }
      },
      admitCardOffer: card => admitLeadCard(options.journal.state, card, options.project, options.model ?? LEAD_MESSAGES_DEFAULTS.model),
      admitBudgetEvent: event => {
        if (event.type === 'reserve') {
          const model = options.model ?? LEAD_MESSAGES_DEFAULTS.model, price = options.prices[model]
          if (!Object.hasOwn(options.prices, model) || !price ||
            event.inputUsdMicrosPerMillion !== price.inputUsdMicrosPerMillion || event.outputUsdMicrosPerMillion !== price.outputUsdMicrosPerMillion ||
            event.cacheReadUsdMicrosPerMillion !== price.cacheReadUsdMicrosPerMillion || event.cacheWriteUsdMicrosPerMillion !== price.cacheWriteUsdMicrosPerMillion) throw new Error('lead-budget-price')
          if (options.journal.state.budget?.requests.some(request => request.reservation.requestId === event.requestId) ||
            options.journal.state.budget?.settled.some(item => item.id === event.requestId)) throw new Error('lead-budget-request')
          this.#reservedHere.add(event.requestId)
        } else if (event.type === 'settle') {
          const recorded = this.#providerUsage.get(event.requestId)
          if (!this.#reservedHere.has(event.requestId) || options.journal.state.budget?.requests.some(request => request.reservation.requestId === event.requestId && request.uncertain) ||
            this.#providerSends.has(event.requestId) || recorded === null ||
            event.inputTokens !== (recorded?.inputTokens ?? 0) || event.outputTokens !== (recorded?.outputTokens ?? 0) ||
            (event.cacheReadTokens ?? 0) !== (recorded?.cacheReadTokens ?? 0) || (event.cacheWriteTokens ?? 0) !== (recorded?.cacheWriteTokens ?? 0)) throw new Error('lead-budget-usage')
          this.#providerFinalized.add(event.requestId)
          this.#providerUsage.delete(event.requestId)
        } else if (event.type === 'write-off') {
          this.#providerFinalized.add(event.requestId)
          this.#providerUsage.delete(event.requestId)
        }
      },
      providerSend: async (requestId, body, signal) => {
        let admitted = false
        try {
          this.#assertOpen()
          if (this.#changingKeys) throw new Error('lead-lifecycle-changed')
          const generation = this.#generation
          const payload = parseLeadMessagesBody(body)
          body = JSON.stringify(payload)
          if (Buffer.byteLength(body) > 1_048_576) throw new Error('lead-provider-failed')
          const budget = options.journal.state.budget
          const request = budget?.requests.find(item => item.reservation.requestId === requestId)
          if (!request || request.uncertain || this.#providerFinalized.has(requestId) || budget?.settled.some(item => item.id === requestId)) throw new Error('lead-provider-failed')
          const reservation = request.reservation
          if (payload.model !== (options.model ?? LEAD_MESSAGES_DEFAULTS.model) ||
            payload.max_tokens > reservation.maxOutputTokens || Buffer.byteLength(body) + 1024 > reservation.inputTokens ||
            this.#providerSends.has(requestId) || this.#providerSends.size >= 2) throw new Error('lead-provider-failed')
          // Hold the slot across key resolution and transport; retries may reuse it only after settlement of this send.
          this.#providerSends.add(requestId); admitted = true
          const key = await options.broker.resolveLead('anthropic')
          this.#assertOpen()
          if (generation !== this.#generation || this.#changingKeys) throw new Error('lead-lifecycle-changed')
          if (signal.aborted) throw new Error('lead-provider-failed')
          const previousUsage = this.#providerUsage.get(requestId)
          this.#providerUsage.set(requestId, null)
          const response = await (options.messagesTransport ?? leadProviderTransport).send({
            requestId, origin: 'https://api.anthropic.com', path: '/v1/messages', method: 'POST', body,
            headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key },
            maxResponseBytes: 1_048_576, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          })
          if (typeof response.body !== 'string' || Buffer.byteLength(response.body) > 1_048_576 ||
            !Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599 ||
            response.retryAfter !== undefined && (typeof response.retryAfter !== 'string' || response.retryAfter.length > 128) ||
            response.processing !== undefined && !['unknown', 'not-started'].includes(response.processing)) throw new Error('lead-provider-failed')
          const result: MessagesHttpResponse = { status: response.status, body: response.body,
            ...(response.retryAfter === undefined ? {} : { retryAfter: response.retryAfter }),
            ...(response.processing === undefined ? {} : { processing: response.processing }) }
          const scan = (value: unknown): void => {
            if (typeof value === 'string' && value.includes(key)) throw new Error('lead-provider-failed')
            if (value !== null && typeof value === 'object') for (const [name, child] of Object.entries(value)) { scan(name); scan(child) }
          }
          scan(result)
          let decoded: unknown
          try { decoded = JSON.parse(response.body) } catch { /* Non-JSON errors still pass the literal scan. */ }
          scan(decoded)
          if (this.#providerFinalized.has(requestId)) return result
          if (response.status >= 200 && response.status < 300) {
            const rawUsage = decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)
              ? (decoded as Record<string, unknown>).usage : null
            const usage = rawUsage !== null && typeof rawUsage === 'object' && !Array.isArray(rawUsage) ? rawUsage as Record<string, unknown> : null
            const count = (name: string, optional = false): number => {
              const value = usage?.[name] ?? (optional && usage?.[name] === undefined ? 0 : NaN)
              if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100_000_000) throw new Error('lead-provider-failed')
              return value
            }
            const used: MessagesUsage = { inputTokens: count('input_tokens'), outputTokens: count('output_tokens'),
              cacheReadTokens: count('cache_read_input_tokens', true), cacheWriteTokens: count('cache_creation_input_tokens', true) }
            if (previousUsage !== null) this.#providerUsage.set(requestId, {
              inputTokens: (previousUsage?.inputTokens ?? 0) + used.inputTokens, outputTokens: (previousUsage?.outputTokens ?? 0) + used.outputTokens,
              cacheReadTokens: (previousUsage?.cacheReadTokens ?? 0) + used.cacheReadTokens, cacheWriteTokens: (previousUsage?.cacheWriteTokens ?? 0) + used.cacheWriteTokens,
            })
          } else if (response.processing === 'not-started') {
            if (previousUsage === undefined) this.#providerUsage.delete(requestId)
            else this.#providerUsage.set(requestId, previousUsage)
          }
          return result
        } catch { throw new Error('lead-provider-failed') }
        finally { if (admitted) this.#providerSends.delete(requestId) }
      },
      resolveTool: async call => {
        this.#assertOpen()
        if (this.#changingKeys) throw new Error('lead-lifecycle-changed')
        const generation = this.#generation
        // Re-read repository restrictions on each operation. Neither a child
        // claim nor an on-disk widening can manufacture management authority.
        const desk = options.journal.state.policy
        if (!desk) throw new Error('lead-policy-unavailable')
        this.#policy = await loadLeadProjectPolicy(options.project.path, desk)
        const resolved = await options.resolveTool(call)
        this.#assertOpen()
        if (generation !== this.#generation || this.#changingKeys) throw new Error('lead-lifecycle-changed')
        return { ...resolved, project: options.project,
          context: { ...resolved.context, desk, project: options.project, projectPolicy: this.#policy } }
      },
      freezePlan: options.freezePlan, readEvidence: options.readEvidence,
      onStarted: () => { this.#endLive = options.childStarted() },
      onExit: reason => this.#exited(reason),
    })
  }
  #queue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(task)
    this.#tail = next.catch(() => {})
    return next
  }
  #assertOpen(): void {
    if (this.#closed) throw new Error('lead-closed')
    if (!this.#enabled) throw new Error('lead-disabled')
    if (this.#cleanupFailed) throw new Error('lead-cleanup-pending')
  }
  async #latch(reason: string): Promise<void> {
    const { journal } = this.options
    if (!['stopped', 'accepted', 'declined'].includes(journal.state.phase)) await journal.setManagementPhase('waiting-for-user', reason)
  }
  /** No child remains to settle these requests. Provider-observed usage wins;
   * interrupted or inherited requests consume their entire durable reservation. */
  async #recoverRequests(): Promise<void> {
    for (const request of this.options.journal.state.budget?.requests ?? []) {
      const requestId = request.reservation.requestId, usage = this.#providerUsage.get(requestId)
      this.#providerFinalized.add(requestId)
      if (usage) await this.options.journal.updateBudget({ version: 1, type: 'settle', now: this.options.journal.state.budget!.now, requestId, ...usage })
      else {
        if (!request.uncertain) await this.options.journal.updateBudget({ version: 1, type: 'uncertain', now: this.options.journal.state.budget!.now, requestId })
        await this.options.journal.updateBudget({ version: 1, type: 'write-off', now: this.options.journal.state.budget!.now, requestId })
      }
      this.#providerUsage.delete(requestId)
    }
  }
  async #release(): Promise<void> {
    this.#endLive?.(); this.#endLive = null
    const door = this.#door; this.#door = null
    try { await door?.close() }
    finally { this.#registration?.close(); this.#registration = null }
  }
  #exited(reason: string): Promise<void> {
    if (this.#exiting) return this.#exiting
    // Called only after the child has fully exited and its pending dispatches
    // have rejected. Recovery never races a live dispatch from that child.
    const task = (async () => {
      try {
        try { await this.#latch(['lead-disabled', 'lead-key-changed', 'lead-host-shutdown', 'lead-send-deadline'].includes(reason) ? reason : 'lead-child-exited') }
        finally { await this.options.stopOwned(reason) }
        this.#endLive?.(); this.#endLive = null
        await this.#recoverRequests()
        await this.options.recover()
      } catch (error) { this.#cleanupFailed = true; throw error }
      finally { await this.#release() }
    })()
    this.#exiting = task
    void task.finally(() => { if (this.#exiting === task) this.#exiting = null }).catch(() => {})
    return task
  }
  async #halt(reason: string): Promise<void> {
    try { await this.#latch(reason) }
    catch (error) { this.#cleanupFailed = true; throw error }
    finally {
      // A broken journal must never keep the key-bearing pid alive.
      try { await this.#supervisor.stop(reason) }
      catch (error) { this.#cleanupFailed = true; throw error }
      finally { await this.#release() }
    }
  }
  /** Only host-built projections opt into revision caching. Other inputs always scan.
   * The queue resolves to void; only a clean boolean survives, never a key or broker promise. */
  assertPublic(value: unknown, projectionRevision?: number): Promise<void> {
    const scan = async (): Promise<void> => {
      const revision = this.options.journal.state.seq, generation = this.#generation
      const projection = projectionRevision === revision
      if (projection && this.#publicProjection?.revision === revision && this.#publicProjection.generation === generation) return
      let key: string | null
      try {
        key = (await this.options.broker.leadStatus('anthropic')).configured ? await this.options.broker.resolveLead('anthropic') : null
      } catch { throw publicRefusal('lead-protection-unavailable') }
      if (generation !== this.#generation) return scan()
      if (key && leadContainsSecret(value, key)) throw publicRefusal('lead-secret-refused')
      if (projection && revision === this.options.journal.state.seq) this.#publicProjection = { revision, generation, clean: true }
    }
    const next = this.#publicScans.then(scan)
    this.#publicScans = next.catch(() => {})
    return next
  }
  status(provider: 'anthropic') { return this.options.broker.leadStatus(provider) }
  setEnabled(enabled: boolean): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('lead-closed'))
    this.#enabled = enabled
    const generation = ++this.#generation
    return this.#queue(async () => {
      if (!enabled) {
        await this.#halt('lead-disabled')
      } else if (generation !== this.#generation) return
    })
  }
  async send(input: LeadMessagesRequest): Promise<LeadMessagesResult> {
    this.#assertOpen()
    const generation = this.#generation
    await this.#queue(async () => {
      this.#assertOpen()
      if (generation !== this.#generation) throw new Error('lead-lifecycle-changed')
      if (this.#exiting) await this.#exiting
      try { await this.#supervisor.ensure() }
      catch (error) {
        ++this.#generation
        try { await this.#supervisor.stop('startup-failed') }
        catch { this.#cleanupFailed = true }
        finally { await this.#release() }
        throw error
      }
    })
    this.#assertOpen()
    if (generation !== this.#generation) throw new Error('lead-lifecycle-changed')
    return this.#supervisor.send(input)
  }
  #changeKey(provider: 'anthropic', write: () => Promise<unknown>, deleting = false): Promise<void> {
    if (provider !== 'anthropic') return Promise.reject(new Error('lead-provider-unsupported'))
    if (this.#closed) return Promise.reject(new Error('lead-closed'))
    this.#publicProjection = null
    ++this.#generation; ++this.#changingKeys
    return this.#queue(async () => {
      try {
        try { await this.#halt('lead-key-changed') }
        catch (error) {
          try { if (deleting && !this.#supervisor.live) await write() }
          finally { throw error }
        }
        await write()
      }
      finally { --this.#changingKeys }
    })
  }
  setKey(provider: 'anthropic', key: string): Promise<void> {
    const check = () => {
      const state = this.options.journal.state
      if (leadContainsSecret([state.messages, state.cards.filter(card => !state.decidedCards.includes(`${card.id}:${card.revision}`))], key))
        throw publicRefusal('lead-secret-in-thread')
    }
    try { check() } catch (error) { return Promise.reject(error) }
    return this.#changeKey(provider, async () => { check(); await this.options.broker.storeLead(provider, key) })
  }
  deleteKey(provider: 'anthropic'): Promise<void> { return this.#changeKey(provider, () => this.options.broker.deleteLead(provider), true) }
  async recover(): Promise<void> {
    if (this.#supervisor.live) throw new Error('lead-child-live')
    await this.#queue(async () => {
      if (this.#supervisor.live) throw new Error('lead-child-live')
      if (this.#exiting) await this.#exiting.catch(() => {})
      const temporary = this.#registration === null ? this.options.register() : null
      try {
        if (this.#cleanupFailed) { await this.#latch('lead-child-exited'); await this.options.stopOwned('lead-child-exited') }
        await this.#recoverRequests()
        await this.options.recover()
        this.#cleanupFailed = false
      } finally { temporary?.close() }
    })
  }
  async ownershipWithdrawn(runId: string): Promise<void> {
    ++this.#generation
    this.#supervisor.ownershipWithdrawn(runId)
    try { await this.#latch('lead-ownership-withdrawn') }
    finally { await this.options.stopOwned('lead-ownership-withdrawn').catch(error => { this.#cleanupFailed = true; throw error }) }
  }
  close(): Promise<void> {
    if (this.#closed) return this.#tail.then(() => {})
    this.#publicProjection = null; this.#closed = true; this.#enabled = false; ++this.#generation
    return this.#queue(async () => {
      await this.#halt('lead-host-shutdown')
    })
  }
}
