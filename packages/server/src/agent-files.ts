import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { digestOf, isSafePathSegment, MAX_BUNDLE_FILES } from '@harnessdesk/agent-inventory'
import type { CeilingLevel, FlowSeat } from '@harnessdesk/protocol'

import {
  AGENT_FILE_LIMIT,
  AGENT_TEMP_PREFIX,
  isAgentFolderName,
  NOTHING_HERE,
  PROJECT_AGENT_DIR,
  idsIn,
  readAtMost,
} from './agents.js'
import { seatSpec, seatWritesCompactly } from './flow.js'

/**
 * An Agent's folder, written: a new one, or a copy of one.
 *
 * Editing an Agent's content is editing its file in the desk's editor; these
 * are the writes that are not that. Two rules hold for all of them. Nothing
 * overwrites an Agent that is there — a folder that exists is a refusal,
 * never a merge. And nothing is written through a link out of a project: the
 * roster never reads through one, and a write through one would put a file
 * somewhere the person never chose.
 */

/** A folder name an Agent can have: what `uses:` and `seating.json` name it by. */
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/

/** The folder a name makes: lower case, words joined by hyphens, accents dropped; null when nothing is left. */
export const agentIdOf = (name: string): string | null => {
  const id = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return AGENT_ID.test(id) ? id : null
}

/** One line of text, as a double-quoted scalar the front matter can carry. */
const quoted = (text: string): string => JSON.stringify(text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim())

/**
 * A seat as front matter writes it: the spec, or the long form when writing
 * it compactly would not read back the same seat (`seatWritesCompactly`,
 * shared with `agent-seating-file.ts`'s `written()` so a model, runtime or
 * effort holding one of the compact grammar's own separators — `=`, `/`,
 * `+` — is never written where any file would misread it).
 */
const seatLines = (seat: FlowSeat): string[] =>
  seatWritesCompactly(seat)
    ? [`  - ${quoted(seatSpec(seat))}`]
    : [
        `  - runtime: ${quoted(seat.runtime)}`,
        ...(seat.model ? [`    model: ${quoted(seat.model)}`] : []),
        ...(seat.effort ? [`    effort: ${quoted(seat.effort)}`] : []),
        ...(seat.thinking ? ['    thinking: true'] : []),
      ]

/**
 * A new Agent's `AGENT.md`: its fields, and a brief with the parts every
 * shipped brief has, each holding one line for its author to replace. The
 * desk opens it in the editor the moment it is written.
 */
export const agentSource = (agent: {
  readonly name: string
  readonly description: string | null
  readonly ceiling: CeilingLevel
  readonly prefer: readonly FlowSeat[]
}): string =>
  [
    '---',
    `name: ${quoted(agent.name)}`,
    ...(agent.description ? [`description: ${quoted(agent.description)}`] : []),
    `ceiling: ${agent.ceiling}`,
    'prefer:',
    ...agent.prefer.flatMap(seatLines),
    '---',
    '',
    agent.description ?? 'What this Agent is for, in your words.',
    '',
    '## How to report',
    '',
    'What it reports when it is done, and the line it ends on.',
    '',
    '## What you never do',
    '',
    'What it must never do, whatever it is asked.',
    '',
  ].join('\n')

/**
 * A project's Agent directory, made where it is missing and refused where it
 * leads out: each step is looked at before it is made, and a link at either
 * step is refused whether it leads in or out, because telling the two apart
 * means following it.
 */
const projectAgentDirWalk = async (project: string, create: boolean): Promise<string> => {
  const within = await realpath(project)
  let at = within
  for (const step of PROJECT_AGENT_DIR.split('/')) {
    at = join(at, step)
    const info = await lstat(at).catch(() => null)
    if (info?.isSymbolicLink()) {
      throw new Error(`${at} is a link, so no Agent was written through it: a project's Agents are written only inside it.`)
    }
    if (info && !info.isDirectory()) throw new Error(`${at} is not a folder, so no Agent was written there.`)
    if (!info) {
      if (!create) throw new Error(`${at} is no longer the Agent folder this call wrote into.`)
      await mkdir(at)
    }
  }
  return at
}

export const projectAgentDir = (project: string): Promise<string> => projectAgentDirWalk(project, true)

interface Identity {
  readonly dev: number
  readonly ino: number
}

const identityOf = (info: Stats): Identity => ({ dev: info.dev, ino: info.ino })
const sameIdentity = (left: Identity, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
const errnoOf = (error: unknown): string => String((error as { code?: unknown } | null)?.code ?? '')
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * macOS's own `O_NOFOLLOW_ANY` — `0x20000000`, no named export in Node,
 * passed through unchanged because libuv's `open()` forwards whatever
 * numeric flags it is given. Plain `O_NOFOLLOW` refuses a link only at a
 * path's *last* component; an ancestor swapped for one after a directory it
 * contains was classified — round 2's own finding — is followed like any
 * other lookup, the same as `readdir` follows one. `O_NOFOLLOW_ANY` refuses a
 * link at *any* component instead, last one included — measured directly:
 * it alone refuses both a same-name last-component link and an ancestor
 * swapped for one, and opens a real file on a canonical path clean. Measured
 * the other way too: OR'd together with `O_NOFOLLOW`, the two refuse every
 * open with `EINVAL` rather than adding up, which is why `openNoFollow`
 * below chooses one or the other, never both. Given that, every path this is
 * used on must already be free of a *legitimate* link to begin with: the
 * walk's own canonical root (`realpath`'d once, per `copyAgentFolder` and
 * `exportAgentFolders`) plus plain joins from there, never a second
 * `realpath` this close to the open — measured on this Mac to happily follow
 * `/var` itself (a link to `/private/var`), which would refuse a perfectly
 * real file the same way a genuine swap should be refused. Elsewhere than
 * macOS this is `0`: the last-step `O_NOFOLLOW` plus the
 * `fstat`-against-classification identity check below still hold there, and
 * the desk ships and runs its CI on macOS only.
 */
