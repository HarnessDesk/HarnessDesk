import {
  LEAD_CONTROL_REFUSALS, LEAD_MANAGEMENT_REASONS, parseLeadCardDecisionFor, parseLeadWindowProjection, parseLeadSettingsProjection, parseLeadSettingsUpdate,
  parseLeadThreadSend, parseLeadResume,
  type LeadAcceptanceContract, type LeadCard, type LeadCardDecision, type LeadWindowProjection, type LeadControlRefusal, type LeadProject,
  type LeadSettingsProjection, type LeadSettingsUpdate, type LeadThreadSend, type WireNotification,
} from '@harnessdesk/protocol'
import type { LeadJournal, LeadState } from '@harnessdesk/lead'
import type { LeadService } from './service.js'
import { admitLeadCard, leadWindowThread } from './projection.js'
import { leadContainsSecret } from './secrets.js'

export const LEAD_PLAN_CONSENT_MS = 86_400_000
export const LEAD_OUTPUT_TOKENS = 4096

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
  #failedRevision: number | null = null
  #continuation: Promise<void> | null = null
  #continueAgain = false
  #requestInFlight = false
  #closed = false
  #lastRevision = -1
  readonly #detach: () => void
  constructor(private readonly options: LeadControlsOptions) {
    this.#detach = options.journal.onChange(() => {
      this.#notifications = this.#notifications.then(async () => {
        const projection = await this.#projection()
        if (projection.revision <= this.#lastRevision) return
        try { options.push({ method: 'lead/changed', params: projection }) }
        catch { this.#failedRevision = projection.revision; throw leadRefusal('lead-projection-failed') }
        this.#lastRevision = projection.revision
      }).catch(() => {
        const revision = options.journal.state.seq
        if (revision <= this.#lastRevision) return
        try { options.push({ method: 'lead/changed', params: { version: 1, revision, error: 'lead-projection-failed' } }); this.#lastRevision = revision }
        catch { this.#failedRevision = revision }
      })
    })
  }
  close(): void { this.#closed = true; this.#detach() }
  async idle(): Promise<void> {
    await this.#tail
    while (this.#continuation) await this.#continuation
    await this.#notifications
  }
  #refuse(error: unknown): never {
    const code = (error as { wireCode?: unknown })?.wireCode
    if (typeof code === 'string' && (LEAD_CONTROL_REFUSALS as readonly string[]).includes(code)) throw leadRefusal(code as LeadControlRefusal)
    throw leadRefusal('lead-operation-refused')
  }
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
    if (this.#failedRevision === state.seq) throw leadRefusal('lead-projection-failed')
    let thread: ReturnType<typeof leadWindowThread>
    try { thread = leadWindowThread(state, this.options.project, settings) }
    catch { this.#failedRevision = state.seq; throw leadRefusal('lead-projection-failed') }
    const wayOut = this.#wayOut(state)
    const waitReason = state.phase === 'waiting-for-user' && (LEAD_MANAGEMENT_REASONS as readonly (string | null)[]).includes(state.managementReason)
      ? state.managementReason : null
    const result = parseLeadWindowProjection({ version: 1, revision: state.seq, thread, settings, wayOut, waitReason,
      planConsentExpiresAt: state.consent?.expiresAt ?? null, requestInFlight: this.#inFlight() })
    try { await this.options.service.assertPublic(result, state.seq) } catch (error) { this.#publicFailure(error) }
    return result
  }
  #inFlight(): boolean {
    return this.#requestInFlight
  }
  #wayOut(state: LeadState): LeadWindowProjection['wayOut'] {
    if (['stopped', 'accepted', 'declined'].includes(state.phase) || state.budget?.stop || state.recoveryBlocked) return null
    const cards = state.cards.filter(card => !state.decidedCards.includes(`${card.id}:${card.revision}`))
    if (cards.some(card => card.type === 'plan')) return 'decide-plan'
    if (this.#inFlight() || cards.some(card => card.type === 'result' || card.type === 'waiting' && card.kind === 'person')) return null
    return (!state.consent || state.consent.expiresAt > this.options.now()) &&
      (state.phase === 'waiting-for-user' || this.#unanswered()) ? 'resume' : null
  }
  #publicFailure(error: unknown): never {
    throw leadRefusal((error as { wireCode?: unknown })?.wireCode === 'lead-protection-unavailable' ? 'lead-protection-unavailable' : 'lead-secret-refused')
  }
  #unanswered(): boolean {
    const state = this.options.journal.state
    return !this.#continuation && state.messages.at(-1)?.role === 'user'
  }
  readThread(): Promise<LeadWindowProjection> { return this.#projection().catch(error => this.#refuse(error)) }
  readSettings(): Promise<LeadWindowProjection> { return this.#projection().catch(error => this.#refuse(error)) }
  send(value: LeadThreadSend) { return this.#queue(async () => {
    const input = parseLeadThreadSend(value), { journal, service } = this.options
    if (leadContainsSecret(input)) throw leadRefusal('lead-secret-refused')
    const previous = journal.state.sends.find(send => send.key === input.idempotencyKey)
    if (previous) return { messageId: previous.messageId, revision: previous.revision }
    if (journal.state.budget?.stop && journal.state.budget.stop.reason !== 'cancelled') throw leadRefusal('lead-budget-stopped')
    if (['accepted', 'declined', 'stopped'].includes(journal.state.phase)) throw leadRefusal('lead-thread-closed')
    if (journal.state.budget?.stop) throw leadRefusal('lead-budget-stopped')
    if (this.#inFlight()) throw leadRefusal('lead-request-in-flight')
    let configured: boolean
    try { configured = (await service.status('anthropic')).configured } catch { throw leadRefusal('lead-protection-unavailable') }
    if (!configured) throw leadRefusal('lead-key-missing')
    try { await service.assertPublic(input) } catch (error) { this.#publicFailure(error) }
    return this.#commitRequest(committed => journal.appendMessage(input.idempotencyKey, input.text, committed))
  }) }
  async #commitRequest<T>(commit: (committed: () => void) => Promise<T>): Promise<T> {
    let committed = false
    try { return await commit(() => { committed = true; this.#requestInFlight = true }) }
    finally { if (committed) this.#detachContinue() }
  }
  #detachContinue(): void {
    if (this.#closed) return
    const publishFlight = !this.#requestInFlight
    this.#requestInFlight = true
    if (this.#continuation) { this.#continueAgain = true; return }
    // A timer yields the durable receipt/projection to the caller before any paid work.
    const work = new Promise<void>(resolve => setTimeout(resolve, 0)).then(async () => {
      this.#continueAgain = false
      if (!this.#closed) {
        if (publishFlight) await this.options.journal.settingsChanged()
        await this.#continue()
      }
    }).catch(() => {
      // Even a failed journal write must not become an unhandled detached rejection.
      const revision = this.options.journal.state.seq
      this.#failedRevision = revision
      try { this.options.push({ method: 'lead/changed', params: { version: 1, revision, error: 'lead-projection-failed' } }) } catch { /* Reads carry the same code. */ }
    }).finally(() => {
      if (this.#continuation !== work) return
      this.#continuation = null
      if (this.#continueAgain && !this.#closed) this.#detachContinue()
      else this.#requestInFlight = false
    })
    this.#continuation = work
  }
  async #continue(): Promise<void> {
    const { journal, service } = this.options
    if (['accepted', 'declined', 'stopped'].includes(journal.state.phase) || journal.state.budget?.stop) {
      this.#requestInFlight = false
      await journal.settingsChanged()
      return
    }
    try {
      const messages = journal.state.messages.filter(message => message.role !== 'system').map(message => ({
        role: message.role as 'user' | 'assistant', content: [{ type: 'text' as const, text: message.text }],
      }))
      if (messages.at(-1)?.role !== 'user') messages.push({ role: 'user', content: [
        { type: 'text', text: 'Continue from the approved contract and fresh desk observations.' },
      ] })
      const result = await service.send({ maxTokens: LEAD_OUTPUT_TOKENS, messages })
      if (result.text) await service.assertPublic(result.text)
      this.#requestInFlight = false
      if (result.text) await journal.appendReply(result.text)
      else await journal.settingsChanged()
    } catch {
      this.#requestInFlight = false
      const revision = journal.state.seq
      if (!['accepted', 'declined', 'stopped'].includes(journal.state.phase)) await journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
      if (journal.state.seq === revision) await journal.settingsChanged()
    }
  }
  decide(decision: LeadCardDecision): Promise<LeadWindowProjection> { return this.#queue(async () => {
    const { journal } = this.options, state = journal.state
    const card = state.cards.find(card => card.id === decision.cardId)
    if (state.decidedCards.includes(`${decision.cardId}:${decision.expectedRevision}`)) throw leadRefusal('lead-card-decided')
    if (!card) throw leadRefusal('lead-card-stale')
    if (card.type === 'waiting' && card.kind === 'worker-approval') throw leadRefusal('lead-worker-approval')
    if (state.decidedCards.includes(`${card.id}:${card.revision}`)) throw leadRefusal('lead-card-decided')
    try { parseLeadCardDecisionFor(decision, card) } catch { throw leadRefusal('lead-card-stale') }
    if (card.type !== 'plan' && card.contractDigest !== (state.contract?.digest ?? null)) throw leadRefusal('lead-card-stale')
    const commit = (committed?: () => void) => journal.decideCard(decision, card.type === 'plan' && decision.choice === 'approve' ? this.options.now() + LEAD_PLAN_CONSENT_MS : null,
      this.options.stopEffects, card.type === 'waiting' || card.type === 'result' ? async () => {
        const contract = journal.state.contract
        if (!contract || contract.digest !== card.contractDigest) throw leadRefusal('lead-card-stale')
        if (card.type === 'waiting') await this.options.decidePerson(card, decision, contract)
        else await this.options.decideResult(card, decision, contract)
      } : undefined, committed)
    if (card.type === 'plan' && decision.choice === 'approve') await this.#commitRequest(commit)
    else await commit()
    return this.#projection()
  }) }
  updateSettings(value: LeadSettingsUpdate): Promise<LeadWindowProjection> { return this.#queue(async () => {
    const input = parseLeadSettingsUpdate(value), { journal, service } = this.options
    this.#expectRevision(input.expectedRevision)
    // Credentials stay exclusive; combined authority changes are preflighted together.
    if (input.credential ? input.policy !== undefined || input.caps !== undefined : !input.policy && !input.caps) throw leadRefusal('lead-settings-one-change')
    if (input.credential) {
      const { provider, key } = input.credential
      if (key === null) await service.deleteKey(provider)
      else {
        const state = journal.state
        if (leadContainsSecret([state.messages, state.cards.filter(card => !state.decidedCards.includes(`${card.id}:${card.revision}`))], key))
          throw leadRefusal('lead-secret-in-thread')
        await service.setKey(provider, key)
      }
      await journal.settingsChanged()
    } else {
      try { await service.assertPublic(input) } catch (error) { this.#publicFailure(error) }
      if (input.policy && input.caps) await journal.changePolicyAndBudgetCaps(input.policy, input.caps, input.expectedRevision,
        { policy: this.options.nextId(), caps: this.options.nextId() }, this.options.now(), this.options.stopEffects,
        (state, card) => admitLeadCard(state, card, this.options.project, this.options.model))
      else if (input.policy) await journal.changePolicy(input.policy, input.expectedRevision, this.options.nextId(), card =>
        admitLeadCard(journal.state, card, this.options.project, this.options.model))
      else if (input.caps) await journal.changeBudgetCaps(input.caps, { id: this.options.nextId(), revision: 1 }, this.options.now(), this.options.stopEffects, input.expectedRevision, card =>
        admitLeadCard(journal.state, card, this.options.project, this.options.model))
    }
    return this.#projection()
  }) }
  resume(input: { readonly expectedRevision: number }): Promise<LeadWindowProjection> { return this.#queue(async () => {
    const parsed = parseLeadResume(input)
    this.#expectRevision(parsed.expectedRevision)
    const wayOut = this.#wayOut(this.options.journal.state)
    if (wayOut === 'decide-plan') throw leadRefusal('lead-plan-pending')
    if (this.#inFlight()) throw leadRefusal('lead-request-in-flight')
    if (wayOut !== 'resume') throw leadRefusal('lead-no-person-wait')
    await this.#commitRequest(committed => this.options.journal.resume(parsed.expectedRevision, this.#unanswered(), committed))
    return this.#projection()
  }) }
}
