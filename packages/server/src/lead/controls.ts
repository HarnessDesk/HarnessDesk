import {
  leadProactiveReport, leadWaitNeedsChange, LEAD_CONTROL_REFUSALS, LEAD_MANAGEMENT_REASONS, parseLeadCardDecisionFor, parseLeadWindowProjection, parseLeadSettingsProjection, parseLeadSettingsUpdate, parseLeadNameReceipt,
  parseLeadOrigin, type LeadOrigin, parseLeadThreadSend, parseLeadResume, parseLeadActionInput, parseLeadSteerInput, type LeadSteer, type LeadAction, type LeadActionInput,
  type LeadAcceptanceContract, type LeadCard, type LeadCardDecision, type LeadWindowProjection, type LeadControlRefusal, type LeadProject,
  type LeadSettingsProjection, type LeadSettingsUpdate, type LeadNameReceipt, type LeadThreadSend, type WireNotification, type LeadPresence,
} from '@harnessdesk/protocol'
import { hasUncertainLeadChatEffect, leadDecisionRevisionMatches, canOfferAutomaticLeadGoal, canBeginLeadGoal, canReplaceLeadPlan, leadPlanRuns, leadBudgetProjection, leadContinuation, type LeadJournal, type LeadState, type MessagesTurn } from '@harnessdesk/lead'
import type { LeadService } from './service.js'
import { admitLeadCard, leadApprovalCards, leadProgress, leadRunTeam, leadWindowThread } from './projection.js'
import { leadContainsSecret } from './secrets.js'

export const LEAD_PLAN_CONSENT_MS = 86_400_000
/** How long a click on a withdrawn result waits for the Lead to offer that same card again: one read of the desk. */
export const LEAD_REOFFER_WAIT_MS = 15_000

/** Trusted host feedback survives the resume transition that clears the wait.
 * It is supplied as current context, rather than fabricated assistant history. */
const leadRecoveryContext = (reason: string | null): string | null => {
  const fixes: Record<string, string> = {
    'lead-plan-not-independent': 'The previous reviewed plan was refused because its reviewer could not be shown to use a different provider from its implementer.',
    'lead-plan-unseatable': 'The previous reviewed plan was refused because an agent could not hold its required permissions.',
    'lead-plan-refused': 'The previous plan could not be validated and was not offered.',
    'lead-card-too-large': 'The previous request exceeded the decision size limit. Reduce its scope or use fewer steps.',
    'lead-start-binding-failed': 'The previous run could not be linked to its approved plan. Inspect existing work before trying to start anything again.',
    'lead-result-revisions-exhausted': 'The previous result reached its revision limit. Inspect existing work and ask for a changed request.',
  }
  const detail = reason === null ? null : fixes[reason]
  return detail ? `Desk observation: ${detail} Explain this once if still relevant. Do not repeat the unchanged rejected plan. Continue the conversation, or use an ordinary chat for a simple task requested by the person. An ordinary chat does not provide reviewed-plan acceptance.` : null
}
export const LEAD_OUTPUT_TOKENS = 4096