const NOFOLLOW_ANY = process.platform === 'darwin' ? 0x20000000 : 0

/**
 * Every content open in this file goes through here: `NOFOLLOW_ANY` where it
 * exists, since it already refuses the last component too; plain `O_NOFOLLOW`
 * where it does not (`NOFOLLOW_ANY` reads `0` there, so `||` falls through).
 * `ELOOP` is what a live link answers with; each caller maps it to the same
 * "was replaced … nothing was used" wording its own `fstat`-identity
 * mismatch already gives, since both mean the same thing found at a
 * different moment — one while a link was still there to refuse, the other
 * once it was gone again.
 */
const openNoFollow = (path: string, flags: number, mode?: number) =>
  open(path, flags | (NOFOLLOW_ANY || constants.O_NOFOLLOW), mode)

/**
 * Creates text under `writeAgentFolder`'s canonical temporary path, with
 * plain joins only. Keep open's default 0666 filtered by the process umask,
 * matching writeFile's mode; write through the descriptor so a later path
 * replacement cannot redirect the bytes.
 */
const writeNewFile = async (path: string, text: string): Promise<void> => {
  let handle
  try {
    handle = await openNoFollow(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
  } catch (error) {
    throw errnoOf(error) === 'ELOOP'
      ? new Error(`${path} could not be made there — its folder was replaced, so nothing was written.`)
      : error
  }
  try {
    await handle.writeFile(text, { encoding: 'utf8' })
  } finally {
    await handle.close()
  }
}

type CheckedStat = { readonly at: 'found'; readonly info: Stats } | { readonly at: 'missing' } | { readonly at: 'error'; readonly reason: string }

const checkedStat = async (path: string): Promise<CheckedStat> => {
  try {
    return { at: 'found', info: await lstat(path) }
  } catch (error) {
    return errnoOf(error) === 'ENOENT' ? { at: 'missing' } : { at: 'error', reason: messageOf(error) }
  }
}

export interface CreatedAgentFolder {
  readonly path: string
  readonly root: string
  readonly rootIdentity: Identity
  readonly folderIdentity: Identity
  readonly fileIdentity: Identity
}

/** Marks `alreadyThere`'s own refusal so a caller can tell it apart from any other failure `writeAgentFolder` raises, without matching its words. */
const AGENT_EXISTS = 'HD_AGENT_EXISTS'

const alreadyThere = (root: string, id: string): Error =>
  Object.assign(new Error(`There is already an Agent called “${id}” in ${root}.`), { code: AGENT_EXISTS })

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return false
    throw error
  }
}

/** Removes only the unpredictable temporary tree this call made, and only while its parent and identity are unchanged. */
const removeTemporary = async (root: string, rootIdentity: Identity, temporary: string, temporaryIdentity: Identity): Promise<string | null> => {
  const currentRoot = await lstat(root).catch(() => null)
  if (!currentRoot || !sameIdentity(rootIdentity, currentRoot)) return 'its temporary parent changed before cleanup'
  const currentTemporary = await lstat(temporary).catch(() => null)
  if (!currentTemporary) return null
  if (!sameIdentity(temporaryIdentity, currentTemporary)) return 'its temporary folder was replaced before cleanup'
  // This is the only recursive removal in this module: the random folder and every child were made by this call.
  await rm(temporary, { recursive: true, force: true })
  return null
}

/**
 * Builds a folder out of sight, then gives it its final name in one move.
 *
 * `root` is `realpath`'d exactly once, here, before anything is made under
 * it, into `canonicalRoot` — mirroring the read side's own invariant, no
 * byte this call (or the `write` it runs) puts anywhere is ever written
 * outside this one canonical path: `canonicalFolder` and `temporary` are
 * both built from it with a plain `join`, never a second `realpath` this
 * close to the write, which a swap landing after this one could just as
 * easily follow as the first. A swap of `root` itself, or of anything under
 * it, landing *after* this point is then a write through a path this call
 * no longer names — `temporary` is handed to `write` as this same canonical
 * path, so a caller building its own destinations under it (`copyTree`'s
 * `copyRegularFile`, most of all) inherits the guarantee for free.
 *
 * The folder this call finally reports, though, is spelled from the
 * *caller's own* `root` — never `canonicalRoot` — because the roster reads
 * an Agent back by that same caller's spelling, not by whatever a legitimate
 * top-level link (a linked-in personal Agents folder, most of all) resolves
 * to: a write reported back under a path that only differs from what the
 * roster would read by having resolved a link the roster does not resolve
 * looks, to a caller comparing the two strings, like the write landed
 * somewhere else entirely. The two identity checks below already catch a
 * swap of `root` or `temporary` themselves before this call ever renames
 * anything into place; they are unchanged by canonicalizing `root` for the
 * writes themselves, since a swap that already happened before this call
 * started is exactly what capturing `rootIdentity` from the canonical path,
 * once, is for.
 */
