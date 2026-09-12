import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type {
  GitBranchRef,
  GitCommitDetail,
  GitCommitFile,
  GitFileStatus,
  GitLogCommit,
  GitLogPage,
  GitLogScope,
  GitLogSearch,
  GitRefsSummary,
  GitRemoteRef,
  GitStashRef,
  GitTagRef,
} from '@harnessdesk/protocol'

import { isSha } from './git-revision.js'

/**
 * The repository's past, read for the history pane: the log, the refs, one
 * commit opened, one file's patch at that commit. Everything here reads;
 * the one writer is `createBranch`, which refuses rather than guesses, the
 * same bargain `git-ops.ts` makes. Nothing shells through a shell — every
 * call is an argument vector — and everything that came from the wire is
 * validated here again, because "the renderer checked" is not a boundary.
 */

const run = promisify(execFile)

/* Commits as they are recorded, not as `git replace` would show them. A
   replacement gives a commit another tree and other parents under the same
   id, and what `commit` keeps for a commit's files would then pair a base
   from before the replacement with a patch from after it (review of #238,
   round 1). The history reads the objects themselves, as
   `git --no-replace-objects` does. The environment is built per call, since
   PATH is read at the call. */
const git = async (root: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', ['-C', root, ...args], {
    timeout: 20_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  })
  return stdout
}

/**
 * What git is *expected* to refuse, in its own stderr words: a folder outside
 * any repository, a repository before its first commit, a name that resolves
 * to nothing. Those are answers — "no" — and read as null below. Anything
 * else that fails (a missing git, a timeout, a corrupt object store) stays
 * thrown, because a pane that renders an empty history over a broken read is
 * lying about the repository.
 */
const REFUSALS =
  /not a git repository|does not have any commits yet|unknown revision|ambiguous argument|bad revision|bad default revision/i

const asked = async (root: string, args: readonly string[]): Promise<string | null> => {
  try {
    return await git(root, args)
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown }
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : ''
    // A query told to be --quiet says "no" as a silent exit 1.
    if (failure.code === 1 && stderr.trim().length === 0) return null
    if (REFUSALS.test(stderr)) return null
    throw error
  }
}

/**
 * A search term used inside a pathspec, with wildmatch's operators escaped:
 * the person typed characters, not a glob. `*`, `?`, the brackets and the
 * escaping backslash itself all match literally once prefixed.
 */
const literalPathspec = (query: string): string => query.replace(/[\\*?[\]]/g, '\\$&')

const seconds = (value: string | undefined): number => Number(value ?? 0) * 1000

// ---------------------------------------------------------------------- log

const LOG_LIMIT_DEFAULT = 400
const LOG_LIMIT_MAX = 1000

/** Fields NUL-separated, records unit-separated: subjects may hold anything but these. */
const LOG_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%s%x00%D%x1f'

const parseLog = (out: string): GitLogCommit[] =>
  out
    .split('\x1f')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.length > 0)
    .flatMap((record): GitLogCommit[] => {
      const [sha, parents, author, authorEmail, authoredAt, committedAt, subject, refs] = record.split('\x00')
      if (!sha) return []
      return [
        {
          sha,
          parents: (parents ?? '').split(' ').filter((entry) => entry.length > 0),
          subject: subject ?? '',
          author: author ?? '',
          authorEmail: authorEmail ?? '',
          authoredAt: seconds(authoredAt),
          committedAt: seconds(committedAt),
          refs: (refs ?? '')
            .split(', ')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        },
      ]
    })

export interface LogOptions {
  readonly scope?: GitLogScope
  readonly skip?: number
  readonly limit?: number
  readonly query?: string
  readonly search?: GitLogSearch
}

/**
 * One page of history, newest first, in commit-date order — the order every
 * git client shows. Asks for one commit more than the page to learn whether
 * history continues, and never says an empty folder is an error: a folder
 * outside git and a repository before its first commit are both an empty
 * page, because `git/refs` is where "not a repository" is stated.
 */
