import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { splitContext } from '@harnessdesk/protocol'

/**
 * Cursor's own chat store, read only.
 *
 * Everything this bridge knows about where Cursor keeps its conversations
 * lives in this file, so there is one place to look when Cursor changes it.
 * The layout, as of `schemaVersion: 1`:
 *
 * ```
 * ~/.cursor/chats/<md5 of the workspace path>/<chat id>/
 *   meta.json   { schemaVersion, createdAtMs, updatedAtMs, hasConversation, title?, cwd? }
 *   store.db    sqlite: meta(key,value) + blobs(id,data)
 * ```
 *
 * Two rules hold everywhere below. **Nothing is edited**: renaming a chat,
 * rewriting its transcript, touching a field inside `meta.json` all belong to
 * Cursor, and a bridge that wrote into another app's records would break the
 * moment that app changed them. `trashChat` is the one write, and it is not
 * an edit: it moves a whole chat folder — opaque to this module, whatever
 * version it is — into the user's Trash, because a person who deletes a
 * conversation in a client that lists it means that conversation, and a
 * client that lists what it cannot remove is half a client. It goes to the
 * Trash rather than away, so a misread confirmation costs a drag back. And
 * **every read degrades to nothing**: a folder that is not there, a file that
 * will not parse, a database that is locked, all return empty rather than
 * throwing, because a listing that fails must fall back to what this bridge
 * knows on its own, not take the session list down with it.
 *
 * Why read it at all: Cursor's chats are Cursor's, whether they were started
 * in its IDE, by `cursor-agent` in a terminal, or here. A conversation the
 * user began in Cursor and one begun in HarnessDesk are the same kind of
 * thing, and only this store knows about both.
 */

/** The `meta.json` shape this module was written against. */
const SCHEMA_VERSION = 1

/** Cursor keys a workspace's chats by the md5 of its path. */
export const workspaceKey = (cwd: string): string => createHash('md5').update(cwd).digest('hex')

const chatsDir = (cwd: string, home: string): string =>
  join(home, '.cursor', 'chats', workspaceKey(cwd))

/** One chat as Cursor records it. */
export interface CursorChat {
  readonly chatId: string
  readonly cwd: string
  /**
   * The name Cursor gave it, or null. Only Cursor's IDE names chats; a chat
   * started by the CLI — or here — carries no name until it is opened and
   * named there, and this bridge invents none for it. One conversation, one
   * name, and it is Cursor's to write.
   */
  readonly title: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

interface ChatFile {
  readonly schemaVersion?: unknown
  readonly createdAtMs?: unknown
  readonly updatedAtMs?: unknown
  readonly hasConversation?: unknown
  readonly title?: unknown
  readonly cwd?: unknown
}

const readChatFile = (dir: string): ChatFile | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as ChatFile) : null
  } catch {
    return null
  }
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

const number = (value: unknown): number | null => (typeof value === 'number' ? value : null)

/**
 * Every chat Cursor holds for a workspace, newest first.
 *
 * `hasConversation` is Cursor's own record of whether anyone has spoken in a
 * chat: `create-chat` mints an id long before there is a conversation, and
 * an options probe or an abandoned draft leaves one of those behind. Those
 * are skipped — but only when the schema is the one that meaning was read
 * from. A store this module has never seen is listed whole rather than
 * filtered by a guess, because hiding a real conversation is the worse
 * failure.
 */
