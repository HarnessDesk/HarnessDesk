import type {
  HostMethodName, HostParams, HostResult, LeadCardDecision, LeadWindowProjection, LeadSettingsProjection, LeadSettingsUpdate, LeadThread, WireNotification,
} from '@harnessdesk/protocol'

interface LeadTransport {
  request<M extends HostMethodName>(method: M, params: HostParams<M>): Promise<HostResult<M>>
}
export interface LeadState {
  readonly revision: number
  readonly thread: LeadThread | null
  readonly settings: LeadSettingsProjection | null
  readonly wayOut: 'resume' | 'decide-plan' | null
}
/** State and actions only. The owner supplies a feature capability, never a runtime id. */
export const createLeadState = (transport: LeadTransport, available: () => boolean) => {
  let state: LeadState = { revision: -1, thread: null, settings: null, wayOut: null }
  const listeners = new Set<() => void>()
  const check = () => { if (!available()) throw Object.assign(new Error('Lead is unavailable'), { code: 'lead-unavailable' }) }
  const keep = (thread: LeadThread, settings: LeadSettingsProjection, wayOut: LeadState['wayOut']) => {
    if (thread.revision < state.revision) return
    state = { revision: thread.revision, thread, settings, wayOut }
    for (const listener of listeners) listener()
  }
  const apply = (projection: LeadWindowProjection) => keep(projection.thread, projection.settings, projection.wayOut)
  return {
    get state(): LeadState { return structuredClone(state) },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    changed(notification: WireNotification): void { if (available() && notification.method === 'lead/changed') apply(notification.params) },
    async readThread() { check(); const result = await transport.request('lead/thread/read', {}); apply(result); return result.thread },
    async readSettings() { check(); const result = await transport.request('lead/settings/read', {}); apply(result); return result.settings },
    async send(text: string, idempotencyKey: string) {
      check(); const receipt = await transport.request('lead/thread/send', { text, idempotencyKey })
      const result = await transport.request('lead/thread/read', {}); apply(result); return receipt
    },
    async decide(decision: LeadCardDecision) { check(); const result = await transport.request('lead/card/decide', decision); apply(result); return result },
    async updateSettings(update: Omit<LeadSettingsUpdate, 'expectedRevision'>) {
      check(); const result = await transport.request('lead/settings/update', { ...update, expectedRevision: state.revision }); apply(result); return result
    },
    async resume() { check(); const result = await transport.request('lead/resume', { expectedRevision: state.revision }); apply(result); return result },
  }
}
