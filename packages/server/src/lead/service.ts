import { LEAD_LIMITS, type LeadAcceptanceContract, type LeadPermissionPolicy, type LeadProject, type LeadControlRefusal, type LeadPresence } from '@harnessdesk/protocol'
import type { LeadAcceptanceEvidence, LeadJournal, LeadMessagesRequest, LeadMessagesResult, LeadPermissionCall, LeadResolvedTool, LeadSeatChoices, MessagesPrice, MessagesUsage, MessagesTransport, MessagesHttpResponse, LeadWithheldPiece } from '@harnessdesk/lead'
import { LEAD_MESSAGES_DEFAULTS, leadRememberLines, parseLeadMessagesBody } from '@harnessdesk/lead'
import { LeadSupervisor, chooseLeadRuntime, hostLeadRuntime, type LeadRuntime, type LeadRuntimeProber, type LeadSupervisorOptions } from '@harnessdesk/lead/supervisor'
import type { CredentialBroker } from '../credentials.js'
import type { ClientDoor } from '../client-door.js'
import type { LeadAdmission } from './admission.js'
import { leadProviderTransport } from './provider-transport.js'
import { loadLeadProjectPolicy } from './project-policy.js'
import { admitLeadCard } from './projection.js'
import { leadContainsSecret, leadMessagesContainSecret } from './secrets.js'

const publicRefusal = (wireCode: LeadControlRefusal) => Object.assign(new Error(wireCode), { wireCode })
/** The check that kept a request on this machine: its shape, its size against the body or the reservation, its model or
 * reply allowance, or credential-shaped text. A code only — the host log never carries the body. */
export type LeadRequestGuard = 'shape' | 'size' | 'model' | 'max-tokens' | 'credential'
export interface LeadRequestRefusal { readonly requestId: string; readonly guard: LeadRequestGuard; readonly bodyBytes: number; readonly reservedTokens: number | null }
/** A request the child built with parts withheld: where and how many, by kind. Like a refusal, it never carries content. */
export interface LeadRequestWithheld { readonly requestId: string; readonly bodyBytes: number; readonly reservedTokens: number; readonly withheld: readonly LeadWithheldPiece[] }
const refusedBy = (guard: LeadRequestGuard) => Object.assign(new Error('lead-provider-refused'), { leadRequestGuard: guard })

export interface LeadProcess {
  readonly live: boolean
  ensure(): Promise<void>
  send(input: LeadMessagesRequest): Promise<LeadMessagesResult>
  stop(reason?: string): Promise<void>
  ownershipWithdrawn(runId: string): void
  evidenceChanged?(): void
}
export interface LeadServiceOptions {
  /** The runtimes the child may run on, in order of preference; absent is this host's own. */
  readonly runtimes?: readonly LeadRuntime[]
  /** Test seam for the capability probe; absent is the real, cached one. */
  readonly probeRuntime?: LeadRuntimeProber
  /** Told once, the first time no runtime passes the probe, so the host can log why. */
  readonly onRuntimeUnavailable?: (reason: string) => void
  /** Told once for each request refused before it was sent: which check, the request id and the sizes, never content. */
  readonly onRequestRefused?: (refusal: LeadRequestRefusal) => void
  readonly onRequestWithheld?: (report: LeadRequestWithheld) => void
  readonly journal: LeadJournal
  readonly project: LeadProject
  readonly broker: Pick<CredentialBroker, 'leadStatus' | 'resolveLead' | 'storeLead' | 'deleteLead'>
  readonly messagesTransport?: MessagesTransport
  readonly model?: string
  /** The seats a plan's assignments may name, which the model is told. The host that composes this service
   * supplies them from its own configuration; absent means the desk offers none and the model says so. */
  readonly seats?: LeadSeatChoices
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
  /** Revoke delegated recovery immediately; desk shutdown preserves durable waits. */
  readonly onManagementStopped?: (reason: string) => void
  /** The Lead's checks between model turns, as the child reports them. */
  readonly onPresence?: (presence: LeadPresence) => void
  /** Lines a reply offered to keep: each is a memory proposal, scanned before it reaches the person's inbox. */
  readonly onRemember?: (lines: readonly string[]) => void
  /** The host's stored conversation: what each step adds, and the conversation again after a compaction. */
  readonly recordContext?: LeadSupervisorOptions['recordContext']
  readonly readContext?: LeadSupervisorOptions['readContext']
  readonly compactContext?: LeadSupervisorOptions['compactContext']
  /** Where the child failed and its code, for the host log; never content. */
  readonly onFailure?: LeadSupervisorOptions['onFailure']
}
/** The host owns this lifecycle and its only journal writer. This service never
 * stores a plaintext key: resolution is transient and host-only.
 * Lifecycle operations serialize; a long model send does not hold that queue. */