export const readWorkspaceChats = (cwd: string, home = homedir()): readonly CursorChat[] => {
  const dir = chatsDir(cwd, home)
  let entries: readonly string[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const chats: CursorChat[] = []
  for (const chatId of entries) {
    const file = readChatFile(join(dir, chatId))
    if (!file) continue
    if (file.schemaVersion === SCHEMA_VERSION && file.hasConversation === false) continue
    const createdAt = number(file.createdAtMs) ?? 0
    chats.push({
      chatId,
      cwd,
      title: text(file.title),
      createdAt,
      updatedAt: number(file.updatedAtMs) ?? createdAt,
    })
  }
  return chats.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Every chat in the store that says which workspace it belongs to.
 *
 * The store is keyed by a hash of the workspace path, which does not run
 * backwards — so a workspace nobody has named cannot be asked about. What
 * saves it is that a chat started by `cursor-agent` records its own `cwd`,
 * and those are exactly the chats no workspace lookup would find: a folder
 * the user worked in from a terminal, never opened here. Chats without one
 * — Cursor's IDE does not write it — are found by hashing a workspace this
 * bridge already knows, which is what `readWorkspaceChats` is for.
 */
export const readAllChats = (home = homedir()): readonly CursorChat[] => {
  const root = join(home, '.cursor', 'chats')
  let workspaces: readonly string[]
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const chats: CursorChat[] = []
  for (const workspace of workspaces) {
    let ids: readonly string[]
    try {
      ids = readdirSync(join(root, workspace), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      continue
    }
    for (const chatId of ids) {
      const file = readChatFile(join(root, workspace, chatId))
      if (!file) continue
      const cwd = text(file.cwd)
      if (cwd === null) continue
      if (file.schemaVersion === SCHEMA_VERSION && file.hasConversation === false) continue
      const createdAt = number(file.createdAtMs) ?? 0
      chats.push({
        chatId,
        cwd,
        title: text(file.title),
        createdAt,
        updatedAt: number(file.updatedAtMs) ?? createdAt,
      })
    }
  }
  return chats.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * The name Cursor itself gave a chat, and when it last touched it.
 *
 * `title` is the name its own picker and IDE show, which is the name this
 * bridge must report so one conversation does not have two names on one
 * machine. A chat Cursor has not named — one started here, or by its CLI,
 * and never opened in the IDE — has none, and says so.
 */
export const cursorMeta = (
  chatId: string,
  cwd: string,
  home = homedir(),
): { readonly title: string | null; readonly updatedAt: number | null } => {
  const file = readChatFile(join(chatsDir(cwd, home), chatId))
  if (!file) return { title: null, updatedAt: null }
  return { title: text(file.title), updatedAt: number(file.updatedAtMs) }
}

/**
 * Which of the given workspaces holds a chat, if any.
 *
 * The store is keyed by a hash of the path, so a chat id alone cannot be
 * resolved to a workspace — the hash does not run backwards. What can be
 * done is to ask each workspace this bridge knows about, which is what
 * makes a chat started in Cursor resumable here: the id is enough for
 * `--resume`, and this finds the folder its name and history live in.
 */
export const findChatWorkspace = (
  chatId: string,
  cwds: readonly string[],
  home = homedir(),
): string | null =>
  cwds.find((cwd) => existsSync(join(chatsDir(cwd, home), chatId, 'meta.json'))) ?? null

/**
 * A prompt as the user wrote it, with any context block HarnessDesk put in
 * front of it removed — a hand-off packet or a referenced conversation is
 * for the model, not a description of the conversation.
 *
 * The protocol's own reader does the removing. A pattern of this file's own
 * was a third opinion on what an envelope is, and it disagreed with the
 * protocol at both edges: it cut out a `<context\nsource="x">` block whose
 * label `splitContext` could not read, so `titleOf` fell through to a label
 * that was never found and named the conversation nothing (#224). Whatever
 * `splitContext` reads as a block is what comes out, by construction.
 */
export const stripEnvelope = (value: string): string => splitContext(value).text.trim()

/**
 * How much of a line names a chat: 120 characters, where the desk's other
 * agents cut a conversation's opening too. A label was cut at 80 and the
 * user's own words at 120, so how long a name was depended on which of the
 * two it came from (#188).
 */
const NAME_WIDTH = 120

/** The first line of `text` that says anything, cut to a row's width. */
export const firstLine = (text: string): string =>
  (text.split('\n').find((entry) => entry.trim() !== '') ?? '').trim().slice(0, NAME_WIDTH)

/**
 * What a message that is only a context block is called: the label the block
 * carries, which is written for people where the block is for the model
 * (#47), by its first line, because a label with a line break put the rest of
 * it in the row (review of #167, round 3). Nothing, for a block with no label.
 * The bridge's titles and Cursor's transcript both name a chat through this.
 */
export const contextLabel = (text: string): string => firstLine(splitContext(text).injections[0]?.label ?? '')

/** The transcript blobs, in the order Cursor threaded them. */
const rootRefs = (root: Uint8Array): readonly string[] => {
  const refs: string[] = []
  let at = 0
  // A list of 32-byte blob hashes, protobuf field 1: `0a 20 <hash>`, repeated.
  // Anything else means the format has moved on, and reading stops there.
  while (at + 34 <= root.length && root[at] === 0x0a && root[at + 1] === 0x20) {
    refs.push(Buffer.from(root.subarray(at + 2, at + 34)).toString('hex'))
    at += 34
  }
  return refs
}

/** The text of a stored message, whose content is a string or typed parts. */
const messageText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .join(' ')
}

/**
 * What the user asked, from a chat this bridge never ran.
 *
 * A chat Cursor has not named would otherwise be a row reading "Untitled
 * session" — true, and useless. Cursor's transcript is a content-addressed
 * blob graph: one meta row names the latest root, the root lists the
 * messages in order, and a message is JSON with a role. The first user
 * message is what the user typed; the ones before it are the environment
 * Cursor injects, wrapped in `<user_info>`, and the prompt itself arrives
 * wrapped in `<user_query>`.
 *
 * This is the one place that reads a format Cursor does not document, so it
 * is the one place gated on the schema it was read from, and every failure
 * — a moved format, a locked database, a chat still being written — returns
 * null and leaves the row as it was.
 */
export const readChatPreview = (
  chatId: string,
  cwd: string,
  home = homedir(),
  limit = NAME_WIDTH,
): string | null => {
  const dir = join(chatsDir(cwd, home), chatId)
  const file = readChatFile(dir)
  if (file?.schemaVersion !== SCHEMA_VERSION) return null
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(join(dir, 'store.db'), { readOnly: true })
    const meta = db.prepare('select value from meta where key = ?').get('0') as
      | { value?: unknown }
      | undefined
    if (typeof meta?.value !== 'string') return null
    const header = JSON.parse(Buffer.from(meta.value, 'hex').toString('utf8')) as {
      latestRootBlobId?: unknown
    }
    if (typeof header.latestRootBlobId !== 'string') return null
    const blob = db.prepare('select data from blobs where id = ?')
    const read = (id: string): Uint8Array | null => {
      const row = blob.get(id) as { data?: unknown } | undefined
      return row?.data instanceof Uint8Array ? row.data : null
    }
    const root = read(header.latestRootBlobId)
    if (!root) return null
    for (const ref of rootRefs(root)) {
      const data = read(ref)
      // Only the JSON messages are of interest; the rest of the graph is
      // Cursor's own binary records and the file contents it captured.
      if (!data || data[0] !== 0x7b) continue
      let message: { role?: unknown; content?: unknown }
      try {
        message = JSON.parse(Buffer.from(data).toString('utf8')) as typeof message
      } catch {
        continue
      }
      if (message.role !== 'user') continue
      const body = messageText(message.content)
      const asked = /<user_query>([\s\S]*?)<\/user_query>/.exec(body)?.[1]
      const said = asked ?? (body.includes('<user_info>') ? null : body)
      if (said === null) continue
      const line = stripEnvelope(said).replace(/\s+/g, ' ').trim()
      if (line !== '') return line.slice(0, limit)
      /* A message that is only a context block is named by its label, as the
         bridge names it. Skipped, the chat was named by its second message,
         and the list renamed a conversation after its second turn (review of
         #167, round 4). One with no label gives way to the next message. */
      const label = contextLabel(said)
      if (label !== '') return label.slice(0, limit)
    }
    return null
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      // A store that will not close cleanly has nothing more to give.
    }
  }
}

/**
 * The mode a chat was last in, when it is one this bridge also offers.
 *
 * Cursor records modes of its own that have no counterpart here; those are
 * left alone rather than mapped onto a guess, and the session opens in the
 * mode HarnessDesk would have given it.
 */
export const readChatMode = (
  chatId: string,
  cwd: string,
  known: readonly string[],
  home = homedir(),
): string | null => {
  const dir = join(chatsDir(cwd, home), chatId)
  if (readChatFile(dir)?.schemaVersion !== SCHEMA_VERSION) return null
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(join(dir, 'store.db'), { readOnly: true })
    const meta = db.prepare('select value from meta where key = ?').get('0') as
      | { value?: unknown }
      | undefined
    if (typeof meta?.value !== 'string') return null
    const header = JSON.parse(Buffer.from(meta.value, 'hex').toString('utf8')) as { mode?: unknown }
    const mode = text(header.mode)
    return mode !== null && known.includes(mode) ? mode : null
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      // As above.
    }
  }
}

