import type { HostParams, HostResult, RuntimeId } from '@harnessdesk/protocol'

export type HistoryMethod = 'history/import' | 'history/cancel' | 'history/status' | 'history/list' | 'history/removeImported' | 'history/clearCached' | 'session/list'
export type HistoryRequest = <M extends HistoryMethod>(method: M, params: HostParams<M>) => Promise<HostResult<M>>

/** History on the authenticated host transport, independent of any screen.
 * Pass the full host transport's request function; the tiered outside Client
 * deliberately does not grant these storage operations. */
export const historyClient = (request: HistoryRequest) => ({
  import: (runtime: RuntimeId) => request('history/import', { runtime }),
  cancel: (runtime: RuntimeId) => request('history/cancel', { runtime }),
  status: (runtime: RuntimeId) => request('history/status', { runtime }),
  list: (params: HostParams<'history/list'> = {}) => request('history/list', params),
  /** Page the agent's own history, independently of the local index. */
  nativeList: (params: HostParams<'session/list'>) => request('session/list', params),
  removeImported: (runtime: RuntimeId) => request('history/removeImported', { runtime }),
  clearCached: () => request('history/clearCached', {}),
})
