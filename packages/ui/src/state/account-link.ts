import type { AccountLinkState, HostMethodName, HostParams, HostResult, WireNotification } from '@harnessdesk/protocol'
interface Transport { request<M extends HostMethodName>(method: M, params: HostParams<M>): Promise<HostResult<M>> }
const off: AccountLinkState = { status: 'unavailable' }
/** The host owns the grant. A newer event or disconnect always wins over a read already in flight. */
export const createAccountLinkState = (transport: Transport) => {
  let state: AccountLinkState = off
  let revision = 0
  const listeners = new Set<() => void>()
  const set = (next: AccountLinkState) => { revision++; state = next; for (const fn of listeners) fn() }
  const request = async (method: 'account/link/state' | 'account/link/start' | 'account/link/cancel') => {
    const current = revision
    try { const next = await transport.request(method, {}); if (revision === current) set(next) }
    catch { if (revision === current) set({ status: 'error', reason: 'The desk could not complete the link. Try again.' }) }
    return state
  }
  return {
    get state(): AccountLinkState { return state },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    reset() { set(off) },
    changed(n: WireNotification) { if (n.method === 'account/link/changed') set(n.params) },
    refresh: () => request('account/link/state'), start: () => request('account/link/start'), cancel: () => request('account/link/cancel'),
  }
}
