import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { parsePorcelain } from './porcelain.js'

/**
 * The verbs a git client owes its toolbar and its context menus — commit,
 * pull, push, fetch, merge, rebase, reset, revert, cherry-pick, tags,
 * stashes, branch upkeep. `git-history.ts` reads; this writes, under the
 * same bargain every host mutation makes: refuse rather than guess, never
 * shell through a shell, and never trust that the renderer validated.
 *
 * Two postures toward a conflict, chosen by what the app can show:
 *
 * - Merge, pull, revert, cherry-pick and stash-apply *leave* their conflicts
 *   in the working tree and name the files. The Changes surface shows
 *   conflicted paths and a commit concludes the operation — that is a state
 *   the app can hold, so refusing it would just be a worse git.
 * - Rebase *aborts* on conflict and says nothing changed. A half-done rebase
 *   is a state this app has no surface for, and "finish it in a terminal" is
 *   not an answer a toolbar button gets to give.
 */

const run = promisify(execFile)

/** Network verbs wait longer: a fetch over a slow link is not a hang. */
const git = async (root: string, args: readonly string[], timeout = 20_000): Promise<string> => {
  const { stdout } = await run('git', ['-C', root, ...args], { timeout, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

const NETWORK = 120_000

/**
 * git's own reason, without the exec noise around it.
 *
 * Split on carriage returns as well as newlines: a verb that draws progress
 * overwrites its own line, so git's reason arrives as
 * `Rebasing (1/1)\rerror: could not apply …`. Reading whole lines only, that
 * one does not *start* with `error:` — and the fallback then reports
 * "Command failed: git -C /long/path rebase main", which tells a person the
 * command they did not type and nothing about what went wrong.
 */
const plain = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error)
  const lines = text
    .split(/[\n\r]/)
    .map((line) => line.trim())
    .filter((line) => /^(error|fatal):/.test(line))
    .map((line) => line.replace(/^(error|fatal):\s*/, ''))
  return lines.length > 0 ? lines.join(' ') : (text.split('\n')[0] ?? text)
}

const fail = (doing: string, error: unknown): never => {
  throw new Error(`${doing}: ${plain(error)}`)
}

/** A full or abbreviated commit id, and nothing that could read as an option. */
const isSha = (value: string): boolean => /^[0-9a-f]{4,40}$/i.test(value)

/**
 * A name this module will hand to git as a revision: a branch, a remote
 * branch, a tag, or a commit id — conservative characters, never starting
 * with `-`, then confirmed to resolve to a commit. "The renderer sent it"
 * is not a boundary, and a name that resolves to nothing is a refusal in
 * words rather than git's "unknown revision".
 */
const resolveCommitish = async (root: string, ref: string): Promise<string> => {
  if (!/^[\w][\w./@{}-]*$/.test(ref) || ref.includes('..')) {
    throw new Error(`"${ref}" is not a usable revision name.`)
  }
  try {
    return (await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim()
  } catch {
    throw new Error(`"${ref}" does not name a commit in this repository.`)
  }
}

/** A branch name, judged by git itself. */
const checkBranchName = async (root: string, name: string): Promise<void> => {
  if (name.startsWith('-')) throw new Error(`"${name}" is not a usable branch name.`)
  try {
    await git(root, ['check-ref-format', '--branch', name])
  } catch {
    throw new Error(`"${name}" is not a usable branch name.`)
  }
}

/** `stash@{0}` and nothing else — the reflog address git hands out. */
const checkStashRef = (ref: string): void => {
  if (!/^stash@\{\d+\}$/.test(ref)) throw new Error(`"${ref}" is not a stash reference.`)
}

/** A search term used as a pathspec must match characters, not a glob. */
const literal = (path: string): string => {
  if (path.startsWith('-')) throw new Error(`"${path}" is not a usable path.`)
  return `:(literal)${path}`
}

/** The paths a merge-like verb left conflicted, straight from status. */
const conflictedFiles = async (root: string): Promise<string[]> => {
  const out = await git(root, ['status', '--porcelain=v1', '-z'])
  /* Through the shared reader, so a copy's origin is never tested as a status
     record. Split by hand it was: an origin named `Utils.ts` has `Ut` in its
     first two characters, which `includes('U')` reads as a conflict, and the
     path reported for it is `ls.ts`. */
  return parsePorcelain(out)
    .filter((entry) => {
      const xy = `${entry.index}${entry.worktree}`
      return xy.includes('U') || xy === 'AA' || xy === 'DD'
    })
    .map((entry) => entry.path)
}

const currentBranch = async (root: string): Promise<string | null> => {
  try {
    const name = (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim()
    return name.length > 0 ? name : null
  } catch {
    return null
  }
}

const upstreamOf = async (root: string): Promise<string | null> => {
  try {
    return (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim()
  } catch {
    return null
  }
}

const head = async (root: string): Promise<string | null> => {
  try {
    return (await git(root, ['rev-parse', 'HEAD'])).trim()
  } catch {
    return null
  }
}

/** What a merge-like verb reports: done, or done-up-to-these-conflicts. */
export interface MergeOutcome {
  readonly summary: string
  /** Paths left conflicted in the working tree; empty when the verb concluded. */
  readonly conflicts: readonly string[]
}

// ------------------------------------------------------------------- commit

/**
 * What a partial commit needs to know about the working tree: where each
 * staged rename came from, keyed by where it went — status names a rename
 * by its destination alone, but committing just that destination would
 * record a copy and leave the deletion staged behind — and which paths are
 * untracked, because only those need introducing to the index first.
 */
const treeState = async (
  root: string,
): Promise<{ renames: Map<string, string>; untracked: Set<string> }> => {
  const out = await git(root, ['status', '--porcelain=v1', '-z'])
  const renames = new Map<string, string>()
  const untracked = new Set<string>()
  for (const entry of parsePorcelain(out)) {
    if (entry.index === '?' && entry.worktree === '?') untracked.add(entry.path)
    /* Renames only. `commitAll` widens a chosen path to include what it came
       from, because committing a rename without its origin leaves the deletion
       behind — and the comment there says why: intent-to-add refuses a path
       that no longer exists, "which is exactly what a rename's origin is". A
       copy's origin does still exist, so widening to it would commit changes
       in a file the user did not choose. */
    if (entry.index === 'R' && entry.origin) renames.set(entry.path, entry.origin)
  }
  return { renames, untracked }
}

/**
 * Stages and commits. With `paths`, exactly those files — literal pathspecs,
 * untracked ones registered first so a new file can ride a partial commit,
 * a staged rename widened to carry its origin — and without, everything,
 * which is also the only shape git accepts while a merge or revert is being
 * concluded. An explicitly empty list refuses: the renderer disables that
 * button, but the host is the boundary, and "commit nothing" must never
 * quietly become "commit everything".
 */
export const commitAll = async (
  root: string,
  message: string,
  paths?: readonly string[],
): Promise<{ sha: string }> => {
  if (message.trim().length === 0) throw new Error('A commit needs a message.')
  if (paths !== undefined && paths.length === 0) {
    throw new Error('No files were chosen — pick the files to commit, or commit everything.')
  }
  try {
    if (paths) {
      const { renames, untracked } = await treeState(root)
      const named = [...new Set(paths.flatMap((path) => {
        const from = renames.get(path)
        return from ? [path, from] : [path]
      }))]
      // `git commit -- <paths>` takes working-tree contents for those paths
      // and leaves the rest of the index as it was. An untracked file joins
      // only once it is known to the index, so say it is intended first —
      // and only for the untracked: intent-to-add refuses a path that no
      // longer exists, which is exactly what a rename's origin is.
      const fresh = named.filter((path) => untracked.has(path)).map(literal)
      if (fresh.length > 0) await git(root, ['add', '--intent-to-add', '--', ...fresh])
      await git(root, ['commit', '-m', message, '--', ...named.map(literal)])
    } else {
      await git(root, ['add', '-A'])
      await git(root, ['commit', '-m', message])
    }
  } catch (error) {
    fail('Could not commit', error)
  }
  return { sha: (await head(root)) ?? '' }
}

// ------------------------------------------------------------ pull and push

/**
 * Pulls the current branch from what it tracks. A clean pull says what
 * arrived; a conflicted merge stays in the working tree with its files
 * named, exactly as `merge` would leave it. The reconcile strategy is
 * merge, said explicitly: a rebase pull's conflict would pause mid-rebase,
 * the one state this module refuses to leave behind, and an unset
 * `pull.rebase` on modern git refuses divergence outright.
 */
export const pull = async (root: string): Promise<MergeOutcome> => {
  const before = await head(root)
  try {
    await git(root, ['pull', '--no-rebase', '--no-edit'], NETWORK)
  } catch (error) {
    const conflicts = await conflictedFiles(root).catch(() => [])
    if (conflicts.length > 0) {
      return {
        summary: `The pull hit ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}; resolve and commit to conclude the merge.`,
        conflicts,
      }
    }
    fail('Could not pull', error)
  }
  const after = await head(root)
  if (before === after) return { summary: 'Already up to date.', conflicts: [] }
  const count = Number((await git(root, ['rev-list', '--count', `${before}..${after}`]).catch(() => '')).trim())
  return {
    summary: Number.isFinite(count) && count > 0 ? `Pulled ${count} commit${count === 1 ? '' : 's'}.` : 'Pulled.',
    conflicts: [],
  }
}

/**
 * Pushes the current branch. A branch that tracks nothing yet is pushed
 * with `-u` to origin — or to the only remote there is — so the first push
 * is one gesture, the way every git client makes it.
 */
export const push = async (root: string): Promise<{ summary: string }> => {
  const branch = await currentBranch(root)
  if (!branch) throw new Error('HEAD is detached; there is no branch to push.')
  const upstream = await upstreamOf(root)
  if (upstream) {
    const ahead = Number((await git(root, ['rev-list', '--count', `${upstream}..HEAD`]).catch(() => '')).trim())
    try {
      await git(root, ['push'], NETWORK)
    } catch (error) {
      fail('Could not push', error)
    }
    return {
      summary:
        Number.isFinite(ahead) && ahead > 0
          ? `Pushed ${ahead} commit${ahead === 1 ? '' : 's'} to ${upstream}.`
          : 'Everything up to date.',
    }
  }
  const remotes = (await git(root, ['remote']))
    .split('\n')
    .filter((line) => line.length > 0)
  if (remotes.length === 0) throw new Error('This repository has no remote to push to.')
  const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0]! : null
  if (!remote) throw new Error(`Several remotes (${remotes.join(', ')}) and no upstream — set one first.`)
  try {
    await git(root, ['push', '-u', remote, 'HEAD'], NETWORK)
  } catch (error) {
    fail('Could not push', error)
  }
  return { summary: `Pushed ${branch} to ${remote} and set it to track ${remote}/${branch}.` }
}

/** Fetches every remote, pruning remote-tracking refs their remote dropped. */
export const fetch = async (root: string): Promise<{ summary: string }> => {
  const remotes = (await git(root, ['remote']))
    .split('\n')
    .filter((line) => line.length > 0)
  if (remotes.length === 0) throw new Error('This repository has no remote to fetch from.')
  try {
    await git(root, ['fetch', '--all', '--prune'], NETWORK)
  } catch (error) {
    fail('Could not fetch', error)
  }
  return { summary: `Fetched ${remotes.join(', ')}.` }
}

// --------------------------------------------------------- merge and rebase

/** Merges a revision into the current branch, leaving conflicts in place. */
export const merge = async (root: string, ref: string): Promise<MergeOutcome> => {
  const before = await head(root)
  await resolveCommitish(root, ref)
  try {
    await git(root, ['merge', '--no-edit', ref])
  } catch (error) {
    const conflicts = await conflictedFiles(root).catch(() => [])
    if (conflicts.length > 0) {
      return {
        summary: `Merging ${ref} hit ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}; resolve and commit to conclude it.`,
        conflicts,
      }
    }
    fail(`Could not merge ${ref}`, error)
  }
  const after = await head(root)
  return {
    summary: before === after ? `Already up to date with ${ref}.` : `Merged ${ref}.`,
    conflicts: [],
  }
}

/**
 * Rebases the current branch onto a revision — and aborts itself on
 * conflict, reporting that nothing changed. See the module note: a paused
 * rebase is a state this app has no surface for.
 */
export const rebase = async (root: string, onto: string): Promise<{ summary: string }> => {
  await resolveCommitish(root, onto)
  try {
    await git(root, ['rebase', onto])
  } catch (error) {
    // Read the wreckage before undoing it: the abort is what makes this verb
    // safe, and it is also what destroys the only evidence of *where* the
    // rebase stopped. "It would not apply cleanly" with no files named leaves
    // a person to re-run the rebase by hand just to learn that much.
    const conflicts = await conflictedFiles(root).catch(() => [])
    await git(root, ['rebase', '--abort']).catch(() => {})
    const named =
      conflicts.length > 0
        ? ` ${conflicts.length === 1 ? 'The file that clashed' : `The ${conflicts.length} files that clashed`}: ${conflicts.join(', ')}.`
        : ''
    throw new Error(
      `The rebase onto ${onto} would not apply cleanly and was aborted; nothing changed.${named} (${plain(error)})`,
    )
  }
  return { summary: `Rebased onto ${onto}.` }
}

// ------------------------------------------------- revert and cherry-pick

/**
 * Reverts one commit — a merge against its first parent, the mainline every
 * client assumes. Conflicts stay in the tree; committing concludes the
 * revert, exactly as with a merge.
 */
export const revertCommit = async (root: string, sha: string): Promise<MergeOutcome> => {
  if (!isSha(sha)) throw new Error(`"${sha}" is not a commit id.`)
  const parents = (await git(root, ['show', '-s', '--format=%P', sha])).trim().split(' ').filter(Boolean)
  const mainline = parents.length > 1 ? ['-m', '1'] : []
  try {
    await git(root, ['revert', '--no-edit', ...mainline, sha])
  } catch (error) {
    const conflicts = await conflictedFiles(root).catch(() => [])
    if (conflicts.length > 0) {
      return {
        summary: `Reverting hit ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}; resolve and commit to conclude it.`,
        conflicts,
      }
    }
    fail('Could not revert', error)
  }
  return { summary: `Reverted ${sha.slice(0, 7)}.`, conflicts: [] }
}

/** Cherry-picks one commit onto the current branch. Merges are refused. */
export const cherryPick = async (root: string, sha: string): Promise<MergeOutcome> => {
  if (!isSha(sha)) throw new Error(`"${sha}" is not a commit id.`)
  const parents = (await git(root, ['show', '-s', '--format=%P', sha])).trim().split(' ').filter(Boolean)
  if (parents.length > 1) {
    throw new Error('That is a merge commit; cherry-pick the commits it merged instead.')
  }
  try {
    await git(root, ['cherry-pick', sha])
  } catch (error) {
    const conflicts = await conflictedFiles(root).catch(() => [])
    if (conflicts.length > 0) {
      return {
        summary: `The cherry-pick hit ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}; resolve and commit to conclude it.`,
        conflicts,
      }
    }
    fail('Could not cherry-pick', error)
  }
  return { summary: `Cherry-picked ${sha.slice(0, 7)}.`, conflicts: [] }
}

// -------------------------------------------------------------------- reset

export type ResetMode = 'soft' | 'mixed' | 'hard'

/**
 * Moves the current branch to a commit. Soft and mixed destroy nothing —
 * the work sits in the tree either way. Hard is the one verb in this file
 * that erases uncommitted work, and it runs only because the dialog that
 * calls it says so in red and asks again.
 */
export const reset = async (root: string, to: string, mode: ResetMode): Promise<void> => {
  if (mode !== 'soft' && mode !== 'mixed' && mode !== 'hard') throw new Error(`"${mode}" is not a reset mode.`)
  const target = await resolveCommitish(root, to)
  try {
    await git(root, ['reset', `--${mode}`, target])
  } catch (error) {
    fail('Could not reset', error)
  }
}

// ----------------------------------------------------------------- checkout

/**
 * Checks a commit out detached — reading an old state, not moving a branch.
 * The same dirty-tree refusal every checkout gets applies; the caller runs
 * that preflight, the way `git/createBranch` composes it.
 */
export const checkoutCommit = async (root: string, sha: string): Promise<void> => {
  if (!isSha(sha)) throw new Error(`"${sha}" is not a commit id.`)
  try {
    await git(root, ['checkout', '--detach', sha])
  } catch (error) {
    fail('Could not check the commit out', error)
  }
}

// ----------------------------------------------------------------- branches

export const renameBranch = async (root: string, from: string, to: string): Promise<void> => {
  await checkBranchName(root, from)
  await checkBranchName(root, to)
  try {
    await git(root, ['branch', '-m', from, to])
  } catch (error) {
    fail(`Could not rename ${from}`, error)
  }
}

/**
 * Deletes a branch. Unmerged work refuses unless forced — that refusal is
 * git's own and it is the right one — and the current branch refuses
 * always, in words, before git says something less helpful.
 */
export const deleteBranch = async (root: string, name: string, force = false): Promise<void> => {
  await checkBranchName(root, name)
  if ((await currentBranch(root)) === name) {
    throw new Error(`${name} is checked out; switch away before deleting it.`)
  }
  try {
    await git(root, ['branch', force ? '-D' : '-d', name])
  } catch (error) {
    fail(`Could not delete ${name}`, error)
  }
}

// --------------------------------------------------------------------- tags

/** A tag at a commit — annotated when it carries a message. */
export const createTag = async (root: string, name: string, at: string, message?: string): Promise<void> => {
  if (!isSha(at)) throw new Error(`"${at}" is not a commit id.`)
  if (name.startsWith('-')) throw new Error(`"${name}" is not a usable tag name.`)
  try {
    await git(root, ['check-ref-format', `refs/tags/${name}`])
  } catch {
    throw new Error(`"${name}" is not a usable tag name.`)
  }
  try {
    await git(root, message && message.trim().length > 0 ? ['tag', '-a', name, '-m', message, at] : ['tag', name, at])
  } catch (error) {
    fail(`Could not tag ${at.slice(0, 7)}`, error)
  }
}

export const deleteTag = async (root: string, name: string): Promise<void> => {
  if (name.startsWith('-')) throw new Error(`"${name}" is not a usable tag name.`)
  try {
    await git(root, ['tag', '-d', name])
  } catch (error) {
    fail(`Could not delete the tag ${name}`, error)
  }
}

// ------------------------------------------------------------------ stashes

/** Sets the working tree aside, untracked files included. */
export const stashSave = async (root: string, message?: string): Promise<void> => {
  const label = message?.trim()
  try {
    const out = await git(root, [
      'stash',
      'push',
      '--include-untracked',
      ...(label && label.length > 0 ? ['-m', label] : []),
    ])
    if (/No local changes to save/i.test(out)) throw new Error('There is nothing to stash.')
  } catch (error) {
    fail('Could not stash', error)
  }
}

/**
 * Applies a stash — dropping it too when `pop`. On conflict git itself
 * keeps the entry, pop or not, so nothing set aside is ever lost to a
 * conflicted apply; the files are named and the tree shows them.
 */
export const stashApply = async (root: string, ref: string, pop = false): Promise<MergeOutcome> => {
  checkStashRef(ref)
  try {
    await git(root, ['stash', pop ? 'pop' : 'apply', ref])
  } catch (error) {
    const conflicts = await conflictedFiles(root).catch(() => [])
    if (conflicts.length > 0) {
      return {
        summary: `Applying the stash hit ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}; the stash entry was kept.`,
        conflicts,
      }
    }
    fail('Could not apply the stash', error)
  }
  return { summary: pop ? 'Applied and dropped the stash.' : 'Applied the stash.', conflicts: [] }
}

export const stashDrop = async (root: string, ref: string): Promise<void> => {
  checkStashRef(ref)
  try {
    await git(root, ['stash', 'drop', ref])
  } catch (error) {
    fail('Could not drop the stash', error)
  }
}

// ---------------------------------------------------------- patch and diff

/** One commit as a mail-format patch, the text `git am` takes. */
export const patch = async (root: string, sha: string): Promise<string> => {
  if (!isSha(sha)) throw new Error(`"${sha}" is not a commit id.`)
  try {
    return await git(root, ['format-patch', '-1', '--stdout', sha])
  } catch (error) {
    return fail('Could not build the patch', error)
  }
}

/** The plain difference between two revisions' trees. */
export const diffRange = async (root: string, from: string, to: string): Promise<string> => {
  const base = await resolveCommitish(root, from)
  const target = await resolveCommitish(root, to)
  try {
    return await git(root, ['diff', '--no-color', '--no-ext-diff', base, target])
  } catch (error) {
    return fail('Could not diff', error)
  }
}

// ------------------------------------------------------------- pull request

/**
 * `git@host:owner/repo.git` and friends, parsed to the https page a browser
 * opens. Credentials embedded in the remote — a token in an https URL — are
 * stripped before anything leaves this process: the result is handed to the
 * system browser, and a secret in that URL would land in its history.
 */
const webUrl = (remote: string): URL | null => {
  const cleaned = remote.trim().replace(/\.git$/, '')
  const ssh = /^(?:ssh:\/\/)?git@([^:/@]+)[:/](.+)$/.exec(cleaned)
  const candidate = ssh ? `https://${ssh[1]}/${ssh[2]}` : cleaned
  if (!/^https?:\/\//.test(candidate)) return null
  try {
    const url = new URL(candidate)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url
  } catch {
    return null
  }
}

/**
 * Where "open a pull request for this branch" goes, for the forges whose
 * compare pages are well-known — by exact hostname, so `github.example.com`
 * never gets a github.com-shaped URL it does not serve. Null — not an
 * error — when the remote is somewhere this cannot name; the menu row says
 * why it is grey.
 */
export const pullRequestUrl = async (root: string, branch: string): Promise<string | null> => {
  await checkBranchName(root, branch)
  const remotes = (await git(root, ['remote']))
    .split('\n')
    .filter((line) => line.length > 0)
  const remote = remotes.includes('origin') ? 'origin' : remotes[0]
  if (!remote) return null
  const url = webUrl(await git(root, ['remote', 'get-url', remote]).catch(() => ''))
  if (!url) return null
  const base = `https://${url.hostname}${url.pathname.replace(/\/+$/, '')}`
  const name = encodeURIComponent(branch)
  if (url.hostname === 'github.com') return `${base}/compare/${name}?expand=1`
  if (url.hostname === 'gitlab.com') return `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${name}`
  if (url.hostname === 'bitbucket.org') return `${base}/pull-requests/new?source=${name}`
  return null
}
