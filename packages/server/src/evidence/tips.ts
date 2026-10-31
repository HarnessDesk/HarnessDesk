import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { Sha } from '@harnessdesk/protocol'

import { readGit } from '../git-read.js'

/**
 * Where a branch stands, asked of git once per move rather than once per
 * reader.
 *
 * Every evidence read measures each fact against its branch's tip, and a desk
 * with open Teams reads its boards many times a second during a Lead run —
 * every Goal view, the Lead's own projection and its child's evidence reads,
 * the client door — about 1,400 `rev-parse` processes in one end-to-end case,
 * nearly every one repeating the answer before it.
 *
 * A tip changes only when its ref is written, and git writes a ref by renaming
 * a new file over the old one: the loose ref, `packed-refs`, or a reftable's
 * `tables.list`. The files a ref can be kept in — each one's identity, size
 * and times, and a loose ref's own text — are therefore a mark that moves
 * whenever the tip can have, and reading it costs a `stat`, not a process. A
 * reader whose mark matches the last read's shares that read's answer, in
 * flight or settled; any other reader asks git. Git still says where a branch
 * is: the mark only says whether to ask again.
 *
 * Nothing is kept that a mark cannot vouch for: a folder that is not the root
 * of its own checkout, a ref name git would read as an expression, a HEAD
 * naming anything but a branch, a branch that is itself a symbolic ref, or a
 * file that cannot be read.
 */

/**
 * A file changed this recently, measured from the moment its mark was read,
 * never vouches for that mark — git's own rule for a racy index. A filesystem
 * stamps times in ticks (a second, on some), and a second write within the
 * tick of the first can leave every part of a mark as it was; once a file
 * has been still for longer than that, the next write is in a later tick.
 * Such a ref is asked again on each read until it has been still that long.
 */
export const RACY_MS = 2_000

/** Enough for every checkout of every open Team several times over; the oldest goes first. */
const KEPT = 1_024

