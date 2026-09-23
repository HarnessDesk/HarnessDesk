import { constants, lstat, open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * `NOTES.md`, beside the winning Agent definition — decisions 17/18. Private
 * to that Agent's configuration scope, never secret: project notes are
 * ordinary committed Markdown, read the same confined, no-follow way an
 * Agent's own source already is. A missing file reads as `text: null`, never
 * created by the read itself; clearing writes an empty file, digest-bound to
 * what was actually shown, through the same atomic temp-then-rename swap
 * `rewriteAgentFile` uses, refusing outright the moment anything on the path
 * is not an ordinary file or directory.
 */

const NOTES_LIMIT = 64 * 1024
const FILE_NAME = 'NOTES.md'

const errnoOf = (error: unknown): string | undefined => (error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined)

/** No path component here is ever followed through a link — the folder itself, or the final file. */
const confinedFolder = async (folder: string): Promise<void> => {
  const info = await lstat(folder).catch((error: unknown) => {
    if (errnoOf(error) === 'ENOENT') throw new Error(`${folder} does not exist.`)
    throw error
  })
  if (info.isSymbolicLink()) throw new Error(`${folder} is a link; its notes are never read through it.`)
  if (!info.isDirectory()) throw new Error(`${folder} is not a folder.`)
}

export interface AgentNotesView {
  readonly path: string
  readonly text: string | null
  readonly digest: string | null
  readonly writable: boolean
  readonly problem: string | null
}

const decodeStrict = (bytes: Buffer): string => {
  // `fatal: true` refuses invalid UTF-8 outright rather than the silent
  // U+FFFD replacement `Buffer#toString` would give — a byte sequence this
  // cannot represent honestly is a problem to report, not paper over.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text.includes('\0')) throw new Error('contains a NUL byte')
  return text
}

const digestOfText = async (text: string): Promise<string> => {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Reads `NOTES.md` beside an Agent's file. `writable` says whether *this*
 * origin may ever be cleared through this same module — a built-in Agent's
 * folder is read-only, so its notes are shown but never offered a Clear.
 */
export async function readAgentNotes(folder: string, writable: boolean): Promise<AgentNotesView> {
  const path = join(folder, FILE_NAME)
  await confinedFolder(folder)
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return { path, text: null, digest: null, writable, problem: null }
    if (errnoOf(error) === 'ELOOP') return { path, text: null, digest: null, writable: false, problem: `${path} is a link; it is never read through one.` }
    return { path, text: null, digest: null, writable: false, problem: error instanceof Error ? error.message : String(error) }
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return { path, text: null, digest: null, writable: false, problem: `${path} is not an ordinary file.` }
    if (stat.size > NOTES_LIMIT) return { path, text: null, digest: null, writable: false, problem: `${path} is larger than ${NOTES_LIMIT / 1024} KiB.` }
    const buffer = Buffer.alloc(stat.size)
    await handle.read(buffer, 0, stat.size, 0)
    try {
      const text = decodeStrict(buffer)
      return { path, text, digest: await digestOfText(text), writable, problem: null }
    } catch (error) {
      return { path, text: null, digest: null, writable: false, problem: `${path} ${error instanceof Error ? error.message : String(error)}.` }
    }
  } finally {
    await handle.close()
  }
}

/**
 * Clears `NOTES.md` to empty — a person action bound to the exact digest
 * they were shown. Never removes the folder, the Agent or any skill file; an
 * already-absent file is already clear and is not created by this call. The
 * write is atomic (temp sibling, then rename) and refuses if the file
 * changed since it was read, or if anything on the path is not what a
 * notes file is expected to be.
 */
export async function clearAgentNotes(folder: string, digest: string): Promise<AgentNotesView> {
  const path = join(folder, FILE_NAME)
  await confinedFolder(folder)
  const before = await readAgentNotes(folder, true)
  if (before.text === null) {
    if (before.problem) throw new Error(before.problem)
    return before // already clear; clearing creates nothing
  }
  if (before.digest !== digest) {
    throw new Error(`${path} has changed since it was shown to you. Open it again to see its current text.`)
  }
  const fileBefore = await lstat(path)
  if (fileBefore.isSymbolicLink()) throw new Error(`${path} is a link; it is never written through one.`)
  const temp = join(dirname(path), `.${FILE_NAME}.${randomUUID().slice(0, 8)}.tmp`)
  let handle
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, fileBefore.mode & 0o777)
    await handle.sync()
  } finally {
    await handle?.close()
  }
  try {
    const fileNow = await lstat(path)
    if (fileNow.isSymbolicLink() || fileNow.ino !== fileBefore.ino || fileNow.dev !== fileBefore.dev) {
      throw new Error(`${path} was replaced while it was being cleared, so nothing was written.`)
    }
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  return { path, text: '', digest: await digestOfText(''), writable: true, problem: null }
}
