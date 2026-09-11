import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  RuntimeId,
  Session,
  SessionId,
  SessionSummary,
  SessionUsage,
  TranscriptHit,
  Turn,
  AgentItem,
} from '@harnessdesk/protocol'

import { publicationsIn, withPublications } from './publications.js'

/**
 * The transcript the host watched, kept.
 *
 * Backends are lossy about their own history. Codex's `thread/read` rebuilds
 * a turn from the rollout with only the messages and file changes in it —
 * its protocol says so: "we explicitly do not persist all agent interactions,
 * such as command executions". The seventy-six steps a person watched become
 * four the next morning. The host folded every one of those events into a
 * session as they happened (`SessionRegistry`), so it already holds the full
 * transcript; this writes that down and reads it back.
 *
 * One JSON file per session under `<state>/transcripts/<runtime>/<id>.json`,
 * written a beat after the last event and at once when a turn completes. On
 * a read, the backend's turns are *enriched*, not replaced: a turn with the
 * same id whose stored copy knows more items takes the stored items, and the
 * backend's own status, timestamps and diff win wherever it has them. A turn
 * the backend no longer lists — after a rollback — is not brought back.
 *
 * The last token figures ride along for the same reason. Every adapter holds
 * its usage on the live session handle, which is gone the moment the host
 * restarts — so before this, *every* agent came back from a restart with the
 * context ring out until the next turn, and no backend will answer a read
 * with the tokens it once reported. This is the only place the host remembers
 * them, and `enrich` the only place it hands them back.
 */

interface Stored {
  readonly version: 1
  readonly runtime: RuntimeId
  readonly id: SessionId
  readonly savedAt: number
  readonly turns: readonly Turn[]
  /**
   * The last usage the runtime reported, true as of the final turn above.
   * Optional: transcripts written before this existed simply have none, which
   * is why the format is not bumped — an old file is still a good transcript.
   */
  readonly usage?: SessionUsage | null
  /**
   * Enough of the session's face to make a search hit presentable without
   * asking the runtime — a hit is only useful if it can say which conversation
   * it is from. Optional for the same reason as `usage`: files written before
   * these existed are still good transcripts, they just introduce themselves
   * with less.
   */
  readonly title?: string | null
  readonly preview?: string | null
  readonly cwd?: string
  readonly updatedAt?: number
}

const FORMAT = 1
const SETTLE_MS = 800

/** A file name that survives any session id the backends mint. */
const fileNameOf = (id: string): string => `${encodeURIComponent(id)}.json`

/**
 * How a stored turn is recognised in a fresh read.
 *
 * Turn ids are minted by counter, and a replay that segments the conversation
 * differently mints different ones: the id "turn-1" names nine steps of work
 * today and a one-line notice tomorrow, and matching on it pastes the work
 * onto the notice while the replay's own copy stands beside it — the same
 * conversation twice. Tool-call ids are the runtime's own and survive any
 * segmentation, so content claims first: a stored turn belongs to the read
 * turn that carries its calls. The id is only trusted where content is
 * silent on both sides — a stored turn whose calls a lossy read dropped
 * entirely (Codex keeps four items of seventy-six) still matches by id, but
 * never one whose calls the read placed somewhere else.
 */
const pairTurns = (
  read: readonly Turn[],
  stored: readonly Turn[],
): ReadonlyMap<Turn, Turn> => {
  const ownerOf = new Map<string, Turn>()
  for (const turn of stored) {
    for (const item of turn.items) {
      if (item.type === 'toolCall') ownerOf.set(String(item.id), turn)
    }
  }
  const claims = new Map<Turn, Set<Turn>>()
  const carried = new Map<Turn, Set<Turn>>()
  for (const turn of read) {
    for (const item of turn.items) {
      if (item.type !== 'toolCall') continue
      const owner = ownerOf.get(String(item.id))
      if (!owner) continue
      const claim = claims.get(owner) ?? new Set<Turn>()
      claim.add(turn)
      claims.set(owner, claim)
      const carries = carried.get(turn) ?? new Set<Turn>()
      carries.add(owner)
      carried.set(turn, carries)
    }
  }
  const byId = new Map(stored.map((turn) => [turn.id, turn]))
  const pairs = new Map<Turn, Turn>()
  for (const turn of read) {
    const owners = carried.get(turn)
    if (owners) {
      // One stored turn, wholly here: a pair. Split or merged across other
      // read turns, the read's own segmentation wins and nothing is pasted.
      if (owners.size !== 1) continue
      const owner = [...owners][0] as Turn
      if (claims.get(owner)?.size === 1) pairs.set(turn, owner)
      continue
    }
    const sameId = byId.get(turn.id)
    if (sameId && !claims.has(sameId)) pairs.set(turn, sameId)
  }
  return pairs
}