const git = async (cwd: string, args: readonly string[]): Promise<string> =>
  (await readGit(cwd, args, { timeout: 20_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout

export const keep = <T>(map: Map<string, T>, key: string, value: T): T => {
  map.delete(key)
  map.set(key, value)
  if (map.size > KEPT) map.delete(map.keys().next().value!)
  return value
}

/** One file's part of a mark: what it is now, its text when asked for, and when it last changed. */
export interface Part { readonly text: string; readonly body: string; readonly changed: number }

/** Absent is an answer too: a branch that is only packed, or gone, has no loose file. */
export const ABSENT: Part = { text: '-', body: '', changed: 0 }

/**
 * A file's identity, size and times — its text too when `text` asks and it is
 * small — or null when it is there and cannot be read. `identity` leaves out
 * size and times: a directory's move with every lock file git writes in it.
 */
export const partOf = async (path: string, text: boolean, identity = false): Promise<Part | null> => {
  try {
    const info = await stat(path, { bigint: true })
    const body = text && info.isFile() && info.size <= 4096n ? await readFile(path, 'utf8') : ''
    const newest = info.mtimeNs > info.ctimeNs ? info.mtimeNs : info.ctimeNs
    const kind = info.isFile() ? 'f' : info.isDirectory() ? 'd' : 'o'
    return {
      text: identity
        ? `${kind}:${info.dev}:${info.ino}:${JSON.stringify(body)}`
        : `${kind}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${JSON.stringify(body)}`,
      body,
      changed: Number(newest / 1_000_000n),
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? ABSENT : null
  }
}

/**
 * A branch name git reads as exactly one file under `refs/heads/`: the names
 * `git check-ref-format` allows, less everything `rev-parse` would read as an
 * expression (`~`, `^`, `@{`), which names no file of its own.
 */
const plainBranch = (name: string): boolean =>
  /^[\w][\w./-]*$/.test(name) && !name.includes('..') && !name.includes('//') && !name.includes('/.') &&
  !name.endsWith('/') && !name.endsWith('.') && !name.endsWith('.lock')

/** Where a checkout keeps its refs: its own HEAD's folder, and the folder its branches are shared from. */
interface Dirs { readonly gitDir: string; readonly commonDir: string }

const dirs = new Map<string, { readonly mark: string; readonly dirs: Promise<Dirs | null> }>()

/**
 * A checkout root's git folders, asked once while its `.git` is the same
 * entry: the same directory, or a `gitdir:` file with the same text. Only a
 * folder with a `.git` of its own is kept — a subfolder's answer depends on
 * every folder above it, and is asked each time.
 */
const dirsOf = async (cwd: string): Promise<Dirs | null> => {
  const dotGit = await partOf(join(cwd, '.git'), true, true)
  if (dotGit === null || dotGit === ABSENT) return null
  const known = dirs.get(cwd)
  if (known && known.mark === dotGit.text) return known.dirs
  const asked = git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']).then((out) => {
    // One line each; a path holding a newline is never kept.
    const lines = out.replace(/\n$/, '').split('\n')
    return lines.length === 2 && lines[0] && lines[1] ? { gitDir: lines[0], commonDir: lines[1] } : null
  }, () => null)
  const entry = keep(dirs, cwd, { mark: dotGit.text, dirs: asked })
  // A refusal is never kept: git may be busy, or the folder half-made.
  void asked.then((answer) => { if (answer === null && dirs.get(cwd) === entry) dirs.delete(cwd) })
  return asked
}

/** Parts read since `since`, as one mark; null when any could not be read. */
export const markFrom = (parts: readonly (Part | null)[], since: number): { readonly text: string; readonly trusted: boolean } | null => {
  if (parts.some((part) => part === null)) return null
  return {
    text: (parts as Part[]).map((part) => part.text).join('|'),
    trusted: (parts as Part[]).every((part) => part.changed < since - RACY_MS),
  }
}

/**
 * The mark of every file git reads to resolve a checkout's branch — or its
 * HEAD, and the branch HEAD names — and whether it vouches for itself: every
 * part still for longer than `RACY_MS` when it was read. Null when nothing
 * can vouch for an answer, and the caller asks git — among them a branch that
 * is itself a symbolic ref, whose tip is another file's.
 */
const markOf = async (cwd: string, branch: string | null): Promise<{ readonly text: string; readonly trusted: boolean } | null> => {
  if (branch !== null && !plainBranch(branch)) return null
  const found = await dirsOf(cwd)
  if (found === null) return null
  const { gitDir, commonDir } = found
  // Taken before any file is read, so a write after this moment is always in a later tick than a trusted part's.
  const since = Date.now()
  const parts: (Part | null)[] = []
  let named = branch
  if (branch === null) {
    const head = await partOf(join(gitDir, 'HEAD'), true)
    if (head === null || head === ABSENT) return null
    parts.push(head)
    if (head.body.startsWith('ref:')) {
      named = /^ref: refs\/heads\/(\S+)\n?$/.exec(head.body)?.[1] ?? null
      if (named === null || !plainBranch(named)) return null
    }
  }
  if (named !== null) {
    const loose = await partOf(join(commonDir, 'refs', 'heads', named), true)
    // A symbolic branch's tip lives in the file it names, and that one in the next.
    if (loose?.body.startsWith('ref:')) return null
    parts.push(loose)
  }
  parts.push(...await Promise.all([
    partOf(join(commonDir, 'packed-refs'), false),
    partOf(join(commonDir, 'reftable', 'tables.list'), false),
    // A linked checkout's reftable keeps its own HEAD in a stack of its own.
    ...(gitDir !== commonDir ? [partOf(join(gitDir, 'reftable', 'tables.list'), false)] : []),
  ]))
  return markFrom(parts, since)
}

/**
 * The mark of what can change how two commits stand to each other without
 * either changing: a replacement or graft gives a commit other parents, and a
 * shallow boundary cuts history short. Replacement refs live loose under
 * `refs/replace/` — a folder whose times move as one is added, swapped or
 * removed — or packed, or in a reftable.
 */
const graphMarkOf = async (commonDir: string): Promise<{ readonly text: string; readonly trusted: boolean } | null> => {
  const since = Date.now()
  return markFrom(await Promise.all([
    partOf(join(commonDir, 'refs', 'replace'), false),
    partOf(join(commonDir, 'packed-refs'), false),
    partOf(join(commonDir, 'reftable', 'tables.list'), false),
    partOf(join(commonDir, 'info', 'grafts'), false),
    partOf(join(commonDir, 'shallow'), false),
  ]), since)
}

/** An answer from git, and whether it is one: a refusal for want of a ref or an ancestor is; a timeout is not. */
export interface Asked<T> { readonly answer: T; readonly definite: boolean }

/** Keeps `reading` under `key` until it settles without a definite answer, which is never kept. */
const share = <T>(map: Map<string, { readonly mark: string; readonly answer: Promise<T> }>, key: string, mark: string, reading: Promise<Asked<T>>): Promise<T> => {
  const entry = { mark, answer: reading.then((one) => one.answer) }
  keep(map, key, entry)
  const drop = (): void => { if (map.get(key) === entry) map.delete(key) }
  void reading.then((one) => { if (!one.definite) drop() }, drop)
  return entry.answer
}

const tips = new Map<string, { readonly mark: string; readonly answer: Promise<Sha | null> }>()

/**
 * Where a checkout's branch, or its HEAD, stands — `read`'s answer, shared
 * with every reader until a file the ref is kept in changes. `read` is asked
 * again whenever the mark has moved, and on every read while it is too recent
 * to vouch for itself.
 */
export const sharedTip = async (cwd: string, branch: string | null, read: () => Promise<Asked<Sha | null>>): Promise<Sha | null> => {
  const mark = await markOf(cwd, branch)
  if (mark === null) return (await read()).answer
  const key = JSON.stringify([cwd, branch])
  const known = tips.get(key)
  if (known && known.mark === mark.text) return known.answer
  if (!mark.trusted) {
    tips.delete(key)
    return (await read()).answer
  }
  return share(tips, key, mark.text, read())
}

const between = new Map<string, { readonly mark: string; readonly answer: Promise<unknown> }>()

/** A whole object name, SHA-1 or SHA-256: an abbreviation can come to name another commit as objects arrive. */
const WHOLE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * An answer about two commits of a checkout's repository — whether `tip`
 * descends from `at`, and by how many commits — which cannot change while
 * both name the commits they do and no replacement, graft or shallow boundary
 * has changed history between them: kept, once git has given it definitely,
 * until one of those does.
 */
export const keptBetween = async <T>(cwd: string, at: Sha, tip: Sha, read: () => Promise<Asked<T>>): Promise<T> => {
  const repository = WHOLE.test(at) && WHOLE.test(tip) ? (await dirsOf(cwd))?.commonDir : undefined
  const mark = repository === undefined ? null : await graphMarkOf(repository)
  if (mark === null) return (await read()).answer
  const key = JSON.stringify([repository, at, tip])
  const known = between.get(key)
  if (known && known.mark === mark.text) return known.answer as Promise<T>
  if (!mark.trusted) {
    between.delete(key)
    return (await read()).answer
  }
  return share(between as Map<string, { readonly mark: string; readonly answer: Promise<T> }>, key, mark.text, read())
}
