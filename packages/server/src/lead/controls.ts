import {
  LEAD_CONTROL_REFUSALS, LEAD_MANAGEMENT_REASONS, parseLeadCardDecisionFor, parseLeadWindowProjection, parseLeadSettingsProjection, parseLeadSettingsUpdate, parseLeadNameReceipt,
  parseLeadThreadSend, parseLeadResume, parseLeadActionInput, parseLeadSteerInput, type LeadSteer, type LeadAction, type LeadActionInput,
  type LeadAcceptanceContract, type LeadCard, type LeadCardDecision, type LeadWindowProjection, type LeadControlRefusal, type LeadProject,
  type LeadSettingsProjection, type LeadSettingsUpdate, type LeadNameReceipt, type LeadThreadSend, type WireNotification, type LeadPresence,
} from '@harnessdesk/protocol'
import { canBeginLeadGoal, canReplaceLeadPlan, leadPlanRuns, leadBudgetProjection, leadContinuation, type LeadJournal, type LeadState, type MessagesTurn } from '@harnessdesk/lead'
import type { LeadService } from './service.js'
import { admitLeadCard, leadApprovalCards, leadProgress, leadRunTeam, leadWindowThread } from './projection.js'
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
  /** Live host registry relays, never child proposals or person decisions. */
  readonly readWorkerApprovals?: () => readonly Extract<LeadCard, { type: 'waiting' }>[]
  readonly readPersonActions?: () => Promise<readonly LeadAction[]>
  readonly performAction?: (input: LeadActionInput) => Promise<void>
  /** Host revalidates the live Flow, card and evidence on the journal's decision queue. */
  readonly decidePerson: (card: Extract<LeadCard, { type: 'waiting' }>, decision: LeadCardDecision, contract: LeadAcceptanceContract) => Promise<void>
  readonly decideResult: (card: Extract<LeadCard, { type: 'result' }>, decision: LeadCardDecision, contract: LeadAcceptanceContract) => Promise<void>
  readonly stopRequest?: () => Promise<void>
  /** Reads the workers' spend again; a Lead request is refused while that spend is not known. */
  readonly meterSpend?: () => Promise<void>
  readonly stopEffects?: () => Promise<void>
  /** The Lead's latest checks between turns; shown only while a goal runs. */
  readonly readPresence?: () => LeadPresence | null
  /** Hands the text to the goal's worker that is in a turn; false when none took it. */
  readonly steerWorker?: (text: string) => Promise<boolean>
}
/** One host owner, no transport or rendering. Child ports never contain these operations. */
export class LeadControls {
  #tail: Promise<unknown> = Promise.resolve()
  #notifications: Promise<void> = Promise.resolve()
  #failedRevision: number | null = null
  // Steers live with the goal they were sent in; a new goal starts an empty list.
  #steers: { readonly goal: string | null; readonly list: LeadSteer[] } = { goal: null, list: [] }
  #runningSince: { readonly goal: string | null; readonly at: number } | null = null
  #continuation: Promise<void> | null = null
  #continueAgain = false
  #requestInFlight = false
  #closed = false
  #lastRevision = -1
  readonly #detach: () => void
  constructor(private readonly options: LeadControlsOptions) {
    this.#detach = options.journal.onChange(() => { void this.#notify() })
  }
  #notify(liveApprovals = false): Promise<void> {
    this.#notifications = this.#notifications.then(async () => {
      // Coalesced journal writes often leave many notifications at the same
      // revision. Do not repeat live evidence reads for each superseded entry.
      if (!liveApprovals && this.options.journal.state.seq <= this.#lastRevision) return
      const projection = await this.#projection()
      if (projection.revision < this.#lastRevision || !liveApprovals && projection.revision === this.#lastRevision) return
      try { this.options.push({ method: 'lead/changed', params: projection }) }
      catch { this.#failedRevision = projection.revision; throw leadRefusal('lead-projection-failed') }
      this.#lastRevision = projection.revision
    }).catch(() => {
      const revision = this.options.journal.state.seq
      if (revision < this.#lastRevision || !liveApprovals && revision === this.#lastRevision) return
      try { this.options.push({ method: 'lead/changed', params: { version: 1, revision, error: 'lead-projection-failed' } }); this.#lastRevision = revision }
      catch { this.#failedRevision = revision }
    })
    return this.#notifications
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
    return parseLeadSettingsProjection({ version: 1, name: this.options.journal.state.name, model: this.options.model,
      key: { configured: key.configured, protection: key.protection === 'file permissions only' ? 'unavailable' : 'encrypted' }, policy, caps: budget.caps })
  }
  async #projection(): Promise<LeadWindowProjection> {
    // Renewal is opportunistic. A refusal must leave reads and key removal usable.
    try { await this.options.journal.renewPlan(this.options.now(), card =>
      admitLeadCard(this.options.journal.state, card, this.options.project, this.options.model)) } catch { /* Keep the last durable projection readable. */ }
    const settings = await this.#settings(), state = this.options.journal.state
    // Settings reads may yield to a journal write. Retry from one coherent revision.
    if (settings.name !== state.name || settings.policy.revision !== state.policy?.revision || JSON.stringify(settings.caps) !== JSON.stringify(state.budget?.caps)) return this.#projection()
    if (this.#failedRevision === state.seq) throw leadRefusal('lead-projection-failed')
    let thread: ReturnType<typeof leadWindowThread>
    const personActions = await this.options.readPersonActions?.() ?? []
    try { thread = leadWindowThread(state, this.options.project, settings, this.options.now(), [
      ...(this.options.readWorkerApprovals?.() ?? []), ...leadApprovalCards(personActions, state.contract?.digest ?? '')]) }
    catch { this.#failedRevision = state.seq; throw leadRefusal('lead-projection-failed') }
    const wayOut = this.#wayOut(state)
    const waitReason = state.phase === 'waiting-for-user' && (LEAD_MANAGEMENT_REASONS as readonly (string | null)[]).includes(state.managementReason)
      ? state.managementReason : null
    const running = leadProgress(state), team = leadRunTeam(state)
    // The journal keeps no clock for the phase change; the host remembers when it first saw this goal run.
    const goal = state.budget?.logicalGoalId ?? null
    if (!running) this.#runningSince = null
    else if (this.#runningSince?.goal !== goal) this.#runningSince = { goal, at: this.options.now() }
    const progress = running && this.#runningSince ? { ...running, since: this.#runningSince.at } : running
    const presence = running ? this.options.readPresence?.() ?? null : null
    if (this.#steers.goal !== goal) this.#steers = { goal, list: [] }
    const steers = this.#steers.list.slice(-64)
    const result = parseLeadWindowProjection({ version: 1, revision: state.seq, thread, settings, wayOut, waitReason,
      planConsentExpiresAt: state.consent?.expiresAt ?? null, requestInFlight: this.#inFlight(), personActions, ...(progress && { progress }), ...(team && { team }), ...(presence && { presence }), ...(steers.length && { steers }) })
    try { await this.options.service.assertPublic(result, state.seq) } catch (error) { this.#publicFailure(error) }
    return result
  }
  #inFlight(): boolean {
    return this.#requestInFlight
  }
  #resumable(state: LeadState): boolean {
    if (['stopped', 'accepted', 'declined'].includes(state.phase) || state.budget?.stop || state.recoveryBlocked || this.#inFlight()) return false
    const cards = state.cards.filter(card => !state.decidedCards.includes(`${card.id}:${card.revision}`))
    return !cards.some(card => card.type === 'plan' || card.type === 'result' || card.type === 'waiting' && card.kind === 'person') &&
      (!state.consent || state.consent.expiresAt > this.options.now()) &&
      (state.phase === 'waiting-for-user' || this.#unanswered())
  }
  #wayOut(state: LeadState): LeadWindowProjection['wayOut'] {
    if (['stopped', 'accepted', 'declined'].includes(state.phase) || state.budget?.stop || state.recoveryBlocked) return null
    if (state.cards.some(card => card.type === 'plan' && !state.decidedCards.includes(`${card.id}:${card.revision}`))) return 'decide-plan'
    if (state.managementReason === 'lead-predecessor-unavailable' || state.managementReason === 'lead-predecessor-unverifiable') return null
    return this.#resumable(state) ? 'resume' : null
  }
  #publicFailure(error: unknown): never {
    throw leadRefusal((error as { wireCode?: unknown })?.wireCode === 'lead-protection-unavailable' ? 'lead-protection-unavailable' : 'lead-secret-refused')
  }
  #unanswered(): boolean {
    const state = this.options.journal.state
    return !this.#continuation && state.messages.at(-1)?.role === 'user'
  }
  workerApprovalsChanged(): Promise<void> {
    return this.#queue(async () => { if (!this.#closed) await this.#notify(true) })
  }
  readThread(): Promise<LeadWindowProjection> { return this.#projection().catch(error => this.#refuse(error)) }
  readSettings(): Promise<LeadWindowProjection> { return this.#projection().catch(error => this.#refuse(error)) }
  perform(value: LeadActionInput): Promise<LeadWindowProjection> { return this.#queue(async () => {
    const input = parseLeadActionInput(value)
    if (input.contractDigest !== this.options.journal.state.contract?.digest) throw leadRefusal('lead-card-stale')
    if (!this.options.performAction) throw leadRefusal('lead-operation-refused')
    await this.options.performAction(input)
    void this.#notify(true)
    return this.#projection()
  }) }
  send(value: LeadThreadSend) { return this.#queue(async () => {
    const input = parseLeadThreadSend(value), { journal, service } = this.options
    if (leadContainsSecret(input)) throw leadRefusal('lead-secret-refused')
    const previous = journal.state.sends.find(send => send.key === input.idempotencyKey)
    if (previous) return { messageId: previous.messageId, revision: previous.revision }
    const newGoal = canBeginLeadGoal(journal.state)
    if (journal.state.budget?.stop && journal.state.budget.stop.reason !== 'cancelled' && !newGoal) throw leadRefusal('lead-budget-stopped')
    if (['accepted', 'declined', 'stopped'].includes(journal.state.phase) && !newGoal) throw leadRefusal('lead-thread-closed')
    if (this.#inFlight()) throw leadRefusal('lead-request-in-flight')
    let configured: boolean
    try { configured = (await service.status('anthropic')).configured } catch { throw leadRefusal('lead-protection-unavailable') }
    if (!configured) throw leadRefusal('lead-key-missing')
    try { await service.assertPublic(input) } catch (error) { this.#publicFailure(error) }
    // Record terminal host observations before the new message, so an earlier
    // request cannot become permission to replace work when it later settles.
    if (!newGoal && journal.state.steps.length && journal.state.steps.every(step => step.state === 'started')) {
      try { await this.options.meterSpend?.() } catch { /* The request loop still fences unknown spend. */ }
    }
    if (newGoal) {
      // Flow cleanup alone cannot prove that the old model process has ended.
      // Retry its stop even after a previous cancellation marker was acknowledged.
      await this.options.stopRequest?.()
      if (this.#continuation) await this.#continuation
      await journal.beginGoal(this.options.nextId(), this.options.now())
    }
    const resume = !newGoal && this.#resumable(journal.state)
    if (journal.state.phase === 'waiting-for-user' && (journal.state.recoveryBlocked ||
      journal.state.consent && journal.state.consent.expiresAt <= this.options.now())) throw leadRefusal('lead-no-person-wait')
    return this.#commitRequest(async committed => {
      const receipt = await journal.appendMessage(input.idempotencyKey, input.text, committed)
      if (resume) await journal.resume(undefined, true, committed)
      return receipt
    })
  }) }
  async #commitRequest<T>(commit: (committed: () => void) => Promise<T>): Promise<T> {
    let committed = false
    try { return await commit(() => { committed = true; this.#requestInFlight = true }) }
    finally { if (committed) this.#detachContinue() }
  }
  #detachContinue(forcePublication = false): void {
    if (this.#closed) return
    const publishFlight = forcePublication || !this.#requestInFlight
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
      if (this.#continueAgain && !this.#closed) this.#detachContinue(true)
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
      try { await this.options.meterSpend?.() } catch { /* The Lead itself refuses while spend stays unknown. */ }
      // History is rebuilt from what the person can read, as plain text, so no reasoning block from an earlier
      // request is carried into a prefix that has changed since the provider wrote it.
      const messages: MessagesTurn[] = journal.state.messages.filter(message => message.role !== 'system').map(message => ({
        role: message.role as 'user' | 'assistant', content: [{ type: 'text' as const, text: message.text }],
      }))
      // Once a plan is approved every request ends with the contract, because the standing instructions say it
      // arrives in a message and the history above holds only words. Before that, a request still ends in a user turn.
      const { contract, steps } = journal.state
      if (contract) messages.push({ role: 'user', content: leadContinuation({ contract, steps, runs: leadPlanRuns(journal.state), mayProposeNewPlan: canReplaceLeadPlan(journal.state),
        personActions: await this.options.readPersonActions?.() ?? [] }) })
      else if (messages.at(-1)?.role !== 'user') messages.push({ role: 'user', content: [
        { type: 'text', text: 'No plan is approved yet. Continue with a plan for the person to approve.' },
      ] })
      const result = await service.send({ maxTokens: LEAD_OUTPUT_TOKENS, messages })
      if (result.text) await service.assertPublic(result.text)
      this.#requestInFlight = this.#continueAgain
      if (result.text && !['accepted', 'declined', 'stopped'].includes(journal.state.phase)) await journal.appendReply(result.text)
      else if (result.status === 'refused' && !['accepted', 'declined', 'stopped', 'waiting-for-user'].includes(journal.state.phase) && journal.state.budget &&
        leadBudgetProjection(journal.state.budget, this.options.now()).spend !== 'known') {
        // The Lead declines to spend while the workers' spend is unknown. Say so, rather than leave a message unanswered.
        await journal.setManagementPhase('waiting-for-user', 'lead-budget-unknown')
      }
      else await journal.settingsChanged()
    } catch {
      this.#requestInFlight = this.#continueAgain
      const revision = journal.state.seq
      if (!['accepted', 'declined', 'stopped'].includes(journal.state.phase)) await journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
      if (journal.state.seq === revision) await journal.settingsChanged()
    }
  }
  decide(decision: LeadCardDecision): Promise<LeadWindowProjection> { return this.#queue(async () => {
    const { journal } = this.options, state = journal.state
    if (this.options.readWorkerApprovals?.().some(card => card.id === decision.cardId)) throw leadRefusal('lead-worker-approval')
    if ((await this.options.readPersonActions?.() ?? []).some(action => action.kind === 'worker-approval' && action.id === decision.cardId)) throw leadRefusal('lead-worker-approval')
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
    else {
      // A person may answer long after the workers went quiet, and a reading that ages out while the decision holds the
      // journal refuses a result that is still exactly as it was offered: read their spend again first, unless the reading
      // has most of its freshness left.
      const budget = journal.state.budget, observed = budget?.observation?.at
      if (card.type !== 'plan' && budget && (observed === undefined || this.options.now() - observed > budget.freshnessMs / 2))
        try { await this.options.meterSpend?.() } catch { /* The decision refuses while spend stays unknown. */ }
      await commit()
    }
    return this.#projection()
  }) }
  updateSettings(value: LeadSettingsUpdate): Promise<LeadWindowProjection | LeadNameReceipt> { return this.#queue(async () => {
    const input = parseLeadSettingsUpdate(value), { journal, service } = this.options
    // Credentials stay exclusive; combined authority changes are preflighted together.
    if (input.name !== undefined && (input.policy !== undefined || input.caps !== undefined)) throw leadRefusal('lead-settings-combination')
    if (input.credential ? input.name !== undefined || input.policy !== undefined || input.caps !== undefined : input.name === undefined && !input.policy && !input.caps) throw leadRefusal('lead-settings-combination')
    if (input.name !== undefined) {
      // This closed choice has no authority or untrusted prose. Acknowledge the
      // write without resolving a key; every later full projection still scans.
      await journal.settingsChanged(input.name)
      return parseLeadNameReceipt({ version: 1, revision: journal.state.seq, settings: { name: journal.state.name } })
    }
    this.#expectRevision(input.expectedRevision)
    if (input.credential) {
      const { provider, key } = input.credential
      if (key === null) await service.deleteKey(provider)
      else {
        const state = journal.state
        if (leadContainsSecret([state.messages, state.decisionMessages, state.cards.filter(card => !state.decidedCards.includes(`${card.id}:${card.revision}`))], key))
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
  stop(value: { readonly expectedRevision: number }): Promise<LeadWindowProjection> { return this.#queue(async () => {
    const input = parseLeadResume(value), { journal } = this.options
    this.#expectRevision(input.expectedRevision)
    if (['accepted', 'declined', 'stopped'].includes(journal.state.phase)) throw leadRefusal('lead-thread-closed')
    this.#continueAgain = false
    await journal.stop(this.options.stopEffects)
    // The independent Flow cleanup owner may already have cleared its marker.
    // Process cancellation is unconditional and must succeed in its own right.
    await this.options.stopRequest?.()
    // Cancellation settles the old detached continuation before another goal is admitted.
    if (this.#continuation) await this.#continuation
    return this.#projection()
  }) }
  steer(value: { readonly text: string }): Promise<LeadWindowProjection> { return this.#queue(async () => {
    const input = parseLeadSteerInput(value), { journal } = this.options
    if (leadContainsSecret(input)) throw leadRefusal('lead-secret-refused')
    if (journal.state.phase !== 'running' || !this.options.steerWorker) throw leadRefusal('lead-steer-unavailable')
    const taken = await this.options.steerWorker(input.text).catch(() => false)
    if (!taken) throw leadRefusal('lead-steer-unavailable')
    const goal = journal.state.budget?.logicalGoalId ?? null
    if (this.#steers.goal !== goal) this.#steers = { goal, list: [] }
    this.#steers.list.push({ id: this.options.nextId(), text: input.text, at: this.options.now(), state: 'acknowledged', after: journal.state.seq })
    void this.#notify(true)
    return this.#projection()
  }) }
  resume(input: { readonly expectedRevision: number }): Promise<LeadWindowProjection> { return this.#queue(async () => {
    const parsed = parseLeadResume(input)
    this.#expectRevision(parsed.expectedRevision)
    const reason = this.options.journal.state.managementReason
    if (reason === 'lead-predecessor-unavailable' || reason === 'lead-predecessor-unverifiable') throw leadRefusal('lead-no-person-wait')
    const wayOut = this.#wayOut(this.options.journal.state)
    if (wayOut === 'decide-plan') throw leadRefusal('lead-plan-pending')
    if (this.#inFlight()) throw leadRefusal('lead-request-in-flight')
    if (wayOut !== 'resume') throw leadRefusal('lead-no-person-wait')
    await this.#commitRequest(committed => this.options.journal.resume(parsed.expectedRevision, this.#unanswered(), committed))
    return this.#projection()
  }) }
}
