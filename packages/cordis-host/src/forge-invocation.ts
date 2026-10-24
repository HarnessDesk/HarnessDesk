import { AsyncLocalStorage } from 'node:async_hooks'
import type { ScopeQuery } from '@harnessdesk/protocol'

const storage = new AsyncLocalStorage<{ owner: string; scope: ScopeQuery; controller: AbortController }>()
/** Host entry points own the lifetime and scope, including callbacks retained by a plugin. */
export async function inForgeInvocation<T>(owner: string, scope: ScopeQuery, run: () => T | Promise<T>): Promise<T> {
  const controller = new AbortController()
  try { return await storage.run({ owner, scope: Object.freeze({ ...scope }), controller }, run) }
  finally { controller.abort() }
}
export function invocationScope(owner: string, claimed?: ScopeQuery): { scope: ScopeQuery; signal: AbortSignal } {
  const current = storage.getStore()
  if (!current || current.owner !== owner || current.controller.signal.aborted ||
    claimed?.runtime !== current.scope.runtime || claimed?.sessionId !== current.scope.sessionId) {
    throw new Error('Refused: this forge call does not ride a live invocation for this conversation, so it cannot be attributed.')
  }
  return { scope: current.scope, signal: current.controller.signal }
}