export const log = async (root: string, options: LogOptions = {}): Promise<GitLogPage> => {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? LOG_LIMIT_DEFAULT)), LOG_LIMIT_MAX)
  const skip = Math.max(0, Math.floor(options.skip ?? 0))
  const query = options.query?.trim() ?? ''

  // A sha search is an address, not a walk: resolve it and show that commit.
  if (query.length > 0 && options.search === 'sha') {
    if (!isSha(query)) return { commits: [], hasMore: false }
    const resolved = (await asked(root, ['rev-parse', '--verify', '--quiet', `${query}^{commit}`]))?.trim()
    if (!resolved) return { commits: [], hasMore: false }
    const out = await asked(root, ['log', '--max-count=1', `--pretty=format:${LOG_FORMAT}`, resolved])
    return { commits: out ? parseLog(out) : [], hasMore: false }
  }

  const args = ['log', `--skip=${skip}`, `--max-count=${limit + 1}`, '--date-order', `--pretty=format:${LOG_FORMAT}`]
  if ((options.scope ?? 'all') === 'all') args.push('--branches', '--tags', '--remotes')
  if (query.length > 0) {
    if (options.search === 'author') args.push(`--author=${query}`, '--fixed-strings', '--regexp-ignore-case')
    else if (options.search !== 'file') args.push(`--grep=${query}`, '--fixed-strings', '--regexp-ignore-case')
  }
  // HEAD by name, so a detached head's history is still on the graph.
  args.push('HEAD')
  if (query.length > 0 && options.search === 'file') args.push('--', `:(icase)*${literalPathspec(query)}*`)

  const out = await asked(root, args)
  if (out === null) return { commits: [], hasMore: false }
  const commits = parseLog(out)
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit }
}

// --------------------------------------------------------------------- refs

/** `[ahead 1, behind 2]`, `[gone]`, or nothing — for-each-ref's own words. */
const parseTrack = (track: string): { ahead: number; behind: number; gone: boolean } => ({
  ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
  behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
  /* The upstream was deleted on its remote and pruned here. Read as counts
     alone that is zero ahead and zero behind — level with a branch that no
     longer exists, and a Pull that can only fail. #98. */
  gone: /\bgone\b/.test(track),
})

/**
 * Every ref, for the rail: local branches with their tracking state, remote
 * branches by remote, tags peeled to the commit they mark, and the stashes.
 * Null when `root` is not inside a repository — that is the one place the
 * pane learns it, so it can say so instead of showing an empty history.
 */
export const refs = async (root: string): Promise<GitRefsSummary | null> => {
  if ((await asked(root, ['rev-parse', '--git-dir'])) === null) return null

  const [headSha, branchName, heads, remoteRefs, tagRefs, stashList] = await Promise.all([
    asked(root, ['rev-parse', 'HEAD']).then((out) => out?.trim() ?? null),
    // symbolic-ref knows the branch even before the first commit; it fails
    // exactly when HEAD is detached, which is what null means here.
    asked(root, ['symbolic-ref', '--short', '-q', 'HEAD']).then((out) => {
      const name = out?.trim()
      return name && name.length > 0 ? name : null
    }),
    asked(root, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)%00%(objectname)%00%(committerdate:unix)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)',
      'refs/heads/',
    ]),
    asked(root, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)%00%(objectname)%00%(committerdate:unix)',
      'refs/remotes/',
    ]),
    asked(root, [
      'for-each-ref',
      '--sort=-creatordate',
      '--format=%(refname:short)%00%(objectname)%00%(*objectname)%00%(creatordate:unix)',
      'refs/tags/',
    ]),
    asked(root, ['stash', 'list', '--format=%gd%x00%H%x00%ct%x00%gs']),
  ])

  const rows = (out: string | null): string[][] =>
    (out ?? '')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.split('\x00'))

  const branches: GitBranchRef[] = rows(heads).flatMap(([name, sha, at, head, upstream, track]) =>
    name && sha
      ? [
          {
            name,
            sha,
            committedAt: seconds(at),
            current: head === '*',
            upstream: upstream && upstream.length > 0 ? upstream : null,
            ...parseTrack(track ?? ''),
          },
        ]
      : [],
  )

  const remotes: GitRemoteRef[] = rows(remoteRefs).flatMap(([short, sha, at]) => {
    if (!short || !sha) return []
    const cut = short.indexOf('/')
    if (cut === -1) return []
    const remote = short.slice(0, cut)
    const name = short.slice(cut + 1)
    // origin/HEAD is a pointer at another row on this list, not a branch.
    if (name === 'HEAD') return []
    return [{ remote, name, sha, committedAt: seconds(at) }]
  })

  const tags: GitTagRef[] = rows(tagRefs).flatMap(([name, sha, peeled, at]) =>
    name && sha ? [{ name, sha: peeled && peeled.length > 0 ? peeled : sha, at: seconds(at) }] : [],
  )

  const stashes: GitStashRef[] = rows(stashList).flatMap(([ref, sha, at, message]) =>
    ref && sha ? [{ ref, sha, at: seconds(at), message: message ?? '' }] : [],
  )

  return { headSha, branch: branchName, branches, remotes, tags, stashes }
}

