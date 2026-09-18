import { constants, type Stats } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { FlowPermission, FlowSeat } from '@harnessdesk/protocol'

import { AGENT_FILE_LIMIT, AGENT_TEMP_PREFIX, PROJECT_AGENT_DIR } from './agents.js'
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

const alreadyThere = (root: string, id: string): Error => new Error(`There is already an Agent called “${id}” in ${root}.`)

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

/** Copies regular files and folders, one by one; links and special files stay behind. */
const copyTree = async (from: string, to: string): Promise<void> => {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const destination = join(to, entry.name)
    const info = await lstat(source)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      await mkdir(destination)
      await copyTree(source, destination)
    } else if (info.isFile()) {
      await copyFile(source, destination, constants.COPYFILE_EXCL)
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