export const leadRefusal = (wireCode: LeadControlRefusal): Error & { wireCode: LeadControlRefusal } => Object.assign(new Error(wireCode), { wireCode })
interface LeadControlsOptions {
  readonly journal: LeadJournal
  readonly service: Pick<LeadService, 'status' | 'setKey' | 'deleteKey' | 'send' | 'assertPublic'>
  readonly automaticProject?: (path: string) => Promise<void>
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
  readonly publishResult?: (card: Extract<LeadCard, { type: 'result' }>, decision: LeadCardDecision, contract: LeadAcceptanceContract) => Promise<void>
  readonly reclaimBranch?: (card: Extract<LeadCard, { type: 'branch-ownership' }>, decision: LeadCardDecision) => Promise<void>
  readonly stopRequest?: () => Promise<void>
  /** Reads the workers' spend again; a Lead request is refused while that spend is not known. */
  readonly meterSpend?: () => Promise<void>
  readonly stopEffects?: () => Promise<void>
  /** Child execution may continue across multiple service.send results. */
  readonly readRequestInFlight?: () => boolean
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
  #automaticRequest = false
  #requestWaitReason: string | null = null
  #requestConversation = true
  #closed = false
  #lastRevision = -1
  #actionsGeneration = 0
  #actions: { readonly scope: string; readonly generation: number; readonly value: readonly LeadAction[] } | null = null
  readonly #detach: () => void
  constructor(private readonly options: LeadControlsOptions) {
    this.#detach = options.journal.onChange(() => { void this.#notify() })
  }
  #notify(liveApprovals = false): Promise<void> {
    this.#notifications = this.#notifications.then(async () => {
      // Coalesced journal writes often leave many notifications at the same
      // revision. Do not repeat live evidence reads for each superseded entry.
      if (!liveApprovals && this.options.journal.state.seq <= this.#lastRevision) return
      const projection = await this.#projection(liveApprovals)
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
    if (!leadDecisionRevisionMatches(this.options.journal.state, revision)) throw leadRefusal('lead-revision-stale')
  }
  async #settings(): Promise<LeadSettingsProjection> {
    const { policy, budget } = this.options.journal.state
    if (!policy || !budget) throw leadRefusal('lead-unavailable')
    const key = await this.options.service.status('anthropic')
    return parseLeadSettingsProjection({ version: 1, name: this.options.journal.state.name, nameChosen: this.options.journal.state.nameChosen, model: this.options.model,
      ...(key.unavailable ? { unavailable: key.unavailable, ...(key.unavailableReason ? { unavailableReason: key.unavailableReason } : {}) } : {}),
      follow: this.options.journal.state.follow, key: { configured: key.configured, protection: key.protection === 'file permissions only' ? 'unavailable' : 'encrypted' }, policy, caps: budget.caps })
  }
  async #projection(liveActions = true): Promise<LeadWindowProjection> {
    // Renewal is opportunistic. A refusal must leave reads and key removal usable.
    try { await this.options.journal.renewPlan(this.options.now(), card =>
      admitLeadCard(this.options.journal.state, card, this.options.project, this.options.model)) } catch { /* Keep the last durable projection readable. */ }
    const settings = await this.#settings()
    let state = this.options.journal.state
    // Settings reads may yield to a journal write. Retry from one coherent revision.
    if (settings.name !== state.name || settings.policy.revision !== state.policy?.revision || JSON.stringify(settings.caps) !== JSON.stringify(state.budget?.caps) || JSON.stringify(settings.follow) !== JSON.stringify(state.follow)) return this.#projection(liveActions)
    if (this.#failedRevision === state.seq) throw leadRefusal('lead-projection-failed')
    let thread: ReturnType<typeof leadWindowThread>
    // Journaled tool reads and wake rows do not change worker requests or check
    // evidence. Only notifications may reuse these facts; window reads stay live.
    const scope = JSON.stringify([state.contract, state.runs]), generation = this.#actionsGeneration
    const personActions = !liveActions && this.#actions?.scope === scope && this.#actions.generation === generation
      ? this.#actions.value : await this.options.readPersonActions?.() ?? []
    if (generation === this.#actionsGeneration) this.#actions = { scope, generation, value: personActions }
    const latest = this.options.journal.state
    if (latest.seq !== state.seq) {
      // Journaled reads and wake bookkeeping can advance while live actions
      // are read. Publish those updates together instead of rereading evidence
      // once per superseded notification. A changed action scope or settings
      // still needs a new coherent read.
      if (JSON.stringify([state.contract, state.runs]) !== JSON.stringify([latest.contract, latest.runs]) ||
        settings.name !== latest.name || settings.nameChosen !== latest.nameChosen || settings.policy.revision !== latest.policy?.revision ||
        JSON.stringify(settings.caps) !== JSON.stringify(latest.budget?.caps) || JSON.stringify(settings.follow) !== JSON.stringify(latest.follow)) return this.#projection(liveActions)
      state = latest
    }
    if (this.#failedRevision === state.seq) throw leadRefusal('lead-projection-failed')
    try { thread = leadWindowThread(state, this.options.project, settings, this.options.now(), [
      ...(this.options.readWorkerApprovals?.() ?? []), ...leadApprovalCards(personActions, state.contract?.digest ?? '')]) }
    catch { this.#failedRevision = state.seq; throw leadRefusal('lead-projection-failed') }
    const wayOut = settings.unavailable ? null : this.#wayOut(state)
    const waitReason = hasUncertainLeadChatEffect(state) && !state.chatEffectsAcknowledged ? 'lead-chat-effect-uncertain' : state.phase === 'waiting-for-user' && (LEAD_MANAGEMENT_REASONS as readonly (string | null)[]).includes(state.managementReason)
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
    return this.#requestInFlight || this.options.readRequestInFlight?.() === true
  }
  #resumable(state: LeadState): boolean {
    if (['stopped', 'accepted', 'declined', 'following'].includes(state.phase) || state.budget?.stop || state.recoveryBlocked || this.#inFlight()) return false
    const cards = state.cards.filter(card => !state.decidedCards.includes(`${card.id}:${card.revision}`))
    return !cards.some(card => card.type === 'plan' || card.type === 'result' || card.type === 'waiting' && card.kind === 'person') &&
      (!state.consent || state.consent.expiresAt > this.options.now()) &&
      (state.phase === 'waiting-for-user' || this.#unanswered())
  }
  #wayOut(state: LeadState): LeadWindowProjection['wayOut'] {
    if (['stopped', 'accepted', 'declined'].includes(state.phase) || state.budget?.stop || state.recoveryBlocked) return null
    if (state.cards.some(card => card.type === 'plan' && !state.decidedCards.includes(`${card.id}:${card.revision}`))) return 'decide-plan'
    if (leadWaitNeedsChange(state.managementReason)) return null
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
    this.#actionsGeneration++
    return this.#queue(async () => { if (!this.#closed) await this.#notify(true) })
  }
  async readWakes() { const state = this.options.journal.state; return { revision: state.seq, wakes: state.wakes } }
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
  send(value: LeadThreadSend, automaticOrigin?: LeadOrigin, automaticProject?: string) { return this.#queue(async () => {
    const input = parseLeadThreadSend(value), { journal, service } = this.options
    if (leadContainsSecret(input)) throw leadRefusal('lead-secret-refused')
    const previous = journal.state.sends.find(send => send.key === input.idempotencyKey)
    if (previous) return { messageId: previous.messageId, revision: previous.revision }
    const origin = automaticOrigin ? parseLeadOrigin(automaticOrigin) : null
    const idle = () => canOfferAutomaticLeadGoal(journal.state, input.idempotencyKey)
    if (origin && !idle()) throw leadRefusal('lead-request-in-flight')
    const newGoal = canBeginLeadGoal(journal.state)
    if (!newGoal && hasUncertainLeadChatEffect(journal.state) && !journal.state.chatEffectsAcknowledged) throw leadRefusal('lead-chat-effect-uncertain')
    if (journal.state.budget?.stop && journal.state.budget.stop.reason !== 'cancelled' && !newGoal) throw leadRefusal('lead-budget-stopped')
    if (['accepted', 'declined', 'stopped'].includes(journal.state.phase) && !newGoal) throw leadRefusal('lead-thread-closed')
    if (this.#inFlight()) throw leadRefusal('lead-request-in-flight')
    let configured: boolean
    const status = await service.status('anthropic').catch(() => { throw leadRefusal('lead-protection-unavailable') })
    if (status.unavailable) throw leadRefusal('lead-runtime-unsupported')
    configured = status.configured
    if (!configured) throw leadRefusal('lead-key-missing')
    try { await service.assertPublic(input) } catch (error) { this.#publicFailure(error) }
    if (origin && !idle()) throw leadRefusal('lead-request-in-flight')
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
    if (origin && automaticProject && automaticProject !== this.options.project.path) {
      if (!this.options.automaticProject) throw leadRefusal('lead-project-missing')
      await this.options.automaticProject(automaticProject)
    }
    if (origin) {
      if (journal.state.origin && JSON.stringify(journal.state.origin) !== JSON.stringify(origin)) throw leadRefusal('lead-request-in-flight')
      if (!journal.state.origin) await journal.setOrigin(origin, input.idempotencyKey)
    }
    const resume = !newGoal && this.#resumable(journal.state)
    if (journal.state.phase === 'waiting-for-user' && (journal.state.recoveryBlocked ||
      journal.state.consent && journal.state.consent.expiresAt <= this.options.now())) throw leadRefusal('lead-no-person-wait')
    return this.#commitRequest(async committed => {
      const receipt = await journal.appendMessage(input.idempotencyKey, input.text, committed)
      if (resume) await journal.resume(undefined, true, committed)
      return receipt
    }, !!origin)
  }) }
  async #commitRequest<T>(commit: (committed: () => void) => Promise<T>, proactive = false,
    waitReason = this.options.journal.state.managementReason, conversation = true): Promise<T> {
    let committed = false
    try { return await commit(() => { committed = true; this.#requestInFlight = true; this.#automaticRequest = proactive; this.#requestWaitReason = waitReason; this.#requestConversation = conversation }) }
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
    const proactive = this.#automaticRequest; this.#automaticRequest = false
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
      const waitReason = this.#requestWaitReason
      this.#requestWaitReason = null
      const recovery = leadRecoveryContext(waitReason)
      if (recovery) messages.push({ role: 'user', content: [{ type: 'text', text: recovery }] })
      // Once a plan is approved every request ends with the contract, because the standing instructions say it
      // arrives in a message and the history above holds only words. Before that, a request still ends in a user turn.
      const { contract, steps } = journal.state
      if (contract) messages.push({ role: 'user', content: leadContinuation({ contract, steps, runs: leadPlanRuns(journal.state), mayProposeNewPlan: canReplaceLeadPlan(journal.state),
        personActions: await this.options.readPersonActions?.() ?? [] }) })
      else if (messages.at(-1)?.role !== 'user') messages.push({ role: 'user', content: [
        { type: 'text', text: 'Continue the conversation from the person\'s latest message. Answer directly or use an ordinary chat for a task. Offer a reviewed plan only when the work needs that workflow; no plan has been approved.' },
      ] })
      const result = await service.send({ maxTokens: LEAD_OUTPUT_TOKENS, messages, conversation: this.#requestConversation, ...(proactive ? { proactive: true, wakeSource: journal.state.origin?.source === 'schedule' ? 'schedule' as const : 'trigger' as const } : {}) })
      if (result.text) await service.assertPublic(result.text)
      this.#requestInFlight = this.#continueAgain
      if ((proactive ? result.proactive : result.text) && !['accepted', 'declined', 'stopped'].includes(journal.state.phase)) {
        if (proactive) {
          const report = leadProactiveReport(result.proactive!, 0, 1, false)
          await service.assertPublic(report)
          await journal.appendReply([report.finding, report.caveat, report.ask].join('\n'), report)
        } else await journal.appendReply(result.text!)
      }
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
  /**
   * A person's decision on a card. The Lead withdraws every undecided result
   * while observations coalesce and restores it once it has read them again,
   * so a click can land on a result taken back a moment before. Then the
   * decision waits, outside the queue, for that same card — same id and
   * revision, so the same evidence — to be offered again, and is made on it;
   * a card offered at another revision, or not again within
   * `LEAD_REOFFER_WAIT_MS`, is refused as before. A card a person decided is
   * never waited for, and nothing whose effect began is decided again.
   */
  async decide(decision: LeadCardDecision): Promise<LeadWindowProjection> {
    for (let attempt = 1; ; attempt++) {
      try { return await this.#decideOnce(decision) } catch (error) {
        const code = (error as { wireCode?: unknown })?.wireCode
        if ((code !== 'lead-card-stale' && code !== 'lead-card-decided') || attempt >= 3 ||
          !this.options.journal.withdrawn(decision.cardId, decision.expectedRevision) || !await this.#offeredAgain(decision)) throw error
      }
    }
  }
  /** Resolves true once the card is undecided again at the same revision; false when it moved on or did not come back in time. */
  #offeredAgain(decision: LeadCardDecision): Promise<boolean> {
    const { journal } = this.options, key = `${decision.cardId}:${decision.expectedRevision}`
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined, detach = () => {}
      const done = (again: boolean) => { if (timer) clearTimeout(timer); detach(); resolve(again) }
      const check = () => {
        const state = journal.state, card = state.cards.find(one => one.id === decision.cardId)
        if (this.#closed || !card || card.revision !== decision.expectedRevision) done(false)
        else if (!state.decidedCards.includes(key)) done(true)
      }
      detach = journal.onChange(check)
      timer = setTimeout(() => done(false), LEAD_REOFFER_WAIT_MS)
      timer.unref?.()
      check()
    })
  }
  #decideOnce(decision: LeadCardDecision): Promise<LeadWindowProjection> { return this.#queue(async () => {
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
        else if (!(card.publication === 'push' && decision.choice === 'decline')) await this.options.decideResult(card, decision, contract)
      } : undefined, committed)
    if (card.type === 'plan' && decision.choice === 'approve') await this.#commitRequest(commit, false, null, false)
    else {
      // Result/person validation can read several runs while holding the writer.
      // Give it a fresh spend reading even when the previous one is still young;
      // half of a short freshness window may not cover those evidence reads.
      const budget = journal.state.budget, observed = budget?.observation?.at
      if (card.type !== 'plan' && budget && (card.type === 'result' || card.type === 'waiting' && card.kind === 'person' ||
        observed === undefined || this.options.now() - observed > budget.freshnessMs / 2))
        try { await this.options.meterSpend?.() } catch { /* The decision refuses while spend stays unknown. */ }
      if (card.type === 'branch-ownership' && decision.choice === 'reclaim-branch') {
        if (!this.options.reclaimBranch) throw leadRefusal('lead-operation-refused')
        try { await this.options.reclaimBranch(card, decision) } catch { throw leadRefusal('lead-card-stale') }
      } else if (card.type === 'result' && (decision.choice === 'accept-open-pr' || card.publication === 'push' && decision.choice === 'accept')) {
        if (!this.options.publishResult || !journal.state.contract) throw leadRefusal('lead-operation-refused')
        try { await this.options.publishResult(card, decision, journal.state.contract) }
        catch (error) { throw leadRefusal(error instanceof Error && error.message === 'lead-card-stale' ? 'lead-card-stale' : 'lead-operation-refused') }
      } else await commit()
    }
    return this.#projection()
  }) }
  updateSettings(value: LeadSettingsUpdate): Promise<LeadWindowProjection | LeadNameReceipt> { return this.#queue(async () => {
    const input = parseLeadSettingsUpdate(value), { journal, service } = this.options
    // Credentials stay exclusive; combined authority changes are preflighted together.
    if (input.name !== undefined && (input.policy !== undefined || input.caps !== undefined || input.follow !== undefined)) throw leadRefusal('lead-settings-combination')
    if (input.credential ? input.name !== undefined || input.policy !== undefined || input.caps !== undefined || input.follow !== undefined : input.name === undefined && !input.policy && !input.caps && !input.follow) throw leadRefusal('lead-settings-combination')
    if (input.name !== undefined) {
      // This closed choice has no authority or untrusted prose. Acknowledge the
      // write without resolving a key; every later full projection still scans.
      await journal.settingsChanged(input.name)
      return parseLeadNameReceipt({ version: 1, revision: journal.state.seq, settings: { name: journal.state.name, nameChosen: journal.state.nameChosen } })
    }
    this.#expectRevision(input.expectedRevision)
    if (input.follow && (input.policy || input.caps)) throw leadRefusal('lead-settings-combination')
    if (input.follow) {
      await journal.settingsChanged(undefined, input.follow)
      return this.#projection()
    }
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
    if (['accepted', 'declined', 'stopped'].includes(journal.state.phase) &&
      !(hasUncertainLeadChatEffect(journal.state) && !journal.state.chatEffectsAcknowledged)) throw leadRefusal('lead-thread-closed')
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
    if ((await this.options.service.status('anthropic')).unavailable) throw leadRefusal('lead-runtime-unsupported')
    const parsed = parseLeadResume(input)
    this.#expectRevision(parsed.expectedRevision)
    const reason = this.options.journal.state.managementReason
    if (reason === 'lead-predecessor-unavailable' || reason === 'lead-predecessor-unverifiable') throw leadRefusal('lead-no-person-wait')
    const wayOut = this.#wayOut(this.options.journal.state)
    if (wayOut === 'decide-plan') throw leadRefusal('lead-plan-pending')
    if (this.#inFlight()) throw leadRefusal('lead-request-in-flight')
    if (wayOut !== 'resume') throw leadRefusal('lead-no-person-wait')
    await this.#commitRequest(committed => this.options.journal.resume(parsed.expectedRevision, this.#unanswered(), committed), false, reason, false)
    return this.#projection()
  }) }
}
