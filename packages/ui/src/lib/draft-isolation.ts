import type { WorkspaceEntry } from '@harnessdesk/protocol'

/** A known repository with a commit can give a new development task its own checkout. */
export const canIsolateDraft = (workspace: WorkspaceEntry | null): boolean =>
  workspace?.git != null && workspace.git.sha !== null
