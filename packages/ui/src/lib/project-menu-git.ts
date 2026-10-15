import type { WorkspaceEntry } from '@harnessdesk/protocol'
import type { AppSnapshot } from '../state/snapshot'
import type { ProjectGroup } from './projects'

/** A menu read belongs to the requested checkout, even when no recent row names it. */
export const projectMenuGit = (
  snapshot: Pick<AppSnapshot, 'workspaceGitFacts' | 'workspace'>,
  root: string,
  current: boolean,
  openEntry: WorkspaceEntry | undefined,
  group: ProjectGroup,
) => {
  const git = snapshot.workspaceGitFacts.has(root)
    ? snapshot.workspaceGitFacts.get(root)
    : (current ? snapshot.workspace : openEntry)?.git ?? group.sessions.find(session => session.git)?.git
  return { isRepo: Boolean(git), git }
}
