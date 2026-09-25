import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

import { ConfinedTree } from '../confined-tree.js'
import { projectOf } from '../evidence/revision.js'
import { TRIGGER_FILE_LIMIT } from './definition.js'

/**
 * A project's triggers file, as committed — never as it sits on disk.
 *
 * The file arrives with a clone and says what may open work unattended, so it
 * is read the way phase 4 reads a project's named checks: one captured `HEAD`
 * commit, then only the immutable object ids git itself returns for that
 * commit's `.harnessdesk` tree and its `triggers.yml` blob. A branch moving
 * during the read cannot splice two versions together, a working-copy edit
 * is said but never read as policy, and a `.harnessdesk` or a file committed
 * as a link, an executable, a submodule, oversized or not UTF-8 is refused
 * before anything parses it.
 *
 * git is run through `spawn` with a fixed argument vector — never a shell, a
 * checkout or a fetch — with replace objects, optional locks and every
 * inherited `GIT_*` override switched off, a 15-second timeout, and a hard
 * byte limit enforced while the answer arrives. The working copy is looked at
 * only through `ConfinedTree`, only to say whether it differs.
 */

export const TRIGGERS_PATH = '.harnessdesk/triggers.yml'

/** git, already bound to one admitted repository: `read` enforces `maxBytes` while receiving. */
export interface TriggerGit {
  read(args: readonly string[], maxBytes: number): Promise<Uint8Array>
}

export interface TriggerSourceFile {
  /** The canonical main checkout. */
  readonly project: string
  /** Which clone this is: a reclone at the same path is a different project. */
  readonly incarnation: string
  /** The commit read, or null before the first commit. */
  readonly revision: string | null
  /** SHA-256 of the committed bytes, or null when no file is committed. */
  readonly sourceDigest: string | null
  /** The committed text, or null when no file is committed. */
  readonly text: string | null
  /** The working copy holds something other than what is committed: that is not what runs. */
  readonly workingCopyChanged: boolean
}

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const GIT_TIMEOUT_MS = 15_000

const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code })
const refusal = (message: string): Error => coded(message, 'HD_TRIGGER_SOURCE')

export async function readTriggerBlob(git: TriggerGit, revision: string): Promise<string | null> {
  if (!OBJECT_ID.test(revision)) throw refusal('The project revision is invalid.')
  const decode = (bytes: Uint8Array): string => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw refusal('The triggers file is not UTF-8 text.')
    }
  }
  const entry = async (tree: string, name: string, mode: string, type: string): Promise<string | null> => {
    const bytes = await git.read(['ls-tree', '-z', tree, '--', name], 1024)
    if (bytes.length === 0) return null
    const text = decode(bytes)
    const match = /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/.exec(text)
    if (!match || match[1] !== mode || match[2] !== type || match[4] !== name) {
      throw refusal('Triggers must be a regular committed file in a committed directory.')
    }
    return match[3]!
  }
  const directory = await entry(revision, '.harnessdesk', '040000', 'tree')
  if (directory === null) return null
  const blob = await entry(directory, 'triggers.yml', '100644', 'blob')
  if (blob === null) return null
  const sizeText = decode(await git.read(['cat-file', '-s', blob], 32)).trim()
  if (!/^(0|[1-9][0-9]*)$/.test(sizeText) || Number(sizeText) > TRIGGER_FILE_LIMIT) {
    throw refusal('Triggers must fit in 64 KiB.')
  }
  const bytes = await git.read(['cat-file', 'blob', blob], TRIGGER_FILE_LIMIT)
  if (bytes.length !== Number(sizeText)) throw refusal('The triggers file changed while it was read.')
  return decode(bytes)
}

/** The environment git runs in: nothing inherited that could redirect a repository or add objects. */
const gitEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }
}

/** git for one repository whose metadata folder the caller already admitted. */
export function gitTransport(gitDir: string, options: { readonly command?: string; readonly timeoutMs?: number } = {}): TriggerGit {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
  return {
    read: (args, maxBytes) => new Promise((resolve, reject) => {
      const child = spawn(options.command ?? 'git', [
        `--git-dir=${gitDir}`, '--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', ...args,
      ], { shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: gitEnvironment() })
      const chunks: Buffer[] = []
      let size = 0
      let failure: Error | null = null
      const timer = setTimeout(() => {
        failure = refusal('git did not answer within 15 seconds.')
        child.kill('SIGKILL')
      }, timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          failure ??= refusal('git answered with more than this read allows.')
          child.kill('SIGKILL')
          return
        }
        chunks.push(chunk)
      })
      child.on('error', () => { failure ??= refusal('git could not be started.') })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (failure) reject(failure)
        else if (code !== 0) reject(refusal('git could not read this project.'))
        else resolve(new Uint8Array(Buffer.concat(chunks)))
      })
    }),
  }
}

/**
 * Which clone a main checkout is: its folder and its `.git` folder, by device,
 * inode and birth time. `.git` must be a real folder — a gitfile or a link
 * pointing anywhere else supplies no authority — so this reads only a
 * repository's own main checkout.
 */
export async function incarnationOf(project: string): Promise<string> {
  const root = await lstat(project, { bigint: true })
  const metadata = await lstat(join(project, '.git'), { bigint: true }).catch(() => null)
  if (!root.isDirectory() || !metadata?.isDirectory()) {
    throw refusal('Triggers are read only from a repository’s own main checkout.')
  }
  return createHash('sha256')
    .update(JSON.stringify([String(root.dev), String(root.ino), String(metadata.dev), String(metadata.ino), String(metadata.birthtimeNs)]))
    .digest('hex')
}

export interface TriggerSourceOptions {
  /** Tests only: the git to read through instead of the real one. */
  readonly git?: (gitDir: string) => TriggerGit
  /** Tests only: the platform the working-copy look behaves as. */
  readonly platform?: NodeJS.Platform
}

/** The working copy, only to say whether it differs; a link, an oversize file or any refusal reads as "differs". */
const workingCopyOf = async (project: string, platform: NodeJS.Platform | undefined): Promise<string | null | 'unreadable'> => {
  try {
    const tree = await ConfinedTree.open(project, platform ? { platform } : {})
    return await tree.read(TRIGGERS_PATH, TRIGGER_FILE_LIMIT)
  } catch {
    return 'unreadable'
  }
}

/**
 * Reads a confined project's triggers as committed at one captured `HEAD`.
 * `root` must already be admitted by the host. Throws a sentence when the
 * committed file is refused; never throws for what the file says.
 */
export async function readTriggerSource(root: string, options: TriggerSourceOptions = {}): Promise<TriggerSourceFile> {
  const project = await projectOf(root)
  const incarnation = await incarnationOf(project)
  const git = (options.git ?? gitTransport)(join(project, '.git'))
  const head = new TextDecoder().decode(await git.read(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], 256).catch(() => new Uint8Array())).trim()
  const revision = OBJECT_ID.test(head) ? head : null
  const text = revision === null ? null : await readTriggerBlob(git, revision)
  const working = await workingCopyOf(project, options.platform)
  return {
    project,
    incarnation,
    revision,
    sourceDigest: text === null ? null : createHash('sha256').update(text, 'utf8').digest('hex'),
    text,
    workingCopyChanged: working !== text,
  }
}
