import type { RuntimeId, SessionKey } from './ids.js'

/**
 * Agents working together: the board and the channel.
 *
 * One board per workspace, owned by the host. The board is *state* —
 * intents, claims, file ownership, context packages — and claiming is a
 * transaction in the one process that owns every session, never a lock file
 * agents race over. The channel is *prose* — messages between conversations,
 * and the user's own posts — with the board's signals folded into the same
 * stream, because "what happened while I was away" is one question.
 *
 * The vocabulary is [swarm-protocol](https://github.com/phuryn/swarm-protocol)'s
 * — intent, claim, signal, context package — so an agent briefed for that
 * server works here unmodified. See docs/multi-agent.md.
 */

/**
 * The longest a channel message may be, in characters.
 *
 * The host is the referee — `Team` refuses anything longer and says so — but
 * the number lives here because the composer has to count *before* the send.
 * A person who pastes a review and learns the limit from a refused row has
 * already lost the paste; the countdown in the box is the same fact, in time
 * to act on. Settings may raise or lower it per install (`messageChars`), and
 * a surface that can read that setting should prefer it to this default.
 */
export const TEAM_MESSAGE_CHARS = 16_000

// ------------------------------------------------------------------ the board

export type IntentState = 'open' | 'claimed' | 'blocked' | 'done' | 'abandoned'

/**
 * One goal, and the work it turned into.
 *
 * A Room is permanent and a goal is not, and without something between them a
 * board is a pile: every job anybody ever added, with no boundary and nothing
 * that can ever be finished. "Wrap up" needs an object to wrap.
 *
 * Deliberately thin. A plan is a heading and a lifecycle, not a second kind of
 * board — the jobs are the same jobs, and one that belongs to no plan is
 * ordinary work somebody added directly. That is the common case and must stay
 * cheap.
 */
export interface Plan {
  readonly id: number
  /** What this is for, in the person's words. */
  readonly goal: string
  /** `wrapped` is finished and put away; its jobs stay for the record. */
  readonly state: 'running' | 'wrapped'
  readonly createdAt: number
  readonly wrappedAt?: number | null
}

/** Which conversation holds an intent, and since when. */
export interface IntentClaim {
  readonly runtime: RuntimeId
  readonly sessionId: string
  readonly at: number
  /**
   * When this claim stops being believed, unless its holder renews it.
   *
   * A claim is a *lease*, not a lock, because the thing holding it is a
   * process on somebody's laptop: it crashes, loses the network, runs out of
   * quota, or is closed with work half done. A permanent lock in that world
   * turns one crash into an intent nobody can ever take again, and the board's
   * whole promise — that work has exactly one owner — quietly becomes "work
   * has at most one owner, forever".
   *
   * Renewed whenever the holder is heard from: any board verb, and the end of
   * any turn. Absent on a claim written before leases existed, which is read
   * as "no lease" rather than "expired" — an old board must not strand every
   * claim on it the moment this ships.
   */
  readonly leaseUntil?: number
}

/**
 * One piece of shared work.
 *
 * `files` is what makes parallel edits safe without a merge queue: claiming
 * an intent claims its paths, and the board refuses a claim whose paths
 * overlap a live one. `handoff` is the context package the finisher left —
 * the actual contract, not "the file changed" — read by whoever works the
 * intents that depended on this one.
 */