/**
 * The stored usage to put back on a read, or null to leave the read alone.
 *
 * Two conditions, both necessary. The read must have carried none: a runtime
 * that still holds the live figures is the authority, and the store never
 * argues with it. And the conversation must not have moved on — the number is
 * only true as of the last turn the host watched, so if the backend now ends
 * on a different turn, because someone carried the conversation on in Codex
 * Desktop or the Claude CLI, the figure describes a context that no longer
 * exists. There the ring stays out until the next turn reports a real one: a
 * wrong number near the limit is worse than no number at all, which is the
 * same rule that gives Cursor a dashed ring rather than a guess.
 */
const restorableUsage = (
  session: Session,
  stored: Stored,
  pairs: ReadonlyMap<Turn, Turn>,
): SessionUsage | null => {
  if (session.usage) return null
  if (!stored.usage) return null
  const last = session.turns.at(-1)
  const lastStored = stored.turns.at(-1)
  if (last === undefined || lastStored === undefined) return null
  return pairs.get(last) === lastStored ? stored.usage : null
}

/**
 * One session's key in the store's queues. Spelled once: `forget()` built it
 * with a space where `record()` used a NUL, so the write still queued for a
 * deleted conversation was never found, and it wrote the transcript back a
 * moment after the delete (#36).
 */
const keyOf = (runtime: RuntimeId, id: SessionId): string => `${runtime}\0${id}`

export class TranscriptStore {
  readonly #pending = new Map<string, { timer: ReturnType<typeof setTimeout>; session: Session }>()
  readonly #writes = new Map<string, Promise<void>>()

  constructor(
    private readonly directory: string,
    private readonly log: (message: string, details?: Record<string, unknown>) => void = () => {},
  ) {}