export class LeadService {
  readonly #supervisor: LeadProcess
  #publicProjection: { revision: number; generation: number; clean: true } | null = null
  #publicScans: Promise<void> = Promise.resolve()
  #enabled = false
  #requestInFlight = false
  readonly #activeTools = new Map<symbol, LeadPermissionCall['method']>()
  get activeTool(): LeadPermissionCall['method'] | null { return [...this.#activeTools.values()].at(-1) ?? null }
  get requestInFlight(): boolean { return this.#requestInFlight }
  /** Host dispatches, including accepted queued work, must observe lifecycle revocation immediately. */
  get managementAvailable(): boolean { return this.#enabled && !this.#closed && !this.#changingKeys && !this.#cleanupFailed }
  #activity(busy: boolean): void {
    const next = busy && !this.#closed
    if (this.#requestInFlight === next) return
    this.#requestInFlight = next
    if (!next) this.#activeTools.clear()
    // Activity outlives an individual send response; give its projection a fresh
    // revision without deriving liveness from durable billing reservations.
    void this.options.journal.settingsChanged().catch(() => {})
  }
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
  #runtimeReported = false
  #tail: Promise<unknown> = Promise.resolve()
  #registration: ReturnType<LeadServiceOptions['register']> | null = null
  #door: ClientDoor | null = null
  #endLive: (() => void) | null = null
  #policy: LeadPermissionPolicy | null = null
  #exiting: Promise<void> | null = null
  /** The logged failure that stopped the current child, and the last unexpected exit it led to, until a request
   * comes back, the Lead is switched off or on, or the key changes. */
  #stoppedBy: { readonly stage: string; readonly code: string } | null = null
  #lastExit: string | null = null
  constructor(private readonly options: LeadServiceOptions) {
    this.#supervisor = (options.createSupervisor ?? (settings => new LeadSupervisor(settings)))({
      ...(options.runtimes === undefined ? {} : { runtimes: options.runtimes }),
      ...(options.probeRuntime === undefined ? {} : { probeRuntime: options.probeRuntime }),
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
            project: options.project, prices: options.prices, ...(options.model === undefined ? {} : { model: options.model }), projectPolicy: this.#policy,
            ...(options.seats ? { seats: options.seats } : {}) }
        } catch (error) { await this.#release(); throw error }
      },
      onActivity: busy => this.#activity(busy),
      onToolActivity: method => {
        const key = Symbol()
        this.#activeTools.set(key, method)
        void options.journal.settingsChanged().catch(() => {})
        return () => {
          if (this.#activeTools.delete(key)) void options.journal.settingsChanged().catch(() => {})
        }
      },
      ...(options.onPresence ? { onPresence: options.onPresence } : {}),
      admitCardOffer: card => admitLeadCard(options.journal.state, card, options.project, options.model ?? LEAD_MESSAGES_DEFAULTS.model),
      // What the model says is written for the person to read, so it gets the scan every other public text gets.
      admitReply: async text => {
        await this.assertPublic(text)
        const lines = leadRememberLines(text)
        if (lines.length) options.onRemember?.(lines)
      },
      admitBudgetEvent: event => {
        if (event.type === 'reserve') {
          const model = options.model ?? LEAD_MESSAGES_DEFAULTS.model, price = options.prices[model]
          if (!Object.hasOwn(options.prices, model) || !price ||
            event.inputUsdMicrosPerMillion !== price.inputUsdMicrosPerMillion || event.outputUsdMicrosPerMillion !== price.outputUsdMicrosPerMillion ||
            event.cacheReadUsdMicrosPerMillion !== price.cacheReadUsdMicrosPerMillion || event.cacheWriteUsdMicrosPerMillion !== price.cacheWriteUsdMicrosPerMillion) throw new Error('lead-budget-price')
          if (options.journal.state.budget?.requests.some(request => request.reservation.requestId === event.requestId) ||
            options.journal.state.budget?.settled.some(item => item.id === event.requestId)) throw new Error('lead-budget-request')
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
      committedBudgetEvent: event => {
        if (event.type === 'reserve') this.#reservedHere.add(event.requestId)
        else if (event.type === 'settle' || event.type === 'write-off') this.#reservedHere.delete(event.requestId)
      },
      providerSend: async (requestId, body, signal, withheld) => {
        let admitted = false, reservedTokens: number | null = null
        const bodyBytes = Buffer.byteLength(body)
        try {
          this.#assertOpen()
          if (this.#changingKeys) throw new Error('lead-lifecycle-changed')
          const generation = this.#generation
          let payload: ReturnType<typeof parseLeadMessagesBody>
          try { payload = parseLeadMessagesBody(body) } catch { throw refusedBy('shape') }
          body = JSON.stringify(payload)
          if (Buffer.byteLength(body) > 1_048_576) throw refusedBy('size')
          const budget = options.journal.state.budget
          const request = budget?.requests.find(item => item.reservation.requestId === requestId)
          if (!request || request.uncertain || this.#providerUsage.get(requestId) === null || this.#providerFinalized.has(requestId) || budget?.settled.some(item => item.id === requestId)) throw new Error('lead-provider-failed')
          const reservation = request.reservation
          reservedTokens = reservation.inputTokens
          // Reported once, for a request this host reserved: the child sends its counts with the first send only.
          if (withheld?.length && this.#reservedHere.has(requestId)) options.onRequestWithheld?.({ requestId, bodyBytes, reservedTokens, withheld: withheld.map(({ turn, kind, count }) => ({ turn, kind, count })) })
          if (payload.model !== (options.model ?? LEAD_MESSAGES_DEFAULTS.model)) throw refusedBy('model')
          if (payload.max_tokens > reservation.maxOutputTokens) throw refusedBy('max-tokens')
          if (Buffer.byteLength(body) + 1024 > reservation.inputTokens) throw refusedBy('size')
          if (this.#providerSends.has(requestId) || this.#providerSends.size >= 2) throw new Error('lead-provider-failed')
          // Hold the slot across key resolution and transport; retries may reuse it only after settlement of this send.
          this.#providerSends.add(requestId); admitted = true
          const key = await options.broker.resolveLead('anthropic')
          this.#assertOpen()
          if (generation !== this.#generation || this.#changingKeys) throw new Error('lead-lifecycle-changed')
          if (signal.aborted) throw new Error('lead-provider-failed')
          if (leadMessagesContainSecret(payload, key)) throw refusedBy('credential')
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
        } catch (error) {
          // Refused by name and never handed to the transport: the child settles it at zero rather than writing it off.
          const guard = (error as { leadRequestGuard?: LeadRequestGuard }).leadRequestGuard
          const open = options.journal.state.budget?.requests.some(item => item.reservation.requestId === requestId && !item.uncertain)
          if (guard && open && this.#reservedHere.has(requestId) && !this.#providerFinalized.has(requestId) && this.#providerUsage.get(requestId) !== null) {
            options.onRequestRefused?.({ requestId: /^[A-Za-z0-9._:/-]{1,100}$/.test(requestId) ? requestId : 'invalid', guard, bodyBytes, reservedTokens })
            throw Object.assign(new Error('lead-provider-refused'), { leadRequestRefused: guard })
          }
          throw new Error('lead-provider-failed')
        }
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
      ...(options.recordContext ? { recordContext: async record => { this.#assertOpen(); await options.recordContext!(record) } } : {}),
      ...(options.readContext ? { readContext: async (epoch, room) => { this.#assertOpen(); return options.readContext!(epoch, room) } } : {}),
      ...(options.compactContext ? { compactContext: async trigger => { this.#assertOpen(); return options.compactContext!(trigger) } } : {}),
      onStarted: () => { this.#endLive = options.childStarted() },
      onExit: reason => this.#exited(reason),
      onFailure: failure => {
        // A failure the child caught and carried on from is only logged; one that stopped the child also keys its exit.
        if (failure.stopped) this.#stoppedBy = { stage: failure.stage, code: failure.code }
        try { options.onFailure?.(failure) } catch { /* A log never owns the lifecycle. */ }
      },
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
    if (['stopped', 'accepted', 'declined', 'following'].includes(journal.state.phase)) return
    if (reason === 'lead-host-shutdown' && journal.state.handbacks.some(op => op.stage === 'prepared' || op.stage === 'running' || op.stage === 'awaiting-ci')) return
    // A desk closing under a Lead that was already waiting for the person interrupted nothing: the person's wait stands.
    if (reason === 'lead-host-shutdown' && journal.state.phase === 'waiting-for-user') return
    await journal.setManagementPhase('waiting-for-user', reason)
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
      this.#reservedHere.delete(requestId)
    }
  }
  async #release(): Promise<void> {
    this.#endLive?.(); this.#endLive = null
    const door = this.#door; this.#door = null
    try { await door?.close() }
    finally { this.#registration?.close(); this.#registration = null }
  }
  #exited(reason: string): Promise<void> {
    this.#activity(false)
    if (this.#exiting) return this.#exiting
    // Called only after the child has fully exited and its pending dispatches
    // have rejected. Recovery never races a live dispatch from that child.
    // Taken on every exit, so a failure never attaches to a later exit it did not cause.
    const stoppedBy = this.#stoppedBy; this.#stoppedBy = null
    const task = (async () => {
      try {
        try { await this.#latch(['lead-disabled', 'lead-key-changed', 'lead-host-shutdown', 'lead-send-deadline'].includes(reason) ? this.#expectedExit(reason) : this.#unexpectedExit(reason, stoppedBy)) }
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
  #expectedExit(reason: string): string { this.#lastExit = null; return reason }
  /**
   * An exit nobody asked for. The same exit after the same logged failure, with no request come back between, is
   * `lead-child-exited-again`: Resume would only start a child that stops at the same step, so the person is told the
   * desk log names it instead of being offered Resume once more (#2085). An exit with no logged failure (the process
   * was killed, the desk went away, startup timed out) is never called a repeat: nothing in the log would name it.
   */
  #unexpectedExit(reason: string, failure: { readonly stage: string; readonly code: string } | null): 'lead-child-exited' | 'lead-child-exited-again' {
    const key = failure ? [reason, failure.stage, failure.code].join('\u0000') : null
    const again = key !== null && this.#lastExit === key
    this.#lastExit = key
    return again ? 'lead-child-exited-again' : 'lead-child-exited'
  }
  async #halt(reason: string, finishExitedRecovery = false): Promise<void> {
    this.options.onManagementStopped?.(reason)
    this.#activity(false)
    try { await this.#latch(reason) }
    catch (error) { this.#cleanupFailed = true; throw error }
    finally {
      // A broken journal must never keep the key-bearing pid alive.
      try { await this.#supervisor.stop(reason) }
      catch (error) {
        this.#cleanupFailed = true
        // The process deadline also covers onExit's host recovery. Once the
        // child has exited, finish that same recovery before replacing its goal.
        // Capture it before release can finish and clear the exit promise.
        if (!(finishExitedRecovery && error instanceof Error && error.message === 'lead-child-shutdown-timeout' && !this.#supervisor.live && this.#exiting)) throw error
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([this.#exiting, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('lead-exit-recovery-pending')), 30_000)
          })])
        } finally { if (timer) clearTimeout(timer) }
      }
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
  /** Why no runtime can run the child, or null when one can. The probe behind it is cached. */
  async #runtimeUnavailable(): Promise<string | null> {
    const choice = await chooseLeadRuntime(this.options.runtimes ?? [hostLeadRuntime()], this.options.probeRuntime)
    if (choice.runtime) return null
    if (!this.#runtimeReported) { this.#runtimeReported = true; this.options.onRuntimeUnavailable?.(choice.reason) }
    return choice.reason
  }
  async status(provider: 'anthropic') {
    // Disabled owners can serve window reads and receipts without a child.
    const status = await this.options.broker.leadStatus(provider)
    const reason = this.#enabled ? await this.#runtimeUnavailable() : null
    return { ...status, ...(reason === null ? {} : { unavailable: 'runtime' as const, unavailableReason: reason.slice(0, LEAD_LIMITS.unavailableReasonChars) }) }
  }
  setEnabled(enabled: boolean): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('lead-closed'))
    this.#enabled = enabled; this.#lastExit = null
    if (!enabled) this.options.onManagementStopped?.('lead-disabled')
    const generation = ++this.#generation
    return this.#queue(async () => {
      if (!enabled) {
        await this.#halt('lead-disabled')
      } else if (generation !== this.#generation) return
    })
  }
  async send(input: LeadMessagesRequest): Promise<LeadMessagesResult> {
    this.#assertOpen()
    if (await this.#runtimeUnavailable() !== null) throw publicRefusal('lead-runtime-unsupported')
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
    const result = await this.#supervisor.send(input)
    // Any result that came back, failed or refused included, proves the child ran: the count of repeated exits starts over.
    this.#lastExit = null
    return result
  }
  #changeKey(provider: 'anthropic', write: () => Promise<unknown>, deleting = false): Promise<void> {
    if (provider !== 'anthropic') return Promise.reject(new Error('lead-provider-unsupported'))
    if (this.#closed) return Promise.reject(new Error('lead-closed'))
    this.#publicProjection = null; this.#lastExit = null
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
      if (leadContainsSecret([state.messages, state.decisionMessages, state.cards.filter(card => !state.decidedCards.includes(`${card.id}:${card.revision}`))], key))
        throw publicRefusal('lead-secret-in-thread')
    }
    try { check() } catch (error) { return Promise.reject(error) }
    return this.#changeKey(provider, async () => { check(); await this.options.broker.storeLead(provider, key) })
  }
  deleteKey(provider: 'anthropic'): Promise<void> { return this.#changeKey(provider, () => this.options.broker.deleteLead(provider), true) }
  /** A host that ended without its shutdown (a crash, a force quit) left the goal running with no process to watch it:
   * the person is shown it stopped, with Resume, as after a clean quit. */
  recoverInterrupted(): Promise<void> {
    return this.#queue(async () => {
      const phase = this.options.journal.state.phase
      if (!this.#closed && !this.#supervisor.live && (phase === 'running' || phase === 'planning')) await this.#latch('lead-host-shutdown')
    })
  }
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
  /** A check or other evidence landed on a Team this goal owns; no desk event carries it to the loop. */
  evidenceChanged(): void { this.#supervisor.evidenceChanged?.() }
  /** Stop the model process too, so no old reply or dispatch can reach a new goal. */
  stopGoal(): Promise<void> {
    ++this.#generation
    return this.#queue(async () => { await this.#halt('lead-request-cancelled', true); await this.#recoverRequests() }).then(() => this.recover())
  }
  close(): Promise<void> {
    if (this.#closed) return this.#tail.then(() => {})
    this.options.onManagementStopped?.('lead-host-shutdown')
    this.#publicProjection = null; this.#closed = true; this.#activity(false); this.#enabled = false; ++this.#generation
    return this.#queue(async () => {
      await this.#halt('lead-host-shutdown')
    })
  }
}
