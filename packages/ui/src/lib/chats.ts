import { isPathInside } from './paths'
import type { WorkspaceEntry } from '@harnessdesk/protocol'

/** Roots are individual host-created chat folders, never the configured parent. */
export const isChatFolder = (cwd: string, roots: readonly string[]): boolean =>
  cwd === '' || roots.some(root => isPathInside(cwd, root))

export const projectWorkspaces = (workspaces: readonly WorkspaceEntry[], roots: readonly string[]): WorkspaceEntry[] =>
  workspaces.filter(workspace => !isChatFolder(workspace.path, roots))

/** Only the first recent entry has fresh Git facts; null elsewhere means unread. */
export const recentWorkspace = (current: WorkspaceEntry | null, workspaces: readonly WorkspaceEntry[]): WorkspaceEntry | null => {
  if (!current) return null
  const entry = workspaces.find(one => one.path === current.path)
  return !entry ? current : entry === workspaces[0] ? entry : { ...current, ...entry, git: current.git }
}

export const readChatsPreferences = (preferences: Readonly<Record<string, unknown>>) => ({
  chatsFolder: typeof preferences['chatsFolder'] === 'string' ? preferences['chatsFolder'] : '',
  chatsFolderRoots: Array.isArray(preferences['chatsFolderRoots'])
    ? preferences['chatsFolderRoots'].filter((root): root is string => typeof root === 'string') : [],
})