export const writeAgentFolder = async (
  root: string,
  id: string,
  write: (temporary: string) => Promise<void>,
): Promise<CreatedAgentFolder> => {
  await mkdir(root, { recursive: true })
  const canonicalRoot = await realpath(root)
  const canonicalFolder = join(canonicalRoot, id)
  if (await exists(canonicalFolder)) throw alreadyThere(root, id)
  const rootIdentity = identityOf(await lstat(canonicalRoot))
  // The component has a fixed, short bound independent of `id`, so a legal
  // long Agent name never makes the transaction name exceed NAME_MAX.
  const temporary = await mkdtemp(join(canonicalRoot, AGENT_TEMP_PREFIX))
  const temporaryIdentity = identityOf(await lstat(temporary))
  let moved = false
  try {
    // `mkdtemp` deliberately starts at 0700. The final Agent is an ordinary
    // directory, so give it the mode `mkdir` would have under this process's umask.
    await chmod(temporary, 0o777 & ~process.umask())
    await write(temporary)
    const currentRoot = await lstat(canonicalRoot)
    if (!sameIdentity(rootIdentity, currentRoot)) {
      throw new Error(`${canonicalRoot} changed before the Agent could be put in place.`)
    }
    const currentTemporary = await lstat(temporary)
    if (!sameIdentity(temporaryIdentity, currentTemporary)) {
      throw new Error(`${temporary} was replaced before the Agent could be put in place.`)
    }
    if (await exists(canonicalFolder)) throw alreadyThere(root, id)
    try {
      await rename(temporary, canonicalFolder)
    } catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes(errnoOf(error))) throw alreadyThere(root, id)
      throw error
    }
    moved = true
  } catch (error) {
    if (!moved) {
      const left = await removeTemporary(canonicalRoot, rootIdentity, temporary, temporaryIdentity)
      if (left) throw new Error(`${messageOf(error)} The temporary Agent folder was left in place because ${left}.`)
    }
    throw error
  }
  const folder = join(root, id)
  const path = join(folder, 'AGENT.md')
  const folderInfo = await lstat(folder)
  const fileInfo = await lstat(path)
  return {
    path,
    root,
    rootIdentity,
    folderIdentity: identityOf(folderInfo),
    fileIdentity: identityOf(fileInfo),
  }
}

/** Writes a new Agent's folder and file, or refuses if an Agent by that name is there. */
export const createAgentFolder = (root: string, id: string, source: string): Promise<CreatedAgentFolder> =>
  writeAgentFolder(root, id, async (temporary) => {
    await writeNewFile(join(temporary, 'AGENT.md'), source)
  })

/** A regular file or folder found directly inside a directory — a link, of any kind, to anything, is not one. */
interface RegularEntry {
  readonly name: string
  readonly source: string
  readonly kind: 'file' | 'dir'
  /** This entry's own identity at the moment it was classified — what a later use is checked against before it is trusted. */
  readonly identity: Identity
}

/**
 * Every regular file and folder directly inside `dir`, classified by
 * `lstat`. The invariant that actually keeps a link's target out of a copy or
 * a backup is not made here: it is made where a classified entry is finally
 * opened (`copyRegularFile`, `take`) — every byte read comes from a
 * descriptor `openNoFollow`'d on a canonical-root-plus-plain-joins path and
 * `fstat`-checked against what this function classified, so a swap landing
 * *after* this call returns (mid-loop below, between the loop's own
 * `readdir` and the recursive call this makes for a nested directory, or
 * anywhere later) is still refused at the one place that matters: a link
 * still there answers `ELOOP`, one already put back answers a mismatched
 * `fstat`. What this function's own before/after checks add is catching a
 * swap of `dir` *itself* early, before wasting a walk on what a live link
 * would otherwise make look like a real subtree — not the last word on
 * safety, a cheaper first one.
 *
 * `expected` is `dir`'s own identity, as classified one level up — absent
 * for a walk's own top folder, which no parent's `regularEntries` ever
 * classified as anything, so a link, a missing target, or a file there is
 * `readdir`'s own natural refusal to make, exactly as it always was: `idsIn`
 * and this file's own callers already decide what a dangling or non-folder
 * top entry means, and this never turns that into the same "replaced" error
 * a swap gets. `copyAgentFolder` and `exportAgentFolders` now give the top
 * folder its own identity too, from a fresh `lstat` right after their own
 * one-time `realpath`, so it gets this same early check. Given `expected`,
 * `dir` *was* classified as a directory a moment ago, and is checked without
 * following, once right before `readdir` and once right after: catching a
 * swap made any time up to there, and one made during `readdir` itself,
 * which two syscalls a path apart can never rule out on their own. A
 * mismatch throws rather than returning fewer entries, so a caller that
 * would otherwise trust an empty or partial listing refuses or leaves the
 * whole folder out instead (`copyTree`'s and `exportAgentFolders`'s own
 * catches already do that with whatever this throws).
 */
const regularEntries = async (dir: string, expected?: Identity): Promise<RegularEntry[]> => {
  if (expected) {
    const before = await lstat(dir)
    if (!before.isDirectory() || !sameIdentity(expected, before)) {
      throw new Error(`${dir} was replaced before its contents could be read, so nothing under it was used.`)
    }
  }
  const entries = await readdir(dir, { withFileTypes: true })
  if (expected) {
    const after = await lstat(dir)
    if (!after.isDirectory() || !sameIdentity(expected, after)) {
      throw new Error(`${dir} was replaced while its contents were being read, so nothing under it was used.`)
    }
  }
  const found: RegularEntry[] = []
  for (const entry of entries) {
    const source = join(dir, entry.name)
    const info = await lstat(source)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) found.push({ name: entry.name, source, kind: 'dir', identity: identityOf(info) })
    else if (info.isFile()) found.push({ name: entry.name, source, kind: 'file', identity: identityOf(info) })
  }
  return found
}