/** A chat id shaped like the ones Cursor mints, and nothing else. */
export const CHAT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * Where Cursor keeps one chat, wherever its workspace was.
 *
 * A delete carries a chat id and nothing else, and Cursor files chats under
 * the md5 of the folder they ran in, so every workspace bucket is checked.
 * The ids are UUIDs: a match is the chat, not a namesake. Null when Cursor
 * has nothing stored, which is the ordinary case for a chat that never took
 * a turn.
 */
export const chatPath = (chatId: string, home = homedir()): string | null => {
  if (!CHAT_ID.test(chatId)) return null
  const root = join(home, '.cursor', 'chats')
  let buckets: readonly string[]
  try {
    buckets = readdirSync(root)
  } catch {
    return null
  }
  for (const bucket of buckets) {
    const candidate = join(root, bucket, chatId)
    if (existsSync(join(candidate, 'meta.json'))) return candidate
  }
  return null
}

/**
 * Moves one chat folder into the user's Trash. True when something moved.
 *
 * A rename within the volume, which is what the Trash is for anything under
 * the home directory. A name already there gets a numbered suffix rather than
 * overwriting it: the point of trashing instead of erasing is that nothing is
 * destroyed, and that has to hold for what is already in the Trash too.
 */
export const trashChat = (path: string, home = homedir()): boolean => {
  const dir = join(home, '.Trash')
  try {
    mkdirSync(dir, { recursive: true })
    renameSync(path, freeName(dir, basename(path)))
    return true
  } catch {
    return false
  }
}

const freeName = (dir: string, name: string): string => {
  if (!taken(join(dir, name))) return join(dir, name)
  for (let n = 2; n < 1000; n += 1) {
    const candidate = join(dir, `${name} ${n}`)
    if (!taken(candidate)) return candidate
  }
  return join(dir, `${name} ${Date.now()}`)
}

const taken = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