// ------------------------------------------------------------------- commit

const STATUS_LETTERS: Record<string, GitFileStatus['status']> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
  U: 'conflicted',
  T: 'modified',
}

/**
 * What one commit compares against: its first parent — which is how every
 * git client reads a merge, "what did landing this change" — or, for the
 * root commit, the empty tree.
 */
const diffBase = async (root: string, sha: string): Promise<string | null> => {
  const parents = (await asked(root, ['show', '-s', '--format=%P', sha]))?.trim() ?? ''
  return parents.split(' ').filter((entry) => entry.length > 0)[0] ?? null
}

/**
 * The empty tree, which a root commit is read against. A well-known object,
 * but named differently in each object format: a SHA-256 repository has no
 * object by the SHA-1 name, so its first commit opened as nothing at all —
 * found by #67's test, once the ids themselves were let through. Asked of the
 * repository only when a root commit needs it; a git too old to answer is a
 * SHA-1 repository.
 */
type ObjectFormat = 'sha1' | 'sha256'
const EMPTY_TREES: Readonly<Record<ObjectFormat, string>> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
}
/**
 * Each repository's answer: its object format never changes, and it was asked
 * again for every root-commit file opened (review of #150). By the `.git` the
 * folder holds, not by the folder: a repository made again at the same path,
 * perhaps in the other format, is another `.git` and is asked again (review of
 * #238, round 1).
 */
const formats = new Map<string, ObjectFormat>()
const repositoryAt = async (root: string): Promise<string> => {
  const found = await stat(join(root, '.git')).catch(() => null)
  return found ? `${root}\0${found.ino}\0${found.birthtimeMs}` : root
}

/** The question, which is also the answer a git too old to know it gives. */
const QUESTION = '--show-object-format'
/** A git whose option parser refuses it, rather than handing it back. */
const OLD_GIT = /unknown option|^usage: git rev-parse/im

/**
 * The repository's object format, or null when git could not answer this
 * time — SHA-1 for this read, and asked again next time rather than kept.
 *
 * Only a git too old for the question — 2.29 brought it — reads as null, and
 * it says so in one of exactly two ways: `rev-parse` hands an option it does
 * not know straight back and exits 0 (measured on git 2.50.1, `git rev-parse
 * --bogus-thing` prints `--bogus-thing`), or its option parser refuses it with
 * exit 129 and "unknown option".
 *
 * Every other failure used to be swallowed here too, answering SHA-1 for a
 * wrapper on PATH, an unreadable repository, a timeout (review of #238, round
 * 2). In a SHA-256 repository that names an object which does not exist, and
 * git calls every diff against it an unknown revision — one of the refusals
 * `asked` reads as "no" — so the commit came back as an empty patch,
 * indistinguishable from one that changed nothing. A wrong answer is worse
 * than none: those are thrown instead. Both callers already throw for a commit
 * id they will not take, and the pane answers a failed `git/commit` with "could
 * not read that commit" rather than drawing a commit that touched nothing.
 */
