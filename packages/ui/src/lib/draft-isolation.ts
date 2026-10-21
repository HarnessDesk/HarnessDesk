import type { WorkspaceEntry } from '@harnessdesk/protocol'

/** Opening a worktree or package is already an explicit choice of code and scope. */
export const keepsWorkspacePlace = (workspace: WorkspaceEntry): boolean =>
  workspace.repo?.worktree === true || (workspace.checkoutRoot != null &&
    (workspace.realPath ?? workspace.path).replace(/\/+$/, '') !== workspace.checkoutRoot.replace(/\/+$/, ''))

/** Ordinary repository roots default to a separate checkout for each task. */
export const canIsolateDraft = (workspace: WorkspaceEntry | null): boolean =>
  workspace?.git != null && workspace.git.sha !== null && !keepsWorkspacePlace(workspace)
