import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { HARDENED_GIT_CONFIG } from './git-hardening.js'

/**
 * The commit the host makes for an agent: `commit_work` (#1074).
 *
 * An agent's sandbox may keep `.git` read-only — Codex's workspace sandbox
 * does, on purpose — and widening it would hand the agent the repository's
 * configuration and hooks, which the next unsandboxed git runs. So the agent
 * never writes `.git` itself: it names a message, and the host commits the
 * card's own work in the Seat's checkout, with git run so nothing the
 * repository says can run code (`HARDENED_GIT_CONFIG`, plus no system or
 * global configuration and every configured filter driver switched off).
 * Work that goes through a filter (LFS) is refused rather than committed raw,
 * and a submodule's changes are never looked at: it is its own repository.
 *
 * Only the card's own work: the paths dirty now that were not dirty when the
 * card was claimed (`IntentClaim.dirtyPaths`, read in the same
 * `git status --porcelain=v1` spelling). A file somebody else left dirty
 * before the claim is never committed, and neither is anything already staged
 * elsewhere: the commit names its paths (`git commit <paths>`, which commits
 * only those). Paths come from git's own status, never from the agent, and
 * reach git as literal pathspecs through a file, so none can carry magic or
 * reach outside the checkout. The message preserves the agent's text and
 * adds the desk's co-author trailer once, stored from a file — never a
 * command-line argument, never a shell.
 *
 * The author is the checkout's configured identity as git itself resolves it
 * (`user.name`, `user.email`), passed in explicitly because the commit runs
 * with global configuration off; with none configured, nothing is committed
 * (docs/decisions.md). A placeholder is never made up.
 */

const run = promisify(execFile)

/** The longest message `commit_work` takes. */
export const COMMIT_MESSAGE_LIMIT = 8_000

/** The desk's attribution; the checkout's configured identity owns the commit. */
const COAUTHOR_TRAILER = 'Co-authored-by: HarnessDesk Agent <agent@harnessdesk.app>'

const attributedMessage = async (cwd: string, message: string): Promise<string> => {
  const comments: string[] = []
  for (const key of ['core.commentChar', 'core.commentString']) {
    const value = await git(cwd, ['config', '--get', key], { env: readEnv() }).catch(() => '')
    if (value) comments.push('-c', `${key}=${value.replace(/\n$/, '')}`)
  }
  // Git owns placement and deduplication. Do not read repository trailer.*
  // configuration: it can run shell commands. Only the comment prefix is
  // read with the person's configuration and carried across, so Git recognizes
  // this checkout's scissors cutoff even with a global or system prefix.
  return gitWithInput(cwd, [
    '--git-dir=/dev/null', ...comments, 'interpret-trailers',
    '--where=end', '--if-exists=addIfDifferent', '--if-missing=add', '--trailer', COAUTHOR_TRAILER,
  ], message, isolatedEnv())
}

export type CardCommit =
  | { readonly commit: string; readonly paths: readonly string[] }
  | { readonly refused: string }

/**
 * The environment the checkout is read in: the person's own configuration, as
 * `revisionAt` read it when the card was claimed, so the two status listings
 * spell every path the same way. Never takes a lock a commit wants.
 */
const readEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0' })

/** The environment the commit is written in: none of the host's own git variables, no system or global configuration. */
const isolatedEnv = (extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    ...extra,
  }
}

