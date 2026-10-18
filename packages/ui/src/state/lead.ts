import type {
  HostMethodName, HostParams, HostResult, LeadCardDecision, LeadChanged, LeadWindowProjection, LeadSettingsProjection, LeadSettingsUpdate, LeadThread, WireNotification,
} from '@harnessdesk/protocol'

interface LeadTransport {
  request<M extends HostMethodName>(method: M, params: HostParams<M>): Promise<HostResult<M>>
}
export interface LeadState {
  readonly revision: number
  readonly thread: LeadThread | null
  readonly settings: LeadSettingsProjection | null
  readonly requestInFlight: boolean
  readonly wayOut: 'resume' | 'decide-plan' | null
  readonly waitReason: LeadWindowProjection['waitReason']
  readonly planConsentExpiresAt: number | null
  readonly error: 'lead-projection-failed' | null
}
/** State and actions only. The owner supplies a feature capability, never a runtime id. */
export const createLeadState = (transport: LeadTransport, available: () => boolean) => {
  const initial = (): LeadState => ({ revision: -1, thread: null, settings: null, requestInFlight: false, wayOut: null, waitReason: null, planConsentExpiresAt: null, error: null })
  let state = initial()
  const listeners = new Set<() => void>()
  const check = () => { if (!available()) throw Object.assign(new Error('Lead is unavailable'), { code: 'lead-unavailable' }) }
  const checkRead = () => { check(); if (state.revision < 0 || state.error) throw Object.assign(new Error('Lead is unavailable'), { code: 'lead-unavailable' }) }
  const apply = (projection: LeadChanged) => {
    if (!available()) return
    if (projection.revision < state.revision || projection.revision === state.revision && ('error' in projection || !state.error)) return
    state = 'error' in projection
      ? { ...state, revision: projection.revision, wayOut: null, error: projection.error }
      : structuredClone({ revision: projection.revision, thread: projection.thread, settings: projection.settings, wayOut: projection.wayOut,
        requestInFlight: projection.requestInFlight, waitReason: projection.waitReason, planConsentExpiresAt: projection.planConsentExpiresAt, error: null })
    for (const listener of listeners) listener()
  }
  return {
    get state(): LeadState { return state },
    reset(): void { state = initial(); for (const listener of listeners) listener() },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    changed(notification: WireNotification): void { if (available() && notification.method === 'lead/changed') apply(notification.params) },
    async readThread() { check(); const result = await transport.request('lead/thread/read', {}); apply(result); return result.thread },
    async readSettings() { check(); const result = await transport.request('lead/settings/read', {}); apply(result); return result.settings },
    async send(text: string, idempotencyKey: string) {
      check(); const receipt = await transport.request('lead/thread/send', { text, idempotencyKey })
      check()
      const result = await transport.request('lead/thread/read', {}); apply(result); return receipt
    },
    async decide(decision: LeadCardDecision) { check(); const result = await transport.request('lead/card/decide', decision); apply(result); return result },
    async updateSettings(update: Omit<LeadSettingsUpdate, 'expectedRevision'>) {
      checkRead()
      const nameOnly = update.name !== undefined && Object.keys(update).length === 1
      let result: LeadWindowProjection
      try { result = await transport.request('lead/settings/update', { ...update, expectedRevision: state.revision }) }
      catch (error) {
        const code = (error as { wireCode?: string; code?: string })?.wireCode ?? (error as { code?: string })?.code
        if (!nameOnly || code !== 'lead-revision-stale') throw error
        const fresh = await transport.request('lead/settings/read', {}); apply(fresh); checkRead()
        result = await transport.request('lead/settings/update', { ...update, expectedRevision: state.revision })
      }
      apply(result); return result
    },
    async resume() { checkRead(); const result = await transport.request('lead/resume', { expectedRevision: state.revision }); apply(result); return result },
  }
}
