import { AsyncLocalStorage } from 'node:async_hooks'
/** Host-only provenance for a translated call; never accepted from plugin arguments. */
export interface GitSteerContext {
  readonly command: string
  readonly admitted?: boolean
  readonly approved?: { readonly repository: string; readonly branch: string; readonly sha: string } | undefined
  readonly signal?: AbortSignal | undefined
  readonly push?: { readonly branch: string; readonly sourceBranch: string; readonly sha: string }
}
export const gitSteerContext = new AsyncLocalStorage<GitSteerContext>()
