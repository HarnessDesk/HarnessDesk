import type { AgentId, AgentOrigin, SeatCandidate } from './agent.js'
import type { FlowPermission, FlowSeat } from './flow.js'

/**
 * The evidence ledger's nouns: what the desk observed, bound to the revision
 * it was true at, and the immutable record of every Seat.
 *
 * Written by the host alone, from something it did — a command it ran, a pull
 * request it read, a diff it computed — never from text an agent typed. Kept
 * under `~/.harnessdesk/evidence/`, one store per project, append-only, and
 * never in the repository. The code calls it `evidence`: `ledger` is the usage
 * ledger's word (`packages/server/src/ledger/`).
 *
 * Every type a record is written in lives here, and each is durable: a record
 * written today is read by every later build. So a field is added nullable and
 * never removed, and a union gains members but never loses one.
 */

/** A commit's full object name: 40 hex characters, or 64 in a SHA-256 repository. */
export type Sha = string

/** A Seat's id: minted by the host once, when a seat is kept, and never reused. */
export type SeatId = string

// ------------------------------------------------------------- the Seat record

/**
 * The ladder a ceiling is written in, narrowest first. Phase 3 reads it from an
 * Agent's `ceiling:`; this phase only records it.
 */
export type CeilingLevel = 'read' | 'edit' | 'publish' | 'merge'

/** A ceiling as one seat ran under it. */
export interface SeatCeiling {
  readonly level: CeilingLevel
  /** `held`: the runtime enforced it. `asked`: it was only asked of the agent. */
  readonly hold: 'held' | 'asked'
}

/**
 * What an Agent's standing order said it may do, in the words of that order's
 * generation — never translated into the other's. Phases 1 and 2 write a
 * `permission:`; phase 3's Agents write a `ceiling:`, and an Agent may carry
 * only that. A record keeps whichever its order said, as it said it, beside
 * the ceiling the seat actually ran under — so neither generation has to
 * invent the other's word, and a reader always knows which it is reading.
 */
export type StandingOrder =
  | { readonly kind: 'permission'; readonly permission: FlowPermission }
  | { readonly kind: 'ceiling'; readonly level: CeilingLevel }

/** When a backup brought a record here, rather than this desk writing it. */
export interface Restored {
  readonly at: number
}

/** The conversation that holds a Seat's prompts and tool calls: a pointer, never a copy. */
export interface SessionPointer {
  readonly runtime: string
  readonly sessionId: string
}

/** Where a Seat worked, as the desk read it when the seat was kept. */
export interface SeatCheckout {
  /** The folder the conversation works in, absolute. */
  readonly cwd: string
  /** The project that folder belongs to: its repository's main checkout, or the folder itself outside one. */
  readonly project: string
  /** The branch checked out then; null on a detached HEAD or outside a repository. */
  readonly branch: string | null
  /** The commit checked out then; null outside a repository or before its first commit. */
  readonly head: Sha | null
}

/** How and when the desk let a Seat go. */
export interface SeatClosed {
  readonly at: number
  /**
   * Why, in one word. This phase writes `deleted` — the conversation was
   * deleted. Later phases add their own (`released`, `wrapped`); a reader that
   * does not know a word still knows the seat is closed.
   */
  readonly why: string
}

/**
 * One Seat, as it was: an Agent (or, for a flow's role, a runtime) working in
 * one checkout on one seat, and the conversation it worked in.
 *
 * Immutable. The opening is written once, when the seat is kept; the closing is
 * a second record written once, when the desk lets it go, and `closed` is read
 * from it. It outlives the conversation it points at and the room it worked in,
 * because *why does this line look like this* is asked long after both are
 * gone.
 */
export interface SeatRecord {
  readonly id: SeatId
  /**
   * The Agent it was seated as, as it was named then; null for a seat a flow
   * opened on a runtime, which is no Agent yet (phase 6 seats Agents in flows).
   */
  readonly agent: { readonly id: AgentId; readonly name: string; readonly origin: AgentOrigin } | null
  /** The content hash of the brief it was handed (`AgentEntry.digest`); null when there was no Agent. */
  readonly briefDigest: string | null
  /** The seat it resolved to, as written: runtime, model, effort. */
  readonly seat: FlowSeat
  /** What it runs, read back when it was kept, in the desk's words: runtime · model · effort. */
  readonly seatLabel: string
  /** Every candidate passed over on the way to this one, as the refusal sheet shows them. */
  readonly passedOver: readonly SeatCandidate[]
  /** What its standing order said it may do, as the order said it: today's `permission:`, or phase 3's `ceiling:`. */
  readonly standing: StandingOrder
  /** The ceiling this seat actually ran under, and whether the runtime held it or it was only asked of the agent. Null until phase 3. */
  readonly ceiling: SeatCeiling | null
  readonly checkout: SeatCheckout
  readonly session: SessionPointer
  /** The board it was seated to work on — a room's id, which phase 5 keeps as its Goal's; null for a conversation seated on its own. */
  readonly board: string | null
  /** The role it holds on that board, when a flow seated it. */
  readonly role: string | null
  readonly openedAt: number
  /** Null while the seat is open. */
  readonly closed: SeatClosed | null
  /**
   * Set when a backup brought this record here; absent or null for a Seat this
   * desk kept. A restored Seat is history — drawn, and carried by the next
   * backup — and never says which Agent a conversation on this desk is.
   */
  readonly restored?: Restored | null
}

