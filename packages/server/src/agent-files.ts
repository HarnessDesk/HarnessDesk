import { constants, type Stats } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { isSafePathSegment, MAX_BUNDLE_FILES } from '@harnessdesk/agent-inventory'
import type { FlowPermission, FlowSeat } from '@harnessdesk/protocol'

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
  readonly permission: FlowPermission
  readonly prefer: readonly FlowSeat[]
}): string =>
  [
    '---',
    `name: ${quoted(agent.name)}`,
    ...(agent.description ? [`description: ${quoted(agent.description)}`] : []),
    `permission: ${agent.permission}`,
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

/** Builds a folder out of sight, then gives it its final name in one move. */
export const writeAgentFolder = async (
  root: string,
  id: string,
  write: (temporary: string) => Promise<void>,
): Promise<CreatedAgentFolder> => {
  await mkdir(root, { recursive: true })
  const folder = join(root, id)
  if (await exists(folder)) throw alreadyThere(root, id)
  const rootIdentity = identityOf(await lstat(root))
  // The component has a fixed, short bound independent of `id`, so a legal
  // long Agent name never makes the transaction name exceed NAME_MAX.
  const temporary = await mkdtemp(join(root, AGENT_TEMP_PREFIX))
  const temporaryIdentity = identityOf(await lstat(temporary))
  let moved = false
  try {
    // `mkdtemp` deliberately starts at 0700. The final Agent is an ordinary
    // directory, so give it the mode `mkdir` would have under this process's umask.
    await chmod(temporary, 0o777 & ~process.umask())
    await write(temporary)
    const currentRoot = await lstat(root)
    if (!sameIdentity(rootIdentity, currentRoot)) throw new Error(`${root} changed before the Agent could be put in place.`)
    const currentTemporary = await lstat(temporary)
    if (!sameIdentity(temporaryIdentity, currentTemporary)) {
      throw new Error(`${temporary} was replaced before the Agent could be put in place.`)
    }
    if (await exists(folder)) throw alreadyThere(root, id)
    try {
      await rename(temporary, folder)
    } catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes(errnoOf(error))) throw alreadyThere(root, id)
      throw error
    }
    moved = true
  } catch (error) {
    if (!moved) {
      const left = await removeTemporary(root, rootIdentity, temporary, temporaryIdentity)
      if (left) throw new Error(`${messageOf(error)} The temporary Agent folder was left in place because ${left}.`)
    }
    throw error
  }
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
    await writeFile(join(temporary, 'AGENT.md'), source, { encoding: 'utf8', flag: 'wx' })
  })

/** A regular file or folder found directly inside a directory — a link, of any kind, to anything, is not one. */
interface RegularEntry {
  readonly name: string
  readonly source: string
  readonly kind: 'file' | 'dir'
}

/**
 * Every regular file and folder directly inside `dir`. The one rule
 * `copyAgentFolder`'s duplicate and `exportAgentFolders`'s backup both carry
 * an Agent by: a link, wherever it leads, is left behind rather than
 * followed, because a folder is `dev`+`ino` away from copying itself into a
 * link that reaches back into it, and a backup that followed a link out of
 * the folder would carry whatever that link names, decided by wherever it
 * happens to point on this machine rather than by what is in the Agent's own
 * folder.
 */
const regularEntries = async (dir: string): Promise<RegularEntry[]> => {
  const found: RegularEntry[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const source = join(dir, entry.name)
    const info = await lstat(source)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) found.push({ name: entry.name, source, kind: 'dir' })
    else if (info.isFile()) found.push({ name: entry.name, source, kind: 'file' })
  }
  return found
}

/** Copies regular files and folders, one by one; links and special files stay behind. */
const copyTree = async (from: string, to: string): Promise<void> => {
  for (const entry of await regularEntries(from)) {
    const destination = join(to, entry.name)
    if (entry.kind === 'dir') {
      await mkdir(destination)
      await copyTree(entry.source, destination)
    } else {
      await copyFile(entry.source, destination, constants.COPYFILE_EXCL)
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
 * took is repeated here. And a copy that followed nothing but links copied
 * nothing worth having, so if no `AGENT.md` arrived, what was made is removed
 * and the copy is refused — never left as an Agent with no brief, and never
 * left to fail later in a stranger's sentence than this one.
 */
export const copyAgentFolder = async (from: string, to: string): Promise<void> => {
  const id = basename(to)
  const real = await realpath(from)
  await writeAgentFolder(dirname(to), id, async (temporary) => {
    await copyTree(real, temporary)
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
 * out without a word, the same as the roster itself reads it. Anything else
 * that could not be read — a permission this account does not have, most
 * likely — leaves just that Agent, or just that file or subfolder, out, with
 * `log` told why.
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

    const take = async (source: string, path: string): Promise<void> => {
      let handle
      try {
        // `O_NONBLOCK`, like the roster's own read of an `AGENT.md`
        // (`agents.ts`'s `READ`): `regularEntries` already checked this path
        // a moment ago and found a regular file, and opening plainly trusts
        // that check to still be true. Opened non-blocking, a file swapped
        // for a pipe with nothing writing to it in that gap is read as empty
        // rather than left to hang the export — and everyone behind it in
        // the same libuv threadpool with it. `O_NOFOLLOW` for the same gap
        // with a link: `regularEntries` already left every link behind, and
        // a plain open would otherwise follow one dropped into its place,
        // carrying into the backup whatever that link happens to name.
        handle = await open(source, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
      } catch (error) {
        log?.('a file or folder was left out of an Agent backup', { id, path, error: messageOf(error) })
        if (path === 'AGENT.md') briefProblem = `it could not be opened — ${messageOf(error)}`
        return
      }
      try {
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

    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries: RegularEntry[]
      try {
        entries = await regularEntries(dir)
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
        if (entry.kind === 'dir') await walk(entry.source, path)
        else {
          examined += 1
          await take(entry.source, path)
        }
      }
    }

    try {
      await walk(join(root, id), '')
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
    // one of those would otherwise reach `writeFile`'s own `wx` flag as an
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
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, file.text, { encoding: 'utf8', flag: 'wx' })
      }
    })
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === AGENT_EXISTS) return { restored: false, reason: null }
    throw error
  }
  return { restored: true }
}

/** Reads the source Customize is about to copy, without following a last-step link and without exceeding the roster's limit. */
export const readAgentSource = async (path: string): Promise<string> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
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
