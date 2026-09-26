import type { UsageRow } from './store.js'

/**
 * A ledger source that lives on a server rather than in a file this machine
 * already has — Cursor's usage events today, and the shape any later one
 * would take. Vendor knowledge (auth, endpoint, field names) stays in
 * `packages/server/src/usage/`; this file only says what the ledger needs
 * back to fold it in.
 */
export interface RemoteEventsSource {
  /** The runtime these rows are filed under. */
  readonly runtime: string
  /**
   * The row key this source's *account* resolves to right now, or `null`
   * when it cannot — signed out, or the local credential is unreadable.
   * Local and cheap: no network call, so a scan can check every remote
   * source before deciding whether any of them are due.
   */
  resolveFile(): Promise<string | null>
  /**
   * Fetches replacement rows for the half-open window `[from, to)`, keyed
   * under `file` — the caller's own `resolveFile()` read, passed in rather
   * than re-derived, so the store's delete and this batch's insert always
   * agree on the key even if the account changed mid-scan. `null` fails
   * closed — a short read, a paging cap, or an envelope the source cannot
   * make sense of — and the rows already stored for this window are left
   * exactly as they were rather than replaced with a partial reading.
   */
  sync(range: { readonly from: number; readonly to: number }, file: string): Promise<{ readonly rows: readonly UsageRow[] } | null>
}
