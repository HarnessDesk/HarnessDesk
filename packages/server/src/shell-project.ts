import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, parse, relative, sep } from 'node:path'
import { promisify } from 'node:util'

import { HARDENED_GIT_CONFIG } from './git-hardening.js'
import type { ShellProjectIdentity } from './state.js'
import { samePath, shellCheckoutIdentity } from './worktree.js'

const run = promisify(execFile)

/** Identity probes use the named folder, never an ambient Git directory or worktree. */
const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  const { stdout } = await run('git', ['-C', cwd, ...HARDENED_GIT_CONFIG, ...args], {
    env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 20_000, maxBuffer: 1024 * 1024,
  })
  return stdout
}

const contains = (root: string, folder: string): boolean => {
  const path = relative(root, folder)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

const assertBoundary = async (root: string): Promise<void> => {
  if (samePath(root, parse(root).root) || samePath(root, await realpath(homedir()))) {
    throw new Error('The filesystem root or home directory cannot be a shell boundary. Open a project folder instead.')
  }
}

/** Captured only by workspace open and persisted in the host's state directory. */
export const captureShellProject = async (opened: string): Promise<ShellProjectIdentity> => {
  await assertBoundary(opened)
  const checkout = await shellCheckoutIdentity(opened)
  if (!checkout) return { project: opened, checkoutRoot: opened, gitCommonDir: null }
  await assertBoundary(checkout.checkoutRoot)
  if (!contains(checkout.checkoutRoot, opened)) throw new Error('The project checkout changed its root. Open the actual project folder before running shell commands.')
  let project = checkout.checkoutRoot
  if (!samePath(checkout.gitDir, checkout.gitCommonDir)) {
    const first = (await git(opened, ['worktree', 'list', '--porcelain'])).split('\n').find((line) => line.startsWith('worktree '))
    if (!first) throw new Error('The project checkout has no main working tree.')
    project = await realpath(first.slice('worktree '.length))
    await assertBoundary(project)
    const main = await shellCheckoutIdentity(project)
    if (!main || !samePath(main.checkoutRoot, project) || !samePath(main.gitCommonDir, checkout.gitCommonDir)) {
      throw new Error('The project checkout changed its repository. Open the actual project folder before running shell commands.')
    }
  }
  return { project, checkoutRoot: checkout.checkoutRoot, gitCommonDir: checkout.gitCommonDir }
}

/** Older or malformed state cannot mint an identity at shell invocation time. */
export const isShellProjectIdentity = (value: unknown): value is ShellProjectIdentity => {
  if (!value || typeof value !== 'object') return false
  const identity = value as Partial<ShellProjectIdentity>
  return typeof identity.project === 'string' && isAbsolute(identity.project) &&
    typeof identity.checkoutRoot === 'string' && isAbsolute(identity.checkoutRoot) &&
    (identity.gitCommonDir === null || typeof identity.gitCommonDir === 'string' && isAbsolute(identity.gitCommonDir))
}

export const shellProjectUnchanged = async (opened: string, identity: ShellProjectIdentity): Promise<boolean> => {
  try {
    await assertBoundary(opened)
    await assertBoundary(identity.project)
    await assertBoundary(identity.checkoutRoot)
    if (!samePath(await realpath(opened), opened) || !samePath(await realpath(identity.project), identity.project)) return false
    const live = await shellCheckoutIdentity(opened)
    if (identity.gitCommonDir === null) return live === null && samePath(identity.project, opened) && samePath(identity.checkoutRoot, opened)
    if (!live || !samePath(live.checkoutRoot, identity.checkoutRoot) || !samePath(live.gitCommonDir, identity.gitCommonDir)) return false
    const main = await shellCheckoutIdentity(identity.project)
    return main !== null && samePath(main.checkoutRoot, identity.project) && samePath(main.gitCommonDir, identity.gitCommonDir)
  } catch {
    return false
  }
}