/**
 * Copies one classified file by its own descriptor, never by reopening its
 * path. The read side's invariant: every byte copied is read from a
 * descriptor opened with `openNoFollow` on a path built from the walk's
 * canonical root plus plain joins, and `fstat`-checked against
 * `regularEntries`' own classification. `NOFOLLOW_ANY` refuses a link at any
 * component the path still has at the moment of this open — an ancestor
 * swapped for one since classification included — so whatever a `readdir` or
 * an `lstat` upstream saw through such a swap, nothing outside is read here:
 * a link still in place answers `ELOOP`; one already put back answers a
 * `fstat` that does not match what was classified, since that identity was
 * only ever the outside one the swap exposed. Read from the descriptor this
 * already opened rather than a fresh look at the path, which a second swap
 * after this check could otherwise still redirect.
 *
 * The write side's own matching invariant: `destination` is itself built
 * from `writeAgentFolder`'s own canonical `temporary`, and created the same
 * `openNoFollow`'d way — exclusively, like `copyFile`'s own `COPYFILE_EXCL`
 * before it, so nothing this call writes ever lands outside that canonical
 * destination either. An ancestor of `destination` swapped for a link after
 * `writeAgentFolder` captured it (a project's own folder, mid-copy, most of
 * all) answers this open with the same `ELOOP` the source side already
 * refuses. `mkdir`, used elsewhere for a nested destination directory, has
 * no such flag to give it — the one thing a live swap can still make land
 * outside is an empty directory a `mkdir` created through it before this
 * open ever ran, never a byte of file content, since every content write
 * uses `openNoFollow`.
 */
