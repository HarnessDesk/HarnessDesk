import { projectRootOf } from './scan.js'
import { MissingTranscriptRuntimeError } from '../transcripts.js'
import type { RemoteEventsSource } from './remote.js'
import type { UsageRow } from './store.js'

/**
 * The desk's own transcript, turned into turn counts — the fallback source
 * for a runtime whose own history this ledger cannot read at all: Cursor
 * (rule 3, AGENTS.md — it keeps no local transcript of its own) and any ACP
 * agent this desk has no scanner for.
 *
 * **The no-double-count rule.** The host's bootstrap wiring (`bindUsage`,
 * `host.ts`) gives a runtime *either* a `CorpusSpec` — its own transcript,
 * scanned for tokens, and for the four kinds in `TURN_CAPABLE_KINDS`
 * (`scan.ts`), for turns too — *or* a `DeskTranscriptTurnsSource`, turns
 * only, from what the host itself watched happen. Never both for the same
 * runtime id. That is the whole rule: it is decided once, at wiring time, by
 * which agents have a readable corpus at all, never detected per session or
 * per read — there is no runtime this ledger could double-count even by
 * accident, because there is exactly one place that ever calls `turns` known
 * for a given id.
 *
 * A stored session's own `turns` array already *is* the host's own
 * segmentation of the conversation into turns — "Turns",
 * `docs/usage-dashboard.md` — so this counts that array's length, one row
 * per local day and project, with no tokens or cost at all: the desk did not
 * watch what anything cost, only that a turn happened.
 */
export interface DeskTranscriptExport {
  readonly runtime: string
  readonly id: string
  readonly data: unknown
}

/** The one thing this source needs from `TranscriptStore` — its own export. */
export interface DeskTranscriptReader {
  exportRuntime(runtime: string): Promise<readonly DeskTranscriptExport[]>
}

const startOfLocalDay = (at: number): number => {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** A stored turn's own start time, when the file carries one. */
const turnStartedAt = (turn: unknown): number | null => {
  if (typeof turn !== 'object' || turn === null) return null
  const value = (turn as { startedAt?: unknown }).startedAt
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Whether a stored turn is one the desk should count at all: a person's (or
 * another agent's) own prompt, or the one shape that stands in for it --
 * `AgentSession.send(recordAs: 'notice')`, which sends a real prompt but
 * records it as a `NoticeItem` so it never shows as a person's own words
 * (`docs/usage-dashboard.md`, "Turns"). Everything else a `NoticeItem` can
 * open a turn with -- a replay's own reconstruction of housekeeping, an
 * interrupted turn nobody answered -- is not a prompt anyone sent, and is
 * told apart from a real `recordAs: 'notice'` turn the only way that is
 * possible from the stored shape alone: a real one was answered, so it has
 * more than the one notice item, or the runtime marked it `completed`. A
 * turn queued but never run has no `Turn` object at all (`send` only builds
 * one once it is actually dispatched), so nothing here has to filter that
 * case out separately.
 */
const countsAsPrompt = (turn: unknown): boolean => {
  if (typeof turn !== 'object' || turn === null) return false
  const items = (turn as { items?: unknown }).items
  if (!Array.isArray(items) || items.length === 0) return false
  const first = items[0] as { type?: unknown } | undefined
  if (typeof first !== 'object' || first === null) return false
  if (first.type === 'userMessage') return true
  if (first.type !== 'notice') return false
  const status = (turn as { status?: unknown }).status
  return items.length > 1 || status === 'completed'
}

export class DeskTranscriptTurnsSource implements RemoteEventsSource {
  readonly runtime: string
  /** Local transcript data changes with turns, so it is read on every ledger scan. */
  readonly syncEveryScan = true
  readonly #transcripts: DeskTranscriptReader

  constructor(runtime: string, transcripts: DeskTranscriptReader) {
    this.runtime = runtime
    this.#transcripts = transcripts
  }

  /** Not credential-gated like a real remote source: a stable key of its own. */
  async resolveFile(): Promise<string | null> {
    return `desk-transcript:${this.runtime}`
  }

  async sync(
    range: { readonly from: number; readonly to: number },
    file: string,
  ): Promise<{ readonly rows: readonly UsageRow[]; readonly missing?: boolean } | null> {
    let entries: readonly DeskTranscriptExport[]
    try {
      entries = await this.#transcripts.exportRuntime(this.runtime)
    } catch (error) {
      if (error instanceof MissingTranscriptRuntimeError) return { rows: [], missing: true }
      return null
    }
    const rows = new Map<string, UsageRow>()
    for (const entry of entries) {
      if (entry.runtime !== this.runtime) continue
      const stored = entry.data as { turns?: unknown; cwd?: unknown }
      if (!Array.isArray(stored.turns)) continue
      const project = projectRootOf(typeof stored.cwd === 'string' ? stored.cwd : '')
      for (const turn of stored.turns) {
        if (!countsAsPrompt(turn)) continue
        const at = turnStartedAt(turn)
        if (at === null || at < range.from || at >= range.to) continue
        const day = startOfLocalDay(at)
        const key = `${day}\u0000${project}`
        const existing = rows.get(key)
        if (existing) {
          rows.set(key, { ...existing, turns: (existing.turns ?? 0) + 1 })
          continue
        }
        rows.set(key, {
          file,
          day,
          runtime: this.runtime,
          model: 'unknown',
          project,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          requests: 0,
          turns: 1,
          vendorCost: null,
        })
      }
    }
    return { rows: [...rows.values()] }
  }
}
