import type {
  LeadChatControl, LeadChatControlList, LeadWakeRecord, HostMethodName, HostParams, HostResult, LeadAction, LeadActionInput, LeadCardDecision, LeadChanged, LeadMemory, LeadPresence, LeadSchedule, LeadProgress, LeadSteer, LeadWindowProjection, LeadSettingsProjection, LeadSettingsUpdate, LeadThread, WireNotification,
} from '@harnessdesk/protocol'

interface LeadTransport {
  request<M extends HostMethodName>(method: M, params: HostParams<M>): Promise<HostResult<M>>
}
export interface LeadState {
  /** Chats the Lead has written to, their holders and its envelope keys. */
  readonly chats: readonly LeadChatControl[]
  readonly chatControlProblem: LeadChatControlList['problem'] | null
  readonly wakes?: readonly LeadWakeRecord[]
  readonly personActions: readonly LeadAction[]
  readonly revision: number
  readonly thread: LeadThread | null
  readonly settings: LeadSettingsProjection | null
  readonly requestInFlight: boolean
  readonly wayOut: 'resume' | 'decide-plan' | null
  readonly waitReason: LeadWindowProjection['waitReason']
  readonly planConsentExpiresAt: number | null
  /** Where a running goal stands; null whenever the host reports none. */
  readonly progress: LeadProgress | null
  /** The Team of the running goal's latest run, or null. */
  readonly team: string | null
  /** The Lead's checks between turns while a goal runs; null when the host reports none. */
  readonly presence: LeadPresence | null
  /** The person's steers to the running worker in this goal. */
  readonly steers: readonly LeadSteer[] | null
  readonly error: 'lead-projection-failed' | null
}
/** State and actions only. The owner supplies a feature capability, never a runtime id. */
export const createLeadState = (transport: LeadTransport, available: () => boolean) => {
  const initial = (): LeadState => ({ chats: [], chatControlProblem: null, personActions: [], revision: -1, thread: null, settings: null, requestInFlight: false, wayOut: null, waitReason: null, planConsentExpiresAt: null, progress: null, team: null, presence: null, steers: null, error: null })
  let state = initial(), wakeRevision = -1
  const listeners = new Set<() => void>()
  const check = () => { if (!available()) throw Object.assign(new Error('Lead is unavailable'), { code: 'lead-unavailable' }) }
  const checkRead = () => { check(); if (state.revision < 0 || state.error) throw Object.assign(new Error('Lead is unavailable'), { code: 'lead-unavailable' }) }
  const apply = (projection: LeadChanged, requestedFrom?: LeadState) => {
    if (!available()) return
    // A response started before a live update cannot put its older approval
    // snapshot back over that update at the same durable revision.
    if (projection.revision === state.revision && requestedFrom && requestedFrom !== state) return
    if (projection.revision < state.revision || projection.revision === state.revision && 'error' in projection) return
    if (projection.revision === state.revision && !state.error && !('error' in projection)) {
      // Worker approvals are live host relays. Their cards may change while
      // the journal revision used by settings and Resume stays unchanged.
      const approvals = (thread: LeadThread | null) => thread?.cards.filter(card => card.type === 'waiting' && card.kind === 'worker-approval') ?? []
      if (JSON.stringify(approvals(projection.thread)) === JSON.stringify(approvals(state.thread)) && JSON.stringify(projection.personActions ?? []) === JSON.stringify(state.personActions)) return
    }
    state = 'error' in projection
      ? { ...state, revision: projection.revision, wayOut: null, error: projection.error }
      : structuredClone({ chats: state.chats, chatControlProblem: state.chatControlProblem, wakes: state.wakes ?? [], personActions: projection.personActions ?? [], revision: projection.revision, thread: projection.thread, settings: projection.settings, wayOut: projection.wayOut,
        requestInFlight: projection.requestInFlight, waitReason: projection.waitReason, planConsentExpiresAt: projection.planConsentExpiresAt, progress: projection.progress ?? null, team: projection.team ?? null, presence: projection.presence ?? null, steers: projection.steers ?? null, error: null })
    for (const listener of listeners) listener()
  }
  let controlVersion = 0
  const retriedControl = new Set<'transient' | 'escalated'>()
  let controlRetry: ReturnType<typeof setTimeout> | undefined
  let controlRetryKind: 'transient' | 'escalated' | undefined
  const cancelControlRetry = () => { clearTimeout(controlRetry); controlRetry = undefined; controlRetryKind = undefined }
  const applyChats = (list: LeadChatControlList) => {
    if (!available()) return
    ++controlVersion
    state = { ...state, chats: list.chats, chatControlProblem: list.problem ?? null }
    // Each retryable state gets one attempt, including an escalation caused
    // by other readers after the initial transient retry has been used.
    const retryKind = list.problem?.kind === 'transient' ? 'transient' : list.problem?.retryable ? 'escalated' : null
    if (retryKind) {
      if (controlRetryKind && controlRetryKind !== retryKind) cancelControlRetry()
      if (!retriedControl.has(retryKind)) {
        retriedControl.add(retryKind)
        controlRetryKind = retryKind
        controlRetry = setTimeout(() => {
          controlRetry = undefined; controlRetryKind = undefined
          if (available()) void readChatControl().catch(() => {})
        }, 750)
      }
    } else { cancelControlRetry(); retriedControl.clear() }
    for (const listener of listeners) listener()
  }
  const readChatControl = async () => {
    check()
    cancelControlRetry()
    const version = ++controlVersion
    try {
      const list = await transport.request('lead/chats/control', {})
      if (version === controlVersion) applyChats(list)
    } catch (failure) {
      if (available() && version === controlVersion) applyChats({ project: null, chats: state.chats,
        problem: { kind: 'transient', message: failure instanceof Error ? failure.message : String(failure) } })
      throw failure
    }
  }
  return {
    get state(): LeadState { return state },
    reset(): void { ++controlVersion; cancelControlRetry(); retriedControl.clear(); state = initial(); wakeRevision = -1; for (const listener of listeners) listener() },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    changed(notification: WireNotification): void {
      if (!available()) return
      if (notification.method === 'lead/changed') apply(notification.params)
      else if (notification.method === 'lead/chats/controlChanged') applyChats(notification.params)
    },
    readChatControl,
    async resetChatControl() { check(); applyChats(await transport.request('lead/chats/resetControl', {})) },
    async takeOverChat(id: string) { check(); applyChats(await transport.request('lead/chat/takeOver', { id })) },
    async handBackChat(id: string) { check(); applyChats(await transport.request('lead/chat/handBack', { id })) },
    async readWakes() {
      check(); const result = await transport.request('lead/wakes/read', {})
      if (available() && result.revision >= wakeRevision) {
        wakeRevision = result.revision; state = { ...state, wakes: result.wakes }
        for (const listener of listeners) listener()
      }
      return result
    },
    async readThread() { check(); const before = state; const result = await transport.request('lead/thread/read', {}); apply(result, before); return result.thread },
    async readSettings() { check(); const before = state; const result = await transport.request('lead/settings/read', {}); apply(result, before); return result.settings },
    async send(text: string, idempotencyKey: string) {
      check(); const receipt = await transport.request('lead/thread/send', { text, idempotencyKey })
      check()
      const before = state, result = await transport.request('lead/thread/read', {}); apply(result, before); return receipt
    },
    async perform(input: LeadActionInput) { check(); const before = state, result = await transport.request('lead/action/perform', input); apply(result, before); return result },
    async decide(decision: LeadCardDecision) { check(); const before = state, result = await transport.request('lead/card/decide', decision); apply(result, before); return result },
    async updateSettings(update: Omit<LeadSettingsUpdate, 'expectedRevision'>) {
      checkRead()
      const retryable = update.credential === undefined && (update.name !== undefined
        ? Object.keys(update).length === 1 : update.caps !== undefined || update.policy !== undefined)
      let result: HostResult<'lead/settings/update'>, before = state
      try { result = await transport.request('lead/settings/update', { ...update, expectedRevision: state.revision }) }
      catch (error) {
        const code = (error as { wireCode?: string; code?: string })?.wireCode ?? (error as { code?: string })?.code
        if (!retryable || code !== 'lead-revision-stale') throw error
        before = state
        const fresh = await transport.request('lead/settings/read', {}); apply(fresh, before); checkRead()
        before = state
        result = await transport.request('lead/settings/update', { ...update, expectedRevision: state.revision })
      }
      if ('thread' in result) apply(result, before)
      else if (available() && state.settings && result.revision >= state.revision) {
        // A name receipt grants no fresh thread or authority facts. Keep the
        // scanned revision until a full projection arrives through read/change.
        state = { ...state, settings: { ...state.settings, name: result.settings.name, nameChosen: result.settings.nameChosen ?? true } }
        for (const listener of listeners) listener()
      }
      return result
    },
    async stop() { checkRead(); const before = state, result = await transport.request('lead/stop', { expectedRevision: state.revision }); apply(result, before); return result },
    /** Words for the goal's running worker, taken mid-turn without a restart. */
    async steer(text: string) { checkRead(); const before = state, result = await transport.request('lead/steer', { text }); apply(result, before); return result },
    /** The timetable and the kept lines are the person's files: read and written whole, never part of the thread. */
    async readSchedule() { check(); return transport.request('lead/schedule/read', {}) },
    async updateSchedule(schedule: LeadSchedule) { check(); return transport.request('lead/schedule/update', { schedule }) },
    async controlRepeat(taskId: string, action: 'pause' | 'resume' | 'stop' | 'run-now') { check(); return transport.request('lead/repeat/control', { taskId, action }) },
    async raiseLimit(logicalGoalId: string, caps: LeadSettingsProjection['caps']) {
      checkRead(); const before = state
      const result = await transport.request('lead/budget/raise', { logicalGoalId, caps, expectedRevision: state.revision })
      apply(result, before); return result
    },
    async readMemory() { check(); return transport.request('lead/memory/read', {}) },
    async updateMemory(memory: LeadMemory) { check(); return transport.request('lead/memory/update', { memory }) },
    async resume() { checkRead(); const before = state, result = await transport.request('lead/resume', { expectedRevision: state.revision }); apply(result, before); return result },
  }
}