const askFormat = async (root: string): Promise<ObjectFormat | null> => {
  let answer: string | null
  try {
    answer = await asked(root, ['rev-parse', QUESTION])
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown }
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : ''
    if (failure.code === 129 && OLD_GIT.test(stderr)) return null
    throw error
  }
  // A folder outside a repository, or one before its first commit: `asked`
  // read those as "no" already.
  if (answer === null) return null
  const format = answer.trim()
  if (format === 'sha1' || format === 'sha256') return format
  // The flag handed back verbatim: a git that never knew it.
  if (format === QUESTION) return 'sha1'
  throw new Error(`git named an object format this build does not know: "${format}".`)
}

const emptyTree = async (root: string): Promise<string> => {
  const repository = await repositoryAt(root)
  let format = formats.get(repository)
  if (format === undefined) {
    const answer = await askFormat(root)
    // A git that couldn't answer this time is asked again next time.
    if (answer !== null) formats.set(repository, answer)
    format = answer ?? 'sha1'
  }
  return EMPTY_TREES[format]
}

/**
 * What `commit` worked out for a commit, its base and its file list, kept for
 * the files it opens next: each file ran a whole-commit `--name-status` of its
 * own, 64 ms on a 2,032-file commit (review of #150). A commit's files never
 * change; only the last few commits are kept. Sixteen commits whatever their
 * size, so a commit of a hundred thousand files keeps its list until fifteen
 * others have been opened after it.
 *
 * Kept by a full object id only. Four to 63 hex characters can name a branch
 * as well, `beef` or `2024`, which git reads as the branch, and a branch moves
 * (review of #238, round 1).
 */
type Opened = { readonly base: string; readonly entries: ReturnType<typeof listed> }
const opened = new Map<string, Opened>()
const FULL_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const remember = (root: string, sha: string, value: Opened): void => {
  if (!FULL_ID.test(sha)) return
  const key = `${root}\0${sha}`
  opened.delete(key)
  opened.set(key, value)
  for (const oldest of opened.keys()) {
    if (opened.size <= 16) break
    opened.delete(oldest)
  }
}

/** Forgets what was kept, for a test that needs a cold read (review of #238, round 1). */
export const forgetKnown = (): void => {
  formats.clear()
  opened.clear()
}

/**
 * One commit opened: full message, both identities, and its files with
 * their +/− counts — numstat and name-status merged by path, since git
 * answers each in a different breath. Binary files carry null counts.
 */
export const commit = async (root: string, sha: string): Promise<GitCommitDetail> => {
  if (!isSha(sha)) throw new Error(`"${sha}" is not a commit id.`)
  const meta = await git(root, [
    'show',
    '-s',
    '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ct%x00%D%x00%B',
    sha,
  ])
  const [fullSha, parentList, author, authorEmail, authoredAt, committer, committedAt, decorations, ...rest] =
    meta.split('\x00')
  const parents = (parentList ?? '').split(' ').filter((entry) => entry.length > 0)
  const base = parents[0] ?? (await emptyTree(root))

  const [numstat, nameStatus] = await Promise.all([
    asked(root, ['diff', '--numstat', '-z', '--no-color', '--no-ext-diff', base, sha]),
    asked(root, ['diff', '--name-status', '-z', '--no-color', '--no-ext-diff', base, sha]),
  ])

  // `--numstat -z`: "added\tremoved\tpath\0", except a rename, which is
  // "added\tremoved\t\0old\0new\0" — the empty path is the signal.
  const counts = new Map<string, { added: number | null; removed: number | null }>()
  {
    const fields = (numstat ?? '').split('\0')
    for (let index = 0; index < fields.length; index += 1) {
      const entry = fields[index]
      if (!entry) continue
      const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(entry)
      if (!match) continue
      const added = match[1] === '-' ? null : Number(match[1])
      const removed = match[2] === '-' ? null : Number(match[2])
      let path = match[3] ?? ''
      if (path.length === 0) {
        path = fields[index + 2] ?? ''
        index += 2
      }
      if (path.length > 0) counts.set(path, { added, removed })
    }
  }

  const entries = listed(nameStatus)
  remember(root, sha, { base, entries })
  if (fullSha && fullSha.trim() !== sha) remember(root, fullSha.trim(), { base, entries })
  const files: GitCommitFile[] = entries.map(({ letter, path, oldPath }) => {
    const count = counts.get(path) ?? { added: 0, removed: 0 }
    return {
      path,
      ...(oldPath ? { oldPath } : {}),
      status: STATUS_LETTERS[letter] ?? 'modified',
      added: count.added,
      removed: count.removed,
    }
  })

  return {
    sha: (fullSha ?? sha).trim(),
    parents,
    author: author ?? '',
    authorEmail: authorEmail ?? '',
    authoredAt: seconds(authoredAt),
    committer: committer ?? '',
    committedAt: seconds(committedAt),
    refs: (decorations ?? '')
      .split(', ')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    // %B is the last field and may itself contain anything, so it is joined
    // back rather than trusted to be one split entry. Trailing newlines are
    // the format's artifact, not the message's.
    message: rest.join('\x00').replace(/\n+$/, ''),
    files,
  }
}