export interface Intent {
  /** Small and human: agents type these back (`claim_work(3)`). */
  readonly id: number
  readonly title: string
  readonly detail?: string | null
  readonly state: IntentState
  /** Path patterns this intent owns while claimed, e.g. `src/api/**`. */
  readonly files: readonly string[]
  readonly dependsOn: readonly number[]
  readonly claim?: IntentClaim | null
  /** Why it is blocked, when someone said so rather than a dependency. */
  readonly blockedReason?: string | null
  /**
   * Who decided it was blocked. `graph` means unfinished dependencies, and
   * finishing them reopens it; `hand` means a person or an agent said so,
   * and only a person or an agent unsays it — a completed dependency must
   * never silently reopen work someone deliberately stopped.
   */
  readonly blockedBy?: 'graph' | 'hand' | null
  /** The context package left by `complete_claim`. */
  readonly handoff?: string | null
  /** The one-line completion note the next agent will read. */
  readonly note?: string | null
  /** The goal this belongs to, when it came from one. */
  readonly plan?: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

// ---------------------------------------------------------------- the channel

/** Who wrote a channel entry. The user's posts carry authority; agents' never do. */
export type TeamActor =
  | { readonly kind: 'user' }
  | {
      readonly kind: 'agent'
      readonly runtime: RuntimeId
      readonly sessionId: string
      /** The conversation's name at the time, kept so the row still reads after it closes. */
      readonly title: string
      /**
       * What it was called *in the room* when it said this.
       *
       * Recorded for the same reason `title` is: the row has to still read
       * after the member has gone. It is what the reader sees, because a title
       * is often absent — a channel of three untitled Cursor conversations
       * showed three rows all saying "Cursor", which is a transcript nobody can
       * reconstruct a conversation from. Absent on rows written before rooms
       * had names.
       */
      readonly nickname?: string
    }

/**
 * What happened to a message. Nothing is dropped silently: a message that
 * silently did not land is the failure this surface exists to prevent.
 */
export type TeamDelivery =
  /** In the receiver's context now. */
  | 'delivered'
  /** Waiting for the receiver's turn to end. */
  | 'queued'
  /** The receiver holds inbound messages; the user releases each one. */
  | 'held'
  /** Not sent, and the sender was told why. */
  | 'refused'
  /**
   * In the room, and nowhere else.
   *
   * The answer a conversation gave after a message woke it, shown so the
   * exchange can be read, and deliberately never transmitted: sending it back
   * would wake the sender, whose answer would wake the receiver, and a desk
   * where two agents talk to each other forever while spending the user's
   * tokens is the failure mode this whole feature is designed against first.
   * So a reply is *shown*, not *sent*.
   */
  | 'shown'

export interface TeamMessage {
  readonly id: string
  readonly at: number
  readonly kind: 'message'
  readonly from: TeamActor
  /** Absent on a post to everyone on the board. */
  readonly to?: {
    readonly runtime: RuntimeId
    readonly sessionId: string
    readonly title: string
    /** What the recipient was called in the room. Absent on older rows. */
    readonly nickname?: string
  } | null
  readonly text: string
  readonly state: TeamDelivery
  readonly reason?: string | null
  /** The exact envelope the receiver saw — trust comes from being able to check it, once. */
  readonly envelope?: string | null
  /**
   * The hand-out this row belongs to, when it was one of many made from one
   * template in one action. Every recipient keeps its own row — its own
   * words, its own delivery state — and the channel draws the batch once.
   */
  readonly batch?: {
    readonly id: string
    readonly size: number
    readonly template: string
  } | null
}

export type TeamSignalKind =
  | 'added'
  | 'claimed'
  | 'released'
  | 'blocked'
  | 'unblocked'
  | 'completed'
  | 'abandoned'
  | 'reopened'
  | 'conflict'

/** A board event in the stream: a claim taken, a conflict refused, work done. */
export interface TeamSignal {
  readonly id: string
  readonly at: number
  readonly kind: 'signal'
  readonly by: TeamActor
  readonly signal: TeamSignalKind
  readonly intent: number
  /** The intent's title at the time, so the row reads without a lookup. */
  readonly title: string
  readonly detail?: string | null
}

/**
 * Why a member stopped, in the vocabulary the interface styles on.
 *
 * `limit` is a usage window or a credit balance the agent ran out of —
 * the one that arrives mid-work and is nobody's mistake. `auth` is a sign-in
 * that lapsed. `stopped` is every other turn that ended without answering,
 * including one a person interrupted.
 */
/**
 * Why the room is narrating rather than somebody speaking.
 *
 * `gone` is the one that is not about a turn: the member's conversation no
 * longer exists in its agent's own history, so it has been taken out of the
 * room. It earns a cause of its own because it is the only one that *changes
 * the roster*, and a room that quietly loses a member owes the channel a line
 * saying so.
 */
export type TeamNoticeCause = 'limit' | 'auth' | 'stopped' | 'gone'

/**
 * Something that happened *to* a member, which the room has to be told.
 *
 * A message is what somebody said and a signal is what somebody did on the
 * board. A turn that died — the agent's five-hour window ran out halfway
 * through a review — is neither, and before this existed it was *nothing*:
 * the member went quiet, the answer it owed the room was written off in
 * silence, and the only record was inside that one conversation's transcript.
 * A room exists so that you can see what everyone is doing; a member that
 * stopped is exactly the thing it must not omit.
 *
 * Deliberately not a message with a new delivery state: delivery is about
 * whether words arrived, and these words are the *host's*, about a member.
 * That difference is load-bearing — a notice is never gated by the
 * "answers in the room" setting, because it is not an answer.
 */
export interface TeamNotice {
  readonly id: string
  readonly at: number
  readonly kind: 'notice'
  /** Who it happened to. */
  readonly about: TeamActor
  readonly cause: TeamNoticeCause
  /** The runtime's own words for it, never the host's paraphrase. */
  readonly text: string
  /** The channel row this member had been asked, when it stopped owing one. */
  readonly answering?: string | null
}

export type TeamEntry = TeamMessage | TeamSignal | TeamNotice

// ------------------------------------------------------------------ the state

/** Per-conversation inbound control, mirroring Claude Code's `crossSessionInbound`. */
export type TeamInbound = 'accept' | 'hold' | 'refuse'

/**
 * Everything one workspace's team surface renders, pushed whole on every
 * change — the `session/options` convention, because one claim moving
 * changes what every other row means.
 */
export interface TeamState {
  /** The room's own id — what every verb addresses it by. */
  readonly id: string
  /** What a person calls it, chosen when the room was made. */
  readonly name: string
  /**
   * The conversations in it, keyed `runtime\u0000sessionId`.
   *
   * A project holds as many rooms as the work wants and each has a board of
   * its own, so membership is explicit: a room reaches its own members and
   * nothing else. A conversation in no room has no board, which is the
   * ordinary case for one working alone.
   */
  readonly members: readonly SessionKey[]
  /** The project the room belongs to. */
  readonly root: string
  readonly intents: readonly Intent[]
  readonly channel: readonly TeamEntry[]
  /** False is board-only mode: agents may claim and signal, but not message. */
  readonly messaging: boolean
  /**
   * What each member is called here, keyed `runtime\u0000sessionId`.
   *
   * Travels with the board because the board is where a member is *named* —
   * a card's holder, a claim's owner, a signal's actor. Without it every
   * board-derived surface has to fetch the roster to say who somebody is, and
   * a card drawn before that answer arrives says "(untitled)" instead, which
   * is the whole problem the nickname was introduced to solve.
   */
  readonly nicknames?: Readonly<Record<string, string>>
  /**
   * What each member does with a message sent to it, keyed like `members`:
   * its own mode, or the default when it was never given one. The same answer
   * `team/peers` gives as `inbound`.
   *
   * Travels with the board so that every view of the room is told when it
   * changes. The roster is a pull, and a mode set in one pane was drawn as the
   * old one in every other pane, window and client until something unrelated
   * made it ask again.
   */
  readonly inbound?: Readonly<Record<string, TeamInbound>>
  /** The goals on this board, newest last. */
  readonly plans?: readonly Plan[]
  /**
   * The board could not be saved (or a stored board could not be read), in a
   * sentence. Non-null means what is on screen is ahead of what is on disk —
   * shown, because a board that silently forgets an acknowledged claim is
   * the exact failure this surface exists to prevent.
   */
  readonly problem?: string | null
}

/**
 * One live conversation on a board, as the host attests it — the recipient
 * roster the Team panel offers. Renderer-side guesses from `cwd` prefixes
 * get worktrees wrong; this list comes from the same resolution the router
 * uses, so what the picker shows is exactly what a post can reach.
 */
export interface TeamPeerInfo {
  readonly runtime: RuntimeId
  readonly sessionId: string
  readonly title: string | null
  /** The agent's presentation name — `Codex`, `Claude Code`. */
  readonly agent: string
  readonly busy: boolean
  /**
   * What this member is called *in this room*, and how it is addressed.
   *
   * Unique on its board, assigned when the member first appears, and editable.
   * It exists because nothing else on a peer is reliably distinct: three Cursor
   * conversations on three models arrive untitled and identical, which makes
   * them not merely indistinguishable in the roster but **unaddressable** —
   * every one of them matches the agent's own name, so `message` refuses with
   * "matches 3 conversations, name one exactly" and there is no exact name to
   * give. A nickname is the name that always exists.
   *
   * The default is derived from the model rather than random, because this is
   * the string an agent has to type back. `Opus`, `Gemini`, `Codex`; a second
   * of the same becomes `Opus 2`.
   */
  readonly nickname: string
  /** What it is running, when the runtime reports one — the default name's source. */
  readonly model?: string | null
  /**
   * Whether this member has been *seen* calling a team verb, this run.
   *
   * Distinct from its runtime advertising plugin tools, which is a claim the
   * agent makes about itself. One that advertised them, listed them back
   * accurately, and could not invoke a single one is the reason this exists:
   * the surface built to flag exactly that member read the claim and believed
   * it. Absent means not yet observed, not "cannot" — a member that has done
   * nothing has proved nothing either way.
   */
  readonly usedBoard?: boolean
  /**
   * Whether the desk has this conversation **open** right now.
   *
   * Membership and presence are different facts, and the roster carries both.
   * A member is in the room because somebody put it there, and it stays a
   * member across a quit and a relaunch, across its agent restarting, and
   * across the conversation simply not being open — none of which is anybody
   * leaving. Presence is whether there is a live handle on it this minute.
   *
   * Drawing only the present ones made every room read as empty on the first
   * launch of the day: the board still listed its members, the sidebar still
   * drew them under the room, and the room's own rail said "Nobody here yet"
   * beside a channel full of what they had said. A message to a member that
   * is not here reopens its conversation and lands — resuming costs nothing,
   * it replays what the agent already stored — so being away is a thing to
   * say on the row, never a reason to leave it out.
   */
  readonly here: boolean
  /**
   * What this member does with a message addressed to it: take it, keep it
   * until somebody releases it, or turn it away.
   *
   * A room-wide switch already exists — board-only stops every message from
   * every member — and the setting underneath it has always been
   * per-conversation, defaulting to the board's own. It was reachable only
   * from the wire: a room could hold one member that must not be interrupted
   * mid-refactor and nine that may, and saying so meant stopping the whole
   * room. Reported here so the roster can both show the state and change it.
   */
  readonly inbound: TeamInbound
}
