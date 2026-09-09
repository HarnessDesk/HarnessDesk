import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { pathWithin } from '@harnessdesk/cordis-host'
import type { AgentEvent, RuntimeId } from '@harnessdesk/protocol'

/**
 * The audit log: one append-only record of what every agent did,
 * whichever vendor made it. This is the artefact only a neutral shell can
 * produce — each backend keeps its own history in its own shape; this one
 * answers "what happened in this repository this week" across all of them.
 *
 * NDJSON on disk, one entry per line, written as events arrive. Reads filter
 * by workspace root and age. Nothing here is ever transmitted; it ships only
 * inside a diagnostics bundle the user saves themselves.
 */

export interface AuditEntry {
  readonly at: number
  readonly runtime: RuntimeId
  readonly sessionId: string
  /** The workspace the session worked in, for the per-repository question. */
  readonly cwd?: string
  readonly kind:
    | 'session/started'
    | 'turn/completed'
    | 'turn/reverted'
    | 'turn/reapplied'
    | 'approval/decided'
    | 'approval/autoDecided'
    | 'team/message'
    | 'team/intent'
    | 'library/write'
  /** turn/completed; for library writes, the op's outcome. */
  readonly status?: string
  readonly steps?: number
  readonly durationMs?: number
  /** approvals */
  readonly approvalType?: string
  readonly decision?: string
  /** Which policy rule decided, for auto-decisions. */
  readonly rule?: string
  /**
   * library/write — writing into another program's configuration is the most
   * destructive thing this app does, so each op names what it did, to what,
   * where, and where the replaced content was filed.
   */
  readonly op?: string
  readonly name?: string
  readonly path?: string
  readonly backupPath?: string
  /** Why a library write failed, when it did. */
  readonly detail?: string
}

const STEP_TYPES = new Set(['command', 'fileChange', 'toolCall', 'webSearch'])

export class AuditLog {
  readonly #path: string
  #writes: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.#path = path
  }

  /** Extracts what is worth keeping from an event stream; most events are not. */
  record(runtime: RuntimeId, event: AgentEvent, cwdOf: (sessionId: string) => string | undefined): void {
    let entry: AuditEntry | null = null
    if (event.type === 'session/started') {
      entry = {
        at: Date.now(),
        runtime,
        sessionId: String(event.session.id),
        cwd: event.session.cwd,
        kind: 'session/started',
      }
    } else if (event.type === 'turn/completed') {
      entry = {
        at: Date.now(),
        runtime,
        sessionId: String(event.sessionId),
        ...(cwdOf(String(event.sessionId)) ? { cwd: cwdOf(String(event.sessionId)) } : {}),
        kind: 'turn/completed',
        status: event.turn.status,
        steps: event.turn.items.filter((item) => STEP_TYPES.has(item.type)).length,
        ...(event.turn.durationMs ? { durationMs: event.turn.durationMs } : {}),
      }
    } else if (event.type === 'approval/resolved') {
      entry = {
        at: Date.now(),
        runtime,
        sessionId: String(event.sessionId),
        ...(cwdOf(String(event.sessionId)) ? { cwd: cwdOf(String(event.sessionId)) } : {}),
        kind: 'approval/decided',
        decision:
          event.resolution.outcome === 'decided'
            ? event.resolution.decision.type === 'option'
              ? event.resolution.decision.optionId
              : event.resolution.decision.type
            : event.resolution.outcome,
      }
    }
    if (entry) this.append(entry)
  }

  append(entry: AuditEntry): void {
    // Serialised writes: an audit log with interleaved half-lines answers nothing.
    this.#writes = this.#writes
      .then(async () => {
        await mkdir(dirname(this.#path), { recursive: true })
        await appendFile(this.#path, `${JSON.stringify(entry)}\n`)
      })
      .catch(() => {})
  }

  /**
   * Resolves once every queued entry has hit disk. `append` returns before its
   * write lands — it is called from the event fan-out, which must not wait on
   * a disk — so without this the quit is only the *request* to stop writing:
   * the last approval of a session can still be appending after `dispose()`
   * has resolved. That costs the entries a diagnostics bundle taken straight
   * after a quit would otherwise be missing, and it costs a test the directory
   * it is trying to remove.
   */
  async flush(): Promise<void> {
    await this.#writes
  }

  /** Entries under `root` (all, when omitted) within the window, newest first. */
  async query(options: { root?: string; sinceDays?: number } = {}): Promise<AuditEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.#path, 'utf8')
    } catch {
      return []
    }
    const cutoff = Date.now() - (options.sinceDays ?? 7) * 24 * 60 * 60 * 1000
    const out: AuditEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      let entry: AuditEntry
      try {
        entry = JSON.parse(line) as AuditEntry
      } catch {
        continue
      }
      if (entry.at < cutoff) continue
      /* One containment test, shared with the plugin gate. Spelled out here as
         string arithmetic it was wrong twice over: `${root}/` doubles the
         separator when the caller passes a root that already ends in one, and
         a cwd is not compared after resolution, so `/repo/../etc` counted as
         inside `/repo`. */
      if (options.root) {
        if (entry.cwd === undefined) continue
        if (!pathWithin(options.root, entry.cwd)) continue
      }
      out.push(entry)
    }
    return out.reverse()
  }
}
