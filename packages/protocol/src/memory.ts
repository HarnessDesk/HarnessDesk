import type { GoalCitation, GoalId, GoalReceipt } from './goal.js'
import type { Sha, SeatRecord } from './evidence.js'

/**
 * Project memory: an ordinary committed Markdown file a person cites into a
 * Goal, retained exactly as it read at that moment so a later Goal can still
 * open it after the source Goal — or its Git history — is gone.
 *
 * A citation is a person-carried reference, never a second message bus: the
 * text is a claim, not a new fact, and none of this grants a tool, moves an
 * evidence column, or lets deleted history authorize new dispatch. See
 * `docs/superpowers/plans/2026-09-19-agents-memory.md` (phase 12) for the
 * decisions this shape answers to.
 */

/** The exact bytes a citation retained, plus the historical context around them at the moment they were captured. */
export interface MemorySnapshot {
  readonly version: 1
  readonly citation: GoalCitation
  readonly text: string
  readonly receipt: GoalReceipt
  readonly seats: readonly SeatRecord[]
  readonly capturedAt: number
  /** Seat ids the receipt named that `SeatBook` no longer has. An explicit gap, never a fabricated record. */
  readonly missingSeatIds: readonly string[]
}

/**
 * What opening a citation answers. `retained` is the ordinary, expected
 * case; `unavailable` means nothing was ever retained for it — including
 * every citation made before this feature existed.
 */
export type MemoryResolution =
  | {
      readonly state: 'retained'
      readonly snapshot: MemorySnapshot
      /** Whether the source Goal still exists with this exact receipt. */
      readonly sourceAvailable: boolean
      /** Whether the cited commit can still be read from the project. */
      readonly revisionAvailable: boolean
      /**
       * True when this snapshot's own authenticity was never verified by a
       * live `capture` in this install — restored from a backup, most of
       * all. History, never authority: a restored snapshot cannot satisfy a
       * missing citation-created dependency.
       */
      readonly restored: boolean
    }
  | { readonly state: 'unavailable'; readonly citation: GoalCitation; readonly reason: string }

/** One committed memory file, as `MemoryPlane.list` finds it — never its contents. */
export interface MemoryFile {
  readonly path: string
  readonly at: Sha
  readonly problem: string | null
}

/**
 * The optional, version-1 Goal document field this phase adds beside the
 * existing `citations` array. Missing means legacy, not corrupted.
 */
export interface GoalMemoryIndex {
  readonly citations: readonly { readonly citation: GoalCitation; readonly archive: string }[]
  /**
   * Which of this Goal's `dependsOn` edges a citation created, and which
   * source receipt makes that one edge satisfiable by retained history alone
   * once the source Goal is gone. An edge a person set directly is never
   * listed here, and its absence from the store never becomes satisfied
   * merely because another edge cites the same Goal.
   */
  readonly satisfiedCitationSources: readonly { readonly goal: GoalId; readonly receipt: string }[]
}