const git = async (
  cwd: string,
  args: readonly string[],
  options: { readonly config?: readonly string[]; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<string> => {
  const { stdout } = await run('git', ['-C', cwd, ...HARDENED_GIT_CONFIG, ...(options.config ?? []), ...args], {
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: options.env ?? isolatedEnv(),
  })
  return stdout
}

const firstLine = (error: unknown): string => {
  const stderr = (error as { stderr?: unknown }).stderr
  const text = typeof stderr === 'string' && stderr.trim() ? stderr : error instanceof Error ? error.message : String(error)
  return text.trim().split('\n')[0]?.replace(/^(fatal|error): /, '') ?? 'git failed'
}

/**
 * Every filter driver the repository's configuration defines, switched off.
 * A driver is a program `git add` runs over a file's contents; only
 * configuration can define one, so the configuration's own list is complete.
 * Read with the person's configuration too, a superset of what the commit
 * itself sees, and switched off for the status reads as well as the commit.
 */
const filtersOff = async (cwd: string): Promise<string[]> => {
  let listed: string
  try {
    listed = await git(cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], { env: readEnv() })
  } catch {
    return [] // git answers 1 when nothing matches
  }
  const drivers = new Set<string>()
  for (const key of listed.split('\0').filter(Boolean)) {
    const last = key.lastIndexOf('.')
    if (last > 'filter.'.length) drivers.add(key.slice('filter.'.length, last))
  }
  return [...drivers].flatMap((name) =>
    ['process', 'clean', 'smudge'].flatMap((field) => ['-c', `filter.${name}.${field}=`]).concat(['-c', `filter.${name}.required=false`]),
  )
}

/** The identity git would commit as here, with the person's own configuration read; null when either half is missing. */
const identityOf = async (cwd: string): Promise<{ readonly name: string; readonly email: string } | null> => {
  const read = async (key: string): Promise<string | null> => {
    try {
      const value = (await run('git', ['-C', cwd, ...HARDENED_GIT_CONFIG, 'config', '--get', key], { timeout: 10_000 })).stdout.trim()
      return value || null
    } catch {
      return null
    }
  }
  const [name, email] = await Promise.all([read('user.name'), read('user.email')])
  return name && email ? { name, email } : null
}

/** Runs git with `input` on its standard input, never through a shell. */
const gitWithInput = (cwd: string, args: readonly string[], input: string, env: NodeJS.ProcessEnv): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', cwd, ...HARDENED_GIT_CONFIG, ...args], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    )
    child.stdin?.end(input)
  })

/**
 * Whether any file among `paths` has a filter attribute. A filter — LFS is
 * the common one — is a program that turns a file into what is stored, and
 * the commit runs with every filter off (no global configuration, where LFS
 * is set up, and the repository's own blanked), so committing such a file
 * would store it raw: a large file straight into history instead of its
 * pointer. Such work is refused rather than committed wrong. A folder git
 * lists as untracked is looked into, file by file. Attributes are read the way
 * the person's own git reads them; reading them runs nothing.
 */
const filteredAmong = async (top: string, paths: readonly string[]): Promise<boolean> => {
  const env = { ...readEnv(), GIT_LITERAL_PATHSPECS: '1' }
  const files: string[] = []
  for (const path of paths) {
    if (!path.endsWith('/')) {
      files.push(path)
      continue
    }
    const inside = await git(top, ['ls-files', '-z', '--others', '--exclude-standard', '--', path], { env })
    files.push(...inside.split('\0').filter(Boolean))
  }
  if (files.length === 0) return false
  const out = await gitWithInput(top, ['check-attr', '-z', '--stdin', 'filter'], files.join('\0') + '\0', env)
  const fields = out.split('\0')
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const value = fields[index + 2]
    if (value !== 'unspecified' && value !== 'unset') return true
  }
  return false
}

/** One `git status --porcelain=v1` line's path, exactly as `revisionAt` reads it. */
const displayPath = (line: string): string => {
  const rest = line.slice(3)
  const arrow = rest.indexOf(' -> ')
  return arrow === -1 ? rest : rest.slice(arrow + 4)
}

/** `git status --porcelain=v1 -z` as entries: the path, and a rename's or copy's source. */
const zEntries = (out: string): { readonly path: string; readonly from: string | null }[] => {
  const fields = out.split('\0')
  const entries: { path: string; from: string | null }[] = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    if (field.length < 4) continue
    const status = field.slice(0, 2)
    const renamed = status.includes('R') || status.includes('C')
    entries.push({ path: field.slice(3), from: renamed ? (fields[++index] ?? null) : null })
  }
  return entries
}

