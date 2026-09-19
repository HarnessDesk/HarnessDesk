import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { NamedCheck, Sha } from '@harnessdesk/protocol'

import { parseYaml } from '../yaml.js'
import { isSha } from './records.js'

/**
 * A project's named checks: `.harnessdesk/checks.yml`, the commands the desk
 * may run to earn `check` evidence outside a flow.
 *
 * **Security-critical.** The file is committed in a repository someone may
 * have cloned, so every command in it is untrusted input — exactly as the
 * repository's Agent folders are. Nothing here runs anything; this only reads
 * what the file says, as strictly as a person reading it would need, so that
 * what is later shown to them is byte for byte what would run:
 *
 * - A command is printable ASCII and line feeds, and nothing else. A control
 *   character, an invisible one (a zero-width space, a direction override) or a
 *   letter from another script that looks like a Latin one could make what is
 *   shown differ from what runs; a check whose command holds one is listed with
 *   that problem and never offered.
 * - A check says `run` and optionally `timeout`, and nothing else. A key this
 *   build does not read — `cwd`, `env` — would look to a reader as if it did
 *   something, so the check is refused rather than run without it.
 * - The file is read **as committed**, at the main checkout's `HEAD`: one git
 *   blob, which git will not change under the reader, rather than a path on
 *   disk that a process in the repository could swap between a check and a
 *   read. The blob's id is the file's generation (`digest`): what a person is
 *   shown, what they approve and what runs are all bound to exactly those
 *   bytes. A file, or a `.harnessdesk`, committed as a link is refused; a
 *   working copy that differs from the committed one is said, never read.
 * - A file that will not parse is listed with where and why, never hidden, and
 *   a list longer than the limit is refused whole, never cut short.
 *
 * Whether a person has seen a command is `seen.ts`'s; running one is
 * `check-runs.ts`'s. Both read the checks through here and nowhere else.
 */

/** Where a project keeps them, from the top of its checkout. */
export const CHECKS_FILE = join('.harnessdesk', 'checks.yml')

/** The same path as git names it inside a commit. */
const CHECKS_PATH = '.harnessdesk/checks.yml'

/** The most a checks file may weigh. It is a list of commands, not a document. */
export const CHECKS_FILE_LIMIT = 64 * 1024

/** The most checks one file may name. A longer list is refused whole. */
export const CHECK_LIMIT = 32

/** The longest command a check may run. */
export const COMMAND_LIMIT = 2_000

/** Seconds a check runs before it is stopped, when it does not say. */
export const TIMEOUT_DEFAULT = 600

/** The longest a check may say it runs: four hours. */
export const TIMEOUT_MAX = 4 * 60 * 60

/** A check's name: what a card's *Run <name>* says, and half of what a person has seen. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

/** Printable ASCII and line feeds, and nothing else. */
const COMMAND = /^[\x20-\x7e\n]+$/

const KEYS = new Set(['run', 'timeout'])

export interface ChecksProblem {
  /** `verify.run`, `verify`, or `''` for the file as a whole. */
  readonly at: string
  readonly text: string
  /** The check it is about, as the file names it; absent for the file as a whole. */
  readonly check?: string
}

