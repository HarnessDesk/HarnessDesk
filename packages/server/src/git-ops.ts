import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'

import type { FileChange, Turn } from '@harnessdesk/protocol'

/**
 * The few things the host does *to* a repository, as opposed to reading it
 * (`git.ts`). Each one is narrow on purpose: undo or redo exactly one turn's
 * edits, list branches, check one out. Nothing here stashes, resets, or
 * touches a branch the user did not name — the checkpoint plugin's reasoning ("a plugin
 * that can roll the working tree back is a plugin that can destroy work")
 * applies to the host too, so every mutation refuses rather than guesses.
 */

const run = promisify(execFile)

const git = async (root: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', ['-C', root, ...args], { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

export class RevertError extends Error {
  constructor(
    message: string,
    /** Files already put back before the refusal, so the user knows the state. */
    readonly reverted: readonly string[],
  ) {
    super(message)
    this.name = 'RevertError'
  }
}

/**
 * A path with its symlinks resolved (macOS's /var is /private/var; git reports
 * the real one), whether or not the file itself still exists.
 */
const canonical = async (path: string): Promise<string> => {
  try {
    return await realpath(path)
  } catch {
    const parent = await realpath(dirname(path)).catch(() => dirname(path))
    return join(parent, basename(path))
  }
}

/** Paths in a patch are relative to the repository root, wherever the session ran. */
const locate = async (root: string, top: string, path: string): Promise<{ absolute: string; inRepo: string }> => {
  const absolute = await canonical(isAbsolute(path) ? path : join(root, path))
  return { absolute, inRepo: relative(top, absolute) }
}

/** Which way a turn's edits are being applied. */
export type TurnDirection = 'undo' | 'redo'

/**
 * `git apply` of one patch — reversed for an undo, forward for a redo —
 * checked first so a stale file refuses whole.
 */
const applyPatch = async (root: string, patch: string, direction: TurnDirection): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-revert-'))
  const file = join(dir, 'turn.patch')
  const reverse = direction === 'undo' ? ['-R'] : []
  try {
    await writeFile(file, patch.endsWith('\n') ? patch : `${patch}\n`)
    await git(root, ['apply', ...reverse, '--check', '--whitespace=nowarn', file])
    await git(root, ['apply', ...reverse, '--whitespace=nowarn', file])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** A git-format patch for one update, as the agent reported its hunks. */
const patchFor = (inRepo: string, change: FileChange): string =>
  `--- a/${inRepo}\n+++ b/${inRepo}\n${change.diff}`

/**
 * Puts back what one turn changed, and nothing else — or, going the other
 * way, writes it again after an undo.
 *
 * The turn's aggregated diff (git-format, from the backend) is applied in a
 * single `git apply`, reversed for an undo, which is all-or-nothing. Without
 * one, each reported change is handled on its own, in reverse order for an
 * undo and in the agent's order for a redo: an update through its hunks; a
 * file the direction removes taken away only while its content is still
 * exactly what the agent left there; a file the direction writes put back
 * only while nothing else occupies the path. A file the user has touched
 * since stops the pass there and the error names what was already done.
 *
 * A redo is not a second undo of the undo: it applies the same recorded diff
 * forward, so a turn can be put back and taken away as often as the working
 * tree still matches, and never more than once at a time.
 */
export const applyTurn = async (root: string, turn: Turn, direction: TurnDirection = 'undo'): Promise<string[]> => {
  const changes = turn.items.flatMap((item) => (item.type === 'fileChange' ? item.changes : []))
  if (changes.length === 0) throw new RevertError('This turn did not change any files.', [])
  const top = await canonical((await topLevel(root)) ?? root)
  const paths = [...new Set(await Promise.all(changes.map(async (change) => (await locate(root, top, change.path)).inRepo)))]

  if (turn.diff && turn.diff.trim().length > 0) {
    try {
      await applyPatch(top, turn.diff, direction)
      return paths
    } catch (error) {
      throw new RevertError(
        direction === 'undo'
          ? `Could not put the files back: ${describeGit(error)}. Nothing was changed.`
          : `Could not write the files again: ${describeGit(error)}. Nothing was changed.`,
        [],
      )
    }
  }

  /* A deletion is put back from what the agent recorded of the file, and an
     agent may record nothing: Codex reports a deleted file with an empty diff.
     Writing that back "restored" an empty file where the real one had been —
     the loss an undo exists to prevent, reported as success (#29). Refused up
     front, before anything is touched, so nothing is half put back. A file
     that really was empty is refused too; it is the one that costs nothing to
     make again. */
  if (direction === 'undo') {
    const blank = changes.filter((change) => change.kind.type === 'delete' && change.diff === '')
    if (blank.length > 0) {
      const names = [...new Set(await Promise.all(blank.map(async (change) => (await locate(root, top, change.path)).inRepo)))]
      throw new RevertError(
        `Cannot put back ${names.join(', ')}: the agent recorded no content for ${names.length === 1 ? 'it' : 'them'}. Nothing was changed.`,
        [],
      )
    }
  }

  const done: string[] = []
  for (const change of direction === 'undo' ? [...changes].reverse() : changes) {
    const { absolute, inRepo: path } = await locate(root, top, change.path)
    // An undo takes an added file away and writes a deleted one back; a redo
    // does the opposite. Either way the file must still be what the agent
    // left, or the pass refuses rather than overwriting somebody's work.
    const removes = change.kind.type === (direction === 'undo' ? 'add' : 'delete')
    try {
      if (change.kind.type === 'update') {
        await applyPatch(top, patchFor(path, change), direction)
      } else if (removes) {
        const current = await readFile(absolute, 'utf8').catch(() => null)
        if (current === null) continue // already gone
        if (current !== change.diff) {
          /* A deletion the agent recorded nothing of can't be checked: what's
             there now can't be told from what it deleted (review of #153). */
          throw new Error(
            change.kind.type === 'delete' && change.diff === ''
              ? `${path} can't be deleted again: the agent recorded nothing of it, so what's there now can't be told from what it deleted`
              : `${path} has been edited since the agent wrote it`,
          )
        }
        await unlink(absolute)
      } else {
        const current = await readFile(absolute, 'utf8').catch(() => null)
        if (current === change.diff) continue // already there
        if (current !== null) throw new Error(`${path} exists again; not overwriting it`)
        await writeFile(absolute, change.diff)
      }
      if (!done.includes(path)) done.push(path)
    } catch (error) {
      throw new RevertError(
        `Stopped at ${path}: ${describeGit(error)}.${done.length > 0 ? ` Already ${direction === 'undo' ? 'put back' : 'written'}: ${done.join(', ')}.` : ''}`,
        done,
      )
    }
  }
  return done
}

/** One turn's edits taken off disk — its diff, reversed. */
export const revertTurn = (root: string, turn: Turn): Promise<string[]> => applyTurn(root, turn, 'undo')

/** The same edits written again after an undo — its diff, forward. */
export const reapplyTurn = (root: string, turn: Turn): Promise<string[]> => applyTurn(root, turn, 'redo')

const describeGit = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error)
  // execFile puts git's stderr into the message after the command line; keep the reason.
  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('error:') || entry.startsWith('fatal:'))
  return (line ?? text).replace(/^(error|fatal):\s*/, '')
}