/**
 * Commits the paths in `cwd` that are dirty now and were not in `before`,
 * with `message`, and answers the new commit — or one sentence saying why
 * nothing was committed.
 */
export const commitCardWork = async (cwd: string, before: readonly string[], message: string): Promise<CardCommit> => {
  if (message.trim() === '') return { refused: 'Refused: a commit needs a message, so nothing was committed.' }
  if (message.length > COMMIT_MESSAGE_LIMIT) {
    return { refused: `Refused: the message is longer than ${COMMIT_MESSAGE_LIMIT} characters, so nothing was committed.` }
  }
  if (message.includes('\0')) return { refused: 'Refused: the message contains a NUL character, so nothing was committed.' }
  let top: string
  try {
    top = (await git(cwd, ['rev-parse', '--show-toplevel'], { env: readEnv() })).trim()
  } catch {
    return { refused: 'Refused: this Seat’s checkout is not a git repository, so there is nothing to commit.' }
  }
  const filters = await filtersOff(top)
  // A submodule is its own repository: its changes are never this card's to commit from here.
  const status = ['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=all']
  let shown: string[]
  let entries: { readonly path: string; readonly from: string | null }[]
  try {
    const read = { config: filters, env: readEnv() }
    const [plain, nul] = await Promise.all([git(top, status, read), git(top, [...status, '-z'], read)])
    shown = plain.split('\n').filter((line) => line.trim() !== '').map(displayPath)
    entries = zEntries(nul)
  } catch (error) {
    return { refused: `Refused: the checkout could not be read (${firstLine(error)}), so nothing was committed.` }
  }
  if (shown.length !== entries.length) {
    return { refused: 'Refused: the checkout changed while it was being read, so nothing was committed. Call commit_work again.' }
  }
  const seen = new Set(before)
  const own = entries.filter((_entry, index) => !seen.has(shown[index]!))
  if (own.length === 0) return { refused: 'Nothing to commit: no file changed since this card was claimed is uncommitted.' }
  const paths = [...new Set(own.flatMap((entry) => (entry.from ? [entry.path, entry.from] : [entry.path])))]
  const filtered = await filteredAmong(top, paths).catch(() => null)
  if (filtered === null) return { refused: 'Refused: the checkout’s git attributes could not be read, so nothing was committed.' }
  if (filtered) {
    return { refused: 'Refused: some of this card’s files go through a git filter (such as LFS), so nothing was committed. Commit them yourself, or ask the person to.' }
  }
  const identity = await identityOf(top)
  if (!identity) {
    return { refused: 'Refused: this checkout has no git author (user.name and user.email), so nothing was committed. Set one, then call commit_work again.' }
  }
  const version = (await git(top, ['--version']).catch(() => '')).match(/^git version (\d+)\.(\d+)/)
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 32)) {
    return { refused: 'Refused: committing a card requires Git 2.32 or newer for co-author trailers, so nothing was committed.' }
  }
  const scratch = await mkdtemp(join(tmpdir(), 'harnessdesk-commit-'))
  try {
    const pathspecs = join(scratch, 'paths')
    const text = join(scratch, 'message')
    await writeFile(pathspecs, paths.join('\0') + '\0')
    await writeFile(text, await attributedMessage(top, message))
    const env = isolatedEnv({
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    })
    const config = [...filters, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false']
    try {
      await git(top, ['add', '--all', `--pathspec-from-file=${pathspecs}`, '--pathspec-file-nul'], { config, env })
      await git(
        top,
        ['commit', '--no-verify', '--no-gpg-sign', '--cleanup=verbatim', '--no-edit', `--file=${text}`, `--pathspec-from-file=${pathspecs}`, '--pathspec-file-nul'],
        { config, env },
      )
      const commit = (await git(top, ['rev-parse', '--verify', 'HEAD^{commit}'], { config, env })).trim()
      return { commit, paths }
    } catch (error) {
      return { refused: `Refused: git did not commit (${firstLine(error)}), so nothing was committed.` }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
