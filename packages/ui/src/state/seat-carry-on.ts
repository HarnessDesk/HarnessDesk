import { sessionKey, type CarryOnDecision, type CarryOnIncidentView, type HostMethodName, type HostParams, type HostResult, type WireNotification } from '@harnessdesk/protocol'

interface SeatCarryOnTransport {
  request<M extends HostMethodName>(method: M, params: HostParams<M>): Promise<HostResult<M>>
}

/**
 * Carry-on incidents of Team and Flow seats, keyed by the seat's
 * conversation. A seat's question is shown on its Team's own `limit` notice,
 * never over a composer, so the window keeps only the seat-owned ones here;
 * the host owns the incident and the decision, and a refusal reaches the
 * caller as the host's error.
 */
export const createSeatCarryOnState = (transport: SeatCarryOnTransport) => {
  let state: ReadonlyMap<string, CarryOnIncidentView> = new Map()
  const listeners = new Set<() => void>()
  const set = (next: ReadonlyMap<string, CarryOnIncidentView>) => { state = next; for (const listener of listeners) listener() }
  const keep = (key: string, incident: CarryOnIncidentView | null) => {
    const next = new Map(state)
    if (incident && incident.owner === 'seat') next.set(key, incident)
    else next.delete(key)
    set(next)
  }
  return {
    get state(): ReadonlyMap<string, CarryOnIncidentView> { return state },
    reset(): void { set(new Map()) },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    changed(notification: WireNotification): void {
      if (notification.method !== 'carryOn/changed') return
      const { key, incident } = notification.params
      keep(sessionKey(key.runtime, key.sessionId), incident)
    },
    /** A whole list from the host: the seats' questions still open. The store's one carry-on read hands it on. */
    listed(incidents: readonly CarryOnIncidentView[]): void {
      set(new Map(incidents.filter((one) => one.owner === 'seat').map((one) => [sessionKey(one.runtime, one.sessionId), one])))
    },
    async refresh(): Promise<void> {
      const { incidents } = await transport.request('carryOn/list', {})
      this.listed(incidents)
    },
    async decide(decision: CarryOnDecision): Promise<void> {
      const { incident } = await transport.request('carryOn/decide', decision)
      keep(sessionKey(incident.runtime, incident.sessionId), incident)
    },
  }
}
