import type { LeadAcceptanceContract, LeadPermissionPolicy, LeadProject } from '@harnessdesk/protocol'
import type { LeadAcceptanceEvidence, LeadJournal, LeadMessagesRequest, LeadMessagesResult, LeadPermissionCall, LeadResolvedTool, MessagesPrice } from '@harnessdesk/lead'
import { LeadSupervisor, type LeadSupervisorOptions } from '@harnessdesk/lead/supervisor'
import type { CredentialBroker } from '../credentials.js'
import type { ClientDoor } from '../client-door.js'
import type { LeadAdmission } from './admission.js'
import { loadLeadProjectPolicy } from './project-policy.js'

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
 * stores a plaintext key: resolution is transient, just before private stdin.
 * Lifecycle operations serialize; a long model send does not hold that queue. */
export class LeadService {
  readonly #supervisor: LeadProcess
  #enabled = false
  #closed = false
  #generation = 0
  #changingKeys = 0
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
        try { await this.#latch(['lead-disabled', 'lead-key-changed', 'lead-host-shutdown'].includes(reason) ? reason : 'lead-child-exited') }
        finally { await this.options.stopOwned(reason) }
        this.#endLive?.(); this.#endLive = null
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
  #changeKey(provider: 'anthropic', write: () => Promise<unknown>): Promise<void> {
    if (provider !== 'anthropic') return Promise.reject(new Error('lead-provider-unsupported'))
    if (this.#closed) return Promise.reject(new Error('lead-closed'))
    ++this.#generation; ++this.#changingKeys
    return this.#queue(async () => {
      try { await this.#halt('lead-key-changed'); await write() }
      finally { --this.#changingKeys }
    })
  }
  setKey(provider: 'anthropic', key: string): Promise<void> { return this.#changeKey(provider, () => this.options.broker.storeLead(provider, key)) }
  deleteKey(provider: 'anthropic'): Promise<void> { return this.#changeKey(provider, () => this.options.broker.deleteLead(provider)) }
  async recover(): Promise<void> {
    if (this.#supervisor.live) throw new Error('lead-child-live')
    await this.#queue(async () => {
      if (this.#supervisor.live) throw new Error('lead-child-live')
      const temporary = this.#registration === null ? this.options.register() : null
      try {
        if (this.#cleanupFailed) { await this.#latch('lead-child-exited'); await this.options.stopOwned('lead-child-exited') }
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
    this.#closed = true; this.#enabled = false; ++this.#generation
    return this.#queue(async () => {
      await this.#halt('lead-host-shutdown')
    })
  }
}
