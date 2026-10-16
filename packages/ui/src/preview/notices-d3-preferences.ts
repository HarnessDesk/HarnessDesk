import type { HostMethodName, HostParams } from '@harnessdesk/protocol'
import type { AppStore } from '../state/store'

/** The wait fixture exercises preference writes, which the generic frame stub omits. */
export const noticesD3Preferences = (store: AppStore) => {
  const request = store.transport.request.bind(store.transport)
  const saved: Record<string, unknown> = {}
  store.transport.request = (async (method: HostMethodName, params: HostParams<HostMethodName>) => {
    if (method === 'app/state/get') return structuredClone(saved)
    if (method === 'app/state/set') {
      Object.assign(saved, (params as HostParams<'app/state/set'>).patch)
      return structuredClone(saved)
    }
    return request(method, params as never)
  }) as typeof store.transport.request
}