export interface ChecksFile {
  /** The file, absolute, whether or not it is there. */
  readonly file: string
  readonly exists: boolean
  /** The committed file's blob id — its generation — or null when there is none. */
  readonly digest: string | null
  /** The commit it was read at, or null when there is none. */
  readonly at: string | null
  /** The working copy holds something other than what is committed: that is not what runs. */
  readonly uncommitted: boolean
  /** Only the checks that read cleanly. */
  readonly checks: readonly NamedCheck[]
  readonly problems: readonly ChecksProblem[]
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const run = promisify(execFile)

/**
 * git, read-only, in the project, as a background reader does: through
 * `execFile`, never a shell, with no optional locks — and never a command that
 * runs a hook or a filter. Null when git refuses.
 */
const git = async (project: string, args: readonly string[]): Promise<Buffer | null> => {
  try {
    const { stdout } = await run('git', ['-C', project, ...args], {
      encoding: 'buffer',
      timeout: 20_000,
      maxBuffer: CHECKS_FILE_LIMIT + 64 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    return stdout
  } catch {
    return null
  }
}

/**
 * The working copy's bytes, only to compare with what is committed — never
 * parsed, never run. Opened without following a link and without waiting on
 * a pipe, and read only when it is a plain file within the limit; null
 * otherwise, which reads as "not what is committed".
 */
const workingCopy = async (file: string): Promise<Buffer | null> => {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const info = await handle.stat()
    return info.isFile() && info.size <= CHECKS_FILE_LIMIT ? await handle.readFile() : null
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/** Reads a checkout's checks from one already-chosen commit object. Never throws for what the file says. */
export const readChecksAt = async (project: string, revision: Sha): Promise<ChecksFile> => {
  const file = join(project, CHECKS_FILE)
  let digest: string | null = null
  const at: string | null = isSha(revision) ? revision : null
  let uncommitted = false
  const answer = (checks: readonly NamedCheck[], problems: readonly ChecksProblem[], exists = true): ChecksFile => ({
    file,
    exists,
    digest,
    at,
    uncommitted,
    checks,
    problems,
  })
  const whole = (text: string): ChecksFile => answer([], [{ at: '', text }])
  if (at === null) return answer([], [], false)

  // The caller chose the commit once. Every lookup below names that immutable
  // object, so a concurrent ref move cannot change either the command or its
  // generation halfway through this read.
  const listed = (await git(project, ['ls-tree', '-z', at, '--', '.harnessdesk', CHECKS_PATH]))?.toString('utf8') ?? ''
  const tree = new Map(
    listed
      .split('\x00')
      .filter(Boolean)
      .map((entry) => {
        const [meta = '', path = ''] = entry.split('\t')
        const [mode = '', type = '', id = ''] = meta.split(' ')
        return [path, { mode, type, id }] as const
      }),
  )
  if (tree.get('.harnessdesk')?.mode === '120000') {
    return whole('.harnessdesk is committed as a link. Checks are read only from the project itself.')
  }
  const blob = tree.get(CHECKS_PATH)
  if (!blob) {
    uncommitted = await lstat(file).then(() => true, () => false)
    if (!uncommitted) return answer([], [], false)
    return whole('It is not committed yet. A check runs only as the file is committed, so none is offered until it is.')
  }
  if (blob.mode === '120000') return whole('It is committed as a link. Checks are read only from a file in the project itself.')
  if (blob.type !== 'blob') return whole('It is not a file.')
  const size = Number((await git(project, ['cat-file', '-s', blob.id]))?.toString('utf8').trim())
  if (!Number.isInteger(size)) return whole('It could not be read from git.')
  if (size > CHECKS_FILE_LIMIT) {
    return whole(`It is ${Math.ceil(size / 1024)} KB, and a checks file may be at most ${CHECKS_FILE_LIMIT / 1024} KB.`)
  }
  const bytes = await git(project, ['show', `${at}:${CHECKS_PATH}`])
  if (bytes === null || bytes.length !== size) return whole('It could not be read from git.')
  digest = blob.id
  // Said, never read: only what is committed runs.
  uncommitted = !(await workingCopy(file))?.equals(bytes)

  let parsed: unknown
  try {
    parsed = parseYaml(bytes.toString('utf8'))
  } catch (error) {
    return whole(`It does not parse: ${error instanceof Error ? error.message : String(error)}.`)
  }
  if (parsed === null) return answer([], [])
  if (!isMap(parsed)) return whole('It has to be a map from each check’s name to what it runs.')

  const entries = Object.entries(parsed)
  if (entries.length > CHECK_LIMIT) {
    return whole(`It names ${entries.length} checks, and at most ${CHECK_LIMIT} are read. None is offered until it names fewer.`)
  }
  const checks: NamedCheck[] = []
  const problems: ChecksProblem[] = []
  for (const [name, value] of entries) {
    const refuse = (at: string, text: string): void => {
      problems.push({ at: `${name}${at}`, text, check: name })
    }
    if (!NAME.test(name)) {
      refuse('', 'A check’s name is letters, digits, dots, dashes and underscores, starts with a letter or a digit, and is at most 40 long.')
      continue
    }
    if (!isMap(value)) {
      refuse('', 'A check is a map: `run`, and optionally `timeout`.')
      continue
    }
    const unread = Object.keys(value).find((key) => !KEYS.has(key))
    if (unread !== undefined) {
      refuse(`.${unread}`, `A check says only \`run\` and \`timeout\`. \`${unread}\` would be ignored, so the check is not offered until it is removed.`)
      continue
    }
    const run = value['run']
    if (typeof run !== 'string' || run.trim() === '') {
      refuse('.run', 'It needs the command to run.')
      continue
    }
    if (run.length > COMMAND_LIMIT) {
      refuse('.run', `The command is ${run.length} characters long, and at most ${COMMAND_LIMIT} are allowed.`)
      continue
    }
    if (!COMMAND.test(run)) {
      refuse(
        '.run',
        'The command holds a character that is not plain printable ASCII — a control character, an invisible one, or a letter that can pass for another. What runs has to be exactly what is shown, so it is not offered.',
      )
      continue
    }
    const timeout = value['timeout'] ?? TIMEOUT_DEFAULT
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > TIMEOUT_MAX) {
      refuse('.timeout', `The timeout is whole seconds, from 1 to ${TIMEOUT_MAX}.`)
      continue
    }
    checks.push({ name, run, timeout })
  }
  return answer(checks, problems)
}

/** Reads a project's checks as committed at its `HEAD`, for listing surfaces that do not start a command. */
export const readChecks = async (project: string): Promise<ChecksFile> => {
  const at = (await git(project, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.toString('utf8').trim() || null
  if (at !== null) return readChecksAt(project, at)
  const file = join(project, CHECKS_FILE)
  return { file, exists: false, digest: null, at: null, uncommitted: false, checks: [], problems: [] }
}