// ------------------------------------------------------------------ evidence

/** One check a forge ran on a revision, as it reported it. */
export interface CheckRun {
  readonly name: string
  readonly state: 'pending' | 'passed' | 'failed' | 'skipped' | 'cancelled'
  readonly url: string | null
}

/**
 * A fact the desk observed, bound to the revision it was true at.
 *
 * This phase produces `check`, `diff`, `pr` and `ci`; `review`, `finding` and
 * `spend` are the spec's, written by later phases, and are here so that no
 * record a later phase writes needs this type changed.
 */
export type Evidence =
  | {
      readonly kind: 'check'
      /** The check's name, and its command as it ran: a renamed check can never pass for the old one. */
      readonly name: string
      readonly run: string
      /** Its exit status; null when it did not exit by itself — it ran over its time, or never started. */
      readonly exit: number | null
      readonly timedOut: boolean
      readonly at: Sha
      /** True when the checkout held changes not committed: the result is about no commit at all. */
      readonly dirty: boolean
      /** The last of what it printed, so a failure can say why. At most 4,000 characters. */
      readonly tail: string
    }
  | { readonly kind: 'ci'; readonly checks: readonly CheckRun[]; readonly at: Sha }
  | {
      readonly kind: 'review'
      readonly verdict: string
      readonly by: SeatId
      readonly at: Sha
      /** What it was judged against — a requirement's revision, a base. */
      readonly against?: readonly Sha[]
    }
  | {
      readonly kind: 'pr'
      readonly number: number
      readonly head: Sha
      readonly state: 'open' | 'merged' | 'closed'
      readonly url: string | null
    }
  | {
      readonly kind: 'diff'
      readonly files: number
      readonly added: number
      readonly removed: number
      readonly from: Sha
      readonly to: Sha
    }
  | { readonly kind: 'finding'; readonly id: string; readonly state: 'open' | 'repaired' | 'withdrawn'; readonly at: Sha }
  | {
      readonly kind: 'spend'
      readonly usd: number
      readonly turns: number
      /** False when a count is a stream floor rather than a settled total. */
      readonly exact: boolean
    }

/** A card on a board: the board's id — a room's, which phase 5 keeps as its Goal's — and the card's number on it. */
export interface CardRef {
  readonly board: string
  readonly id: number
}

/** Where a fact was observed, so its staleness is read against the branch it was about. */
export interface EvidenceCheckout {
  readonly cwd: string
  /** Null when HEAD was detached: then HEAD itself is what later commits are counted on. */
  readonly branch: string | null
}

export interface EvidenceRecord {
  /** Minted by the host when the record is written; how a restore knows it already has one. */
  readonly id: string
  readonly fact: Evidence
  /** The card it was observed for; absent for a fact about no card. */
  readonly card?: CardRef | null
  readonly checkout?: EvidenceCheckout | null
  /** The Seat that produced it; absent when the desk observed it unattended. */
  readonly seat?: SeatId | null
  /** The round it belongs to. Evidence publishes when its ROUND closes. */
  readonly round?: number | null
  readonly observedAt: number
  /** Where it was published, so a reply threads under it and a re-review sees the thread. */
  readonly posted?: { readonly pr: number; readonly comment: number } | null
  /**
   * Set when a backup brought this fact here; absent or null for one this desk
   * observed. A restored fact is history: it stands as unknown until the desk
   * observes the same question again, and it never puts a card in *Ready*.
   */
  readonly restored?: Restored | null
}
// ----------------------------------------------------------- what is drawn

/**
 * How a fact stands against where its branch is now.
 *
 * Only a current fact is a verdict: `fresh`, or `final` — which only a merged
 * pull request whose branch is gone can be. `behind`, `moved` and
 * `uncommitted` are stale — drawn, never silently green — and `unknown` is not
 * zero: it says why the desk cannot tell. A fact a backup brought is `unknown`
 * until this desk observes the same question itself.
 */
export type Freshness =
  | { readonly state: 'fresh' }
  /** Its revision is on the branch, and this many commits have landed since. */
  | { readonly state: 'behind'; readonly commits: number }
  /** Its revision is no longer on the branch: rewritten by an amend or a rebase. */
  | { readonly state: 'moved' }
  /** It ran on changes that were never committed. */
  | { readonly state: 'uncommitted' }
  /**
   * The last word on a branch that is gone: a pull request that was merged, and
   * its branch deleted after. Nothing can land on it now, so it stands as it is.
   * Only a merged pull request is ever final.
   */
  | { readonly state: 'final' }
  | { readonly state: 'unknown'; readonly why: string }

/** A named check, as `.harnessdesk/checks.yml` declares it. */
export interface NamedCheck {
  readonly name: string
  /** The command, exactly as it will run: printable ASCII and line breaks only. */
  readonly run: string
  /** Seconds before it is stopped. */
  readonly timeout: number
}
