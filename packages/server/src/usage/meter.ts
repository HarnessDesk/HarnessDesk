import type { UsageCredits, UsageLane, UsageSource } from '@harnessdesk/protocol'

/**
 * A source that can say what one account has left.
 *
 * Vendor knowledge lives here, in the host, and nowhere above it: the renderer
 * reads `UsageReport`s and has no idea whether a figure came from an API, a
 * file another application wrote, or a bridge. Design:
 * `docs/usage-dashboard.md`.
 */

export interface MeterReading {
  /** Which account, when the source names one. */
  readonly account: string | null
  readonly plan: string | null
  readonly lanes: readonly UsageLane[]
  readonly credits: UsageCredits | null
  /** Set only when a limit has actually been hit. */
  readonly reached: string | null
  /**
   * When the *source* obtained these numbers — not when we read them. A cache
   * another application wrote an hour ago is an hour old however fresh our
   * read of it is, and saying otherwise is the one lie a freshness line can tell.
   */
  readonly fetchedAt: number
  readonly staleAfterMs: number
}

export interface UsageMeter {
  /** Stable id, referenced from the agent registry. */
  readonly id: string
  /** Named in the card footer, in words: "from its own cache". */
  readonly source: UsageSource
  /**
   * Null when this meter has nothing to say — the file is absent, the agent is
   * signed out. Null is not an error and produces no card content of its own.
   */
  read(): Promise<MeterReading | null>
  /** Files whose change means a re-read. Watched instead of polled. */
  watchPaths(): readonly string[]
}

const HOUR = 3_600_000

/** Everything a meter needs to turn a percentage into a lane. */
export const lane = (
  input: Omit<UsageLane, 'label'> & { readonly label?: string },
): UsageLane => ({
  label: input.label ?? input.id,
  ...input,
})

/** Window lengths for the lane kinds every plan seems to share. */
export const WINDOW_MINUTES = {
  session: 5 * 60,
  daily: 24 * 60,
  weekly: 7 * 24 * 60,
  monthly: 30 * 24 * 60,
} as const

export const DEFAULT_STALE_AFTER_MS = HOUR
