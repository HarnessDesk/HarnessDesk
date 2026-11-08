import { AsyncLocalStorage } from 'node:async_hooks'
import { currentActor } from './provenance.js'
import type { ScopeQuery } from '@harnessdesk/protocol'

const storage = new AsyncLocalStorage<{ owner: string; scope: ScopeQuery; controller: AbortController; actor: 'agent' | 'human' | 'context' }>()
/** Host entry points own the lifetime and scope, including callbacks retained by a plugin. */
export async function inForgeInvocation<T>(owner: string, scope: ScopeQuery, run: () => T | Promise<T>): Promise<T> {
  const controller = new AbortController()
  try { return await storage.run({ owner, scope: Object.freeze({ ...scope }), controller, actor: currentActor() === 'human' ? 'human' : currentActor() === 'agent' ? 'agent' : 'context' }, run) }
  finally { controller.abort() }
}
export function invocationScope(owner: string, claimed?: ScopeQuery): { scope: ScopeQuery; signal: AbortSignal; actor: 'agent' | 'human' | 'context' } {
  const current = storage.getStore()
  if (!current || current.owner !== owner || current.controller.signal.aborted ||
    claimed?.runtime !== current.scope.runtime || claimed?.sessionId !== current.scope.sessionId) {
    throw new Error('Refused: this forge call does not ride a live invocation for this conversation, so it cannot be attributed.')
  }
  return { scope: current.scope, signal: current.controller.signal, actor: current.actor }
}
