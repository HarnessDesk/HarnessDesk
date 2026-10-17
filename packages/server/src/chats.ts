import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { StateStore } from './state.js'
import { assertAbsolute } from './workspace.js'

/** The host resolves the default; windows never construct a managed path. */
export const chatsFolderOf = (state: StateStore): string => {
  const saved = state.state.preferences['chatsFolder']
  const folder = typeof saved === 'string' ? saved : join(state.directory, 'chats')
  assertAbsolute(folder)
  return resolve(folder)
}

export const chatsPreferences = (state: StateStore): Readonly<Record<string, unknown>> => ({
  ...state.state.preferences,
  chatsFolder: chatsFolderOf(state),
  chatsFolderRoots: managedChatFolders(state),
})

/** Only successful host allocations confer chat identity, never a chosen parent. */
export const managedChatFolders = (state: StateStore): string[] => {
  const roots = state.state.preferences['managedChatFolders']
  return Array.isArray(roots) ? roots.filter((root): root is string => typeof root === 'string') : []
}

const inside = (child: string, parent: string): boolean => {
  const part = relative(parent, child)
  return part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part)
}

export const isManagedChatFolder = (state: StateStore, cwd: string): boolean =>
  managedChatFolders(state).some(folder => inside(cwd, folder))

export const rememberChatFolder = async (state: StateStore, cwd: string): Promise<void> => {
  const canonical = await realpath(cwd)
  await state.setPreferences({ managedChatFolders: [...new Set([...managedChatFolders(state), cwd, canonical])] })
}

export const chatsPreferencePatch = async (state: StateStore, patch: Record<string, unknown>): Promise<Record<string, unknown>> => {
  if (Object.hasOwn(patch, 'chatsFolderRoots') || Object.hasOwn(patch, 'managedChatFolders')) throw new Error('Chats folder roots are maintained by the host.')
  if (!Object.hasOwn(patch, 'chatsFolder')) return patch
  const folder = patch['chatsFolder']
  if (folder !== null && typeof folder !== 'string') throw new Error('Chats folder must be an absolute path or null.')
  if (typeof folder === 'string') assertAbsolute(folder)
  const chosen = resolve(typeof folder === 'string' ? folder : join(state.directory, 'chats'))
  const canonical = await realpath(chosen).catch(() => chosen)
  const projects = state.state.workspaces.filter(project => !isManagedChatFolder(state, project.path))
  const canonicalProjects = await Promise.all(projects.map(project => realpath(project.path).catch(() => project.realPath ?? project.path)))
  if (projects.some((project, index) => inside(project.path, chosen) || inside(canonicalProjects[index]!, canonical))) {
    throw new Error('Chats folder contains an opened project.')
  }
  return patch
}

/** mkdtemp creates a new direct child atomically and never reuses a folder. */
export const createChatFolder = async (state: StateStore): Promise<string> => {
  const root = chatsFolderOf(state)
  await mkdir(root, { recursive: true })
  const canonical = await realpath(root)
  const cwd = await mkdtemp(join(canonical, `${new Date().toISOString().slice(0, 10)}-`))
  if (dirname(cwd) !== canonical) throw new Error('Conversation folder must stay inside the chats folder.')
  return join(root, basename(cwd))
}