  #pathOf(runtime: RuntimeId, id: SessionId): string {
    return join(this.directory, encodeURIComponent(runtime), fileNameOf(id))
  }

  /**
   * Notes the session's current transcript for writing. `now` skips the
   * settle delay — the end of a turn is worth a write of its own.
   */
  record(session: Session, options: { readonly now?: boolean } = {}): void {
    if (!session.itemsLoaded) return
    if (!session.turns.some((turn) => turn.items.length > 0)) return
    const key = keyOf(session.runtime, session.id)
    const pending = this.#pending.get(key)
    if (pending) clearTimeout(pending.timer)
    const timer = setTimeout(() => {
      this.#pending.delete(key)
      void this.#write(session)
    }, options.now ? 0 : SETTLE_MS)
    this.#pending.set(key, { timer, session })
  }

  async #write(session: Session): Promise<void> {
    const key = keyOf(session.runtime, session.id)
    const previous = this.#writes.get(key) ?? Promise.resolve()
    const next = previous.then(async () => {
      const stored: Stored = {
        version: FORMAT,
        runtime: session.runtime,
        id: session.id,
        savedAt: Date.now(),
        turns: session.turns,
        usage: session.usage ?? null,
        title: session.title ?? null,
        preview: session.preview ?? null,
        cwd: session.cwd,
        updatedAt: session.updatedAt,
      }
      const file = this.#pathOf(session.runtime, session.id)
      try {
        // A file stamped by a newer format is left exactly as it is: writing
        // would replace tomorrow's schema with today's, and the newer build
        // that owns it will be back.
        try {
          const current = JSON.parse(await readFile(file, 'utf8')) as { version?: unknown }
          if (typeof current.version === 'number' && current.version > FORMAT) {
            this.log('transcript from a newer format left untouched', { session: session.id })
            return
          }
        } catch {
          // Absent or unreadable is the normal case; the write proceeds.
        }
        await mkdir(dirname(file), { recursive: true })
        // Write-then-rename so a crash mid-write cannot truncate the file.
        const temp = `${file}.${process.pid}.tmp`
        await writeFile(temp, JSON.stringify(stored))
        await rename(temp, file)
      } catch (error) {
        this.log('transcript not saved', { session: session.id, error: String(error) })
      }
    })
    this.#writes.set(key, next)
    await next
  }

  async #read(runtime: RuntimeId, id: SessionId): Promise<Stored | null> {
    try {
      const raw = await readFile(this.#pathOf(runtime, id), 'utf8')
      const parsed = JSON.parse(raw) as Partial<Stored>
      if (parsed.version !== FORMAT || !Array.isArray(parsed.turns)) return null
      return parsed as Stored
    } catch {
      return null
    }
  }

  /**
   * A session rebuilt purely from what the host stored, for when the backend
   * cannot serve it at all — an ACP agent restarted out of its idle sessions,
   * a Codex build that refuses its own rollout. Read-only by nature: idle,
   * no settings, no options. Null when the host never watched this session.
   */
  async recover(runtime: RuntimeId, id: SessionId): Promise<Session | null> {
    const stored = await this.#read(runtime, id)
    if (!stored || stored.turns.length === 0) return null
    const at = stored.updatedAt ?? stored.savedAt
    return {
      id,
      runtime,
      cwd: stored.cwd ?? '',
      status: { type: 'idle' },
      createdAt: at,
      updatedAt: at,
      itemsLoaded: true,
      turns: stored.turns,
      ...(stored.title !== undefined ? { title: stored.title } : {}),
      ...(stored.preview !== undefined ? { preview: stored.preview } : {}),
      ...(stored.usage != null ? { usage: stored.usage } : {}),
    }
  }

  /**
   * The backend's read, with what the host remembers folded in. Items are
   * merged per turn, and the last usage is restored when the read carried
   * none; nothing else about the session changes.
   */
  async enrich(session: Session): Promise<Session> {
    const stored = await this.#read(session.runtime, session.id)
    if (!stored) return session
    // A backend that answers with no turns at all — an ACP agent restarted
    // out of its idle sessions serves the session but not its past — is not
    // making a claim about history the way a rollback is; the host watched
    // the turns happen, so they stand in whole.
    if (session.turns.length === 0 && stored.turns.length > 0) {
      return { ...session, turns: stored.turns, ...(session.usage ? {} : stored.usage != null ? { usage: stored.usage } : {}) }
    }
    const pairs = pairTurns(session.turns, stored.turns)
    // Where each item the read knows about lives. A stored turn that would
    // bring an item some other read turn already shows is a split the
    // pairing could not see — pasting it would show the item twice.
    const homes = new Map<string, Turn>()
    for (const turn of session.turns) {
      for (const entry of turn.items) homes.set(String(entry.id), turn)
    }
    let changed = false
    const turns = session.turns.map((turn) => {
      const kept = pairs.get(turn)
      if (!kept) return turn
      // What the host itself put in the turn. The backend has never heard of
      // a publication, so a read that otherwise wins on count — a Codex
      // rollout that stored more than it streamed — would drop the row the
      // host recorded. Put back at its place, whichever list stands.
      const published = publicationsIn(kept.items)
      const carry = (items: readonly AgentItem[]): readonly AgentItem[] => withPublications(items, published)
      if (kept.items.length <= turn.items.length) {
        const items = carry(turn.items)
        if (items.length === turn.items.length) return turn
        changed = true
        return { ...turn, items }
      }
      if (
        kept.items.some((entry) => {
          const home = homes.get(String(entry.id))
          return home !== undefined && home !== turn
        })
      ) {
        const items = carry(turn.items)
        if (items.length === turn.items.length) return turn
        changed = true
        return { ...turn, items }
      }
      changed = true
      return {
        ...kept,
        ...turn,
        items: kept.items,
        diff: turn.diff ?? kept.diff ?? null,
        plan: turn.plan ?? kept.plan,
      }
    })
    const usage = restorableUsage(session, stored, pairs)
    if (!changed && !usage) return session
    return { ...session, turns, ...(usage ? { usage } : {}) }
  }

  /**
   * Search every stored transcript for the words themselves.
   *
   * This is the one search that treats every agent the same, because it reads
   * what the host watched rather than asking anyone. The adapters' own
   * searches are narrower on purpose — Codex greps its rollouts, ACP agents
   * can only offer their live previews — and the palette merges all three.
   *
   * What is searched is what a person would call the conversation: their own
   * messages and the agent's answers. Not tool output, not reasoning, and not
   * the client scaffolding around a user message — matching a conversation on
   * a word that appears only in a command's stderr surprises more than it
   * helps. Most recent transcripts are read first, so under a result cap it
   * is the oldest conversations that go unsearched, never the latest.
   */
  async search(query: string, options: { readonly limit?: number } = {}): Promise<readonly TranscriptHit[]> {
    const limit = options.limit ?? 20
    const needle = query.trim().toLowerCase()
    if (needle === '') return []

    const files: { path: string; mtime: number }[] = []
    let runtimes: string[] = []
    try {
      runtimes = await readdir(this.directory)
    } catch {
      return [] // No transcript was ever written; nothing to search is a fine answer.
    }
    for (const dir of runtimes) {
      let names: string[] = []
      try {
        names = await readdir(join(this.directory, dir))
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const path = join(this.directory, dir, name)
        try {
          files.push({ path, mtime: (await stat(path)).mtimeMs })
        } catch {
          // Deleted between readdir and stat: a session being forgotten.
        }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime)

    const hits: TranscriptHit[] = []
    for (const file of files) {
      if (hits.length >= limit) break
      let stored: Stored
      try {
        const parsed = JSON.parse(await readFile(file.path, 'utf8')) as Partial<Stored>
        if (parsed.version !== FORMAT || !Array.isArray(parsed.turns)) continue
        stored = parsed as Stored
      } catch {
        continue
      }
      const hit = firstMatch(stored.turns, needle)
      if (hit) hits.push({ summary: summaryOf(stored), ...hit })
    }
    return hits
  }

  /**
   * Every stored transcript, raw, for the backup file. Corrupt files are
   * skipped: a backup that cannot be restored is worse than one file short.
   */
  async exportAll(): Promise<readonly { runtime: string; id: string; data: unknown }[]> {
    const out: { runtime: string; id: string; data: unknown }[] = []
    let runtimes: string[] = []
    try {
      runtimes = await readdir(this.directory)
    } catch {
      return []
    }
    for (const dir of runtimes) {
      let names: string[] = []
      try {
        names = await readdir(join(this.directory, dir))
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        try {
          const data = JSON.parse(await readFile(join(this.directory, dir, name), 'utf8')) as Partial<Stored>
          if (data.version !== FORMAT || !Array.isArray(data.turns)) continue
          out.push({ runtime: decodeURIComponent(dir), id: String(data.id), data })
        } catch {
          continue
        }
      }
    }
    return out
  }

  /**
   * Puts one transcript from a backup into the store, additively and
   * verified. `skipped` when the local copy is at least as new — a restore
   * must never roll a conversation backwards — `refused` when the data is
   * not a transcript, and `restored` only after the written file was read
   * back and matched.
   */
  async importOne(
    runtime: string,
    id: string,
    data: unknown,
  ): Promise<'restored' | 'skipped' | 'refused'> {
    const incoming = data as Partial<Stored>
    if (
      typeof incoming !== 'object' ||
      incoming === null ||
      incoming.version !== FORMAT ||
      !Array.isArray(incoming.turns) ||
      typeof incoming.savedAt !== 'number'
    ) {
      return 'refused'
    }
    const existing = await this.#read(runtime as RuntimeId, id as SessionId)
    if (existing && existing.savedAt >= incoming.savedAt) return 'skipped'
    const file = this.#pathOf(runtime as RuntimeId, id as SessionId)
    try {
      await mkdir(dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(incoming))
      await rename(temp, file)
    } catch {
      return 'refused'
    }
    const written = await this.#read(runtime as RuntimeId, id as SessionId)
    return written && written.savedAt === incoming.savedAt && written.turns.length === incoming.turns.length
      ? 'restored'
      : 'refused'
  }

  /**
   * Drops the host's copy of one session, and any write still queued for it.
   *
   * Called when a conversation is deleted. The pending write is cancelled
   * first: a settle timer that fired afterwards would write the transcript
   * back out, and a deleted conversation that returns from the dead a second
   * later is worse than one that was never deleted.
   */
  async forget(runtime: RuntimeId, id: SessionId): Promise<void> {
    const key = keyOf(runtime, id)
    const pending = this.#pending.get(key)
    if (pending) {
      clearTimeout(pending.timer)
      this.#pending.delete(key)
    }
    // Wait out a write already in flight, or the unlink races it.
    await this.#writes.get(key)?.catch(() => {})
    this.#writes.delete(key)
    try {
      await rm(this.#pathOf(runtime, id))
    } catch {
      // No transcript kept for this session is the expected case for a
      // conversation that was never opened here.
    }
  }

  /**
   * Drops a conversation's last `count` turns from what the store kept,
   * because the conversation itself dropped them: a rollback. Untold, the
   * store filled a later read in from the turns it had, and a relaunch
   * brought the dropped ones back (#156). A write still waiting goes out
   * first, so the turns counted from the end are the conversation's last,
   * and a transcript with no turn left is forgotten. It trims the file rather
   * than writing the host's copy over it, since that copy can be thinner
   * than the file, or not loaded (review of #236, round 1).
   */
  async dropTurns(runtime: RuntimeId, id: SessionId, count: number): Promise<void> {
    if (!(count > 0)) return
    const key = keyOf(runtime, id)
    const pending = this.#pending.get(key)
    if (pending) {
      clearTimeout(pending.timer)
      this.#pending.delete(key)
      await this.#write(pending.session)
    }
    await this.#writes.get(key)?.catch(() => {})
    const stored = await this.recover(runtime, id)
    if (!stored) return
    const kept = Math.max(0, stored.turns.length - count)
    if (kept === 0) await this.forget(runtime, id)
    else await this.#write({ ...stored, turns: stored.turns.slice(0, kept) })
  }

  /** Writes whatever is still waiting. Call on shutdown. */
  async flush(): Promise<void> {
    const waiting = [...this.#pending.values()]
    for (const entry of waiting) clearTimeout(entry.timer)
    this.#pending.clear()
    await Promise.all(waiting.map((entry) => this.#write(entry.session)))
    await Promise.all([...this.#writes.values()])
  }
}

/** The conversation's spoken words: what the person typed, what the agent said. */
const spokenText = function* (turns: readonly Turn[]): Generator<string> {
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'assistantMessage' && typeof item.text === 'string') yield item.text
      if (item.type === 'userMessage' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === 'text' && typeof part.text === 'string') yield part.text
        }
      }
    }
  }
}

/**
 * The first line containing the needle, trimmed and clipped for a result row,
 * with the match's offsets recomputed for whatever survived the clipping.
 */
const firstMatch = (
  turns: readonly Turn[],
  needle: string,
): { line: string; start: number; end: number } | null => {
  for (const text of spokenText(turns)) {
    if (!text.toLowerCase().includes(needle)) continue
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      const at = line.toLowerCase().indexOf(needle)
      if (at === -1) continue
      if (line.length <= 200) return { line, start: at, end: at + needle.length }
      const from = Math.max(0, at - 60)
      const to = Math.min(line.length, at + needle.length + 120)
      const clipped = `${from > 0 ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''}`
      const start = at - from + (from > 0 ? 1 : 0)
      return { line: clipped, start, end: start + needle.length }
    }
  }
  return null
}

/**
 * A summary from the stored file alone. Files written before the metadata
 * existed fall back to the transcript's own first words; `notLoaded` is the
 * honest status for a conversation nobody has opened this session.
 */
const summaryOf = (stored: Stored): SessionSummary => {
  const preview =
    stored.preview ?? [...spokenText(stored.turns)][0]?.split('\n')[0]?.slice(0, 120) ?? null
  return {
    id: stored.id,
    runtime: stored.runtime,
    title: stored.title ?? null,
    preview,
    cwd: stored.cwd ?? '',
    status: { type: 'notLoaded' },
    createdAt: stored.updatedAt ?? stored.savedAt,
    updatedAt: stored.updatedAt ?? stored.savedAt,
  }
}
