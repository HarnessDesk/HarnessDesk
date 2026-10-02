import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import type { CapabilityScope, ScopeQuery } from '@harnessdesk/protocol'

/** A comparison key, never shell authority. Capture registration keys once so a moved alias cannot widen them. */
const canonicalRoot = (root: string): string => {
  if (!isAbsolute(root)) return root
  try { return realpathSync.native(root) } catch {
    try { return realpathSync(root) } catch { return root }
  }
}

export const canonicalWorkspaceScope = (scope: CapabilityScope): CapabilityScope =>
  scope.kind === 'workspace' ? { ...scope, root: canonicalRoot(scope.root) } : scope

/** Listing may normalize a hint for comparison; execution must normalize only the host-admitted root. */
export const canonicalScopeQuery = (query: ScopeQuery): ScopeQuery =>
  query.workspaceRoot === undefined ? query : { ...query, workspaceRoot: canonicalRoot(query.workspaceRoot) }
