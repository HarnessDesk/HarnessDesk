import {
  LEAD_CONTROL_REFUSALS, LEAD_LIMITS, parseLeadCardDecisionFor, parseLeadWindowProjection, parseLeadSettingsProjection, parseLeadSettingsUpdate,
  parseLeadThreadSend, parseLeadResume, windowLeadThread,
  type LeadAcceptanceContract, type LeadCard, type LeadCardDecision, type LeadWindowProjection, type LeadControlRefusal, type LeadProject,
  type LeadSettingsProjection, type LeadSettingsUpdate, type LeadThreadSend, type WireNotification,
} from '@harnessdesk/protocol'
import type { LeadJournal } from '@harnessdesk/lead'
import type { LeadService } from './service.js'

export const leadRefusal = (wireCode: LeadControlRefusal): Error & { wireCode: LeadControlRefusal } => Object.assign(new Error(wireCode), { wireCode })
interface LeadControlsOptions {
  readonly journal: LeadJournal
  readonly service: Pick<LeadService, 'status' | 'setKey' | 'deleteKey' | 'send' | 'assertPublic'>
  readonly project: LeadProject
  readonly model: string
  readonly now: () => number
  readonly nextId: () => string
  readonly push: (notification: WireNotification) => void
  /** Host revalidates the live Flow, card and evidence on the journal's decision queue. */
  readonly decidePerson: (card: Extract<LeadCard, { type: 'waiting' }>, decision: LeadCardDecision, contract: LeadAcceptanceContract) => Promise<void>
  readonly decideResult: (card: Extract<LeadCard, { type: 'result' }>, decision: LeadCardDecision, contract: LeadAcceptanceContract) => Promise<void>
  readonly stopEffects?: () => Promise<void>
}
/** One host owner, no transport or rendering. Child ports never contain these operations. */
export class LeadControls {
  #tail: Promise<unknown> = Promise.resolve()
  #notifications: Promise<void> = Promise.resolve()
  #notificationFailure: unknown = null
  #lastRevision = -1
  readonly #detach: () => void
  constructor(private readonly options: LeadControlsOptions) {
    this.#detach = options.journal.onChange(() => {
      this.#notifications = this.#notifications.then(async () => {
        const projection = await this.#projection()
        if (projection.revision <= this.#lastRevision) return
        this.#lastRevision = projection.revision
        options.push({ method: 'lead/changed', params: projection })
      }).catch(error => { this.#notificationFailure = error })
    })
  }
  close(): void { this.#detach() }
  async idle(): Promise<void> { await this.#tail; await this.#notifications; if (this.#notificationFailure) throw this.#notificationFailure }
  #queue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation).catch(error => {
      // Provider, cipher and validation errors may contain user input. Only closed codes leave this owner.
      const code = (error as { wireCode?: unknown })?.wireCode
      if (typeof code === 'string' && (LEAD_CONTROL_REFUSALS as readonly string[]).includes(code)) throw leadRefusal(code as LeadControlRefusal)
      throw leadRefusal('lead-operation-refused')
    })
    this.#tail = next.catch(() => {})
    return next
  }
  #expectRevision(revision: number): void {
    if (revision !== this.options.journal.state.seq) throw leadRefusal('lead-revision-stale')
  }
  async #settings(): Promise<LeadSettingsProjection> {
    const { policy, budget } = this.options.journal.state
    if (!policy || !budget) throw leadRefusal('lead-unavailable')
    const key = await this.options.service.status('anthropic')
    return parseLeadSettingsProjection({ version: 1, model: this.options.model,
      key: { configured: key.configured, protection: key.protection === 'file permissions only' ? 'unavailable' : 'encrypted' }, policy, caps: budget.caps })
  }
  async #projection(): Promise<LeadWindowProjection> {
    const settings = await this.#settings(), state = this.options.journal.state
    // Settings reads may yield to a journal write. Retry from one coherent revision.
    if (settings.policy.revision !== state.policy?.revision || JSON.stringify(settings.caps) !== JSON.stringify(state.budget?.caps)) return this.#projection()
    const overhead = new TextEncoder().encode(JSON.stringify({ version: 1, revision: state.seq, settings, thread: null })).byteLength + 128
    const thread = windowLeadThread({ version: 1, id: 'lead', revision: state.seq, state: state.phase, project: this.options.project,
      olderMessages: state.olderMessages, messages: state.messages,
      cards: state.cards.filter(card => !state.decidedCards.includes(`${card.id}:${card.revision}`)) }, LEAD_LIMITS.ipcBytes - overhead)
    const wayOut = !['stopped', 'accepted', 'declined'].includes(state.phase) && !state.budget?.stop && !state.recoveryBlocked
      ? thread.cards.some(card => card.type === 'plan') ? 'decide-plan' : state.phase === 'waiting-for-user' ? 'resume' : null : null
    const result = parseLeadWindowProjection({ version: 1, revision: state.seq, thread, settings, wayOut })
    try { await this.options.service.assertPublic(result) } catch { throw leadRefusal('lead-secret-refused') }
    return result
  }
  readThread(): Promise<LeadWindowProjection> { return this.#queue(() => this.#projection()) }
  readSettings(): Promise<LeadWindowProjection> { return this.#queue(() => this.#projection()) }
  send(value: LeadThreadSend) { return this.#queue(async () => {
    const input = parseLeadThreadSend(value), { journal, service } = this.options
    const previous = journal.state.sends.find(send => send.key === input.idempotencyKey)
    if (previous) return { messageId: previous.messageId, revision: previous.revision }
    try { await service.assertPublic(input) } catch { throw leadRefusal('lead-secret-refused') }
    const receipt = await journal.appendMessage(input.idempotencyKey, input.text)
    // Admission is durable before a paid request; a retry never resends even after a lost response.
    await this.#continue()
    return receipt
  }) }
  async #continue(): Promise<void> {
    const { journal, service } = this.options
    try {
      const messages = journal.state.messages.filter(message => message.role !== 'system').map(message => ({
        role: message.role as 'user' | 'assistant', content: [{ type: 'text' as const, text: message.text }],
      }))
      const result = await service.send({ maxTokens: 4096, messages: messages.length ? messages : [
        { role: 'user', content: [{ type: 'text', text: 'Continue from the approved contract and fresh desk observations.' }] },
      ] })
      if (result.text) { await service.assertPublic(result.text); await journal.appendReply(result.text) }
    } catch {
      if (!['accepted', 'declined', 'stopped'].includes(journal.state.phase)) await journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
    }
  }
  decide(decision: LeadCardDecision): Promise<LeadWindowProjection> { return this.#queue(async () => {
    const { journal } = this.options, state = journal.state
    const card = state.cards.find(card => card.id === decision.cardId)
    if (!card) throw leadRefusal('lead-card-stale')
    if (card.type === 'waiting' && card.kind === 'worker-approval') throw leadRefusal('lead-worker-approval')
    if (state.decidedCards.includes(`${card.id}:${card.revision}`)) throw leadRefusal('lead-card-decided')
    try { parseLeadCardDecisionFor(decision, card) } catch { throw leadRefusal('lead-card-stale') }
    if (card.type !== 'plan' && card.contractDigest !== (state.contract?.digest ?? null)) throw leadRefusal('lead-card-stale')
    await journal.decideCard(decision, card.type === 'plan' && decision.choice === 'approve' ? this.options.now() + 86_400_000 : null,
      this.options.stopEffects, card.type === 'waiting' || card.type === 'result' ? async () => {
        const contract = journal.state.contract
        if (!contract || contract.digest !== card.contractDigest) throw leadRefusal('lead-card-stale')
        if (card.type === 'waiting') await this.options.decidePerson(card, decision, contract)
        else await this.options.decideResult(card, decision, contract)
      } : undefined)
    if (card.type === 'plan' && decision.choice === 'approve') await this.#continue()
    return this.#projection()
  }) }
  updateSettings(value: LeadSettingsUpdate): Promise<LeadWindowProjection> { return this.#queue(async () => {
    const input = parseLeadSettingsUpdate(value), { journal, service } = this.options
    this.#expectRevision(input.expectedRevision)
    // Each update is one independently reviewable change; no partial key+policy transaction.
    if ([input.policy, input.caps, input.credential].filter(item => item !== undefined).length !== 1) throw leadRefusal('lead-settings-one-change')
    if (input.credential) {
      const { provider, key } = input.credential
      if (key === null) await service.deleteKey(provider)
      else await service.setKey(provider, key)
      await journal.settingsChanged()
    } else {
      try { await service.assertPublic(input) } catch { throw leadRefusal('lead-secret-refused') }
      if (input.policy) await journal.changePolicy(input.policy, input.expectedRevision, this.options.nextId())
      if (input.caps) await journal.changeBudgetCaps(input.caps, { id: this.options.nextId(), revision: 1 }, this.options.now(), this.options.stopEffects, input.expectedRevision)
    }
    return this.#projection()
  }) }
  resume(input: { readonly expectedRevision: number }): Promise<LeadWindowProjection> { return this.#queue(async () => {
    const parsed = parseLeadResume(input)
    await this.options.journal.resume(parsed.expectedRevision)
    await this.#continue()
    return this.#projection()
  }) }
}
