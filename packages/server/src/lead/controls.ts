import { leadThreadStage } from './projection.js'
import { boundLeadApprovalHistory, leadWorkerApprovalEntries } from '@harnessdesk/protocol'
import {
  parseLeadApprovalRevoke, parseLeadMessage, parseLeadAsk, parseLeadProactiveOutput, leadProactiveReport, leadWaitNeedsChange, LEAD_CONTROL_REFUSALS, LEAD_MANAGEMENT_REASONS, parseLeadCardDecisionFor, parseLeadWindowProjection, parseLeadSettingsProjection, parseLeadSettingsUpdate, parseLeadNameReceipt,
  parseLeadOrigin, type LeadOrigin, parseLeadThreadSend, parseLeadResume, parseLeadActionInput, parseLeadSteerInput, type LeadSteer, type LeadAction, type LeadActionInput,
  parseLeadBudgetRaise, parseLeadSpendLimitSet, leadNoSpendLimit, type LeadBudgetRaise, type LeadSpendLimitSet, type LeadScheduledTask, type LeadAcceptanceContract, type LeadCard, type LeadCardDecision, type LeadWindowProjection, type LeadControlRefusal, type LeadProject,
  type LeadSettingsProjection, type LeadSettingsUpdate, type LeadNameReceipt, type LeadThreadSend, type WireNotification, type LeadPresence,
} from '@harnessdesk/protocol'
import { isLeadPlanRenewal, hasUncertainLeadChatEffect, leadDecisionRevisionMatches, canOfferAutomaticLeadGoal, canBeginLeadGoal, canReplaceLeadPlan, leadPlanRuns, leadBudgetProjection, leadLimitedCaps, leadApprovedPlan, leadPlanMoment, leadWithPlan, leadHistory, leadAppendUser, type LeadContextMark, type LeadJournal, type LeadState, type LeadStopFrom, type MessagesTurn } from '@harnessdesk/lead'
import type { LeadService } from './service.js'
import { admitLeadCard, leadApprovalCards, leadProgress, leadRunTeam, leadWindowThread } from './projection.js'
import { leadContainsSecret } from './secrets.js'
import { leadMemoryScan, leadRememberRequest } from './memory-scan.js'
import type { LeadContextStore } from './context-store.js'
import type { LeadContextFacts } from '@harnessdesk/protocol'

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
/** What the Lead already did since it last spoke, said as a desk observation. */
const leadEffectsObservation = ({ started, sent, stopped }: { readonly started: number; readonly sent: number; readonly stopped: number }): string => {
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
  const did = [started ? `started ${count(started, 'chat')}` : '', sent ? `sent ${count(sent, 'message')} to chats` : '', stopped ? `stopped ${count(stopped, 'chat')}` : '']
    .filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' and $1')
  return `Desk observation: since your last reply to the person you already ${did}. Those actions are done: do not repeat them. Use chat_list to see where each chat stands, then tell the person what you did and what happens next.`
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
  readonly revokeApproval?: (input: { readonly id: string; readonly contractDigest: string }) => Promise<void>
  readonly performAction?: (input: LeadActionInput) => Promise<void>
  /** Host revalidates the live Flow, card and evidence on the journal's decision queue. */
  readonly decidePerson: (card: Extract<LeadCard, { type: 'waiting' }>, decision: LeadCardDecision, contract: LeadAcceptanceContract) => Promise<void>
  readonly decideResult: (card: Extract<LeadCard, { type: 'result' }>, decision: LeadCardDecision, contract: LeadAcceptanceContract) => Promise<void>
  readonly publishResult?: (card: Extract<LeadCard, { type: 'result' }>, decision: LeadCardDecision, contract: LeadAcceptanceContract) => Promise<void>
  readonly reclaimBranch?: (card: Extract<LeadCard, { type: 'branch-ownership' }>, decision: LeadCardDecision) => Promise<void>
  readonly approveRepeat?: (cardId: string, contract: LeadAcceptanceContract, reactivate: boolean) => Promise<void>
  readonly validateRepeat?: (contract: LeadAcceptanceContract) => Promise<string | null>
  readonly freezeRepeat?: (contract: LeadAcceptanceContract) => Promise<LeadAcceptanceContract>
  readonly stopRequest?: () => Promise<void>
  /** Reads the workers' spend again; a Lead request is refused while that spend is not known. */
  readonly meterSpend?: () => Promise<void>
  readonly stopEffects?: () => Promise<void>
  /** Child execution may continue across multiple service.send results. */
  readonly readRequestInFlight?: () => boolean
  readonly readActiveTool?: () => string | null
  readonly readChatEffectQueued?: () => boolean
  /** The Lead's latest checks between turns; shown only while a goal runs. */
  readonly readPresence?: () => LeadPresence | null
  /** Hands the text to the goal's worker that is in a turn; false when none took it. */
  readonly steerWorker?: (text: string) => Promise<boolean>
  /** The open work cards, already bounded; they ride the end of each request and are never stored in the thread. */
  readonly readWorkContext?: (turn: { readonly proactive: boolean }) => Promise<string | null>
  /** The stored conversation. Absent, each request is rebuilt from the words the person can read, as before. */
  readonly context?: Pick<LeadContextStore, 'request' | 'due' | 'compact' | 'facts' | 'compacting' | 'epoch'> & Partial<Pick<LeadContextStore, 'settle'>>
  /** Test seam for the idle check after a step was recorded. */
  readonly scheduleContextCheck?: (run: () => void) => void
}
/** One host owner, no transport or rendering. Child ports never contain these operations. */
export class LeadControls {
  #tail: Promise<unknown> = Promise.resolve()
  #notifications: Promise<void> = Promise.resolve()
  #failedRevision: number | null = null
  // Steers live with the goal they were sent in; a new goal starts an empty list.
  #steers: { readonly goal: string | null; readonly list: LeadSteer[] } = { goal: null, list: [] }
  #replySince: number | null = null
  #runningSince: { readonly goal: string | null; readonly at: number } | null = null
  #continuation: Promise<void> | null = null
  #continueAgain = false
  #requestInFlight = false
  #automaticRequest = false
  /** Set only by a path the person took (their own message, their plan approval, their resume); read once by the next request. */
  #personRequest = false
  #requestWaitReason: string | null = null
  #requestConversation = true
  #closed = false
  #lastRevision = -1
  #actionsGeneration = 0
  #actions: { readonly scope: string; readonly generation: number; readonly value: readonly LeadAction[] } | null = null
  readonly #detach: () => void
  #contextWork: Promise<unknown> = Promise.resolve()
  #contextCheck = false
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
      follow: this.options.journal.state.follow, key: { configured: key.configured, protection: key.protection === 'file permissions only' ? 'unavailable' : 'encrypted' }, policy, caps: budget.caps,
      ...(this.options.journal.state.spendLimit ? { spendLimitUsdMicros: this.options.journal.state.spendLimit.usdMicros } : {}) })
  }
  async #projection(liveActions = true): Promise<LeadWindowProjection> {
    // Renewal is opportunistic. A refusal must leave reads and key removal usable.
    try { await this.options.journal.renewPlan(this.options.now(), card =>
      admitLeadCard(this.options.journal.state, card, this.options.project, this.options.model)) } catch { /* Keep the last durable projection readable. */ }
    const settings = await this.#settings()
    let state = this.options.journal.state
    // Settings reads may yield to a journal write. Retry from one coherent revision.
    if (settings.name !== state.name || settings.policy.revision !== state.policy?.revision || JSON.stringify(settings.caps) !== JSON.stringify(state.budget?.caps) || settings.spendLimitUsdMicros !== state.spendLimit?.usdMicros || JSON.stringify(settings.follow) !== JSON.stringify(state.follow)) return this.#projection(liveActions)
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
        JSON.stringify(settings.caps) !== JSON.stringify(latest.budget?.caps) || settings.spendLimitUsdMicros !== latest.spendLimit?.usdMicros || JSON.stringify(settings.follow) !== JSON.stringify(latest.follow)) return this.#projection(liveActions)
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
    const auditFailed = state.managementReason === 'lead-worker-audit-failed'
    const approvalHistory = boundLeadApprovalHistory(state.workerApprovals.map(rule => ({ ...rule, entries: auditFailed ? leadWorkerApprovalEntries(rule) : rule.entries ?? [] })))
    const requestInFlight = this.#inFlight()
    if (!requestInFlight) this.#replySince = null
    else this.#replySince ??= this.options.now()
    const activity = requestInFlight ? { since: this.#replySince!, method: this.options.readActiveTool?.() ?? null } : null
    const { stage, reason: stageReason } = leadThreadStage(state, thread, personActions, waitReason as LeadWindowProjection['waitReason'], requestInFlight, this.options.readChatEffectQueued?.() ?? false)
    const result = parseLeadWindowProjection({ stage, stageReason, version: 1, revision: state.seq, thread, settings, wayOut, waitReason,
      planConsentExpiresAt: state.consent?.expiresAt ?? null, requestInFlight, ...(activity && { activity }), personActions, savedApprovals: approvalHistory.filter(rule => !rule.revoked).map(({ id, target, count, entries, dispatch }) => ({ id, target, count, ...(dispatch && auditFailed ? { uncertain: true } : {}), ...(entries?.length ? { entries } : {}) })), revokedApprovals: approvalHistory.filter(rule => rule.revoked).map(({ id, target, count, entries }) => ({ id, target, count, ...(entries?.length ? { entries } : {}) })), ...(progress && { progress }), ...(team && { team }), ...(presence && { presence }), ...(steers.length && { steers }) })
    try { await this.options.service.assertPublic(result, state.seq) } catch (error) { this.#publicFailure(error) }
    return result
  }
  #inFlight(): boolean {
    return this.#requestInFlight || this.options.readRequestInFlight?.() === true
  }
  #resumable(state: LeadState, explicit = false): boolean {
    if (state.orphanedWorkerDispatch && !explicit) return false
    if (state.workerApprovals.some(rule => rule.dispatch) || ['stopped', 'accepted', 'declined', 'following'].includes(state.phase) || state.budget?.stop || state.recoveryBlocked || this.#inFlight()) return false
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
    return this.#resumable(state, true) ? 'resume' : null
  }
  #publicFailure(error: unknown): never {
    throw leadRefusal((error as { wireCode?: unknown })?.wireCode === 'lead-protection-unavailable' ? 'lead-protection-unavailable' : 'lead-secret-refused')
  }
  #unanswered(): boolean {
    const state = this.options.journal.state
    return !this.#continuation && state.messages.findLast(message => message.role === 'user' || message.role === 'assistant')?.role === 'user'
  }
  workerApprovalsChanged(): Promise<void> {
    this.#actionsGeneration++
    return this.#queue(async () => { if (!this.#closed) await this.#notify(true) })
  }
  async readWakes() { const state = this.options.journal.state; return { revision: state.seq, wakes: state.wakes } }
  readThread(): Promise<LeadWindowProjection> { return this.#projection().catch(error => this.#refuse(error)) }
  readSettings(): Promise<LeadWindowProjection> { return this.#projection().catch(error => this.#refuse(error)) }
  revokeApproval(value: { readonly id: string; readonly contractDigest: string }): Promise<LeadWindowProjection> { return this.#queue(async () => {
    const input = parseLeadApprovalRevoke(value)
    if (!this.options.revokeApproval) throw leadRefusal('lead-operation-refused')
    await this.options.revokeApproval(input)
    void this.#notify(true)
    return this.#projection()
  }) }
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
    // A request to keep words aimed at an agent is refused here, before the model reads it: memory is read on every
    // later turn, so the scan every proposal passes runs on the person's request too (docs/decisions.md).
    const kept = automaticOrigin ? null : leadRememberRequest(input.text)
    if (kept !== null) {
      const scan = leadMemoryScan(kept)
      if (!scan.ok && scan.reason === 'instruction') throw leadRefusal('lead-memory-instruction-refused')
    }
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
      const receipt = await journal.appendMessage(input.idempotencyKey, input.text, origin ? origin.source === 'schedule' ? 'schedule' : 'automatic' : 'person', committed)
      if (resume) await journal.resume(undefined, true, committed)
      return receipt
    }, !!origin)
  }) }
  async #commitRequest<T>(commit: (committed: () => void) => Promise<T>, proactive = false,
    waitReason = this.options.journal.state.managementReason, conversation = true, person = !proactive): Promise<T> {
    let committed = false
    try { return await commit(() => { committed = true; this.#requestInFlight = true; this.#automaticRequest = proactive; if (person) this.#personRequest = true; this.#requestWaitReason = waitReason; this.#requestConversation = conversation }) }
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
    const proactive = this.#automaticRequest, person = this.#personRequest; this.#automaticRequest = false; this.#personRequest = false
    if (['accepted', 'declined', 'stopped'].includes(journal.state.phase) || journal.state.budget?.stop || journal.state.managementReason === 'lead-worker-audit-failed') {
      this.#requestInFlight = false
      await journal.settingsChanged()
      return
    }
    try {
      try { await this.options.meterSpend?.() } catch { /* The Lead itself refuses while spend stays unknown. */ }
      const waitReason = this.#requestWaitReason
      this.#requestWaitReason = null
      const { context } = this.options
      let persons: readonly string[] = []
      const build = async () => {
        // With the context engine the request starts from the stored conversation, tool pairs and all; without it,
        // from the words the person can read. Either way no reasoning from an earlier request is carried.
        const stored = context ? await context.request() : null
        persons = stored?.persons ?? []
        let messages: MessagesTurn[] = stored ? [...stored.messages] : leadHistory(journal.state.messages)
        // Once a plan is approved every request carries the contract, because the standing instructions say it
        // arrives in a message. It is the host's own words, kept in the stored conversation as they are (`kept`), so
        // a later wake still reads the plan's step ids. With the context engine it is stored once: a conversation that
        // already carries it gets no second copy, and one a checkpoint took it from gets it again. Without it, the
        // words the person can read never hold it, so it goes on every request.
        const { contract, steps } = journal.state
        let kept: LeadContextMark | null = null
        // What follows is desk context of this moment: after the cache mark, and stubbed when the step is stored.
        const desk: { type: 'text'; text: string }[] = []
        if (contract) {
          const planned = leadWithPlan(messages, leadApprovedPlan(contract))
          messages = planned.messages; kept = stored ? planned.kept ?? null : null
          // Where the plan stands now (step states, its runs, the open waits) is of this moment, never kept verbatim.
          desk.push(...leadPlanMoment({ contract, steps, runs: leadPlanRuns(journal.state), mayProposeNewPlan: canReplaceLeadPlan(journal.state),
            personActions: await this.options.readPersonActions?.() ?? [] }))
        }
        const recovery = leadRecoveryContext(waitReason)
        if (recovery) desk.push({ type: 'text', text: recovery })
        // Chats the Lead already started or wrote to since its last reply are not in the words above, so a Lead resumed
        // after a silent or failed turn is told, or it reads the request as undone and repeats it.
        const done = journal.state.chatEffectsSinceReply
        if (done.started || done.sent || done.stopped) desk.push({ type: 'text', text: leadEffectsObservation(done) })
        // Before a plan is approved a request still ends in a user turn.
        if (!contract && messages.at(-1)?.role !== 'user' && !desk.length) desk.push({ type: 'text',
          text: 'Continue the conversation from the person\'s latest message. Answer directly or use an ordinary chat for a task. Offer a reviewed plan only when the work needs that workflow; no plan has been approved.' })
        // The work ledger is desk context, read fresh for each request: it closes the request and is never kept in history.
        let work: string | null = null
        try { work = await this.options.readWorkContext?.({ proactive: !!proactive }) ?? null } catch { /* A request without the cards still answers. */ }
        if (work) desk.push({ type: 'text', text: work })
        // One user turn: the person's words, the plan and the desk's context of this moment are never two turns in a row.
        messages = leadAppendUser(messages, desk)
        return { maxTokens: LEAD_OUTPUT_TOKENS, messages, conversation: this.#requestConversation,
          ...(stored ? { epoch: stored.epoch, ...(stored.base ? { base: stored.base } : {}), ...(stored.stable ? { stable: stored.stable } : {}), ...(kept ? { kept } : {}) } : {}),
          ...(proactive ? { proactive: true } : {}),
          // Only the person's own path is the person's; every other request (a scheduled run, a trigger's) names its source, and one that names none is automatic.
          wakeSource: person ? 'person' as const : journal.state.origin?.source === 'schedule' ? 'schedule' as const : 'trigger' as const }
      }
      // A compaction under way finishes first; past the hard line one runs now, whatever else is happening.
      await this.#contextWork
      if (context?.due() === 'hard') await this.#compactContext('hard')
      let result = await service.send(await build())
      // The provider counted more than the window: compact and try once more.
      if (context && result.status === 'failed' && result.reason === 'lead-messages-too-long') {
        await this.#compactContext('overflow')
        result = await service.send(await build())
      }
      // A reply whose step could not be stored still answered the person: store their words with it.
      if (persons.length) try { await context?.settle?.(persons) } catch { /* The next request sends them again. */ }
      if (result.text) await service.assertPublic(result.text)
      if (result.ask) {
        parseLeadMessage({ version: 1, id: 'reply', revision: 1, role: 'assistant', text: result.text ?? '', ask: result.ask, ...(result.proactive ? { proactive: result.proactive } : {}) })
        await service.assertPublic(parseLeadAsk(result.ask))
      }
      this.#requestInFlight = this.#continueAgain
      if ((proactive ? result.proactive : result.text || result.ask) && !['accepted', 'declined', 'stopped'].includes(journal.state.phase)) {
        if (proactive) {
          const report = leadProactiveReport(parseLeadProactiveOutput(result.proactive!), 0, 1, false)
          await service.assertPublic(report)
          await journal.appendReply([report.finding, report.caveat, report.ask].join('\n'), report)
        } else await journal.appendReply(result.text ?? '', undefined, result.ask)
      }
      else if (result.status === 'refused' && !['accepted', 'declined', 'stopped', 'waiting-for-user'].includes(journal.state.phase) && journal.state.budget &&
        leadBudgetProjection(journal.state.budget, this.options.now()).spend !== 'known') {
        // The Lead declines to spend while the workers' spend is unknown. Say so, rather than leave a message unanswered.
        await journal.setManagementPhase('waiting-for-user', 'lead-budget-unknown')
      }
      else await journal.settingsChanged()
      this.contextChanged()
    } catch {
      this.#requestInFlight = this.#continueAgain
      const revision = journal.state.seq
      if (!['accepted', 'declined', 'stopped'].includes(journal.state.phase)) await journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
      if (journal.state.seq === revision) await journal.settingsChanged()
    }
  }
  /** One compaction at a time, the person's request behind it; a failure leaves the conversation as it was. */
  #compactContext(trigger: 'soft' | 'hard' | 'manual' | 'overflow'): Promise<unknown> {
    const context = this.options.context
    if (!context || this.#stopped()) return Promise.resolve()
    const work = this.#contextWork.then(() => context.compact(trigger, input => this.options.service.send(input)))
    this.#contextWork = work.catch(() => {}).finally(() => this.#notify())
    void this.#notify()
    return work.catch(() => {})
  }
  /**
   * A step was stored: past the soft line, compact once the Lead is idle (no request of the host's and none of the
   * child's in flight), so the person never waits on it. Checked again until idle, at most once a second.
   */
  contextChanged(): void {
    if (!this.options.context || this.#contextCheck || this.#closed) return
    this.#contextCheck = true
    const check = () => {
      this.#contextCheck = false
      if (this.#closed || this.#stopped() || this.options.context?.due() == null) return
      if (this.#continuation || this.options.readRequestInFlight?.() || this.options.context.compacting) { this.contextChanged(); return }
      void this.#compactContext('soft')
    }
    ;(this.options.scheduleContextCheck ?? (run => { setTimeout(run, 1000).unref?.() }))(check)
  }
  /** Stopped, finished or out of budget: no compaction spends. */
  #stopped(): boolean {
    const state = this.options.journal.state
    return ['accepted', 'declined', 'stopped'].includes(state.phase) || !!state.budget?.stop
  }
  /**
   * Before a desk wake, from the child, outside its turn queue: compact past the hard line (`due`), or because the
   * provider refused the wake as too long (`overflow`). True when the stored conversation moved to a new epoch.
   */
  async compactForWake(trigger: 'due' | 'overflow'): Promise<boolean> {
    const context = this.options.context
    if (!context || this.#closed || this.#stopped()) return false
    const before = context.epoch
    await this.#contextWork
    if (trigger === 'overflow' || context.due() === 'hard') await this.#compactContext(trigger === 'overflow' ? 'overflow' : 'hard')
    return context.epoch !== before
  }
  async readContext(): Promise<LeadContextFacts> {
    if (!this.options.context) throw leadRefusal('lead-unavailable')
    return this.options.context.facts()
  }
  /** The person's "Summarise now": refused while the Lead is answering, so it never cuts a turn in half. */
  compactContext(): Promise<LeadContextFacts> {
    return this.#queue(async () => {
      const { context } = this.options
      if (!context) throw leadRefusal('lead-unavailable')
      if (this.#continuation || this.options.readRequestInFlight?.() || context.compacting) throw leadRefusal('lead-request-in-flight')
      await this.#compactContext('manual')
      return context.facts()
    })
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
    const commit = async (committed?: () => void) => { await journal.decideCard(decision, card.type === 'plan' && decision.choice === 'approve' ? this.options.now() + LEAD_PLAN_CONSENT_MS : null,
      this.options.stopEffects, card.type === 'waiting' || card.type === 'result' ? async () => {
        const contract = journal.state.contract
        if (!contract || contract.digest !== card.contractDigest) throw leadRefusal('lead-card-stale')
        if (card.type === 'waiting') await this.options.decidePerson(card, decision, contract)
        else if (!(card.publication === 'push' && decision.choice === 'decline')) await this.options.decideResult(card, decision, contract)
      } : undefined, committed)
      if (card.type === 'plan' && decision.choice === 'approve' && card.contract.repeat) {
        try { await this.options.approveRepeat?.(card.id, card.contract, !isLeadPlanRenewal(state, card)) }
        catch { await journal.appendReply('The repeat could not be saved. This approval applies to this run only.') }
      }
    }
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
  raiseBudget(value: LeadBudgetRaise): Promise<LeadWindowProjection> { return this.#queue(async () => {
    const input = parseLeadBudgetRaise(value)
    await this.options.journal.raiseBudget(input.logicalGoalId, input.caps, input.expectedRevision, this.options.now())
    return this.#projection()
  }) }
  /** The person's money limit, or Off. Like a raise it is the person's own decision, so it applies to the goal in hand
   * without a card, behind the same revision fence; it never touches rounds or permissions. */
  setSpendLimit(value: LeadSpendLimitSet): Promise<LeadWindowProjection> { return this.#queue(async () => {
    const input = parseLeadSpendLimitSet(value)
    await this.options.journal.setSpendLimit(input.usdMicros, input.expectedRevision, this.options.now(), this.options.stopEffects)
    return this.#projection()
  }) }
  /** A schedule slot redeems only a previously person-approved contract, and gets
   * its own logical goal, step ids, budget and fresh host-clock consent. */
  /**
   * A reminder the Lead set on a work item wakes it while a conversation is open, as the same schedule-sourced
   * proactive request a scheduled run makes. False when it cannot go now (a request in flight, an uncertain effect,
   * a closed or waiting thread, no key); the host's minute timer offers it again. A closed thread takes it through
   * the automatic-goal path instead.
   */
  remind(key: string, text: string): Promise<boolean> { return this.#queue(async () => {
    const { journal, service } = this.options
    if (journal.state.sends.some(send => send.key === key)) return true
    if (this.#inFlight() || hasUncertainLeadChatEffect(journal.state) || journal.state.budget?.stop) return false
    if (!['draft', 'running', 'following'].includes(journal.state.phase)) return false
    if (leadContainsSecret([text])) return false
    const status = await service.status('anthropic').catch(() => null)
    if (!status?.configured || status.unavailable) return false
    await this.#commitRequest(committed => journal.appendMessage(key, text, 'schedule', committed), true)
    return true
  }) }
  runScheduled(task: LeadScheduledTask, slot: number): Promise<{ logicalGoalId: string; approved: boolean; reason?: string }> { return this.#queue(async () => {
    const { journal, service } = this.options
    if (this.#inFlight() || !(canBeginLeadGoal(journal.state) || journal.state.phase === 'draft' && !journal.state.messages.length)) throw leadRefusal('lead-request-in-flight')
    // The same scan as a typed send: a scheduled title or goal reaches the thread and the model.
    if (leadContainsSecret([task.title, task.goal])) throw leadRefusal('lead-secret-refused')
    const status = await service.status('anthropic')
    if (!status.configured || status.unavailable) throw leadRefusal('lead-key-missing')
    if (canBeginLeadGoal(journal.state)) {
      try { await this.options.stopRequest?.() } catch { throw leadRefusal('lead-repeat-cleanup-pending') }
      if (this.#continuation) await this.#continuation
      if (!canBeginLeadGoal(journal.state)) throw leadRefusal('lead-repeat-cleanup-pending')
      await journal.beginGoal(this.options.nextId(), this.options.now())
    }
    if (task.project && task.project !== this.options.project.path) await this.options.automaticProject?.(task.project)
    const key = `schedule-${task.id}-${slot}`
    await journal.setOrigin({ source: 'schedule', event: 'scheduled-run', subject: String(slot), url: null }, key)
    await journal.appendMessage(key, `Scheduled: ${task.title}${task.goal.trim() === task.title.trim() ? '' : `\n${task.goal}`}`, 'schedule')
    const logicalGoalId = journal.state.budget!.logicalGoalId
    if (!task.approved || !this.options.freezeRepeat || !this.options.validateRepeat) {
      this.#requestInFlight = true; this.#automaticRequest = true; this.#detachContinue()
      return { logicalGoalId, approved: false }
    }
    const reason = await this.options.validateRepeat(task.approved.contract)
    const original = task.approved.contract
    // Each run takes the person's limit as it stands now: a set limit caps the figure the repeat was approved with, Off keeps it.
    const perRun = leadLimitedCaps(journal.state.spendLimit, task.perRunCaps ?? original.caps)
    if (reason) {
      await journal.appendReply(`This run needs your approval: ${reason}`)
      await journal.appendMessage(`${key}-changed`, `Draft a fresh reviewed plan for this recurring task. Repeat ${task.every} at ${task.at}, with ${leadNoSpendLimit(perRun.usdMicros) ? 'no spending limit' : `up to ${perRun.usdMicros} microdollars`} and ${perRun.rounds} rounds per run. ${task.goal}`, 'schedule')
      this.#requestInFlight = true; this.#requestConversation = false; this.#detachContinue()
      return { logicalGoalId, approved: false, reason }
    }
    const contract = await this.options.freezeRepeat({ ...original, revision: Math.max(original.revision + 1, journal.state.seq + 1), digest: '0'.repeat(64), policyRevision: journal.state.policy!.revision,
      steps: original.steps.map(step => ({ ...step, id: this.options.nextId() })), caps: perRun })
    const card = await journal.offerCard({ version: 1, id: this.options.nextId(), revision: 1, type: 'plan', contractDigest: contract.digest, contract }, card =>
      admitLeadCard(journal.state, card, this.options.project, this.options.model))
    const recheck = await this.options.validateRepeat(original)
    if (recheck) { await journal.appendReply(`This run needs your approval: ${recheck}`); return { logicalGoalId, approved: false, reason: recheck } }
    await this.#commitRequest(committed => journal.decideCard({ version: 1, cardId: card.id, cardType: 'plan', expectedRevision: card.revision,
      contractDigest: card.contractDigest, choice: 'approve' }, this.options.now() + LEAD_PLAN_CONSENT_MS, this.options.stopEffects, undefined, committed), false, null, false, false)
    return { logicalGoalId, approved: true }
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
      await journal.settingsChanged(undefined, undefined, 'credential')
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
  /**
   * A stop asked for elsewhere than the person's Stop — a comment on the thread that opened this goal — taken exactly as
   * Stop takes it: journaled with where it came from, the goal's owned runs stopped, then the model process ended. `owns`
   * is read on the queue, against the journal as it is then, so a goal begun meanwhile is never the one stopped. False
   * when `owns` refuses or the goal has already ended, and nothing is done.
   */
  stopAsked(from: LeadStopFrom, owns: (state: LeadState) => boolean): Promise<boolean> { return this.#queue(async () => {
    const { journal } = this.options
    if (['accepted', 'declined', 'stopped'].includes(journal.state.phase) || !owns(journal.state)) return false
    this.#continueAgain = false
    await journal.stop(this.options.stopEffects, from)
    await this.options.stopRequest?.()
    if (this.#continuation) await this.#continuation
    return true
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