// ---------------------------------------------------------------- branches

export interface Branch {
  readonly name: string
  readonly current: boolean
  /** Last commit time, epoch milliseconds. */
  readonly committedAt: number
}

/** Local branches, most recently committed first. */
export const listBranches = async (root: string): Promise<Branch[]> => {
  const out = await git(root, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(HEAD)%00%(refname:short)%00%(committerdate:unix)',
    'refs/heads/',
  ])
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [head, name, at] = line.split('\0')
      return { name: name ?? '', current: head === '*', committedAt: Number(at ?? 0) * 1000 }
    })
    .filter((branch) => branch.name.length > 0)
}

/**
 * A refusal that says which files it is refusing over.
 *
 * The count alone was all this carried, and the surface above it could only
 * say "the working tree may have uncommitted changes" — a guess, about
 * something the error already knew exactly. Removing a worktree has named the
 * work it would discard since it was written; a checkout refusing for the same
 * reason should not be vaguer about the same fact.
 *
 * Three names and a count, because a rebase over forty files should not print
 * forty lines into a toast.
 */
const naming = (files: readonly string[]): string => {
  const shown = files.slice(0, 3).join(', ')
  const rest = files.length - Math.min(files.length, 3)
  return rest > 0 ? `${shown} and ${rest} more` : shown
}

export class DirtyTreeError extends Error {
  constructor(readonly files: readonly string[]) {
    super(
      `The working tree has ${files.length} uncommitted change${files.length === 1 ? '' : 's'}` +
        `${files.length > 0 ? ` — ${naming(files)}` : ''}; commit or stash before switching branches.`,
    )
    this.name = 'DirtyTreeError'
  }
}

/**
 * Everything `checkout` refuses before it moves — a dirty tree, a name its
 * gate does not take — asked on its own. `git/createBranch` runs this
 * *before* creating a branch it was asked to switch to: a refusal after the
 * branch exists would leave half the request done, and the retry failing on
 * "already exists".
 */
export const checkoutPreflight = async (root: string, branch: string): Promise<void> => {
  await assertCleanTree(root)
  if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-')) {
    throw new Error(`"${branch}" is not a usable branch name.`)
  }
}

/** The dirty-tree half of the refusal on its own, for moves that name no branch. */
export const assertCleanTree = async (root: string): Promise<void> => {
  const status = await git(root, ['status', '--porcelain=v1', '--untracked-files=no'])
  const dirty = status
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3))
  if (dirty.length > 0) throw new DirtyTreeError(dirty)
}

/**
 * Checks a branch out, creating it from the current head when asked. Refuses
 * on a dirty tree: git would carry the changes over silently, and "where did
 * my edits go" is a worse surprise than a refusal.
 */
export const checkout = async (
  root: string,
  branch: string,
  options: { readonly create?: boolean } = {},
): Promise<void> => {
  await checkoutPreflight(root, branch)
  await git(root, options.create ? ['checkout', '-b', branch] : ['checkout', branch])
}

/** Where the repository root is, for a folder that may be inside one. */
export const topLevel = async (root: string): Promise<string | null> => {
  try {
    return (await git(root, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return null
  }
}