const copyRegularFile = async (entry: RegularEntry, destination: string): Promise<void> => {
  const replaced = `${entry.source} was replaced after it was found there, so nothing was copied from it.`
  let source
  try {
    source = await openNoFollow(entry.source, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (error) {
    throw errnoOf(error) === 'ELOOP' ? new Error(replaced) : error
  }
  try {
    const info = await source.stat()
    if (!info.isFile() || !sameIdentity(entry.identity, info)) {
      throw new Error(replaced)
    }
    let out
    try {
      out = await openNoFollow(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    } catch (error) {
      throw errnoOf(error) === 'ELOOP'
        ? new Error(`${destination} could not be made there — its folder was replaced, so nothing was copied.`)
        : error
    }
    try {
      // Permissions set before the streaming, not after: a write stream
      // auto-closes its `FileHandle` the moment the pipeline ends, and a
      // `chmod` after that would find the descriptor already gone. The later
      // `close()` below is then a harmless no-op on what the stream already closed.
      await out.chmod(info.mode & 0o777)
      await pipeline(source.createReadStream(), out.createWriteStream())
    } finally {
      await out.close()
    }
  } finally {
    await source.close()
  }
}

/** Copies regular files and folders, one by one; links and special files stay behind. */
const copyTree = async (from: string, to: string, expected?: Identity): Promise<void> => {
  for (const entry of await regularEntries(from, expected)) {
    const destination = join(to, entry.name)
    if (entry.kind === 'dir') {
      await mkdir(destination)
      await copyTree(entry.source, destination, entry.identity)
    } else {
      await copyRegularFile(entry, destination)
    }
  }
}

/**
 * Copies an Agent's folder whole — its `AGENT.md`, and its `skills/` and
 * notes where it has them — leaving every link inside it behind rather than
 * following it, and refusing if an Agent by that name is already at the
 * destination.
 *
 * `from` is followed once, at the top, with `realpath` before anything is
 * read from it: the roster reads this machine's own folders straight through
 * a link at their top — a dotfiles checkout linked into place — so `from`
 * itself may be exactly such a link, and `cp`'s own filter (below) would
 * otherwise drop it whole, copying nothing. Every link *inside* the tree is
 * still left behind, because only the one step the roster itself already
 * took is repeated here. `real` is also `lstat`'d once, right after, so its
 * own identity can be given to `regularEntries` as `topIdentity` below —
 * every path this walk ever opens is built from `real` plus plain joins from
 * there, never a second `realpath`, which a swap made after this one could
 * just as easily follow as the first. And a copy that followed nothing but
 * links copied nothing worth having, so if no `AGENT.md` arrived, what was
 * made is removed and the copy is refused — never left as an Agent with no
 * brief, and never left to fail later in a stranger's sentence than this one.
 */
export const copyAgentFolder = async (from: string, to: string): Promise<void> => {
  const id = basename(to)
  const real = await realpath(from)
  const topIdentity = identityOf(await lstat(real))
  await writeAgentFolder(dirname(to), id, async (temporary) => {
    await copyTree(real, temporary, topIdentity)
    const hasBrief = await lstat(join(temporary, 'AGENT.md')).then(
      (info) => info.isFile(),
      () => false,
    )
    if (!hasBrief) {
      throw new Error(`${from} has no AGENT.md to copy — nothing but links, which are left behind rather than followed.`)
    }
  })
}

/** What a backup carries of one Agent: its folder's regular text files. */
export interface AgentFolderCopy {
  readonly id: string
  readonly files: readonly { readonly path: string; readonly text: string }[]
}

/** The most one Agent folder contributes to a backup, across all of its files. */
const BACKUP_FOLDER_LIMIT = 1024 * 1024
// `ignoreBOM: true` keeps the decoder from doing what its name suggests it
// would refuse to do: strip a leading byte-order mark. Without it, a file
// that starts with one does not come back byte for byte.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** A linked git checkout's own metadata — never carried, at any depth: its `config` can hold a remote's token. */
const GIT_DIR = '.git'

/**
 * A path segment, folded so a case or Unicode alias of one already taken —
 * or of `.git` itself, on a case-insensitive volume the default on macOS —
 * reads as the same segment.
 */
const foldedSegment = (segment: string): string => segment.normalize('NFC').toLowerCase()

/** Whether a segment is a git checkout's own metadata folder, however its case was spelled. */
const isGitDir = (name: string): boolean => foldedSegment(name) === GIT_DIR

/** A plain, total order no locale can read differently on a different machine. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Every Agent folder in this machine's roster, with links inside each folder
 * left behind (`regularEntries`, the rule `copyAgentFolder`'s own duplicate
 * copies by) and a linked git checkout's `.git` left out at every depth.
 *
 * One bad Agent, or one bad file or subfolder inside an otherwise-good one,
 * never costs the rest of the export. `idsIn` already decides what is an
 * Agent at all — a dangling link or a link to a file is not one, and is left
 * out without a word, the same as the roster itself reads it, so each id's
 * own top folder is `realpath`'d and `lstat`'d before anything under it is
 * walked: `realpath`'s and that `lstat`'s own failures are what decide
 * "nothing here" (`NOTHING_HERE` reads their codes exactly as it always read
 * `readdir`'s), and only past them is there a real, canonical top folder to
 * give `regularEntries` an identity for, the same early check a nested
 * directory already gets. Anything else that could not be read — a
 * permission this account does not have, most likely — leaves just that
 * Agent, or just that file or subfolder, out, with `log` told why.
 *
 * `AGENT.md` is read first, always, so nothing else in the folder can fill
 * the budget before it gets a turn; everything after it follows in code-unit
 * order, the same order a backup taken on a different machine would read it
 * in.
 */
export const exportAgentFolders = async (
  root: string,
  log?: (message: string, details?: unknown) => void,
): Promise<AgentFolderCopy[]> => {
  const copies: AgentFolderCopy[] = []
  for (const id of await idsIn(root)) {
    const files: { path: string; text: string }[] = []
    let total = 0
    // Every file entry looked at, accepted or not — the walk's own cap on
    // itself, so a run of rejected files (too large, not UTF-8, over an
    // already-spent budget) costs no more opens than an equally long run of
    // accepted ones would. `files.length` alone let a flood of rejects walk
    // on forever, never tripping `MAX_BUNDLE_FILES` because none of them ever
    // counted.
    let examined = 0
    // Set the moment one file is turned away for not fitting what is left of
    // the folder's own budget: every file after it is skipped without being
    // opened, because the order files are found in is not sorted by size — a
    // smaller one after it might technically still fit, but finding out costs
    // an open per try, which an Agent folder with a spent budget and many
    // files left to look at must never pay for each one.
    let budgetSpent = false
    // Why AGENT.md itself, specifically, never made it into `files` — set at
    // whichever point decides that, so the one warning below can carry a
    // cause instead of just a name.
    let briefProblem: string | null = null

    const take = async (entry: RegularEntry, path: string): Promise<void> => {
      const reason = 'it was replaced after it was found there'
      let handle
      try {
        // `O_NONBLOCK`, like the roster's own read of an `AGENT.md`
        // (`agents.ts`'s `READ`): `regularEntries` already checked this path
        // a moment ago and found a regular file, and opening plainly trusts
        // that check to still be true. Opened non-blocking, a file swapped
        // for a pipe with nothing writing to it in that gap is read as empty
        // rather than left to hang the export — and everyone behind it in
        // the same libuv threadpool with it. `openNoFollow`, not a plain
        // `O_NOFOLLOW`, for the link: an ancestor swapped for one after a
        // directory containing this file was classified is followed by a
        // plain open exactly as `readdir` follows it — `NOFOLLOW_ANY`
        // refuses a link at any component the path still has, not only the
        // last one, which is the gap round 2 found here.
        handle = await openNoFollow(entry.source, constants.O_RDONLY | constants.O_NONBLOCK)
      } catch (error) {
        if (errnoOf(error) === 'ELOOP') {
          log?.('a file or folder was left out of an Agent backup', { id, path, error: reason })
          if (path === 'AGENT.md') briefProblem = reason
          return
        }
        log?.('a file or folder was left out of an Agent backup', { id, path, error: messageOf(error) })
        if (path === 'AGENT.md') briefProblem = `it could not be opened — ${messageOf(error)}`
        return
      }
      try {
        // A live link is `openNoFollow`'s to refuse; this is the other half —
        // a *different regular file* swapped into the same gap, nothing to
        // refuse to follow there — checked against the very identity
        // `regularEntries` classified, never a fresh `lstat` of the path,
        // which a second swap after that check could still redirect just as
        // easily as the first did.
        const info = await handle.stat()
        if (!info.isFile() || !sameIdentity(entry.identity, info)) {
          log?.('a file or folder was left out of an Agent backup', { id, path, error: reason })
          if (path === 'AGENT.md') briefProblem = reason
          return
        }
        const bytes = await readAtMost(handle, AGENT_FILE_LIMIT)
        if (bytes === null) {
          // Too large: quiet for any other file, exactly as it was before
          // this file was ever looked at — but AGENT.md's own absence still
          // needs a reason, since nothing else will explain it.
          if (path === 'AGENT.md') briefProblem = `it is larger than ${AGENT_FILE_LIMIT / 1024} KiB`
          return
        }
        if (total + bytes.length > BACKUP_FOLDER_LIMIT) {
          budgetSpent = true
          if (path === 'AGENT.md') briefProblem = 'the folder budget was already spent'
          return
        }
        let text: string
        try {
          text = utf8.decode(bytes)
        } catch {
          if (path === 'AGENT.md') briefProblem = 'it is not valid UTF-8'
          return // not UTF-8: quiet, the same as an oversized file
        }
        total += bytes.length
        files.push({ path, text })
      } catch (error) {
        log?.('a file or folder was left out of an Agent backup', { id, path, error: messageOf(error) })
        if (path === 'AGENT.md') briefProblem = `it could not be read — ${messageOf(error)}`
      } finally {
        await handle.close()
      }
    }

    const walk = async (dir: string, prefix: string, expected?: Identity): Promise<void> => {
      let entries: RegularEntry[]
      try {
        entries = await regularEntries(dir, expected)
      } catch (error) {
        // At the Agent's own top folder, the caller decides quiet-or-warned:
        // `idsIn` already kept this id only because something is there, so
        // ENOENT/ENOTDIR here means a link that leads nowhere or to a file —
        // not an Agent, the same as the roster reads it — and anything else
        // is a real folder this account could not open.
        if (prefix === '') throw error
        log?.('a file or folder was left out of an Agent backup', { id, path: prefix, error: messageOf(error) })
        return
      }
      if (prefix === '' && !entries.some((entry) => entry.name === 'AGENT.md')) {
        // Nothing named AGENT.md survived `regularEntries`' regular-files-only
        // rule: either there is truly nothing there, or something is but it
        // is a link or a folder — never followed or read either way, so the
        // reason is read straight off `lstat` rather than guessed at.
        const raw = await lstat(join(dir, 'AGENT.md')).catch(() => null)
        briefProblem = raw
          ? raw.isSymbolicLink()
            ? 'AGENT.md is a link, and a link is never carried'
            : 'AGENT.md is not a regular file'
          : 'there is no AGENT.md here'
        // Nothing under this folder will ever be carried without an
        // AGENT.md at its top — decided once, here, rather than after
        // walking however much is underneath it looking for one that is
        // never coming (a linked git checkout's own history, most of all).
        return
      }
      const usable = entries.filter((entry) => !isGitDir(entry.name))
      const ordered =
        prefix === ''
          ? [
              ...usable.filter((entry) => entry.name === 'AGENT.md'),
              ...usable.filter((entry) => entry.name !== 'AGENT.md').sort((a, b) => byCodeUnit(a.name, b.name)),
            ]
          : [...usable].sort((a, b) => byCodeUnit(a.name, b.name))
      for (const entry of ordered) {
        if (examined >= MAX_BUNDLE_FILES || budgetSpent) return
        const path = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.kind === 'dir') await walk(entry.source, path, entry.identity)
        else {
          examined += 1
          await take(entry, path)
        }
      }
    }

    try {
      // `idsIn` keeps a dangling or a to-a-file top link (`isDirectory() ||
      // isSymbolicLink()`, its own rule) without following either — so
      // deciding "nothing here" is still `realpath`'s and this `lstat`'s own
      // natural refusal, in their own codes, exactly as `readdir`'s used to
      // be: caught below, `NOTHING_HERE` reads it the same as ever, quietly.
      // Only past this point is there a real, present, canonical top folder
      // to give `walk` an identity for at all.
      const canonicalTop = await realpath(join(root, id))
      const topInfo = await lstat(canonicalTop)
      if (!topInfo.isDirectory()) throw Object.assign(new Error(`${canonicalTop} is not a folder.`), { code: 'ENOTDIR' })
      await walk(canonicalTop, '', identityOf(topInfo))
    } catch (error) {
      if (!NOTHING_HERE.has(errnoOf(error))) {
        log?.('a file or folder was left out of an Agent backup', { id, error: messageOf(error) })
      }
      continue
    }

    if (!files.some((one) => one.path === 'AGENT.md')) {
      log?.('an Agent was left out of the backup', { id, error: briefProblem ?? 'its AGENT.md could not be carried' })
      continue
    }
    copies.push({ id, files })
  }
  return copies
}

/**
 * One relative backup path segment: never a climb, a separator, a string
 * the filesystem cannot accept, or a linked checkout's own metadata —
 * `isSafePathSegment` is the one rule every one of those is built from, so
 * this and a skill bundle's own name check cannot quietly drift apart at an
 * edge (a backslash, a `.`, a NUL) the way they once had. A path segment
 * this long already fails on most filesystems (`ENAMETOOLONG`) — dropped
 * here, before the write, one long name no longer costs the whole folder.
 */
const isSegment = (name: string): boolean => isSafePathSegment(name) && !isGitDir(name) && Buffer.byteLength(name, 'utf8') <= 255

/**
 * Whether a whole relative path is safe to write under a temporary Agent
 * folder. `isAbsolute` is not asked here: an absolute path's leading `/`
 * makes an empty first segment, which `isSegment` already refuses — asking
 * again would be a second rule that could one day disagree with the first,
 * not a second guard.
 */
const isBackupPath = (path: string): boolean => !/^[A-Za-z]:\//.test(path) && path.split('/').every(isSegment)

/** A whole relative path, folded segment by segment — the separator itself never changes case or normal form. */
const foldedPath = (path: string): string => path.split('/').map(foldedSegment).join('/')

/** What became of one Agent folder from a backup: restored, or refused and — a bare collision aside — why. */
export type AgentFolderRestoreOutcome = { readonly restored: true } | { readonly restored: false; readonly reason: string | null }

const REFUSED_INVALID_ID = 'its id is not a valid Agent id'
const REFUSED_NOT_A_FILE_LIST = 'it names no files'
const REFUSED_NO_BRIEF = 'it has no AGENT.md once its files were checked'

/**
 * Restores one missing Agent folder transactionally and says what happened:
 * restored, or refused and why — except a plain collision with an Agent
 * already here, which is this machine's own and never a stranger's to be
 * told about, so it is refused quietly (`reason: null`). Detected from
 * `writeAgentFolder`'s own refusal (tagged `AGENT_EXISTS`) rather than a
 * separate `exists()` first: a second check is a second place for the
 * answer to be stale by the time the first one writes.
 *
 * The id is checked against `isAgentFolderName` — the roster and export's own
 * rule, not `agentIdOf`, which slugs a typed *name* into a brand new folder
 * and was never a reader's rule for a folder already there. A reserved name
 * (`constructor`, `__proto__`) is deliberately not refused here either: the
 * roster keys every Agent in a `Map`, where neither is special, so it already
 * seats a folder by either name without complaint, and refusing to restore
 * one would only make backup stricter than the roster it restores into —
 * dropping a real Agent instead of merely declining to write JSON's own
 * `__proto__` key, which is `agent-seating-file.ts`'s own, different concern.
 */
export const importAgentFolder = async (root: string, copy: unknown): Promise<AgentFolderRestoreOutcome> => {
  const record = (copy ?? {}) as { id?: unknown; files?: unknown }
  const id = typeof record.id === 'string' ? record.id : ''
  if (!isAgentFolderName(id)) return { restored: false, reason: REFUSED_INVALID_ID }
  if (!Array.isArray(record.files)) return { restored: false, reason: REFUSED_NOT_A_FILE_LIST }

  const files: { path: string; text: string }[] = []
  const filePaths = new Set<string>()
  const folderPaths = new Set<string>()
  let total = 0
  // Sliced before anything about an entry is even looked at: the cap bounds
  // what is *examined*, not what is *accepted* — a backup naming thousands
  // of entries that fail validation must cost no more than this one slice,
  // not an unbounded walk that only gives up once 200 have been accepted.
  for (const one of record.files.slice(0, MAX_BUNDLE_FILES)) {
    const file = (one ?? {}) as { path?: unknown; text?: unknown }
    if (typeof file.path !== 'string' || typeof file.text !== 'string' || !isBackupPath(file.path)) continue
    const bytes = Buffer.byteLength(file.text, 'utf8')
    if (bytes > AGENT_FILE_LIMIT || total + bytes > BACKUP_FOLDER_LIMIT) continue
    const segments = file.path.split('/')
    const key = foldedPath(file.path)
    const parents = segments.slice(0, -1).map((_, index) => foldedPath(segments.slice(0, index + 1).join('/')))
    // First wins: an exact duplicate, a case or Unicode alias of a path
    // already taken, a descendant of a file, or a file where an earlier
    // descendant already made a folder is left out before any write — every
    // one of those would otherwise reach `writeNewFile`'s exclusive open as an
    // `EEXIST`, which costs the whole folder, not just the one file.
    if (filePaths.has(key) || folderPaths.has(key) || parents.some((path) => filePaths.has(path))) continue
    files.push({ path: file.path, text: file.text })
    filePaths.add(key)
    for (const path of parents) folderPaths.add(path)
    total += bytes
  }
  if (!files.some((one) => one.path === 'AGENT.md')) return { restored: false, reason: REFUSED_NO_BRIEF }

  try {
    await writeAgentFolder(root, id, async (temporary) => {
      for (const file of files) {
        const target = join(temporary, file.path)
        // Like copyTree's mkdir, a swapped ancestor can leave an empty
        // directory outside; writeNewFile refuses the link before any file
        // content follows it.
        await mkdir(dirname(target), { recursive: true })
        await writeNewFile(target, file.text)
      }
    })
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === AGENT_EXISTS) return { restored: false, reason: null }
    throw error
  }
  return { restored: true }
}

/**
 * Reads the source Customize is about to copy, without exceeding the
 * roster's limit and without following a link anywhere in the path — a
 * project's own Agent is exactly the case `copyAgentFolder` itself refuses to
 * read through one for, and `path` here is read *before* that call, to
 * validate what it is about to copy. `dirname(path)` is `realpath`'d once,
 * the same single top-level follow `copyAgentFolder` gives a linked-in
 * built-in or personal Agent, and every path after that is `openNoFollow`'d:
 * a project that swaps its own Agent folder for a link out of it, in the gap
 * between the roster finding this path and this call opening it, is refused
 * the same way a copy or an export would refuse it.
 */
export const readAgentSource = async (path: string): Promise<string> => {
  const canonical = join(await realpath(dirname(path)), basename(path))
  let handle
  try {
    handle = await openNoFollow(canonical, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (error) {
    if (errnoOf(error) === 'ELOOP') {
      throw new Error(`${path} was replaced before it could be read, so nothing was copied.`)
    }
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`${path} is not a regular Agent file.`)
    const bytes = Buffer.allocUnsafe(AGENT_FILE_LIMIT + 1)
    let filled = 0
    while (filled < bytes.length) {
      const read = await handle.read(bytes, filled, bytes.length - filled, filled)
      if (read.bytesRead === 0) return bytes.subarray(0, filled).toString('utf8')
      filled += read.bytesRead
    }
    throw new Error(`${path} is too large to copy: an Agent file is read whole or not at all.`)
  } finally {
    await handle.close()
  }
}

/**
 * Undoes a project Save after its seating write failed. Every pathname and inode is checked again first; the one
 * `AGENT.md` this call wrote is unlinked, and its folder is removed only if nothing else has appeared in it.
 */
export const rollbackCreatedAgent = async (created: CreatedAgentFolder, project: string): Promise<string | null> => {
  let root: string
  try {
    root = await projectAgentDirWalk(project, false)
  } catch (error) {
    return messageOf(error)
  }
  if (root !== created.root) return 'the project now reaches a different Agent folder'
  const rootRead = await checkedStat(root)
  if (rootRead.at === 'error') return `the project Agent folder could not be checked: ${rootRead.reason}`
  if (rootRead.at === 'missing' || !sameIdentity(created.rootIdentity, rootRead.info)) return 'the project Agent folder was replaced'
  const folder = dirname(created.path)
  const folderRead = await checkedStat(folder)
  if (folderRead.at === 'error') return `the Agent folder could not be checked: ${folderRead.reason}`
  if (folderRead.at === 'missing') return null
  if (!sameIdentity(created.folderIdentity, folderRead.info)) return 'the Agent folder was replaced'
  const fileRead = await checkedStat(created.path)
  if (fileRead.at === 'error') return `the Agent file could not be checked: ${fileRead.reason}`
  if (fileRead.at === 'found' && !sameIdentity(created.fileIdentity, fileRead.info)) return 'the Agent file was replaced'
  if (fileRead.at === 'found') {
    try {
      await unlink(created.path)
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') return `the Agent file could not be removed: ${messageOf(error)}`
    }
  }
  try {
    await rmdir(folder)
    return null
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOENT') return null
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return 'the Agent folder changed after it was written'
    if (code === 'ENOTDIR') return 'the Agent folder was replaced before cleanup'
    return `the Agent folder could not be removed: ${messageOf(error)}`
  }
}

/** Reach an existing Agent folder one real directory at a time, never through a link. */
const agentFolderAt = async (within: string, steps: readonly string[]): Promise<string> => {
  let at = within
  for (const step of steps) {
    at = join(at, step)
    const info = await lstat(at).catch(() => null)
    if (!info) throw new Error(`${at} is not there, so nothing was written.`)
    if (info.isSymbolicLink()) {
      throw new Error(`${at} is a link, so nothing was written through it: an Agent is only ever written inside its own folder.`)
    }
    if (!info.isDirectory()) throw new Error(`${at} is not a folder, so nothing was written there.`)
  }
  return at
}

export const projectAgentFolder = async (project: string, id: string): Promise<string> =>
  agentFolderAt(await realpath(project), [...PROJECT_AGENT_DIR.split('/'), id])

export const userAgentFolder = async (root: string, id: string): Promise<string> =>
  agentFolderAt(await realpath(root), [id])

/** Read an update target directly, with no top-level link following. */
const rewriteSource = async (path: string): Promise<string> => {
  let handle
  try {
    handle = await openNoFollow(path, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (error) {
    if (errnoOf(error) === 'ELOOP') throw new Error(`${path} was replaced before it could be read, so nothing was written.`)
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`${path} is not a regular Agent file.`)
    const bytes = await readAtMost(handle, AGENT_FILE_LIMIT)
    if (bytes === null) throw new Error(`${path} is too large to update: an Agent file is read whole or not at all.`)
    return bytes.toString('utf8')
  } finally {
    await handle.close()
  }
}

/** Atomically rewrite one digest-bound Agent file without following a link. */
export const rewriteAgentFile = async (
  folder: string,
  digest: string,
  change: (source: string) => string,
): Promise<void> => {
  const path = join(folder, 'AGENT.md')
  const folderBefore = await lstat(folder)
  const source = await rewriteSource(path)
  if (digestOf(source) !== digest) {
    throw new Error(`${path} has changed since the update was shown to you. Open Update… again to see what it would change now.`)
  }
  const next = change(source)
  const fileBefore = await lstat(path)
  const temporary = join(folder, `.AGENT.md.${randomUUID().slice(0, 8)}.tmp`)
  let temporaryHandle
  try {
    temporaryHandle = await openNoFollow(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      fileBefore.mode & 0o777,
    )
    await temporaryHandle.writeFile(next, 'utf8')
  } finally {
    await temporaryHandle?.close()
  }
  try {
    const folderNow = await lstat(folder)
    const fileNow = await lstat(path)
    if (!sameIdentity(identityOf(folderBefore), folderNow) || !sameIdentity(identityOf(fileBefore), fileNow)) {
      throw new Error(`${path} was replaced while it was being updated, so nothing was written.`)
    }
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}
