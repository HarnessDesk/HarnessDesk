import type { HostMethodName, HostParams, HostResult, PhoneLinkState, PhonePairing, PhoneTier, WireNotification } from '@harnessdesk/protocol'

interface PhoneTransport {
  request<M extends HostMethodName>(method: M, params: HostParams<M>): Promise<HostResult<M>>
}
const off: PhoneLinkState = { enabled: false, deskName: '', deskId: '', port: null, devices: [], pending: [] }

/**
 * The desk's phone link, as the window sees it: who is paired, who is asking,
 * and the code for the next phone. State and actions only; the host owns the
 * keys and the decision, and a refusal reaches the caller as the host's error.
 */
export const createPhoneState = (transport: PhoneTransport) => {
  let state: PhoneLinkState = off
  const listeners = new Set<() => void>()
  const set = (next: PhoneLinkState) => { state = next; for (const listener of listeners) listener() }
  const refresh = async () => { const next = await transport.request('phone/state', {}); set(next); return next }
  return {
    get state(): PhoneLinkState { return state },
    reset(): void { set(off) },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    changed(notification: WireNotification): void { if (notification.method === 'phone/changed') set(notification.params) },
    refresh,
    pairing(): Promise<PhonePairing> { return transport.request('phone/pairing', {}) },
    async allow(id: string, tiers?: readonly PhoneTier[]) { await transport.request('phone/allow', tiers ? { id, tiers } : { id }) },
    async deny(id: string) { await transport.request('phone/deny', { id }) },
    async revoke(device: string) { await transport.request('phone/revoke', { device }) },
  }
}