/**
 * `--name-status -z`: a status letter, then one path — or two for a rename or
 * a copy, the old one first. Empty when git gave nothing.
 */
const listed = (nameStatus: string | null): { letter: string; path: string; oldPath?: string }[] => {
  const files: { letter: string; path: string; oldPath?: string }[] = []
  const fields = (nameStatus ?? '').split('\0')
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index]
    if (!status || status.length === 0) continue
    const letter = status[0] ?? ''
    const renamed = letter === 'R' || letter === 'C'
    const oldPath = renamed ? (fields[index + 1] ?? '') : undefined
    const path = renamed ? (fields[index + 2] ?? '') : (fields[index + 1] ?? '')
    index += renamed ? 2 : 1
    if (path.length === 0) continue
    files.push({ letter, path, ...(oldPath && oldPath.length > 0 ? { oldPath } : {}) })
  }
  return files
}

/** One file's patch at one commit, against the same base the file list used. */
export const commitDiff = async (root: string, sha: string, path: string): Promise<string> => {
  if (!isSha(sha)) throw new Error(`"${sha}" is not a commit id.`)
  const known = opened.get(`${root}\0${sha}`)
  const base = known?.base ?? (await diffBase(root, sha)) ?? (await emptyTree(root))
  /* A rename is two paths, and a pathspec naming only the new one hides the
     old one from git: with nothing to pair it with, the file read as added
     from nothing, every line new. #68. The old path comes from the same
     name-status the file list is built from, so the patch shows what the list
     said — a rename, and only what changed across it. */
  const entry = (
    known?.entries ?? listed(await asked(root, ['diff', '--name-status', '-z', '--no-color', '--no-ext-diff', base, sha]))
  ).find((file) => file.path === path)
  /* Renames only. A rename's two paths are one file; a copy's are two, and
     naming the source brought the source's own edits into the copy's patch
     (review, round 1). A copy opens as the file it made. */
  const paths = entry?.letter === 'R' && entry.oldPath ? [entry.oldPath, path] : [path]
  return (await asked(root, ['diff', '--no-color', '--no-ext-diff', base, sha, '--', ...paths])) ?? ''
}

// ------------------------------------------------------------ createBranch

/**
 * A branch at a commit — the one mutation the history pane owns, because it
 * destroys nothing. The name is judged by git itself (`check-ref-format`),
 * and checking the new branch out goes through the same dirty-tree refusal
 * every checkout gets; the caller composes that separately.
 */
export const createBranch = async (root: string, name: string, at: string): Promise<void> => {
  if (!isSha(at)) throw new Error(`"${at}" is not a commit id.`)
  if (name.startsWith('-')) throw new Error(`"${name}" is not a usable branch name.`)
  await git(root, ['check-ref-format', '--branch', name])
  await git(root, ['branch', name, at])
}
