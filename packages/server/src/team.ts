import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  AGENT_MESSAGE_NOTICE,
  agentMessageSource,
  sessionKey,
  splitSessionKey,
  TEAM_MESSAGE_CHARS,
  wrapContext,
  type Intent,
  type Plan,
  type IntentState,
  type RuntimeId,
  type SessionKey,
  type TeamActor,
  type TeamEntry,
  type TeamInbound,
  type TeamMessage,
  type TeamPeerInfo,
  type TeamNotice,
  type TeamNoticeCause,
  type TeamSignalKind,
  type TeamState,
} from '@harnessdesk/protocol'

/**
 * The team plane: one board and one channel per workspace, host-owned.
 *
 * The board is shared work — intents, claims, file ownership, context
 * packages — and claiming is a transaction here, in the one process that
 * owns every session, never a lock file agents race over. The channel is
 * the messages: routed here so one set of guards applies whichever vendor's
 * agent is sending, and recorded here so the user can always read the
 * traffic and always stop it.
 *
 * Everything an agent does arrives through `TeamEngine` verbs carrying the
 * scope its tool call carried; everything the person does arrives through
 * the `team/*` wire methods. Both mutate the same state, and every mutation
 * is pushed whole to every window.
 *
 * The vocabulary is swarm-protocol's — intent, claim, signal, context
 * package — per docs/multi-agent.md §2b: an agent briefed for that server
 * should work here unmodified.
 *
 * Delivery discipline, learned from review rather than luck: a channel row
 * says `delivered` only after the runtime accepted the text; a failed send
 * is `refused` with the error and does not poison the loop guards, so a
 * retry after a transient failure is allowed; a queued or held row is never
 * trimmed away and never lost silently — a restart, a closed session, or a
 * policy change turns it into a state with a reason instead.
 */

// -------------------------------------------------------------------- guards

/**
 * The loop-safety constants. A desk where two agents talk to each other
 * forever while spending the user's tokens is the failure mode this feature
 * is designed against first; every one of these is a lesson Claude Code's
 * cross-session messaging already learned.
 */
const MESSAGE_CHAR_LIMIT = TEAM_MESSAGE_CHARS
/** Sends allowed per sender→receiver pair inside the window. */
const RATE_LIMIT = 4
const RATE_WINDOW_MS = 60_000
/** An identical text repeated inside this window is a loop, not a message. */
const REPEAT_WINDOW_MS = 10 * 60_000
/** Messages waiting on one receiver's turn to end. */
const PENDING_LIMIT = 8
/**
 * Channel entries kept per room, at least. The oldest *settled* rows fall
 * off; a queued or held message is a pending delivery, and trimming one
 * would destroy a message the user was told is waiting.
 *
 * At least, because a fixed two hundred was sized for a room of three. A
 * room of 138, each member handed its page, wrote 138 posts, 138 claims,
 * 138 completions and 138 replies inside four minutes — and the channel had
 * forgotten every assignment before the first answers came back. The floor
 * stays; a bigger room keeps a few rows per member on top of it.
 */
const CHANNEL_LIMIT = 200
const CHANNEL_PER_MEMBER = 6
/** And no more than this, whatever the room's size: a board file is rewritten on every change. */
const CHANNEL_CEILING = 5000
/** Intents kept per board, at least; beyond it the oldest done/abandoned rows fall off. */
const INTENT_LIMIT = 200
const INTENTS_PER_MEMBER = 4
const INTENT_CEILING = 2000
/**
 * How long app launch will wait for stored roots to be re-resolved. The
 * resolver shells out to git, and this is on the path `Host.start()` awaits;
 * whatever has not answered in this long keeps its recorded root and is
 * migrated at the next launch, which is safe because the pass is idempotent.
 * Sized at what the room resolver used to cap a single `rev-parse` at, so
 * launch never spends more on this than one probe already cost.
 */
const MIGRATION_BUDGET_MS = 4000

/**
 * How many rows a room keeps: a floor for a small room, a few per member
 * for a big one, and a ceiling so the size of the file rewritten on every
 * change has a bound. In the open so the formula can be pinned directly.
 */
export const roomCap = (members: number, floor: number, perMember: number, ceiling: number): number =>
  Math.min(ceiling, Math.max(floor, members * perMember))

// --------------------------------------------------------------------- state

/** What one workspace's file holds. Mutable working copy; `TeamState` is its projection. */
interface Board {
  /** Stable, and the key everything reaches this room by. */
  readonly id: string
  /** What a person calls it. Chosen when the room is made. */
  name: string
  /**
   * The conversations in this room, keyed `runtime\u0000sessionId`.
   *
   * Explicit, because a project can hold several rooms and each has its own
   * board: two rooms sharing one would referee each other's claims, and a
   * member of one would read the other's channel. A room reaches its own
   * members and nothing else. A conversation in no room has no board — it is
   * a solo session, which is most of them.
   */
  members: SessionKey[]
  readonly root: string
  nextIntent: number
  nextPlan: number
  plans: Plan[]
  messaging: boolean
  intents: Intent[]
  channel: TeamEntry[]
  /** What each member is called here, keyed by `runtime\u0000sessionId`. */
  nicknames: Record<string, string>
  /**
   * What role each member holds here, keyed the same way.
   *
   * Empty on every room without a flow, which is every room that exists
   * today: a member with no role can claim anything a card with no role
   * offers, and that is the whole of the old behaviour.
   */
  roles: Record<string, string>
  /**
   * What the room knows about each member, keyed the same way.
   *
   * Membership is persisted; the conversations themselves are not this
   * module's to keep. So the room writes down the little it needs to *draw* a
   * member — its name, its agent, its folder, its model — and refreshes that
   * every time it sees the live conversation.
   *
   * Without it a relaunched desk had a list of keys and nothing to render:
   * the board still knew three conversations were in the room and could not
   * say which three, so the rail said "Nobody here yet" over a channel full
   * of what they had said. This is what makes a member survive the quit —
   * and it works with every agent down, which no lookup does.
   */
  roster: Record<string, RememberedMember>
}

/**
 * A member as the board remembers it, for when the conversation is not open.
 *
 * Deliberately only what the roster draws and what addressing needs. It is a
 * *photograph*, always outranked by the live conversation when there is one:
 * a title changed elsewhere is right again the moment the member is opened.
 */
export interface RememberedMember {
  readonly title: string | null
  /** The agent's presentation name — `Codex`, `Claude Code`. */
  readonly agent: string
  readonly cwd: string
  readonly model?: string | null
  /**
   * When these facts were last *written*, not when the member was last seen.
   *
   * `#remember` returns early when nothing has changed — a roster read
   * happens on every glance at a room, and dirtying the board file each time
   * would be a write per glance — so a member opened every day for a week
   * with the same title and model keeps the timestamp of the first sighting.
   * That is the honest reading of the field, and the only one it can support
   * without paying for a write nobody asked for.
   */
  readonly at: number
}

interface StoredBoard {
  readonly version: 1
  /** Absent on a board written before a project could hold more than one. */
  readonly id?: string
  readonly name?: string
  readonly root?: string
  readonly members?: readonly string[]
  readonly nextIntent: number
  /** Absent on a board written before goals had a name; read as none. */
  readonly nextPlan?: number
  readonly plans?: readonly Plan[]
  readonly messaging: boolean
  readonly intents: readonly Intent[]
  readonly channel: readonly TeamEntry[]
  /** Absent on a board written before rooms had names; rebuilt on sight. */
  readonly nicknames?: Readonly<Record<string, string>>
  /** Absent on a board written before roles existed; read as nobody holding one. */
  readonly roles?: Readonly<Record<string, string>>
  /**
   * Absent on a board written before a member had to survive the quit. Such a
   * board's members are drawn as soon as each is seen once — which is what
   * opening the room already does.
   */
  readonly roster?: Readonly<Record<string, RememberedMember>>
}

/** One live conversation, as the host describes it to this module. */
export interface TeamPeer {
  readonly runtime: RuntimeId
  readonly sessionId: string
  readonly title: string | null
  readonly cwd: string
  /** The agent's presentation name — `Codex`, `Claude Code` — for attribution. */
  readonly agent: string
  readonly busy: boolean
  readonly canSteer: boolean
  /** Messages the *user* has queued; theirs always outrank an agent's. */
  readonly queuedByUser: number
  /** What it is running. The room's default nickname is derived from this. */
  readonly model?: string | null
  /**
   * Whether the desk has this conversation open right now.
   *
   * Every peer the *host* hands over is here by construction — the host knows
   * about a conversation because it is holding one. The rooms synthesise the
   * other kind: a member of theirs that nobody has opened this run, drawn from
   * what the board remembers about it. See `Board.roster`.
   */
  readonly here: boolean
}

/**
 * What this module needs from the host, and nothing more. Sending is the
 * host's because the live handles are; everything else — the board, the
 * routing decision, the guards — is decided here and merely executed there.
 */
export interface TeamPort {
  /** Live conversations, whichever workspace. Reachability is liveness. */
  peers(): readonly TeamPeer[]
  /** The workspace a session's folder belongs to; null when none is open. */
  rootOf(cwd: string): Promise<string | null>
  /** Starts a turn on an idle conversation with this text. */
  send(runtime: RuntimeId, sessionId: string, text: string): Promise<void>
  /** Injects into a running turn — only where the runtime can. */
  steer(runtime: RuntimeId, sessionId: string, text: string): Promise<void>
  /** One workspace's whole surface, to every window. */
  changed(state: TeamState): void
  /** A room that no longer exists, so a window can stop drawing it. */
  removed(room: string): void
  /**
   * A conversation joined or left a room.
   *
   * The host counts consecutive failed reopens per member and lets one go
   * after two in a row — a count that only means anything *within* one
   * membership. Nothing reset it when membership moved, so a transient
   * failure, a leave, a rejoin and one more transient failure read as "two
   * refusals in a row" and evicted a member whose two failures belonged to
   * two different stays. Told rather than inferred: reachability bookkeeping
   * is the host's, and this is the engine saying when it stops applying.
   */
  membershipChanged(runtime: RuntimeId, sessionId: string): void
  /** A row in the cross-agent audit log. */
  audit(entry: {
    runtime: RuntimeId
    sessionId: string
    cwd?: string
    kind: 'team/message' | 'team/intent'
    decision?: string
  }): void
}

/**
 * What a running flow needs from the board, and all it may ask of it.
 *
 * The flow engine is a separate service on purpose: the board is one writer
 * over one file per room, and a second thing mutating cards would be a second
 * writer. So the board *asks* — may this card answer that? — and *tells* —
 * this card finished — and every card a rule opens comes back through
 * `addIntentForFlow`, down the same path a person's card takes.
 *
 * Absent on a desk with no flows, which is the ordinary case: the hook is
 * null and nothing on this plane behaves differently from the day before.
 */
export interface TeamFlows {
  /**
   * Why this card may not answer that — or null, which is the answer for
   * every card that belongs to no run. Synchronous, because it decides
   * whether a completion is written at all.
   */
  refuseOutcome(room: string, intent: Intent, outcome: string | null): string | null
  /** A card finished. The engine may open the next round. */
  completed(room: string, intent: Intent): void
  /**
   * Why this seat should stop waiting and end its turn, in a sentence — or
   * null while its run is still going. The one thing that may end a standing
   * order's turn, so it is the flow engine's to say and nobody else's.
   */
  standDown(room: string, runtime: string, sessionId: string): string | null
}

/**
 * How a member's turn ended, when it ended without answering.
 *
 * The host classifies — it owns the turn vocabulary and the adapters' error
 * codes — and the room only has to know what to tell people.
 */
export interface TeamTurnFailure {
  readonly cause: TeamNoticeCause
  readonly message: string
}

/** Which conversation an engine verb is on behalf of. */
export interface TeamCallScope {
  readonly runtime?: string
  readonly sessionId?: string
}

/**
 * A seat parked inside `await_work` until its board has something for it.
 *
 * Held in memory only: a wait is a tool call in flight, and a process that
 * restarts has no tool call to answer. The seat's order tells it to call
 * again, which is what a restart leaves it doing.
 */
interface Waiter {
  readonly key: string
  readonly board: string
  readonly resolve: (answer: string | null) => void
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * How long one `await_work` blocks when the caller does not say.
 *
 * Deliberately short of any vendor's tool timeout we have measured. A seat
 * that is cut off mid-wait sees an error rather than an answer, and the loop
 * has to survive that; a seat that is answered "nothing yet" simply calls
 * again. So the default errs towards more answers, and a flow may raise it.
 */
const DEFAULT_WAIT_MS = 240_000
/** And a ceiling, so a flow cannot park a tool call for an afternoon. */
const WAIT_CEILING_MS = 900_000

/** A message waiting for its receiver's turn to end. */
interface PendingDelivery {
  /** The channel entry to update when it lands. */
  readonly entryId: string
  readonly roots: readonly string[]
  readonly envelope: string
  readonly receiver: { readonly runtime: RuntimeId; readonly sessionId: string }
  /**
   * The user posted or released it. Their words carry authority an agent's
   * never do, so board-only mode and inbound policy sweeps leave these alone.
   */
  readonly byUser?: boolean
}

// The separator is NUL, spelled as an escape so this file stays text to Git
// and every diff tool; neither half of the key can contain it.
/**
 * How long a claim is believed without hearing from its holder.
 *
 * Long, deliberately. The cost of stranding a claim early is an agent losing
 * work it was in the middle of; the cost of stranding it late is a person
 * waiting a while before they can take it back. Only one of those destroys
 * anything, so the number is set where a long turn — a marathon Codex run, a
 * model thinking for twenty minutes — comfortably fits inside it.
 */
const LEASE_MS = 45 * 60 * 1000

const keyOf = (runtime: string, sessionId: string): SessionKey => sessionKey(runtime, sessionId)

/**
 * The family a model belongs to, as a person would say it.
 *
 * Deliberately a short list rather than a clever parse: model ids are a
 * vendor's私 business and change shape without warning, and a heuristic that
 * guesses wrong produces a *name*, which is the one kind of output that has to
 * be right. An id nobody here recognises falls back to the agent's own name,
 * where the number suffix still keeps two of them apart.
 */
const MODEL_FAMILIES: readonly (readonly [RegExp, string])[] = [
  [/\bopus\b/i, 'Opus'],
  [/\bsonnet\b/i, 'Sonnet'],
  [/\bhaiku\b/i, 'Haiku'],
  [/\bcodex\b/i, 'Codex'],
  [/\bgemini\b/i, 'Gemini'],
  [/\bgrok\b/i, 'Grok'],
  [/\bcomposer\b/i, 'Composer'],
  [/\bdeepseek\b/i, 'DeepSeek'],
  [/\bgpt\b/i, 'GPT'],
]

const shortModelName = (model: string | null | undefined): string | null => {
  if (!model) return null
  for (const [pattern, name] of MODEL_FAMILIES) if (pattern.test(model)) return name
  return null
}

/**
 * `{{name}}` slots filled from `vars`. A slot with no value is left as it was
 * written: a member reading "Take card {{card}}" knows at once that the
 * hand-out was wrong, where an empty gap would read as a typo in the words.
 */
export const renderTemplate = (template: string, vars: Readonly<Record<string, string>>): string =>
  template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  )

/**
 * One spelling per area of the tree.
 *
 * Ownership is compared as text, so two spellings of one path are two
 * different regions and the guard simply steps aside: `src/../README.md` and
 * `README.md` could be claimed at the same time by different conversations.
 * Everything is therefore reduced to a workspace-relative, forward-slashed,
 * dot-free form before it is stored or compared.
 *
 * A pattern that escapes the workspace — absolute, or climbing above the root
 * — is not normalised into something harmless; it is rejected, because a
 * claim on `/etc` or `../../other-repo` is not a claim this board can referee
 * and pretending otherwise would be the same silence in a new place.
 */
export const normalisePattern = (pattern: string): string | null => {
  const raw = pattern.trim().replace(/\\/g, '/')
  if (raw === '') return null
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) return null
  const out: string[] = []
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      // Above the root is out of the board's jurisdiction; inside it, the
      // segment simply cancels the one before.
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.length === 0 ? null : out.join('/')
}

/**
 * The fixed lead of a path pattern — everything before the first glob
 * character. Two claims conflict when either lead contains the other, which
 * is deliberately coarser than real glob intersection: the board's job is to
 * stop two agents editing one area, and a rule an agent can predict beats a
 * clever one it cannot.
 */
const fixedLead = (pattern: string): string => {
  const glob = pattern.search(/[*?[]/)
  const lead = glob === -1 ? pattern : pattern.slice(0, glob)
  return lead.replace(/^\.\//, '').replace(/\/+$/, '')
}

const overlaps = (a: string, b: string): boolean => {
  const leadA = fixedLead(a)
  const leadB = fixedLead(b)
  if (leadA === '' || leadB === '') return true
  return leadA === leadB || leadA.startsWith(`${leadB}/`) || leadB.startsWith(`${leadA}/`)
}

/**
 * How long ago, as a phrase that already reads as a time — never a bare number.
 *
 * The callers used to append " ago" themselves, which turned the under-a-minute
 * case into "just now ago". Owning the whole phrase here is what keeps the two
 * spellings from drifting apart again.
 */
const ago = (since: number): string => {
  const m = Math.max(0, Math.round((Date.now() - since) / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''} ago`
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * The sentence a refused, unattributable call gets. Written once: refusing
 * is the rule §25.3 exists for — an unattributed claim or message is worse
 * than none.
 */
/**
 * Two refusals, because there are two causes and they need different actions.
 *
 * They used to share one sentence, and the sentence gave the advice that fits
 * only one of them. A live run cost an hour to that: an agent whose calls carry
 * no caller token tried twice, was told both times to "try again from a normal
 * turn", and trying again from a normal turn is exactly what had just failed.
 * Nothing on screen said the door was locked; the only way to find out was for
 * an agent to walk into it.
 *
 * `UNATTRIBUTED` is permanent for that runtime and the fix is not the agent's.
 * `NOT_LIVE` is transient and the agent can fix it by taking a turn.
 */
const UNATTRIBUTED =
  'This call carries no caller token, so the board cannot tell which conversation is asking — and it records who asked for everything it stores. This will not change by retrying: it is how this agent is connected, not what you did. The desk shows it on the member row, with what would fix it.'

const NOT_LIVE =
  'This conversation is not attached to its agent, so it is not on the board yet. It joins when it takes a turn.'

/** The last segment of a path — a room's name when nobody gave it one. */
const folderOf = (root: string): string =>
  root.split('/').filter((one) => one !== '').pop() ?? 'Room'

/**
 * Whether one folder strictly contains another. Trailing slashes are trimmed
 * so `/repo` and `/repo/` are one folder, and the separator is required so
 * `/repo` does not enclose `/repo-fork`.
 */
const encloses = (outer: string, inner: string): boolean => {
  const above = outer.replace(/\/+$/, '')
  const below = inner.replace(/\/+$/, '')
  return above !== below && below.startsWith(`${above}/`)
}

const NOT_IN_ROOM =
  'This conversation is not in a room, so there is no shared board for it to read. A room is made by the person, and members are added to it — a conversation working on its own has no board and needs none. Ask to be added to one if the work is shared.'

/**
 * What the person can change about how a team works.
 *
 * Every one of these is a switch on a behaviour that a live run showed was
 * not obviously right for everybody — not a knob for its own sake. The
 * defaults are the behaviour as it shipped, except `answersInRoom`, which is
 * on because a room where the answers are invisible reads as a room where
 * nobody answered.
 */
export interface TeamSettings {
  /**
   * Show a woken conversation's answer in the channel. Never sends it: see
   * `'shown'` in the protocol for why the room is a mirror and not a wire.
   */
  readonly answersInRoom: boolean
  /**
   * Write a refused row when board-only stops a message. Without it the
   * sender is told it was muted and the user sees nothing at all, which is
   * the one place this surface implies something about the traffic.
   */
  readonly recordMutedAttempts: boolean
  /** How a conversation treats inbound messages until told otherwise. */
  readonly inboundDefault: TeamInbound
  /** Sends allowed per sender→receiver pair per minute. */
  readonly rateLimit: number
  /** The longest message one agent may send another. */
  readonly messageChars: number
}

export const DEFAULT_TEAM_SETTINGS: TeamSettings = {
  answersInRoom: true,
  recordMutedAttempts: true,
  inboundDefault: 'accept',
  rateLimit: RATE_LIMIT,
  messageChars: MESSAGE_CHAR_LIMIT,
}

export class Team {
  readonly #dir: string
  readonly #port: TeamPort
  #settings: TeamSettings = DEFAULT_TEAM_SETTINGS
  /** The flow engine, when the host has one. Null on every desk running no flows. */
  #flows: TeamFlows | null = null
  /**
   * Who is owed an answer: a receiver whose current turn was started by a
   * delivery, and the conversation that asked. Cleared when the turn ends,
   * whether or not there was anything to show.
   */
  readonly #owed = new Map<string, { asker: TeamActor; roots: readonly string[] }>()
  readonly #boards = new Map<string, Board>()
  /** Per-conversation inbound control; sparse — absent means accept. */
  #inbound = new Map<string, TeamInbound>()
  readonly #pending = new Map<string, PendingDelivery[]>()
  /** Send timestamps per sender→receiver pair, for the rate limit. */
  readonly #recent = new Map<string, number[]>()
  /** Last text per pair, for repeat suppression. */
  readonly #lastText = new Map<string, { text: string; at: number }>()
  /** Receivers with a delivery in flight — the second nudge for one turn end waits its turn. */
  readonly #draining = new Set<string>()
  /** Held entries being released right now; a second click is refused, not doubled. */
  readonly #releasing = new Set<string>()
  /**
   * Conversations denied an approval in their current turn. Their outbound
   * messages are held for the user until the turn ends: an agent denied an
   * action must not quietly ask a more permissive peer to do it —
   * docs/multi-agent.md safety rule 2, at the grain the host can enforce.
   */
  readonly #deniedInTurn = new Set<string>()
  #waiters = new Set<Waiter>()
  #writes: Promise<void> = Promise.resolve()
  /** Latest content per file; a burst of mutations becomes one write. */
  readonly #queuedContent = new Map<string, string | null>()
  readonly #queuedFiles = new Set<string>()
  /**
   * The last persistence failure, in a sentence — surfaced on every board's
   * state until a write succeeds again. `null` is the healthy state.
   */
  #problem: string | null = null
  #entryCounter = 0
  /** What launch will spend re-resolving stored roots. See `#migrateRoots`. */
  readonly #migrationBudgetMs: number

  /**
   * `migrationBudgetMs` is what launch will spend re-resolving stored roots;
   * it exists as an option so a test can prove the deadline without sitting
   * through it, the way `Host` already takes its start and refresh deadlines.
   */
  constructor(dir: string, port: TeamPort, options: { migrationBudgetMs?: number } = {}) {
    this.#dir = dir
    this.#port = port
    this.#migrationBudgetMs = options.migrationBudgetMs ?? MIGRATION_BUDGET_MS
  }

  /**
   * The plugin's configuration, applied whole. Partial and malformed values
   * fall back to the default rather than to nothing: a settings page that can
   * put the engine in a state with no rate limit is a settings page that can
   * spend the user's tokens.
   */
  /**
   * Hands the board the flow engine, once, at start-up.
   *
   * Not a constructor argument because the two are mutually referential —
   * the engine opens cards through this board — and the cycle is easier to
   * read broken here than threaded through both constructors.
   */
  attachFlows(flows: TeamFlows): void {
    this.#flows = flows
  }

  configure(next: Partial<TeamSettings>): void {
    const inboundBefore = this.#settings.inboundDefault
    this.#settings = {
      answersInRoom: next.answersInRoom ?? DEFAULT_TEAM_SETTINGS.answersInRoom,
      recordMutedAttempts:
        next.recordMutedAttempts ?? DEFAULT_TEAM_SETTINGS.recordMutedAttempts,
      inboundDefault:
        next.inboundDefault === 'hold' || next.inboundDefault === 'refuse'
          ? next.inboundDefault
          : 'accept',
      rateLimit:
        typeof next.rateLimit === 'number' && next.rateLimit >= 1 && next.rateLimit <= 60
          ? Math.floor(next.rateLimit)
          : DEFAULT_TEAM_SETTINGS.rateLimit,
      messageChars:
        typeof next.messageChars === 'number' &&
        next.messageChars >= 200 &&
        next.messageChars <= 200_000
          ? Math.floor(next.messageChars)
          : DEFAULT_TEAM_SETTINGS.messageChars,
    }
    // The default is the mode of every member without one of its own.
    if (this.#settings.inboundDefault !== inboundBefore) this.#pushStates(null)
  }

  /** What the engine is currently set to — the settings page reads this. */
  settings(): TeamSettings {
    return this.#settings
  }

  /** Waits out the write chain — a disposer's courtesy, and the tests'. */
  async flush(): Promise<void> {
    await this.#writes
  }

  /** Reads every persisted board, so a fresh window can be handed them all. */
  async load(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.#dir)
    } catch {
      return
    }
    /* Every board's root as the file recorded it, keyed by id, for the
       migration pass below. Collected rather than resolved inline: the read
       loop stays pure file I/O, and the git the resolver runs happens once,
       concurrently and on a clock, rather than once per board in series. */
    const recordedRoots = new Map<string, string>()
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'inbound.json') continue
      try {
        const raw = JSON.parse(await readFile(join(this.#dir, name), 'utf8')) as StoredBoard
        /* A file written when a project had exactly one board is named after
           the folder; one written since is named after the room. Either way it
           becomes a room — the old ones keep the folder's name and take as
           members everyone the board had already met, which is what
           `nicknames` records. Nothing is lost and nothing has to be
           reassigned by hand. */
        const stored = decodeURIComponent(name.slice(0, -'.json'.length))
        const recorded = raw.root ?? stored
        const id = raw.id ?? stored
        recordedRoots.set(id, recorded)
        this.#boards.set(id, {
          id,
          /* Named after the folder as it was *recorded*, not as the
             resolver spells it today. A room from that era has no name of its
             own — the folder is the name the person saw — and moving the root
             must not quietly rename their room. */
          name: raw.name ?? folderOf(recorded),
          members: [...(raw.members ?? Object.keys(raw.nicknames ?? {}))] as SessionKey[],
          root: recorded,
          nextIntent: raw.nextIntent,
          nextPlan: raw.nextPlan ?? 1,
          plans: [...(raw.plans ?? [])],
          messaging: raw.messaging,
          nicknames: { ...(raw.nicknames ?? {}) },
          roles: { ...(raw.roles ?? {}) },
          roster: { ...(raw.roster ?? {}) },
          intents: [...raw.intents],
          // A `queued` row waits on an in-memory delivery, and this is a
          // fresh memory: left as it was it would read "queued" forever.
          // Refused-with-the-reason is the honest state — nothing is
          // dropped silently, including by a restart.
          channel: raw.channel.map((entry) =>
            entry.kind === 'message' && entry.state === 'queued'
              ? {
                  ...entry,
                  state: 'refused' as const,
                  reason: 'The desk restarted before the message was delivered.',
                }
              : entry,
          ),
        })
      } catch (error) {
        // An unreadable board must not read as an empty one that the next
        // mutation quietly overwrites. Set it aside under a name that says
        // what happened, and say so on the surface.
        const aside = `${name}.unreadable-${Date.now()}`
        try {
          await rename(join(this.#dir, name), join(this.#dir, aside))
        } catch {
          // If even the rename fails the original is still on disk.
        }
        this.#problem = `A stored board could not be read (${errorText(error)}). The file was set aside as ${aside}; the board starts empty.`
      }
    }
    await this.#migrateRoots(recordedRoots)
    try {
      const raw = JSON.parse(await readFile(join(this.#dir, 'inbound.json'), 'utf8')) as Record<
        string,
        TeamInbound
      >
      this.#inbound = new Map(Object.entries(raw))
    } catch {
      // Absent means everyone accepts, which is the default anyway.
    }
  }

  /**
   * Puts every stored root back through the resolver that keys rooms today,
   * and writes back the ones that moved.
   *
   * `root` is the string that decides which project a room is drawn in and
   * which conversations may join it — `roomsFor` filters on it and `joinRoom`
   * compares it against what the host resolves for the joining conversation's
   * folder. So a change to how the host resolves a folder is a change to what
   * that string has to be, and boards written under the old rule would
   * otherwise be left keyed by a path the resolver no longer produces: a
   * submodule or `--separate-git-dir` checkout that used to resolve to
   * whatever workspace was open. A room in a folder of its own, drawn beside
   * its own conversations and refusing them.
   *
   * Concurrently and on a clock, because this is on the path `Host.start()`
   * awaits and the resolver shells out to git. Serially, a desk with rooms in
   * five projects paid five probes before its window could open, and one repo
   * on a disconnected volume would have held the whole app on git's own
   * 30-second timeout. Neither is a thing a person should ever wait for: the
   * budget below is what launch will spend, and whatever has not answered by
   * then keeps its recorded root and is migrated at the next launch instead.
   * That is safe precisely because the pass is idempotent — a root already
   * corrected resolves to itself.
   */
  async #migrateRoots(recorded: ReadonlyMap<string, string>): Promise<void> {
    if (recorded.size === 0) return
    let expired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      // Deliberately not `unref`'d: an unref'd timer cannot fire once the
      // promise it races is the only work left, which is exactly when the
      // deadline is needed. `clearTimeout` below is what keeps it from
      // holding the process open.
      timer = setTimeout(() => {
        expired = true
        resolve()
      }, this.#migrationBudgetMs)
    })
    const work = Promise.all(
      [...recorded].map(async ([id, was]) => {
        const now = await this.#reroot(was)
        if (expired || now === was) return
        const board = this.#boards.get(id)
        // Only if nothing has touched it in the meantime: a late answer must
        // never overwrite a root the running app has since decided on.
        if (!board || board.root !== was) return
        /* `Board.root` is readonly on purpose — a room's project is fixed for
           the life of the board, and this migration is the one exception —
           so the entry is replaced rather than the field assigned, and no
           other call site gains the ability to re-key a room. */
        const moved: Board = { ...board, root: now }
        this.#boards.set(id, moved)
        /* Written back through `#commit` like every other change — the same
           serialised write chain, and the same push, which is a no-op with no
           window connected — so the correction is made once rather than on
           every launch, and the file says what the room in memory says. */
        this.#commit(moved)
      }),
    ).catch(() => undefined)
    try {
      await Promise.race([work, deadline])
    } finally {
      expired = true
      clearTimeout(timer)
    }
  }

  /**
   * One stored root, re-resolved — or kept, which is the answer more often
   * than not.
   *
   * A root the resolver has nothing to say about — the folder has since been
   * deleted, which is true of every scratch room a demo ever made — is kept
   * exactly as recorded, and so is one whose resolution throws. A room never
   * loses the only note of where it was.
   *
   * And it is never moved *up*. A board keyed by a folder that contains its
   * project is the one case the recorded root cannot settle: it names the
   * parent, nothing on disk says which repository underneath it the room was
   * for, and members are session keys rather than folders. Resolving that
   * parent is worse than useless — if the parent is itself inside some other
   * repository (a `git init` over `~/code`, a dotfiles repo above the
   * checkouts) the resolver answers with *that*, and the board would be
   * silently re-keyed to a project it has no relationship to, with the
   * recorded root overwritten. Measured, not supposed: a folder `outer/work`
   * holding a repository `outer/work/repo` resolves to `outer`. Since the
   * correct answer for such a board is always *below* the recorded root and
   * the resolver can only ever answer at or above it, an answer that encloses
   * what was recorded is by construction not the room's project, and the
   * board stays where it was found.
   */
  async #reroot(recorded: string): Promise<string> {
    let resolved: string | null
    try {
      resolved = await this.#port.rootOf(recorded)
    } catch {
      return recorded
    }
    if (resolved === null || encloses(resolved, recorded)) return recorded
    return resolved
  }

  /**
   * Every room, for the connect-time replay.
   *
   * This used to skip a board with nothing on it, which was right when a board
   * appeared by itself for any folder somebody opened — replaying those would
   * have been a list of empty surfaces nobody made. A room is made and named
   * by a person now, so *existing* is the whole of what it has to prove. With
   * the filter still here, a room created and not yet used was on disk and in
   * `roomsFor`, and simply vanished from the tree at the next launch.
   */
  states(): TeamState[] {
    return [...this.#boards.values()].map((board) => this.#stateOf(board))
  }

  stateFor(id: string): TeamState {
    const board = this.#boards.get(id)
    return board
      ? this.#stateOf(board)
      : {
          id,
          name: '',
          root: '',
          members: [],
          intents: [],
          channel: [],
          messaging: true,
          problem: this.#problem,
        }
  }

  inboundFor(runtime: string, sessionId: string): TeamInbound {
    return this.#inbound.get(keyOf(runtime, sessionId)) ?? this.#settings.inboundDefault
  }

  /**
   * Who a post can reach on this board, for the room's roster and its
   * recipient picker. The renderer must not guess this from folder prefixes —
   * a worktree's conversation belongs to the workspace its checkout hangs off,
   * which only the host's resolution knows.
   *
   * Every member, whether or not the desk has it open: `here` says which is
   * which, and the surface draws the difference. See `#membersOf`.
   */
  async peersFor(id: string): Promise<TeamPeerInfo[]> {
    const board = this.#board(id)
    if (!board) return []
    const peers = this.#membersOf(board, this.#port.peers())
    const info = peers.map((peer) => ({
      runtime: peer.runtime,
      sessionId: peer.sessionId,
      title: peer.title,
      agent: peer.agent,
      busy: peer.busy,
      nickname: this.#nameOn(board, peer),
      model: peer.model ?? null,
      /* Evidence from *this* run, so a member nobody has opened yet has none
         either way — which is why the surface only draws the doubt for a
         member that is here. */
      usedBoard: this.#used.has(keyOf(peer.runtime, peer.sessionId)),
      here: peer.here,
      /* The board's default until this conversation was given one of its
         own, which is what `inboundFor` resolves — so the roster reports the
         mode that will actually be applied rather than only the override. */
      inbound: this.inboundFor(peer.runtime, peer.sessionId),
    }))
    // Naming is a write, and so is remembering: a member seen for the first
    // time has just been given a name and a photograph, and both have to
    // survive a restart or neither is worth having.
    this.#commit(board)
    return info
  }

  // ---------------------------------------------------------- the user's half

  /** The user adds work. `by` on the signal says so. */
  addIntentAsUser(
    id: string,
    args: {
      title: string
      detail?: string
      files?: readonly string[]
      dependsOn?: readonly number[]
      plan?: number
    },
  ): Intent {
    const board = this.#boardById(id)
    /* Refused rather than filtered, the same way the agent's `add_intent` is.
       `#addIntent` drops a path the board cannot own, which is right for what
       it stores and wrong as an answer: the long form closed on a card owning
       one of the three paths that were typed into it, and said nothing about
       the other two. A person cannot tell a path that was rejected from one
       that was accepted and did nothing. */
    const outside = (args.files ?? []).filter(
      (file) => file.trim() !== '' && normalisePattern(file) === null,
    )
    if (outside.length > 0) {
      throw new Error(
        `${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside this workspace. The board can only own paths inside the project it is for. Nothing was added.`,
      )
    }
    return this.#addIntent(board, args, { kind: 'user' })
  }

  /**
   * A goal, and the work it becomes. The person's verb, always.
   *
   * Naming a goal and creating its work are separate steps, deliberately: a
   * plan that made jobs in the same breath as being named would be a control
   * that spends before anybody has read what it is about to do. The goal exists
   * first, and the jobs are added to it, so there is a moment in between where
   * a person can look.
   */
  planWork(id: string, goal: string): Plan {
    const board = this.#boardById(id)
    const text = goal.trim()
    if (text === '') throw new Error('A goal needs saying. Nothing was started.')
    const plan: Plan = { id: board.nextPlan, goal: text, state: 'running', createdAt: Date.now() }
    board.nextPlan += 1
    board.plans = [...board.plans, plan]
    this.#commit(board)
    return plan
  }

  /**
   * Put a finished goal away.
   *
   * Refused while anything on it is still live, and the refusal names what — a
   * "wrap up" that quietly abandoned three claimed jobs would be the most
   * expensive button in the app. Wrapping keeps the jobs: they are the record
   * of what happened, and the board simply stops leading with them.
   */
  wrapPlan(room: string, id: number): string {
    const board = this.#boardById(room)
    const plan = board.plans.find((entry) => entry.id === id)
    if (!plan) return `There is no goal #${id} on this board.`
    if (plan.state === 'wrapped') return `“${plan.goal}” is already wrapped up.`
    const live = board.intents.filter(
      (intent) => intent.plan === id && intent.state !== 'done' && intent.state !== 'abandoned',
    )
    if (live.length > 0) {
      return `Refused: ${live.length} ${live.length === 1 ? 'job is' : 'jobs are'} still live on “${plan.goal}” — ${live
        .map((intent) => `#${intent.id}`)
        .join(', ')}. Finish or abandon them first.`
    }
    const kept = board.intents.filter((intent) => intent.plan === id).length
    board.plans = board.plans.map((entry) =>
      entry.id === id ? { ...entry, state: 'wrapped' as const, wrappedAt: Date.now() } : entry,
    )
    this.#commit(board)
    return `Wrapped up “${plan.goal}”. Its ${kept} ${kept === 1 ? 'job stays' : 'jobs stay'} on the board as the record.`
  }

  /**
   * The person's verbs over an intent. The host is the referee, so these
   * always win: a claim is taken away by `release` whether or not the agent
   * holding it would agree.
   */
  intentAction(
    room: string,
    id: number,
    action: 'reopen' | 'abandon' | 'done' | 'release' | 'block',
    reason?: string,
    /**
     * What the person answered, on a card a flow addressed to them.
     *
     * `who: person` is a step, not an absence: the round opens, the card
     * appears addressed to them, the loop waits, and their completion carries
     * the outcome the next rule branches on. Read on `done`; ignored by the
     * other verbs, which say nothing about the merits.
     */
    outcome?: string,
  ): void {
    const board = this.#boardById(room)
    const intent = board.intents.find((entry) => entry.id === id)
    if (!intent) throw new Error(`There is no intent #${id} on this board.`)
    const by: TeamActor = { kind: 'user' }
    if (action === 'block') {
      /* `blockedBy: 'hand'`, the same as an agent's `release(blocked)`: a
         completed dependency must never silently restart work somebody
         deliberately stopped. The claim goes with it — an agent cannot be left
         holding a job it has been told not to do — which is why this is a
         referee's verb and not a note on the card. */
      const said = reason?.trim() || null
      this.#patchIntent(board, id, {
        state: 'blocked',
        claim: null,
        blockedReason: said,
        blockedBy: 'hand',
      })
      this.#signal(board, by, 'blocked', intent, said ?? 'stopped by you')
    } else if (action === 'release') {
      this.#patchIntent(board, id, { state: 'open', claim: null, blockedReason: null, blockedBy: null })
      this.#signal(board, by, 'released', intent, 'released by you')
    } else if (action === 'abandon') {
      /* The block goes with the work, as it does on release and reopen below.
         Left standing, a card read done — or abandoned — and blocked at once,
         and the board draws `blockedReason` ahead of the card's own note, so
         the Done column showed why the work had once been stopped instead of
         how it finished. */
      this.#patchIntent(board, id, { state: 'abandoned', claim: null, blockedReason: null, blockedBy: null })
      this.#signal(board, by, 'abandoned', intent, null)
    } else if (action === 'done') {
      const said = outcome?.trim() || null
      const refusal = this.#flows?.refuseOutcome(board.id, intent, said) ?? null
      if (refusal) throw new Error(refusal)
      this.#patchIntent(board, id, {
        state: 'done',
        claim: null,
        blockedReason: null,
        blockedBy: null,
        outcome: said,
      })
      this.#signal(board, by, 'completed', intent, said ? `you answered ${said}` : 'marked done by you')
      this.#unblock(board, by)
      this.#commit(board)
      this.#flows?.completed(board.id, { ...intent, state: 'done', outcome: said })
      return
    } else {
      this.#patchIntent(board, id, { state: 'open', claim: null, blockedReason: null, blockedBy: null })
      this.#signal(board, by, 'reopened', intent, null)
    }
    this.#commit(board)
  }

  /**
   * Board-only mode. Turning messaging off also stops what is already in the
   * air: agents' queued messages become `held` — visible, releasable, going
   * nowhere on their own. The user's own pending posts are untouched; the
   * switch exists to stop agents, not the person.
   */
  setMessaging(id: string, enabled: boolean): void {
    const board = this.#boardById(id)
    board.messaging = enabled
    if (!enabled) {
      this.#sweepPending(
        (pending) => !pending.byUser && pending.roots.includes(board.id),
        { state: 'held', reason: 'Board-only was turned on before this was delivered. Release it from here, or leave it.' },
      )
    }
    this.#commit(board)
  }

  /**
   * Per-conversation inbound control. A change applies to what is already
   * queued for that conversation too — `refuse` refuses it, `hold` holds it
   * — because "stop messages to this conversation" that lets three earlier
   * ones through was not what the person meant. The user's own posts are
   * exempt for the reason on `PendingDelivery.byUser`.
   */
  setInbound(runtime: string, sessionId: string, mode: TeamInbound): void {
    // Stored whatever it is, `accept` included. Deleting the entry made
    // `accept` mean "inherit", which is invisible until the default is not
    // `accept`: with the board set to hold, choosing accept for one
    // conversation did exactly nothing. Absence is the only way to say
    // inherit, and choosing a mode always says that mode.
    this.#inbound.set(keyOf(runtime, sessionId), mode)
    if (mode !== 'accept') {
      this.#sweepPending(
        (pending) =>
          !pending.byUser &&
          pending.receiver.runtime === runtime &&
          pending.receiver.sessionId === sessionId,
        mode === 'refuse'
          ? { state: 'refused', reason: 'The conversation now refuses inter-agent messages.' }
          : { state: 'held', reason: 'The conversation now holds inter-agent messages; release it from here.' },
      )
    }
    this.#persistInbound()
    /* The member's room draws the mode, so the room is told. Nothing was
       pushed before, and a second view of the room kept drawing the old mode
       until something unrelated made it ask again. */
    const key = keyOf(runtime, sessionId)
    for (const board of this.#boards.values()) {
      if (board.members.includes(key)) this.#port.changed(this.#stateOf(board))
    }
  }

  /**
   * The user posts into the channel. Their words go as themselves — no
   * envelope, no quarantine — because it *is* the user speaking, with the
   * authority an agent's message never has. Each recipient is its own
   * attempt: a runtime that refuses the text gets a `refused` row with the
   * error, and the rest of a broadcast still goes out.
   */
  async post(
    id: string,
    text: string,
    to?: { runtime: RuntimeId; sessionId: string },
  ): Promise<void> {
    const body = text.trim()
    if (body === '') return
    const board = this.#boardById(id)
    if (body.length > this.#settings.messageChars) {
      this.#message(board, {
        from: { kind: 'user' },
        to: null,
        text: `${body.slice(0, 200)}…`,
        state: 'refused',
        reason: `The post is ${body.length} characters; the limit is ${this.#settings.messageChars}.`,
      })
      this.#commit(board)
      return
    }
    const onBoard = this.#membersOf(board, this.#port.peers())
    const targets = to
      ? onBoard.filter((peer) => peer.runtime === to.runtime && peer.sessionId === to.sessionId)
      : onBoard
    if (targets.length === 0) {
      this.#message(board, {
        from: { kind: 'user' },
        to: null,
        text: body,
        state: 'refused',
        /* Membership, because membership is what a post is addressed to now:
           a member the desk does not have open is still reached, by reopening
           it. "Nothing is live on this board" was the sentence every room gave
           for the whole of the first post after a relaunch, and it named a
           condition the user could do nothing about and that was not true. */
        reason: to
          ? 'That conversation is not in this room.'
          : 'This room has no members yet. Add one from the roster.',
      })
      this.#commit(board)
      return
    }
    for (const peer of targets) {
      const address = {
        runtime: peer.runtime,
        sessionId: peer.sessionId,
        title: peer.title ?? peer.agent,
        nickname: this.#nameOn(board, peer),
      }
      if (peer.busy) {
        const entry = this.#message(board, {
          from: { kind: 'user' },
          to: address,
          text: body,
          state: 'queued',
        })
        this.#enqueue(peer, entry.id, [board.id], body, true)
        continue
      }
      try {
        await this.#port.send(peer.runtime, peer.sessionId, body)
        this.#message(board, { from: { kind: 'user' }, to: address, text: body, state: 'delivered' })
        this.#owe(peer, { kind: 'user' }, [board.id])
      } catch (error) {
        this.#message(board, {
          from: { kind: 'user' },
          to: address,
          text: body,
          state: 'refused',
          reason: `Sending failed: ${errorText(error)}`,
        })
      }
    }
    this.#commit(board)
  }

  /**
   * The user hands out one message to many members, each with its own values.
   *
   * `template` holds `{{name}}` slots; each recipient's `vars` fill them, and
   * a slot nobody filled is left standing so the mistake is visible rather
   * than silent. Every rendering is its own delivery — its own row, its own
   * state, the same rules as `post` — but the sends go out together, the
   * board is committed once, and every row carries the batch so the channel
   * can draw the action as one. A room of 138 handed a page each was 138
   * posts, 138 board writes and 138 rows before this existed.
   */
  async handout(
    id: string,
    template: string,
    recipients: readonly {
      readonly runtime: RuntimeId
      readonly sessionId: string
      readonly vars?: Readonly<Record<string, string>>
    }[],
  ): Promise<{ batch: string; delivered: number; queued: number; refused: number }> {
    const board = this.#boardById(id)
    const batch = { id: this.#entryId(), size: recipients.length, template }
    const tally = { batch: batch.id, delivered: 0, queued: 0, refused: 0 }
    if (recipients.length === 0 || template.trim() === '') return tally
    const onBoard = this.#membersOf(board, this.#port.peers())

    type Row = {
      readonly to: NonNullable<TeamMessage['to']>
      readonly text: string
      readonly state: TeamMessage['state']
      readonly reason?: string | null
      readonly peer?: TeamPeer
    }
    const rendered = recipients.map((one) => renderTemplate(template, one.vars ?? {}))
    const rows: Row[] = []

    const attempt = async (index: number): Promise<void> => {
      const recipient = recipients[index]!
      const body = rendered[index]!.trim()
      const peer = onBoard.find(
        (candidate) => candidate.runtime === recipient.runtime && candidate.sessionId === recipient.sessionId,
      )
      const address = peer
        ? { runtime: peer.runtime, sessionId: peer.sessionId, title: peer.title ?? peer.agent, nickname: this.#nameOn(board, peer) }
        : { runtime: recipient.runtime, sessionId: recipient.sessionId, title: recipient.sessionId }
      if (!peer) {
        rows[index] = { to: address, text: body, state: 'refused', reason: 'That conversation is not running on this board.' }
        return
      }
      if (body === '') {
        rows[index] = { to: address, text: body, state: 'refused', reason: 'The message rendered empty for this member.' }
        return
      }
      if (body.length > this.#settings.messageChars) {
        rows[index] = {
          to: address,
          text: `${body.slice(0, 200)}…`,
          state: 'refused',
          reason: `The message is ${body.length} characters for this member; the limit is ${this.#settings.messageChars}.`,
        }
        return
      }
      if (peer.busy) {
        rows[index] = { to: address, text: body, state: 'queued', peer }
        return
      }
      try {
        await this.#port.send(peer.runtime, peer.sessionId, body)
        rows[index] = { to: address, text: body, state: 'delivered', peer }
      } catch (error) {
        rows[index] = { to: address, text: body, state: 'refused', reason: `Sending failed: ${errorText(error)}` }
      }
    }
    // A few at a time: a send resolves on acceptance, but each one may have
    // to reopen a conversation first, and a hundred reopenings at once is
    // the burst the bridge's own gate exists to prevent.
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < recipients.length) {
        const index = next
        next += 1
        await attempt(index)
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, recipients.length) }, () => worker()))

    // Rows in the order the hand-out named them, whatever order the sends
    // settled in, so the batch reads as one list and not as a race.
    for (const row of rows) {
      const entry = this.#message(board, { from: { kind: 'user' }, to: row.to, text: row.text, state: row.state, reason: row.reason ?? null, batch })
      if (row.state === 'delivered' && row.peer) {
        this.#owe(row.peer, { kind: 'user' }, [board.id])
        tally.delivered += 1
      } else if (row.state === 'queued' && row.peer) {
        this.#enqueue(row.peer, entry.id, [board.id], row.text, true)
        tally.queued += 1
      } else {
        tally.refused += 1
      }
    }
    this.#commit(board)
    return tally
  }

  /**
   * Releases one held message to its receiver now. In-flight releases are
   * tracked by entry id, so two windows — or one double-click — cannot send
   * the same envelope twice; and the entry is patched on *every* board that
   * holds a copy, so nothing is left `held` somewhere it can be released
   * again.
   */
  async deliverHeld(id: string, entryId: string): Promise<void> {
    if (this.#releasing.has(entryId)) {
      throw new Error('That message is already being released.')
    }
    const board = this.#boardById(id)
    const entry = board.channel.find(
      (candidate): candidate is TeamMessage =>
        candidate.id === entryId && candidate.kind === 'message',
    )
    if (!entry || entry.state !== 'held' || !entry.to || !entry.envelope) {
      throw new Error('That message is not waiting to be released.')
    }
    const roots = this.#rootsHolding(entryId)
    this.#releasing.add(entryId)
    try {
      /* The room's own members, not whatever is open: a message held
         overnight is released the next morning against a desk that has
         reopened nothing, and refusing it there would have thrown away the
         one message the user had deliberately kept. Sending reopens the
         conversation, exactly as a fresh post to that member does. */
      const peer = this.#membersOf(board, this.#port.peers()).find(
        (p) => p.runtime === entry.to?.runtime && p.sessionId === entry.to?.sessionId,
      )
      if (!peer) {
        this.#updateEntry(roots, entryId, {
          state: 'refused',
          reason: 'That conversation is no longer in this room.',
        })
        return
      }
      if (peer.busy) {
        this.#updateEntry(roots, entryId, { state: 'queued', reason: null })
        // Released by the user, so the pending row carries their authority:
        // a later policy sweep must not re-hold what they explicitly freed.
        this.#enqueue(peer, entryId, roots, entry.envelope, true)
        return
      }
      try {
        await this.#port.send(peer.runtime, peer.sessionId, entry.envelope)
        this.#updateEntry(roots, entryId, { state: 'delivered', reason: null })
      } catch (error) {
        this.#updateEntry(roots, entryId, {
          state: 'refused',
          reason: `Sending failed: ${errorText(error)}`,
        })
      }
    } finally {
      this.#releasing.delete(entryId)
    }
  }

  // --------------------------------------------------------- the agents' half

  async board(scope: TeamCallScope): Promise<string> {
    const caller = this.#caller(scope)
    const board = await this.#boardOf(caller)
    // Reading the board is the holder being heard from, which is all a lease
    // asks for. Renewing on use rather than on a heartbeat means the signal is
    // the work itself.
    if (this.#renew(board, caller)) this.#commit(board)
    return this.#renderBoard(board)
  }

  async addIntent(
    args: {
      title: string
      detail?: string
      files?: readonly string[]
      dependsOn?: readonly number[]
    },
    scope: TeamCallScope,
  ): Promise<string> {
    const caller = this.#caller(scope)
    const board = await this.#boardOf(caller)
    const title = (args.title ?? '').trim()
    if (title === '') return 'An intent needs a title. Nothing was added.'
    for (const dep of args.dependsOn ?? []) {
      if (!board.intents.some((intent) => intent.id === dep)) {
        return `There is no intent #${dep} to depend on. Nothing was added.\n\n${this.#renderBoard(board)}`
      }
    }
    const outside = (args.files ?? []).filter(
      (file) => file.trim() !== '' && normalisePattern(file) === null,
    )
    if (outside.length > 0) {
      return `Refused: ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside this workspace. The board can only own paths inside the project it is for. Nothing was added.`
    }
    const intent = this.#addIntent(board, { ...args, title }, this.#actorOf(board, caller))
    this.#port.audit({
      runtime: caller.runtime,
      sessionId: caller.sessionId,
      cwd: caller.cwd,
      kind: 'team/intent',
      decision: 'added',
    })
    return `Added intent #${intent.id} — ${intent.title}.\n\n${this.#renderBoard(board)}`
  }

  /**
   * Atomic: the check and the claim happen in one synchronous pass over
   * host-owned state, so "refused if someone got there first" is a fact
   * rather than a hope.
   */
  /**
   * Take an open intent, and say what it will touch.
   *
   * `files` is the claimant's own declaration, merged into whatever the intent
   * already owned. It exists because the paths are usually not known when the
   * work is *written down* — a person adding "fix the refill bug" from the
   * board's own input has no field for them, and an agent only learns which
   * files it needs after reading. Without somewhere to put that discovery, the
   * ownership half of the guarantee simply never engaged: every claim in a
   * real run owned nothing, and the board could only promise one-claim-per-job.
   */
  /**
   * The next open card, whichever it is — the lowest-numbered one that is
   * unblocked, not waiting on unfinished work, and not overlapping a live
   * claim — taken atomically.
   *
   * This is how a room drains a board with more cards than members: every
   * member takes one, finishes it, takes the next, until nothing is left.
   * Asking each member to list the board and pick was a herd — a hundred
   * members reading a hundred cards and all claiming the first one, then
   * all retrying on the second. Here the pick and the claim are one call,
   * and a card another member took a moment ago is simply skipped.
   */
  /**
   * Waits, for free, until there is a card this member can take.
   *
   * This is what lets a seat live inside **one turn** for as long as the desk
   * is up. On a request-billed plan a turn costs the same whether it lasts a
   * second or a day, and a *second* message is a second request — so a seat is
   * handed one standing order and loops inside it: wait, claim, do, finish,
   * wait. A hundred cards for the price of the seating.
   *
   * The wait costs nothing because it is not a poll. The board is in this
   * process, so a waiter is woken by the write that made its card claimable,
   * with no file read, no round trip and no tokens spent between calls. What
   * it costs the *seat* is one tool call, which is why the answer is one line:
   * a seat sees this line thousands of times and every character of it is
   * context it will be carrying for the rest of its life.
   *
   * `cycle` is in the answer rather than the question because of a measured
   * failure: a vendor harness stops accepting the *same* blocked call after
   * enough repeats, and two seats ended their turns saying exactly that. The
   * answer hands back the number to pass next time, so no two calls are
   * alike and the model never has to remember one.
   */
  async awaitWork(
    scope: TeamCallScope,
    options: { blockMs?: number; cycle?: number } = {},
  ): Promise<string> {
    const caller = this.#caller(scope)
    const board = await this.#boardOf(caller)
    const cycle = Number.isFinite(options.cycle) ? Math.max(0, Math.trunc(options.cycle as number)) : 0
    const next = `Call await_work again with cycle: ${cycle + 1}.`
    const key = keyOf(caller.runtime, caller.sessionId)
    const done = this.#flows?.standDown(board.id, caller.runtime, caller.sessionId) ?? null
    if (done) return `stand down — ${done}`
    const ready = (): Intent | null =>
      [...board.intents]
        .filter(
          (intent) =>
            intent.state === 'open' &&
            !intent.claim &&
            this.#misaddressed(board, intent, caller) === null &&
            intent.dependsOn.every((dep) => {
              const found = board.intents.find((entry) => entry.id === dep)
              return found === undefined || found.state === 'done'
            }) &&
            this.#conflictsWith(board, intent.files, caller).length === 0,
        )
        .sort((a, b) => a.id - b.id)[0] ?? null
    const now = ready()
    if (now) return `work: #${now.id} ${now.title}. Claim it with claim_next. ${next}`

    const blockMs = Math.min(
      WAIT_CEILING_MS,
      Math.max(1000, Math.trunc(options.blockMs ?? DEFAULT_WAIT_MS)),
    )
    const answer = await new Promise<string | null>((resolve) => {
      const waiter: Waiter = { key, board: board.id, resolve, timer: null }
      waiter.timer = setTimeout(() => {
        this.#waiters.delete(waiter)
        resolve(null)
      }, blockMs)
      this.#waiters.add(waiter)
    })
    if (answer !== null) return answer
    /* Re-asked rather than remembered: the board may have changed while the
       timer was settling, and a seat told "nothing yet" about a card that is
       sitting there would wait out another whole cycle for nothing. */
    const late = ready()
    if (late) return `work: #${late.id} ${late.title}. Claim it with claim_next. ${next}`
    const ended = this.#flows?.standDown(board.id, caller.runtime, caller.sessionId) ?? null
    if (ended) return `stand down — ${ended}`
    return `nothing yet. ${next}`
  }

  /**
   * Wakes every waiter whose board just changed, with whatever it can now
   * take. Called from `#commit`, which is the one place a card can become
   * claimable.
   */
  #wake(board: Board): void {
    if (this.#waiters.size === 0) return
    for (const waiter of [...this.#waiters]) {
      if (waiter.board !== board.id) continue
      const { runtime, id } = splitSessionKey(waiter.key as SessionKey)
      const sessionId = String(id)
      const peer = this.#membersOf(board, this.#port.peers()).find(
        (one) => one.runtime === runtime && one.sessionId === sessionId,
      )
      if (!peer) continue
      const standDown = this.#flows?.standDown(board.id, runtime, sessionId) ?? null
      const found = standDown
        ? null
        : [...board.intents]
            .filter(
              (intent) =>
                intent.state === 'open' &&
                !intent.claim &&
                this.#misaddressed(board, intent, peer) === null &&
                intent.dependsOn.every((dep) => {
                  const dependency = board.intents.find((entry) => entry.id === dep)
                  return dependency === undefined || dependency.state === 'done'
                }) &&
                this.#conflictsWith(board, intent.files, peer).length === 0,
            )
            .sort((a, b) => a.id - b.id)[0]
      if (!standDown && !found) continue
      if (waiter.timer) clearTimeout(waiter.timer)
      this.#waiters.delete(waiter)
      waiter.resolve(
        standDown
          ? `stand down — ${standDown}`
          : `work: #${found!.id} ${found!.title}. Claim it with claim_next. Call await_work again with the next cycle number.`,
      )
    }
  }

  /**
   * Lets every waiting seat go, with a reason. The desk is closing, or the
   * room is; either way a tool call held open across it is a turn that never
   * ends.
   */
  stopWaiting(reason: string): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.timer) clearTimeout(waiter.timer)
      this.#waiters.delete(waiter)
      waiter.resolve(`stand down — ${reason}`)
    }
  }

  /**
   * A card a rule opened, addressed to the role the rule named.
   *
   * The person's authority, because it is the person who started the flow:
   * they read the dry run, they pressed the thing, and every card it opens is
   * theirs in exactly the way a card they typed is. It goes down the same path
   * as one they typed, so there is one writer over a board and one set of
   * rules about what may be on it.
   */
  addIntentForFlow(
    room: string,
    args: {
      title: string
      detail?: string
      files?: readonly string[]
      dependsOn?: readonly number[]
      role: string
    },
  ): Intent {
    const board = this.#boardById(room)
    return this.#addIntent(board, args, { kind: 'user' })
  }

  async claimNext(scope: TeamCallScope, files?: readonly string[]): Promise<string> {
    const caller = this.#caller(scope)
    const board = await this.#boardOf(caller)
    const ready = (intent: Intent): boolean =>
      intent.state === 'open' &&
      !intent.claim &&
      /* A card addressed to a role is not "the next card" for anybody else.
         Skipped rather than refused: `claim_next` is a member asking what it
         can do, and a reviewer being handed the fixer's card is the routing
         failure roles exist to end. */
      this.#misaddressed(board, intent, caller) === null &&
      intent.dependsOn.every((dep) => {
        const found = board.intents.find((entry) => entry.id === dep)
        return found === undefined || found.state === 'done'
      }) &&
      this.#conflictsWith(board, intent.files, caller).length === 0
    const candidates = [...board.intents].filter(ready).sort((a, b) => a.id - b.id)
    for (const candidate of candidates) {
      const answer = await this.claim(candidate.id, scope, files)
      // Taken between the look and the claim: the next one is as good.
      if (/^Refused: #\d+ is already claimed by/.test(answer)) continue
      return answer
    }
    // Why not, counted the way the asker needs it: what is already theirs,
    // what others hold, what waits, what overlaps — so a member can decide
    // between finishing its own cards and asking somebody.
    const mine = board.intents.filter(
      (intent) =>
        intent.state === 'claimed' &&
        intent.claim?.runtime === caller.runtime &&
        intent.claim.sessionId === caller.sessionId,
    ).length
    const others = board.intents.filter((intent) => intent.state === 'claimed').length - mine
    const waiting = board.intents.filter((intent) => intent.state === 'blocked').length
    const overlapping = board.intents.filter((intent) => intent.state === 'open').length
    const parts: string[] = []
    if (overlapping > 0) parts.push(`${overlapping} open ${overlapping === 1 ? 'card overlaps' : 'cards overlap'} files someone holds`)
    if (mine > 0) parts.push(`${mine} ${mine === 1 ? 'is' : 'are'} yours already`)
    if (others > 0) parts.push(`${others} ${others === 1 ? 'is' : 'are'} held by others`)
    if (waiting > 0) parts.push(`${waiting} ${waiting === 1 ? 'waits' : 'wait'} on other work or ${waiting === 1 ? 'is' : 'are'} blocked`)
    const why = parts.length > 0 ? `${parts.join('; ')}.` : 'The board is empty.'
    return `Nothing to take right now. ${why} ${this.#renderBoard(board)}`
  }

  async claim(intentId: number, scope: TeamCallScope, files?: readonly string[]): Promise<string> {
    const caller = this.#caller(scope)
    const board = await this.#boardOf(caller)
    const intent = board.intents.find((entry) => entry.id === intentId)
    if (!intent) return `There is no intent #${intentId}. ${this.#renderBoard(board)}`

    /* Canonical before anything compares them, exactly as `add_intent` does.
       Trimming alone let `src/../README.md` and `README.md` claim the same
       file without either conflicting: two spellings of one path, and the
       one-agent-per-file guarantee is only as good as the comparison behind
       it. Absolute paths and ones that escape the project are refused rather
       than dropped — a path the board cannot own is not a path it should
       pretend to. */
    const outside = (files ?? []).filter(
      (file) => file.trim() !== '' && normalisePattern(file) === null,
    )
    if (outside.length > 0) {
      return `Refused: ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside this workspace. The board can only own paths inside the project it is for. Nothing was claimed.`
    }
    const declared = [
      ...new Set(
        (files ?? [])
          .map((file) => normalisePattern(file))
          .filter((file): file is string => file !== null),
      ),
    ]

    /* Addressed work, before anything else is decided about it. A card with
       no role reaches this and passes, which is every card on every board
       that has no flow. */
    const misaddressed = this.#misaddressed(board, intent, caller)
    if (misaddressed) return misaddressed

    if (intent.state === 'claimed' && intent.claim) {
      if (
        intent.claim.runtime === caller.runtime &&
        intent.claim.sessionId === caller.sessionId
      ) {
        /* Adding paths to work already in hand, which is the ordinary case:
           a claim's own answer tells an agent that owns nothing to "claim
           again with `files`", and that retry landed here and returned
           without reading them. The advice and the behaviour disagreed, and
           the advice was right. */
        const added = declared.filter((one) => !intent.files.includes(one))
        if (added.length === 0) {
          this.#renew(board, caller)
          this.#commit(board)
          return `You already hold #${intentId}.${this.#ownership(intent.files)}`
        }
        const taken = this.#conflictsWith(board, added, caller)
        if (taken.length > 0) {
          this.#signal(board, this.#actorOf(board, caller), 'conflict', intent, taken.join('; '))
          this.#commit(board)
          return `Refused: you hold #${intentId}, but ${taken.join('; ')}. The job is still yours; those paths are not.`
        }
        const widened = [...intent.files, ...added]
        this.#patchIntent(board, intentId, { files: widened })
        this.#renew(board, caller)
        this.#signal(board, this.#actorOf(board, caller), 'claimed', intent, widened.join(', '))
        this.#commit(board)
        return `You already hold #${intentId}, and now own ${added.join(', ')} as well.${this.#ownership(widened)}`
      }
      /* A stranded claim is taken over rather than refused. Its holder's lease
         ran out and it is not attached to anything — a crash, a closed laptop,
         an exhausted quota. Refusing here is what turns one crash into work
         nobody can ever pick up again. The signal says a takeover happened, so
         it is on the record rather than looking like an ordinary claim. */
      if (!this.#stranded(intent)) {
        return `Refused: #${intentId} is already claimed by ${this.#holderName(board, intent)} (${ago(intent.claim.at)}).`
      }
      this.#signal(
        board,
        this.#actorOf(board, caller),
        'released',
        intent,
        `taken over from ${this.#holderName(board, intent)}, whose claim ran out`,
      )
    }
    if (intent.state === 'done' || intent.state === 'abandoned') {
      return `Refused: #${intentId} is ${intent.state}.`
    }
    if (intent.state === 'blocked' && intent.blockedBy === 'hand') {
      return `Refused: #${intentId} was deliberately blocked${intent.blockedReason ? ` — ${intent.blockedReason}` : ''}. Only the user, or whoever blocked it, reopens it.`
    }
    const waiting = intent.dependsOn.filter((dep) => {
      // A dependency that is no longer on the board was settled and trimmed;
      // it must not read as forever-unfinished.
      const found = board.intents.find((entry) => entry.id === dep)
      return found !== undefined && found.state !== 'done'
    })
    if (waiting.length > 0) {
      return `Refused: #${intentId} depends on ${waiting.map((dep) => `#${dep}`).join(', ')}, not done yet. Claim something unblocked, or ask the holder.`
    }
    /* Whatever the job already owned, plus whatever the claimant now says it
       will touch — both canonical, so a path discovered at claim time is
       refereed exactly like one written down in advance. */
    const owned = [...new Set([...intent.files, ...declared])]
    const conflict = this.#conflictsWith(board, owned, caller)
    if (conflict.length > 0) {
      this.#signal(board, this.#actorOf(board, caller), 'conflict', intent, conflict.join('; '))
      this.#commit(board)
      return `Refused: the files of #${intentId} overlap a live claim — ${conflict.join('; ')}. Work elsewhere, or message the holder.`
    }
    this.#patchIntent(board, intentId, {
      state: 'claimed',
      files: owned,
      claim: {
        runtime: caller.runtime,
        sessionId: caller.sessionId,
        at: Date.now(),
        leaseUntil: Date.now() + LEASE_MS,
      },
      blockedReason: null,
      blockedBy: null,
    })
    this.#signal(board, this.#actorOf(board, caller), 'claimed', intent, owned.join(', ') || null)
    this.#commit(board)
    this.#port.audit({
      runtime: caller.runtime,
      sessionId: caller.sessionId,
      cwd: caller.cwd,
      kind: 'team/intent',
      decision: 'claimed',
    })
    const ownership = this.#ownership(owned)
    /* What the work this depends on left behind, handed over at the moment the
       job is taken — which is the moment it is needed and the only moment the
       agent is certainly listening.
       It used to be available and not delivered: `get_context` existed, and an
       agent had to know to call it. Correctness that depends on remembering a
       tool name is correctness that will be got wrong, and the failure is
       silent — work built against a contract nobody read. */
    const inherited = intent.dependsOn
      .map((id) => board.intents.find((entry) => entry.id === id))
      .filter((entry): entry is Intent => Boolean(entry?.handoff))
      .map((entry) => `#${entry.id} — ${entry.title}\n${entry.handoff as string}`)
    const carried =
      inherited.length > 0
        ? `\n\nWhat the work this depends on left for you:\n\n${inherited.join('\n\n')}`
        : ''
    return `Claimed #${intentId} — ${intent.title}.${ownership}${intent.detail ? `\n\n${intent.detail}` : ''}${carried}`
  }

  async conflicts(paths: readonly string[], scope: TeamCallScope): Promise<string> {
    const caller = this.#caller(scope)
    const board = await this.#boardOf(caller)
    // The same canonical form the claim was stored in: an answer of "clear
    // to work there" about a spelling nobody owns is worse than no answer.
    const cleaned = [
      ...new Set(
        paths.map((path) => normalisePattern(path)).filter((path): path is string => path !== null),
      ),
    ]
    const rejected = paths.filter((path) => normalisePattern(path) === null && path.trim() !== '')
    if (cleaned.length === 0) {
      return rejected.length > 0
        ? `No paths this board can referee were given: ${rejected.join(', ')} ${rejected.length === 1 ? 'is' : 'are'} outside the workspace.`
        : 'No paths were given, so there is nothing to check.'
    }
    const hits = this.#conflictsWith(board, cleaned, caller)
    if (hits.length === 0) return `No live claim overlaps ${cleaned.join(', ')}. Clear to work there.`
    return `Conflicts: ${hits.join('; ')}. Do not edit those paths — message the holder, or claim different work.`
  }

  async complete(
    intentId: number,
    args: { note?: string; handoff?: string; outcome?: string },
    scope: TeamCallScope,
  ): Promise<string> {
    const caller = this.#caller(scope)
    const board = await this.#boardOf(caller)
    const intent = board.intents.find((entry) => entry.id === intentId)
    if (!intent) return `There is no intent #${intentId}.`
    if (
      intent.state !== 'claimed' ||
      !intent.claim ||
      intent.claim.runtime !== caller.runtime ||
      intent.claim.sessionId !== caller.sessionId
    ) {
      return `Refused: you do not hold #${intentId}, so you cannot complete it. Claim it first, or leave it to ${this.#holderName(board, intent)}.`
    }
    /* What the card answered, checked against what its role may say before
       anything is written. An outcome a role never declared is a rule that
       will silently never fire, so it is refused here with the vocabulary
       spelled out rather than stored and puzzled over later. */
    const outcome = args.outcome?.trim() || null
    const refusal = this.#flows?.refuseOutcome(board.id, intent, outcome) ?? null
    if (refusal) return refusal
    this.#patchIntent(board, intentId, {
      state: 'done',
      claim: null,
      note: args.note?.trim() || null,
      handoff: args.handoff?.trim() || null,
      outcome,
    })
    this.#signal(board, this.#actorOf(board, caller), 'completed', intent, args.note?.trim() || null)
    const opened = this.#unblock(board, this.#actorOf(board, caller))
    this.#commit(board)
    this.#port.audit({
      runtime: caller.runtime,
      sessionId: caller.sessionId,
      cwd: caller.cwd,
      kind: 'team/intent',
      decision: 'completed',
    })
    /* After the board is written, never before: a rule that opens the next
       round adds cards through this same engine, and a run advanced against a
       board that had not yet recorded the completion would read its own round
       as unfinished. */
    this.#flows?.completed(board.id, { ...intent, state: 'done', outcome })
    const unblocked =
      opened.length > 0
        ? ` That unblocked ${opened.map((id) => `#${id}`).join(', ')}.`
        : ''
    const handoff = args.handoff
      ? ' Your context package is on the board for whoever works what depended on this.'
      : intent.dependsOn.length === 0 && board.intents.some((entry) => entry.dependsOn.includes(intentId))
        ? ' Consider leaving a context package (`complete_claim` with `context`) next time — something depended on this.'
        : ''
    return `Completed #${intentId} — ${intent.title}.${unblocked}${handoff}`
  }

  async release(
    intentId: number,
    args: { reason?: string; blocked?: boolean },
    scope: TeamCallScope,
  ): Promise<string> {
    const caller = this.#caller(scope)
    const board = await this.#boardOf(caller)
    const intent = board.intents.find((entry) => entry.id === intentId)
    if (!intent) return `There is no intent #${intentId}.`
    if (
      intent.state !== 'claimed' ||
      !intent.claim ||
      intent.claim.runtime !== caller.runtime ||
      intent.claim.sessionId !== caller.sessionId
    ) {
      return `Refused: you do not hold #${intentId}.`
    }
    const reason = args.reason?.trim() || null
    if (args.blocked) {
      this.#patchIntent(board, intentId, {
        state: 'blocked',
        claim: null,
        blockedReason: reason,
        // Blocked by a decision, not by the dependency graph: a completed
        // dependency must not silently put this back in play.
        blockedBy: 'hand',
      })
      this.#signal(board, this.#actorOf(board, caller), 'blocked', intent, reason)
    } else {
      this.#patchIntent(board, intentId, { state: 'open', claim: null, blockedBy: null })
      this.#signal(board, this.#actorOf(board, caller), 'released', intent, reason)
    }
    this.#commit(board)
    this.#port.audit({
      runtime: caller.runtime,
      sessionId: caller.sessionId,
      cwd: caller.cwd,
      kind: 'team/intent',
      decision: args.blocked ? 'blocked' : 'released',
    })
    return `Released #${intentId}. Its files are free again.`
  }

  async handoff(intentId: number, scope: TeamCallScope): Promise<string> {
    const caller = this.#caller(scope)
    const board = await this.#boardOf(caller)
    const intent = board.intents.find((entry) => entry.id === intentId)
    if (!intent) return `There is no intent #${intentId}.`
    if (intent.handoff) {
      return `Context package for #${intentId} — ${intent.title}:\n\n${intent.handoff}`
    }
    if (intent.note) {
      return `#${intentId} left no context package, only a note: ${intent.note}`
    }
    return `#${intentId} has no context package${intent.state === 'done' ? ' — it finished without leaving one' : ' yet; it is not done'}.`
  }

  async status(scope: TeamCallScope): Promise<string> {
    const caller = this.#caller(scope)
    /* The caller's room, and only that: this list is what an agent reads to
       learn who it may address, and it may address its own members. A caller
       in no room is told so rather than shown the folder. */
    const board = this.#roomOf(caller.runtime, caller.sessionId)
    if (!board) return NOT_IN_ROOM
    const peers = this.#membersOf(board, this.#port.peers())
    const lines: string[] = []
    for (const peer of peers) {
      const you = peer.runtime === caller.runtime && peer.sessionId === caller.sessionId
      const claims = board.intents
        .filter(
          (intent) =>
            intent.state === 'claimed' &&
            intent.claim?.runtime === peer.runtime &&
            intent.claim.sessionId === peer.sessionId,
        )
        .map((intent) => `#${intent.id} ${intent.title}`)
      lines.push(
        // Named the way the room names it, because this list is what an agent
        // reads to learn who it can address. Rendering the conversation title
        // instead gave two untitled Cursor members the same "(untitled) —
        // Cursor" row, so the roster offered no unique recipient at all — in
        // exactly the multi-member room the nicknames exist for — while
        // `agent_message` was already resolving those nicknames happily.
        /* `not open` rather than `idle`: both are reachable — a message
           reopens a conversation the desk is not holding — but they are not
           the same fact, and an agent deciding who to hand something to
           deserves to know which of its peers is warm. */
        `- ${this.#nameOn(board, peer)}${you ? ' (you)' : ''} · ${peer.here ? (peer.busy ? 'working' : 'idle') : 'not open'}${claims.length > 0 ? ` · holds ${claims.join(', ')}` : ''}`,
      )
    }
    const team =
      lines.length > 0
        ? `On this board:\n${lines.join('\n')}`
        : 'Nobody else is in this room.'
    const counts = board ? ` ${this.#counts(board)}.` : ' The board is empty.'
    // Naming is a write: a member seen here for the first time has just been
    // given the name this answer offers, and a name that does not survive the
    // next restart is not a name.
    if (board) this.#commit(board)
    return `${team}\n${counts} Address a message by its room name with agent_message; list work with list_intents.`
  }

  async send(
    args: { to: string; text: string; wake?: boolean },
    scope: TeamCallScope,
  ): Promise<string> {
    const caller = this.#caller(scope)
    /* Its own room's board. A message is addressed within a room, so a sender
       in none has nobody to address — and one in a room can reach that room's
       members and no others, which is what having several rooms in a project
       has to mean. */
    const board = this.#roomOf(caller.runtime, caller.sessionId)
    if (!board) return NOT_IN_ROOM
    // Declared before the first refusal, not after the last guard. Six paths
    // used to return above the point where this was created — board-only,
    // empty, oversized, unknown recipient, repeat, rate limit — so the
    // attempts most worth having a record of were the ones with none, and
    // the promise that every agent message reaches the audit was true only
    // of the messages that succeeded.
    const audit = (decision: string): void => {
      this.#port.audit({
        runtime: caller.runtime,
        sessionId: caller.sessionId,
        cwd: caller.cwd,
        kind: 'team/message',
        decision,
      })
    }
    if (!board.messaging) {
      // The sender learns it was muted either way. Whether the *user* learns
      // it is the setting: without a row, the one thing this surface implies
      // rather than shows is that nobody tried to talk.
      if (this.#settings.recordMutedAttempts) {
        const attempted = (args.text ?? '').trim()
        if (attempted !== '') {
          this.#message(board, {
            from: this.#actorOf(board, caller),
            to: null,
            text: attempted.slice(0, this.#settings.messageChars),
            state: 'refused',
            reason: 'board-only is on, so this was not sent. Claims and signals continue.',
          })
          this.#commit(board)
        }
      }
      audit('refused-board-only')
      return 'Refused: this board is in board-only mode — claims and signals, no messages. The user can turn messaging on from the Team panel.'
    }
    const text = (args.text ?? '').trim()
    if (text === '') {
      audit('refused-empty')
      return 'Refused: the message is empty.'
    }
    if (text.length > this.#settings.messageChars) {
      audit('refused-too-long')
      return `Refused: the message is ${text.length} characters; the limit is ${this.#settings.messageChars}. Put long material on the board as a context package instead.`
    }

    // Routing stays inside the sender's board. Reaching another project's
    // conversation by name would bypass that board's own messaging switch
    // and inbound policy, and a failed guess must not read back the global
    // roster — what is reachable is exactly what shares this board.
    const resolved = await this.#resolve(args.to, caller, board)
    if ('refusal' in resolved) {
      this.#message(board, {
        from: this.#actorOf(board, caller),
        to: null,
        text,
        state: 'refused',
        reason: resolved.refusal,
      })
      this.#commit(board)
      audit('refused-unknown-recipient')
      return `Refused: ${resolved.refusal}`
    }
    const peer = resolved.peer
    const address = {
      runtime: peer.runtime,
      sessionId: peer.sessionId,
      title: peer.title ?? peer.agent,
      nickname: this.#nameOn(board, peer),
    }

    // The loop guards, in the order that names the real problem first. Their
    // state is recorded only when a message is *accepted* — a transient
    // failure must not read back "you already sent exactly this" about a
    // text that never arrived.
    const pair = `${keyOf(caller.runtime, caller.sessionId)} ${keyOf(peer.runtime, peer.sessionId)}`
    const now = Date.now()
    const last = this.#lastText.get(pair)
    if (last && last.text === text && now - last.at < REPEAT_WINDOW_MS) {
      audit('refused-repeat')
      return 'Refused: you already sent exactly this message to that conversation. It was accepted once; repeating it is a loop, not emphasis.'
    }
    const recent = (this.#recent.get(pair) ?? []).filter((at) => now - at < RATE_WINDOW_MS)
    if (recent.length >= this.#settings.rateLimit) {
      audit('refused-rate-limit')
      return `Refused: rate limit — ${this.#settings.rateLimit} messages to one conversation per minute. Put shared state on the board instead of chatting.`
    }
    const accept = (): void => {
      this.#recent.set(pair, [...recent, now])
      this.#lastText.set(pair, { text, at: now })
    }

    const envelope = wrapContext(
      agentMessageSource(caller.agent, caller.title),
      `${text}\n\n${AGENT_MESSAGE_NOTICE}`,
    )
    const record = (state: TeamMessage['state'], reason: string | null = null): TeamMessage => {
      const entry = this.#message(board, {
        from: this.#actorOf(board, caller),
        to: address,
        text,
        state,
        reason,
        envelope,
      })
      this.#commit(board)
      return entry
    }

    // Safety rule 2, at the grain the host can see: a sender denied an
    // approval this turn does not get a direct line to a peer that might
    // not be. The message is held for the user, with the reason on it.
    if (this.#deniedInTurn.has(keyOf(caller.runtime, caller.sessionId))) {
      accept()
      audit('held-after-denial')
      record('held', 'Held automatically: the sender was denied an approval this turn. Release it if relaying is fine.')
      return 'Held: you were denied an approval this turn, so this message waits for the user to release it. Permission does not travel through a teammate.'
    }

    const inbound = this.inboundFor(peer.runtime, peer.sessionId)
    if (inbound === 'refuse') {
      audit('refused-inbound')
      record('refused', 'That conversation refuses inter-agent messages.')
      return 'Refused: that conversation refuses inter-agent messages. Leave what matters on the board.'
    }
    if (inbound === 'hold') {
      accept()
      audit('held')
      record('held', 'The user releases held messages from the Team panel.')
      return 'Held: that conversation holds inter-agent messages for the user to release. It is visible in their Team panel now.'
    }

    if (!peer.busy) {
      try {
        await this.#port.send(peer.runtime, peer.sessionId, envelope)
      } catch (error) {
        audit('send-failed')
        record('refused', `Sending failed: ${errorText(error)}`)
        return `Refused: sending failed — ${errorText(error)}. The guards were not charged; you may retry.`
      }
      accept()
      audit('delivered')
      record('delivered', null)
      this.#owe(peer, this.#actorOf(board, caller), [board.id])
      /* Answered in the name it was addressed by, and in the conversation's
         own name when it has one. Saying "Delivered to “Cursor”" to an agent
         that wrote `to: 'Gemini'` reads as having reached somebody else, and
         in a room of three Cursor members the sentence could not say which.
         Naming it *only* by the room name would lose the other half, which is
         the half a titled conversation is known by. */
      const room = this.#nameOn(board, peer)
      const also = peer.title && peer.title !== room ? ` (“${peer.title}”)` : ''
      return `Delivered to ${room}${also}. It starts their next turn.`
    }

    if (args.wake && peer.canSteer) {
      try {
        await this.#port.steer(peer.runtime, peer.sessionId, envelope)
      } catch (error) {
        audit('steer-failed')
        record('refused', `Steering failed: ${errorText(error)}`)
        return `Refused: steering failed — ${errorText(error)}. The guards were not charged; you may retry.`
      }
      accept()
      audit('steered')
      record('delivered', 'steered into the running turn')
      return `Delivered into “${peer.title ?? peer.agent}”'s running turn.`
    }

    const waiting = this.#pending.get(keyOf(peer.runtime, peer.sessionId)) ?? []
    if (waiting.length >= PENDING_LIMIT) {
      audit('refused-backlog')
      record('refused', `${PENDING_LIMIT} messages are already waiting on that conversation.`)
      return `Refused: ${PENDING_LIMIT} messages are already waiting on that conversation. The board is the place for state; messages are for surprises.`
    }
    accept()
    audit('queued')
    const entry = record('queued', null)
    this.#enqueue(peer, entry.id, [board.id], envelope)
    const why = args.wake
      ? `${peer.agent} cannot take input mid-turn, so it is queued instead`
      : 'it is queued'
    return `Queued: “${peer.title ?? peer.agent}” is mid-turn, so ${why} — read when the turn ends.`
  }

  /**
   * Notes that a conversation's next turn is an answer to someone.
   *
   * The room shows that answer when the turn ends; it is never sent back.
   * Sending it would wake the asker, whose reply would wake the receiver, and
   * two agents talking to each other forever on the user's tokens is the
   * failure this feature is designed against before any other.
   */
  #owe(peer: TeamPeer, asker: TeamActor, roots: readonly string[]): void {
    /* Recorded even when answers in the room are switched off. The debt is a
       fact about the room — this member was asked something and has not
       answered yet — and it is what lets the room say so when the turn dies
       instead. Only the *answer* is a preference; a member disappearing is
       not, and gating the debt here made the notice impossible to write for
       exactly the people who had turned the chatter down. */
    this.#owed.set(keyOf(peer.runtime, peer.sessionId), { asker, roots })
  }

  /**
   * Puts a woken conversation's answer in the room, addressed to whoever
   * asked, and marked `shown` — it is in the channel and in nobody's context.
   * One answer per delivery: the debt is cleared whether or not the turn
   * produced anything worth showing, so a later turn the user started does
   * not get posted as though it were a reply.
   */
  #show(
    runtime: RuntimeId,
    sessionId: string,
    answer: string | undefined,
    failure?: TeamTurnFailure,
  ): void {
    const key = keyOf(runtime, sessionId)
    const owed = this.#owed.get(key)
    if (!owed) return
    // Cleared on the turn that ended, answer or none: a turn that said
    // nothing has still answered, and the debt must not roll forward onto
    // whatever the user asks next.
    this.#owed.delete(key)
    const text = (answer ?? '').trim()
    const peer = this.#port.peers().find((p) => p.runtime === runtime && p.sessionId === sessionId)

    /*
     * A turn that died still has to be reported.
     *
     * This is the case the room used to lose entirely: the member was asked,
     * it worked, its usage window ran out, and the debt above was written off
     * without a word. Two of three reviews would appear and the third would
     * simply never exist — no row, no reason, nothing to distinguish "still
     * reading" from "stopped forty minutes ago". A notice is written before
     * the answer path, and outside the `answersInRoom` gate, because it is
     * not an answer: it is the room losing a member.
     */
    if (failure && text === '') {
      for (const root of owed.roots) {
        const board = this.#boards.get(root)
        if (!board) continue
        this.#notice(board, {
          about: peer
            ? this.#actorOf(board, peer)
            : { kind: 'agent', runtime, sessionId, title: '' },
          cause: failure.cause,
          text: failure.message,
        })
        this.#commit(board)
      }
      return
    }
    if (text === '' || !this.#settings.answersInRoom) return
    for (const root of owed.roots) {
      const board = this.#boards.get(root)
      if (!board) continue
      /* Built through `#actorOf` like every other entry, so the answer carries
         the room name too. It used to build its own actor from the peer's
         title, which is empty for an ACP conversation — so a room of three
         Cursor members showed three answers all attributed to "Cursor", the
         exact reading the nickname exists to prevent. A peer that has since
         gone still gets a row: the fallback keeps the shape rather than the
         name. */
      this.#message(board, {
        from: peer
          ? this.#actorOf(board, peer)
          : { kind: 'agent', runtime, sessionId, title: '' },
        to:
          owed.asker.kind === 'agent'
            ? {
                runtime: owed.asker.runtime,
                sessionId: owed.asker.sessionId,
                title: owed.asker.title,
                ...(owed.asker.nickname ? { nickname: owed.asker.nickname } : {}),
              }
            : null,
        text: text.slice(0, this.#settings.messageChars),
        state: 'shown',
        reason: null,
      })
      this.#commit(board)
    }
  }

  /** Who sent the message a delivery just landed — the one owed the answer. */
  #askerOf(roots: readonly string[], entryId: string): TeamActor | null {
    for (const root of roots) {
      const board = this.#boards.get(root)
      const entry = board?.channel.find((one) => one.id === entryId)
      if (entry && entry.kind === 'message') return entry.from
    }
    return null
  }

  // ------------------------------------------------------------- host signals

  /**
   * The host thinks a conversation's turn just ended — and says so twice for
   * one turn, because `turn/completed` and the trailing idle status both
   * nudge. Deliveries are single-flighted per receiver: one nudge drains,
   * a concurrent one leaves, and at most one message goes out per call —
   * the next waits for the turn *this* delivery starts to end.
   */
  async onTurnEnded(
    runtime: RuntimeId,
    sessionId: string,
    /**
     * Present only on `turn/completed`, which is the signal that actually
     * knows what the turn said. The trailing idle nudge passes nothing and
     * must not be mistaken for a turn that answered with silence.
     */
    completed?: { readonly answer?: string; readonly failure?: TeamTurnFailure },
  ): Promise<void> {
    const key = keyOf(runtime, sessionId)
    /* A turn ending is the strongest evidence there is that a conversation is
       alive, so it renews whatever that conversation holds — including through
       a long turn that touched the board only at the start. */
    const holder = this.#port
      .peers()
      .find((peer) => peer.runtime === runtime && peer.sessionId === sessionId)
    if (holder) {
      for (const board of this.#boards.values()) {
        if (this.#renew(board, holder)) this.#commit(board)
      }
    }
    if (completed) this.#show(runtime, sessionId, completed.answer, completed.failure)
    // The turn is over; its denials no longer gate the sender's mail.
    this.#deniedInTurn.delete(key)
    if (this.#draining.has(key)) return
    // Before anything is taken off the queue: a row from a room this
    // conversation is no longer in must never be sent.
    this.#dropCrossRoom(key)
    const waiting = this.#pending.get(key)
    if (!waiting || waiting.length === 0) return
    this.#draining.add(key)
    try {
      // Re-read liveness *inside* the flight: the state that made the nudge
      // fire is not necessarily the state now.
      const peer = this.#port
        .peers()
        .find((p) => p.runtime === runtime && p.sessionId === sessionId)
      if (!peer || peer.busy || peer.queuedByUser > 0) return
      const next = waiting.shift()
      if (waiting.length === 0) this.#pending.delete(key)
      if (!next) return
      try {
        await this.#port.send(runtime, sessionId, next.envelope)
        this.#updateEntry(next.roots, next.entryId, { state: 'delivered', reason: null })
        const asker = this.#askerOf(next.roots, next.entryId)
        if (asker) this.#owe(peer, asker, next.roots)
      } catch (error) {
        this.#updateEntry(next.roots, next.entryId, {
          state: 'refused',
          reason: `Sending failed: ${errorText(error)}`,
        })
      }
    } finally {
      this.#draining.delete(key)
    }
  }

  /** A conversation went away; what waited on it is refused, never dropped. */
  onSessionClosed(runtime: RuntimeId, sessionId: string): void {
    const key = keyOf(runtime, sessionId)
    this.#settle(key, 'The conversation closed before the message was read.')
    // Whatever it proved, it proved about a process that is gone. The same id
    // reattached to a fresh agent has proved nothing yet — see `#used`.
    this.#used.delete(key)
  }

  /**
   * A whole runtime went away — its process died, its health failed, its
   * account was removed. Every conversation it was carrying loses its mail.
   *
   * `session/closed` is not enough on its own: `registry.detachAll` takes
   * sessions down without one, so a queued message sat marked `queued`
   * forever, which is precisely the silent non-delivery this surface exists
   * to prevent — and it contradicted the documented restart behaviour, which
   * promises that what could not be delivered is refused with a reason.
   */
  onRuntimeDetached(runtime: RuntimeId, reason?: string): void {
    const prefix = `${runtime}\u0000`
    for (const key of [...this.#pending.keys()]) {
      if (!key.startsWith(prefix)) continue
      this.#settle(key, reason ?? 'The agent stopped before the message was read.')
    }
    for (const key of [...this.#owed.keys()]) {
      if (key.startsWith(prefix)) this.#owed.delete(key)
    }
    /* And the evidence that its conversations could reach the board. The whole
       point of witnessing rather than trusting the runtime's advertisement is
       that the answer belongs to a *process*; carrying it across a restart is
       the stale evidence this was built to avoid, one level up. */
    for (const key of [...this.#used]) {
      if (key.startsWith(prefix)) this.#used.delete(key)
    }
  }

  /**
   * Refuses whatever is waiting on one conversation from a room it has left.
   *
   * `#pending` is keyed by the receiver and each row remembers only which
   * board to write the outcome to, so nothing in the delivery path asked
   * whether the receiver was *still there*: a message queued for a busy member
   * who then moved rooms was delivered on its next turn, carrying an envelope
   * out of a board it was no longer on. Called both when membership moves —
   * so the sender learns at once rather than whenever the receiver next
   * finishes something — and again inside the drain, which is the guarantee,
   * because any future path that changes membership passes through neither
   * `joinRoom` nor `leaveRoom` for free.
   *
   * The user's own posts are exempt: their authority does not come from
   * membership, and a message a person released by hand is theirs to place.
   */
  #dropCrossRoom(key: string): void {
    this.#refusePending(
      key,
      (pending) =>
        pending.roots.some((id) => {
          const board = this.#boards.get(id)
          return board !== undefined && !board.members.includes(key as SessionKey)
        }),
      'They left the room before the message was read.',
    )
  }

  /**
   * Refuses the pending rows for one receiver that a predicate picks out.
   *
   * Kept general because the two callers differ only in *which* rows, and the
   * one that did not go through here got it wrong: deleting a room called
   * `#settle`, which is receiver-wide, so a message the user had queued in a
   * different room was refused by a delete that had nothing to do with it and
   * never reached the agent it was written for.
   *
   * The user's own posts and hand-released messages are exempt throughout:
   * their authority does not come from membership, so neither a move nor a
   * delete unwrites them.
   */
  #refusePending(
    key: string,
    doomed: (pending: PendingDelivery) => boolean,
    reason: string,
  ): void {
    const waiting = this.#pending.get(key)
    if (!waiting || waiting.length === 0) return
    const kept: PendingDelivery[] = []
    for (const pending of waiting) {
      if (pending.byUser || !doomed(pending)) {
        kept.push(pending)
        continue
      }
      this.#updateEntry(pending.roots, pending.entryId, { state: 'refused', reason })
    }
    if (kept.length === waiting.length) return
    if (kept.length === 0) this.#pending.delete(key)
    else this.#pending.set(key, kept)
  }

  /** Refuses everything waiting on one conversation, with the reason why. */
  #settle(key: string, reason: string): void {
    this.#deniedInTurn.delete(key)
    this.#owed.delete(key)
    const waiting = this.#pending.get(key)
    if (!waiting) return
    this.#pending.delete(key)
    for (const pending of waiting) {
      this.#updateEntry(pending.roots, pending.entryId, { state: 'refused', reason })
    }
  }

  /**
   * The user denied this conversation an approval, mid-turn. Until that turn
   * ends its outbound messages are held — see the rule at `#deniedInTurn`.
   */
  noteDenial(runtime: RuntimeId, sessionId: string): void {
    this.#deniedInTurn.add(keyOf(runtime, sessionId))
  }

  // ------------------------------------------------------------------ innards

  #stateOf(board: Board): TeamState {
    return {
      id: board.id,
      name: board.name,
      members: [...board.members],
      root: board.root,
      intents: [...board.intents],
      channel: [...board.channel],
      messaging: board.messaging,
      nicknames: { ...board.nicknames },
      roles: { ...board.roles },
      // What `inboundFor` resolves, for each member of this room.
      inbound: Object.fromEntries(
        board.members.map((key) => [key, this.#inbound.get(key) ?? this.#settings.inboundDefault]),
      ),
      plans: [...board.plans],
      problem: this.#problem,
    }
  }

  /** A room by its id, or nothing. Rooms are made on purpose, never on sight. */
  #board(id: string): Board | undefined {
    return this.#boards.get(id)
  }

  /** The same, for the many call sites that cannot proceed without one. */
  #boardById(id: string): Board {
    const board = this.#boards.get(id)
    if (!board) throw new Error(`There is no room ${id}.`)
    return board
  }

  /**
   * Start a room in a project.
   *
   * A project can hold as many as the work wants, the way it holds sessions,
   * and each gets a board of its own: its own task list, its own members, its
   * own channel. Nothing is created implicitly — a room exists because
   * somebody made one and gave it a name.
   *
   * The root is canonicalised through the host's resolver, the same one
   * `joinRoom` asks. A linked worktree is a real folder with a path of its
   * own, and a room keyed by that path was invisible in a tree that groups a
   * worktree under its project *and* unjoinable, because every conversation
   * in it resolved to a root the room did not have. Identity is decided here,
   * so every caller gets the guarantee rather than each remembering to ask.
   */
  async createRoom(root: string, name: string): Promise<Board> {
    const called = name.trim() || folderOf(root)
    /* A folder in no workspace keeps its own path: the host knows nothing
       about it, and refusing would make a room unmakeable rather than
       correctly keyed. */
    const project = (await this.#port.rootOf(root)) ?? root
    const board: Board = {
      id: `room-${Date.now().toString(36)}-${(this.#nextRoom += 1).toString(36)}`,
      name: called,
      members: [],
      root: project,
      nextIntent: 1,
      nextPlan: 1,
      plans: [],
      messaging: true,
      intents: [],
      channel: [],
      nicknames: {},
      roles: {},
      roster: {},
    }
    this.#boards.set(board.id, board)
    this.#commit(board)
    return board
  }

  #nextRoom = 0

  /** The rooms in one project, oldest first. */
  roomsFor(root: string): readonly TeamState[] {
    return [...this.#boards.values()]
      .filter((board) => board.root === root)
      .map((board) => this.#stateOf(board))
  }

  /**
   * Puts a conversation in a room. It leaves whichever room it was in.
   *
   * Rooms subdivide a project; they never span one. So the two boundaries
   * compose — a room reaches only its members, and its members are only ever
   * conversations from its own project — and this is where the second one is
   * enforced. A membership written down and then filtered out later is worse
   * than a refusal: the rail draws it, and nothing it promises works.
   *
   * The check goes through the host's own resolver rather than comparing
   * paths, because a linked git worktree lives outside the checkout it
   * belongs to and still shares its board.
   */
  async joinRoom(
    id: string,
    runtime: RuntimeId,
    sessionId: string,
    /**
     * What the joining conversation is, when the caller already knows — the
     * host does, because it had to read the conversation to let the join
     * through at all. Written straight into the board's roster so a member
     * added from a stored conversation can be *drawn* immediately, rather
     * than appearing as a key nobody can name until it is next opened.
     */
    card?: RememberedMember,
  ): Promise<void> {
    const board = this.#boardById(id)
    const key = keyOf(runtime, sessionId)
    const live = this.#port
      .peers()
      .find((one) => one.runtime === runtime && one.sessionId === sessionId)
    /* The folder the joining conversation works in, whichever way we know it:
       the live peer when the desk holds one, the caller's card when it does
       not. Checked here rather than trusted from the caller — `team/room/join`
       does its own check with a better sentence, and this one is what makes
       the *method* safe rather than the one caller that happens to be careful.
       A room that accepts a conversation from another project hands it a board
       belonging to work it has never done. */
    const from = live?.cwd ?? card?.cwd ?? null
    if (from !== null) {
      const root = await this.#port.rootOf(from)
      if (root !== board.root) {
        throw new Error(
          `That conversation is working in ${from}, which is outside ${board.root}. A room only holds conversations from its own project.`,
        )
      }
    }
    for (const other of this.#boards.values()) {
      if (other.id === id || !other.members.includes(key)) continue
      other.members = other.members.filter((one) => one !== key)
      delete other.roster[String(key)]
      this.#commit(other)
    }
    if (card) board.roster[String(key)] = card
    else if (live) this.#remember(board, key, live)
    if (!board.members.includes(key)) {
      board.members = [...board.members, key]
    }
    this.#commit(board)
    this.#dropCrossRoom(key)
    // A fresh stay deserves fresh tries; see `TeamPort.membershipChanged`.
    this.#port.membershipChanged(runtime, sessionId)
  }

  /**
   * A member nothing can reach any more, taken out of every room it is in.
   *
   * The one thing that ends a membership without a person ending it, and it
   * is deliberately not a policy this module decides. Reaching a conversation
   * is the host's — it owns the handles and the agents' error codes — so the
   * host says *when*, having heard the agent's own answer that the id names
   * nothing, or having been refused twice running by an agent that is up.
   * Anything softer than that leaves the member where it is: an agent that is
   * down, or busy, or slow comes back, and so does its conversation.
   *
   * Membership has to be able to end this way now that it is what the roster
   * draws. A room used to hide the unreachable by only ever listing open
   * conversations — which is the same reason every room came back empty after
   * a relaunch — and drawing membership honestly means saying when a member
   * has stopped existing rather than leaving a row nobody can address. The
   * channel is told, because a room that quietly loses a member is a room you
   * cannot trust to have kept the others.
   *
   * `said` is the host's sentence about why, in the agent's own words.
   */
  forget(runtime: RuntimeId, sessionId: string, said: string): void {
    const key = keyOf(runtime, sessionId)
    /* Whatever was waiting on this member is not going to be read, and a row
       left saying `queued` is a promise the room can no longer keep — it
       would sit there until a restart rewrote it, which is the one thing
       `load` exists to stop being the only correction. Settled first, while
       the membership those rows were queued under is still on the board.
       `onSessionClosed` has always done this for a conversation that closed;
       a member that can never be reopened is the same event arriving by a
       different route. */
    this.#settle(key, said)
    for (const board of this.#boards.values()) {
      if (!board.members.includes(key)) continue
      const remembered = board.roster[String(key)]
      board.members = board.members.filter((one) => one !== key)
      delete board.roster[String(key)]
      delete board.roles[String(key)]
      /* `nicknames` is deliberately left alone, the way it is when somebody
         leaves: the channel's own rows already name this member, and one that
         somehow comes back keeps the word people were using for it. */
      this.#notice(board, {
        about: {
          kind: 'agent',
          runtime,
          sessionId,
          title: remembered?.title ?? '',
          ...(board.nicknames[String(key)] ? { nickname: board.nicknames[String(key)]! } : {}),
        },
        cause: 'gone',
        text: said,
      })
      this.#commit(board)
    }
    /* And anything queued under a *different* room's membership, for the same
       reason `leaveRoom` does it: the rows are keyed by receiver, and this
       receiver is now in no room at all. */
    this.#dropCrossRoom(key)
  }

  /** Takes a conversation out of a room, leaving it on its own. */
  leaveRoom(id: string, runtime: RuntimeId, sessionId: string): void {
    const board = this.#boardById(id)
    const key = keyOf(runtime, sessionId)
    if (!board.members.includes(key)) return
    board.members = board.members.filter((one) => one !== key)
    /* The photograph goes with the membership: it exists so the room can draw
       a member it cannot see, and this is no longer a member. The *nickname*
       stays, as it always has, so a conversation that comes back keeps the
       word the channel already used for it. */
    delete board.roster[String(key)]
    /* The role does *not* stay. A nickname is what a member is called and
       survives it leaving; a role is a permission to claim, and a member that
       is no longer here must not be able to claim work addressed to the seat
       it used to hold. */
    delete board.roles[String(key)]
    this.#commit(board)
    this.#dropCrossRoom(key)
    this.#port.membershipChanged(runtime, sessionId)
  }

  renameRoom(id: string, name: string): void {
    const board = this.#boardById(id)
    const called = name.trim()
    if (called === '' || called === board.name) return
    board.name = called
    this.#commit(board)
  }

  /**
   * Puts a room away for good, and says what went with it.
   *
   * Never refused. The person is the referee everywhere else on this plane —
   * `intentAction` takes a claim away whether or not the agent holding it
   * would agree — and a room somebody wants gone is not the one place to
   * start overruling them. What the verb owes them instead is the truth
   * *before* they press: the counts come back so a dialog can name the work,
   * the members and the messages that are about to stop existing, and the
   * surface can say it in a sentence rather than making somebody guess.
   *
   * The conversations themselves are untouched. They stop being members and
   * carry on exactly as they were — a room is a place to work together, not
   * a container that owns what is in it, and deleting one must not reach into
   * an agent's own history.
   */
  async deleteRoom(
    id: string,
  ): Promise<{ name: string; intents: number; members: number; messages: number }> {
    const board = this.#boardById(id)
    const gone = {
      name: board.name,
      intents: board.intents.length,
      members: board.members.length,
      messages: board.channel.filter((entry) => entry.kind === 'message').length,
    }
    /* Whatever was waiting on a member of this room, *from this room*, is
       refused rather than delivered into a board that no longer exists — the
       same rule as leaving, arrived at the other way round.
       From this room and no other: `#settle` is receiver-wide, and using it
       here meant deleting one room refused a message queued in a different
       one, which the receiver then never got. */
    for (const member of board.members) {
      this.#refusePending(
        member,
        (pending) => pending.roots.includes(id),
        'The room was deleted before the message was read.',
      )
    }
    this.#boards.delete(id)
    /* Awaited, because a delete that reports success while its unlink is still
       queued can be acknowledged, empty the interface, and hand the room back
       from its own file at the next launch — and the writer has nowhere to
       report that, since the board it would hang `problem` on has just gone.
       A file that will not go means the room is still there, so it goes back
       in memory too: what a person was told and what is on disk must not
       disagree about whether a room exists. */
    const failed = await this.#erase(join(this.#dir, `${encodeURIComponent(id)}.json`))
    if (failed) {
      this.#boards.set(id, board)
      this.#commit(board)
      throw new Error(
        `“${board.name}” could not be deleted: ${failed.message}. It is still here, and nothing was lost.`,
      )
    }
    this.#port.removed(id)
    return gone
  }

  /** The room a conversation is in, if it is in one. */
  #roomOf(runtime: string, sessionId: string): Board | undefined {
    const key = keyOf(runtime, sessionId)
    return [...this.#boards.values()].find((board) => board.members.includes(key))
  }

  #caller(scope: TeamCallScope): TeamPeer {
    if (!scope.runtime || !scope.sessionId) throw new Error(UNATTRIBUTED)
    const peer = this.#port
      .peers()
      .find((p) => p.runtime === scope.runtime && p.sessionId === scope.sessionId)
    if (!peer) throw new Error(NOT_LIVE)
    /* Every team verb comes through here, so this is where reaching the board
       is *observed* rather than declared. The rail used to say a member could
       take jobs whenever its runtime advertised plugin tools — and a real run
       had a member that advertised them, described them accurately when asked,
       and could not invoke one. The chip built for exactly that member never
       fired, because a capability is a claim and this is evidence. */
    this.#used.add(keyOf(peer.runtime, peer.sessionId))
    return peer
  }

  /** Members observed calling a team verb, this run. Never persisted: a name
   *  written down last week is no evidence about the process running now. */
  readonly #used = new Set<string>()

  /**
   * The board this caller reads, which is its room's and no other.
   *
   * It used to be the folder's: any conversation open in a project shared one
   * board with every other, which made "a room" something you fell into rather
   * than something you joined. A project holds several rooms now, so
   * membership is the only thing that can answer this — and a conversation in
   * none has no board, which is the ordinary case for a session working alone.
   */
  async #boardOf(caller: TeamPeer): Promise<Board> {
    const board = this.#roomOf(caller.runtime, caller.sessionId)
    if (!board) throw new Error(NOT_IN_ROOM)
    return board
  }

  /**
   * The conversations in this room, in the order it lists them.
   *
   * Membership, not the folder they happen to be open in, and not what the
   * desk happens to be holding this minute. A room reaches its own members
   * and nothing else — which is the whole reason a project can hold more than
   * one of them — and a member is in it until a person takes it out or its
   * agent says the conversation is gone.
   *
   * So a member with no live conversation is not dropped, it is drawn from
   * what the board remembers and marked `here: false`. This used to return
   * only the live ones, which read correctly for as long as one process
   * lived: quit the desk and every room came back empty, because a relaunched
   * host holds no conversation until somebody opens one. The board still had
   * its members, the sidebar still drew them under the room, and the room's
   * own rail said "Nobody here yet" over a channel full of what they had
   * said. Nothing had happened to them. The desk had restarted.
   *
   * The same reasoning was already applied one size down — a member whose
   * *agent* restarted stays listed and is reopened by the next delivery
   * (`SessionRecord.detached`) — and the rule it set is the rule here: ask
   * whether a person closed this, not whether there is a handle.
   *
   * Seeing a member live is also when the board writes down what it will need
   * to draw that member after the next quit, which is why this is the one
   * place membership is resolved.
   */
  #membersOf(board: Board, peers: readonly TeamPeer[]): TeamPeer[] {
    const live = new Map(peers.map((peer) => [keyOf(peer.runtime, peer.sessionId), peer]))
    const out: TeamPeer[] = []
    for (const key of board.members) {
      const peer = live.get(key)
      if (peer) {
        this.#remember(board, key, peer)
        out.push(peer)
        continue
      }
      const away = this.#awayPeer(board, key)
      if (away) out.push(away)
    }
    return out
  }

  /**
   * A member the desk does not have open, as a peer.
   *
   * Everything a delivery needs is the key, which the board has; everything
   * the roster *draws* is the photograph. A member with neither — a key
   * written down before the board remembered anything about its members — is
   * left out rather than drawn as a blank row: there is genuinely nothing to
   * say about it until it is seen once, and opening the conversation is what
   * says it.
   */
  #awayPeer(board: Board, key: SessionKey): TeamPeer | null {
    const remembered = board.roster[String(key)]
    if (!remembered) return null
    const { runtime, id } = splitSessionKey(key)
    return {
      runtime,
      sessionId: String(id),
      title: remembered.title,
      cwd: remembered.cwd,
      agent: remembered.agent,
      // Not open is not working, and it can take no injection: both of these
      // are facts about a live turn, and there is no turn.
      busy: false,
      canSteer: false,
      queuedByUser: 0,
      ...(remembered.model !== undefined ? { model: remembered.model } : {}),
      here: false,
    }
  }

  /** Writes down what the board will need to draw this member after a quit. */
  #remember(board: Board, key: SessionKey, peer: TeamPeer): void {
    const held = board.roster[String(key)]
    const model = peer.model ?? null
    if (
      held &&
      held.title === peer.title &&
      held.agent === peer.agent &&
      held.cwd === peer.cwd &&
      (held.model ?? null) === model
    ) {
      return
    }
    board.roster[String(key)] = {
      title: peer.title,
      agent: peer.agent,
      cwd: peer.cwd,
      model,
      at: Date.now(),
    }
    /* Committed by the caller. Every path that resolves members either
       commits already — `peersFor` does, for the nicknames it mints on the
       same read — or is a delivery, which commits the row it writes. */
  }

  /**
   * A claim is stranded when its lease has run out *and* nobody is holding it.
   *
   * Both halves are needed. The lease alone would strand a member that is
   * simply thinking for a long time; being absent alone would strand every
   * claim the moment a laptop sleeps, and take it back from an agent that is
   * about to return. Computed on read rather than swept by a timer: a lease is
   * a fact about the clock, so asking is always right and a timer would have to
   * survive restarts, disposal and a machine that was asleep.
   */
  #stranded(intent: Intent): boolean {
    const claim = intent.claim
    if (intent.state !== 'claimed' || !claim?.leaseUntil) return false
    if (Date.now() < claim.leaseUntil) return false
    return !this.#port
      .peers()
      .some((peer) => peer.runtime === claim.runtime && peer.sessionId === claim.sessionId)
  }

  /**
   * The holder was heard from, so its claims keep running.
   *
   * Called from every board verb and from the end of every turn — anything
   * that proves the conversation is alive. Renewing on *use* rather than on a
   * heartbeat means the signal is the work itself, and an agent that has gone
   * quiet for the whole lease genuinely has.
   */
  /**
   * Push this caller's leases out, and say whether any moved.
   *
   * The caller commits. `#patchIntent` only edits the board in memory — the
   * write and the `team/changed` push are `#commit`'s — so a renewal that
   * stopped here was a renewal that did not survive a restart: reload the same
   * directory and `leaseUntil` was back at the value the claim was made with.
   * A restart after that original deadline, while the holder happened to be
   * unattached, then let a second agent take over work that had been renewed
   * seconds earlier, and both would own the same paths. Returning the answer
   * rather than committing here keeps the double-write off the one call site
   * that already commits.
   */
  #renew(board: Board, caller: TeamPeer): boolean {
    const until = Date.now() + LEASE_MS
    let moved = false
    for (const intent of board.intents) {
      if (
        intent.state === 'claimed' &&
        intent.claim?.runtime === caller.runtime &&
        intent.claim.sessionId === caller.sessionId
      ) {
        this.#patchIntent(board, intent.id, { claim: { ...intent.claim, leaseUntil: until } })
        moved = true
      }
    }
    return moved
  }

  #actorOf(board: Board, caller: TeamPeer): TeamActor {
    return {
      kind: 'agent',
      runtime: caller.runtime,
      sessionId: caller.sessionId,
      title: caller.title ?? caller.agent,
      nickname: this.#nameOn(board, caller),
    }
  }

  /**
   * Who is holding this, in the name the room uses.
   *
   * This predated nicknames and named the holder by agent and conversation
   * title — `Codex — “(untitled)”` for anyone whose conversation has not been
   * titled yet, which is every conversation for its first minutes. A refusal
   * is read by the agent that was turned away and, through the channel, by the
   * person watching; both of them know that holder as GPT, because that is
   * what the card, the rail, and every signal call it. Naming one member three
   * different ways in three places is how one member starts to look like three.
   */
  /**
   * What a claim owns, in one sentence — or that it owns nothing.
   *
   * Owning nothing is said out loud. A claim with no paths still stops a
   * second agent taking the *job*, but it stops nobody editing the same file,
   * and an agent told only "Claimed #1" has no reason to know the difference —
   * so it never declares any and the gap never closes. Said in one place
   * because a claim can now be widened after the fact, and two spellings of
   * this would drift.
   */
  /**
   * What role a member holds in a room, or nothing.
   *
   * Nothing is the ordinary answer: a room without a flow gives nobody a
   * role, and a member with no role is refereed exactly as it was before
   * roles existed.
   */
  roleOf(room: string, runtime: string, sessionId: string): string | null {
    const board = this.#board(room)
    return board?.roles[keyOf(runtime, sessionId)] ?? null
  }

  /**
   * Gives a member its role in a room, or takes it away with `null`.
   *
   * The flow runner calls this as it seats; it is here because the board is
   * where a member is named and where the claim is refereed, and a role kept
   * anywhere else would be a second source of truth for the one question
   * `claim_next` has to answer.
   */
  setRole(room: string, runtime: string, sessionId: string, role: string | null): void {
    const board = this.#boardById(room)
    const key = keyOf(runtime, sessionId)
    if (role === null) {
      if (!(key in board.roles)) return
      delete board.roles[key]
    } else {
      if (board.roles[key] === role) return
      board.roles[key] = role
    }
    this.#commit(board)
  }

  /**
   * Why this caller may not take a card somebody addressed to a role — or
   * null, which is the answer for every card that carries no role.
   *
   * The refusal names the role and who holds it, because the failure it
   * replaces was silent: with no assignee, `claim_next` handed a reviewer the
   * fix card and a fixer its own pull request, and the only workaround was to
   * put them in separate rooms, which then made the loop impossible to close.
   */
  #misaddressed(board: Board, intent: Intent, caller: TeamPeer): string | null {
    const wanted = intent.role
    if (!wanted) return null
    const key = keyOf(caller.runtime, caller.sessionId)
    if (board.roles[key] === wanted) return null
    /* Named the way the room names them — through the same lazy naming the
       rail and every signal use, so the refusal says "Codex holds that role"
       rather than nothing at all for the first minutes of a conversation's
       life, which is exactly when a seat is most likely to ask. */
    const live = this.#membersOf(board, this.#port.peers())
    const holders = board.members
      .filter((member) => board.roles[member] === wanted)
      .map((member) => {
        const { runtime, id } = splitSessionKey(member)
        const peer = live.find((one) => one.runtime === runtime && one.sessionId === String(id))
        return peer ? this.#nameOn(board, peer) : board.nicknames[member]
      })
      .filter((name): name is string => Boolean(name))
    const held = board.roles[key]
    const who =
      holders.length > 0
        ? ` ${holders.join(', ')} ${holders.length === 1 ? 'holds' : 'hold'} that role`
        : ' Nobody on this board holds that role, so it is waiting for whoever does'
    return `Refused: #${intent.id} is addressed to ${wanted}, and you are ${held ? `the ${held}` : 'not holding a role here'}.${who}.`
  }

  #ownership(files: readonly string[]): string {
    return files.length > 0
      ? ` You own ${files.join(', ')} until you complete or release it; nobody else can claim work that overlaps them.`
      : ' It owns no files yet, so nothing stops another conversation editing the same ones — claim again with `files` once you know which you will touch.'
  }

  #holderName(board: Board, intent: Intent): string {
    if (!intent.claim) return 'nobody'
    const peer = this.#port
      .peers()
      .find(
        (p) => p.runtime === intent.claim?.runtime && p.sessionId === intent.claim.sessionId,
      )
    return peer ? this.#nameOn(board, peer) : 'a conversation that is not running'
  }

  /** Live claims whose files overlap these paths, excluding the caller's own. */
  #conflictsWith(board: Board, paths: readonly string[], caller: TeamPeer): string[] {
    const hits: string[] = []
    for (const intent of board.intents) {
      if (intent.state !== 'claimed' || !intent.claim) continue
      if (intent.claim.runtime === caller.runtime && intent.claim.sessionId === caller.sessionId) {
        continue
      }
      /* A stranded claim owns nothing. Its holder's lease ran out and it is not
         attached to anything, so the paths are free — and if they were not, a
         takeover would pass the state check and then be refused by the files
         the very claim it is taking over still held, which is how this was
         found. A claim that can be taken over has already stopped owning
         things; the two rules have to agree. */
      if (this.#stranded(intent)) continue
      const overlap = intent.files.some((owned) => paths.some((path) => overlaps(owned, path)))
      if (overlap) {
        hits.push(`${intent.files.join(', ')} is held by #${intent.id} (${this.#holderName(board, intent)})`)
      }
    }
    return hits
  }

  #addIntent(
    board: Board,
    args: {
      title: string
      detail?: string
      files?: readonly string[]
      dependsOn?: readonly number[]
      plan?: number
      /** Who the card is for. Only a flow sets this; everything else adds open work. */
      role?: string
    },
    by: TeamActor,
  ): Intent {
    const dependsOn = [...new Set(args.dependsOn ?? [])].filter((dep) =>
      board.intents.some((intent) => intent.id === dep),
    )
    const blocked = dependsOn.some(
      (dep) => board.intents.find((intent) => intent.id === dep)?.state !== 'done',
    )
    const intent: Intent = {
      id: board.nextIntent,
      title: args.title.trim(),
      detail: args.detail?.trim() || null,
      state: blocked ? 'blocked' : 'open',
      // Canonical on the way in: what is stored is what every later
      // comparison sees, so no claim can be dodged by spelling.
      files: [
        ...new Set(
          (args.files ?? [])
            .map((file) => normalisePattern(file))
            .filter((file): file is string => file !== null),
        ),
      ],
      dependsOn,
      /* Only a goal that exists: a job pointing at a plan nobody made would
         group under a heading the board cannot draw, and disappear. */
      plan: board.plans.some((entry) => entry.id === args.plan) ? (args.plan as number) : null,
      /* Null rather than absent, so a card added without one is explicitly
         open to anybody rather than merely missing a field. */
      role: args.role?.trim() || null,
      outcome: null,
      claim: null,
      blockedReason: null,
      blockedBy: blocked ? 'graph' : null,
      handoff: null,
      note: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    board.nextIntent += 1
    board.intents.push(intent)
    this.#trimIntents(board)
    this.#signal(board, by, 'added', intent, intent.files.join(', ') || null)
    this.#commit(board)
    return intent
  }

  #patchIntent(board: Board, id: number, patch: Partial<Intent>): void {
    board.intents = board.intents.map((intent) =>
      intent.id === id ? { ...intent, ...patch, updatedAt: Date.now() } : intent,
    )
  }

  /**
   * Blocked intents whose dependencies are now all done become open, with a
   * signal each. Only graph blocks: an intent somebody *decided* to stop
   * (`blockedBy: 'hand'`) stays stopped — something other than the graph is
   * wrong, and only a person or the blocker knows when it is not.
   */
  #unblock(board: Board, by: TeamActor): number[] {
    const opened: number[] = []
    for (const intent of board.intents) {
      if (intent.state !== 'blocked') continue
      if (intent.blockedBy === 'hand') continue
      const ready = intent.dependsOn.every((dep) => {
        const found = board.intents.find((entry) => entry.id === dep)
        // Trimmed dependencies were settled; absence is not "unfinished".
        return found === undefined || found.state === 'done'
      })
      if (ready && intent.dependsOn.length > 0) {
        this.#patchIntent(board, intent.id, { state: 'open', blockedReason: null, blockedBy: null })
        this.#signal(board, by, 'unblocked', intent, null)
        opened.push(intent.id)
      }
    }
    return opened
  }

  #entryId(): string {
    this.#entryCounter += 1
    return `t-${Date.now().toString(36)}-${this.#entryCounter}`
  }

  #signal(
    board: Board,
    by: TeamActor,
    signal: TeamSignalKind,
    intent: Intent,
    detail: string | null,
  ): void {
    board.channel.push({
      id: this.#entryId(),
      at: Date.now(),
      kind: 'signal',
      by,
      signal,
      intent: intent.id,
      title: intent.title,
      detail,
    })
    this.#trim(board)
  }

  #message(
    board: Board,
    args: {
      from: TeamActor
      to: TeamMessage['to']
      text: string
      state: TeamMessage['state']
      reason?: string | null
      envelope?: string | null
      batch?: TeamMessage['batch']
    },
  ): TeamMessage {
    const entry: TeamMessage = {
      id: this.#entryId(),
      at: Date.now(),
      kind: 'message',
      from: args.from,
      to: args.to ?? null,
      text: args.text,
      state: args.state,
      reason: args.reason ?? null,
      envelope: args.envelope ?? null,
      ...(args.batch ? { batch: args.batch } : {}),
    }
    board.channel.push(entry)
    this.#trim(board)
    return entry
  }

  /** A row about a member, rather than from one. */
  #notice(
    board: Board,
    args: { about: TeamActor; cause: TeamNoticeCause; text: string; answering?: string | null },
  ): TeamNotice {
    const entry: TeamNotice = {
      id: this.#entryId(),
      at: Date.now(),
      kind: 'notice',
      about: args.about,
      cause: args.cause,
      text: args.text.trim().slice(0, this.#settings.messageChars) || 'The turn ended without an answer.',
      answering: args.answering ?? null,
    }
    board.channel.push(entry)
    this.#trim(board)
    return entry
  }

  /** Drops the oldest rows over the limit — but never a pending delivery. */
  #trim(board: Board): void {
    let over = board.channel.length - roomCap(board.members.length, CHANNEL_LIMIT, CHANNEL_PER_MEMBER, CHANNEL_CEILING)
    if (over <= 0) return
    board.channel = board.channel.filter((entry) => {
      if (over <= 0) return true
      const pinned =
        entry.kind === 'message' && (entry.state === 'queued' || entry.state === 'held')
      if (pinned) return true
      over -= 1
      return false
    })
  }

  /** Drops the oldest settled intents over the limit; live work is never dropped. */
  #trimIntents(board: Board): void {
    let over = board.intents.length - roomCap(board.members.length, INTENT_LIMIT, INTENTS_PER_MEMBER, INTENT_CEILING)
    if (over <= 0) return
    board.intents = board.intents.filter((intent) => {
      if (over <= 0) return true
      if (intent.state !== 'done' && intent.state !== 'abandoned') return true
      over -= 1
      return false
    })
  }

  #enqueue(
    peer: TeamPeer,
    entryId: string,
    roots: readonly string[],
    envelope: string,
    byUser = false,
  ): void {
    const key = keyOf(peer.runtime, peer.sessionId)
    const waiting = this.#pending.get(key) ?? []
    waiting.push({
      entryId,
      roots,
      envelope,
      receiver: { runtime: peer.runtime, sessionId: peer.sessionId },
      ...(byUser ? { byUser } : {}),
    })
    this.#pending.set(key, waiting)
  }

  /**
   * Takes matching pending deliveries out of the queue and patches their
   * channel rows — the shape of every policy change that applies to what is
   * already in the air.
   */
  #sweepPending(
    matches: (pending: PendingDelivery) => boolean,
    patch: { state: TeamMessage['state']; reason: string },
  ): void {
    for (const [key, waiting] of this.#pending) {
      const keep: PendingDelivery[] = []
      for (const pending of waiting) {
        if (!matches(pending)) {
          keep.push(pending)
          continue
        }
        this.#updateEntry(pending.roots, pending.entryId, patch)
      }
      if (keep.length === 0) this.#pending.delete(key)
      else if (keep.length !== waiting.length) this.#pending.set(key, keep)
    }
  }

  #updateEntry(roots: readonly string[], entryId: string, patch: Partial<TeamMessage>): void {
    for (const root of roots) {
      const board = this.#boards.get(root)
      if (!board) continue
      board.channel = board.channel.map((entry) =>
        entry.id === entryId && entry.kind === 'message' ? { ...entry, ...patch } : entry,
      )
      this.#commit(board)
    }
  }

  /** Every board holding a copy of this entry — old cross-workspace rows included. */
  #rootsHolding(entryId: string): string[] {
    const roots: string[] = []
    for (const board of this.#boards.values()) {
      if (board.channel.some((entry) => entry.id === entryId)) roots.push(board.id)
    }
    return roots
  }

  /**
   * Resolves a name to one live conversation *on this board*, or explains
   * exactly why not.
   *
   * The conversation's title first; failing that, the *agent's* name —
   * because an ACP conversation is born untitled (the title is the agent's
   * to give, and many never do), and "message the Cursor conversation" is
   * how a person or a model actually says it when there is only one.
   * Ambiguity is refused with the candidates, never guessed at — and the
   * candidates, like the roster on a miss, only ever name this board's own
   * conversations.
   */
  async #resolve(
    to: string,
    caller: TeamPeer,
    board: Board,
  ): Promise<{ peer: TeamPeer } | { refusal: string }> {
    const needle = (to ?? '').trim().toLowerCase()
    if (needle === '') return { refusal: 'no conversation was named. Say who it is for.' }
    const onBoard = this.#membersOf(board, this.#port.peers())
    const peers = onBoard.filter(
      (peer) => !(peer.runtime === caller.runtime && peer.sessionId === caller.sessionId),
    )
    // The nickname first: it is the only name guaranteed to exist and to be
    // unique on this board, which is what makes a room of identical
    // conversations addressable at all. Title and agent stay as they were, so
    // an agent that learned to say “API migration” keeps working.
    const named = peers.filter((peer) => this.#nameOn(board, peer).toLowerCase() === needle)
    const titled =
      named.length > 0 ? named : peers.filter((peer) => (peer.title ?? '').toLowerCase() === needle)
    const byAgent =
      titled.length > 0
        ? titled
        : peers.filter((peer) => peer.agent.toLowerCase() === needle)
    const loose =
      byAgent.length > 0
        ? byAgent
        : peers.filter(
            (peer) =>
              (peer.title ?? '').toLowerCase().includes(needle) ||
              peer.agent.toLowerCase().includes(needle),
          )
    if (loose.length === 1 && loose[0]) return { peer: loose[0] }
    if (loose.length > 1) {
      return {
        refusal: `“${to}” matches ${loose.length} conversations: ${loose
          .map((peer) => this.#addressOf(board, peer))
          .join(', ')}. Name one exactly.`,
      }
    }
    const roster =
      peers.length > 0
        ? ` In this room: ${peers.map((peer) => this.#addressOf(board, peer)).join(', ')}.`
        : ' Nothing else is live on this board.'
    return {
      refusal: `no conversation in this room is named “${to}”.${roster} A message reaches this room's members and nobody else.`,
    }
  }

  /** How a peer is addressed, said the way the roster prints it. */
  #addressOf(board: Board, peer: TeamPeer): string {
    const nickname = this.#nameOn(board, peer)
    return peer.title ? `${nickname} (“${peer.title}”)` : `${nickname} (${peer.agent})`
  }

  /**
   * What a member is called on its board — assigned once and then kept.
   *
   * Derived from the model rather than randomised, because this is the string
   * an agent has to type back to reach a peer: `Opus`, `Gemini`, `Codex`. A
   * random tag would be unique and unusable, which is the wrong half of the
   * problem to solve. Ties get a number, so a second Opus is `Opus 2` and the
   * first one's name never changes under it — a name that moves is not a name.
   */
  #nameOn(board: Board, peer: TeamPeer): string {
    const key = keyOf(peer.runtime, peer.sessionId)
    /* Names are unique among the members of *this room*, not among every
       conversation that ever passed through it and not among everything
       running anywhere.

       Both halves have been wrong in production. Deduping on liveness alone
       held a name on a board its holder had walked off — a GPT that moved
       rooms left the next GPT in the old one answering to "GPT 2" while being
       its only GPT. Deduping on membership *and* liveness numbered a
       relaunched room's agents upward forever — "Gemini 2", "Gemini 3",
       "Gemini 4", each the only Gemini present — because a board carried
       members whose conversations were long gone and nothing ever took them
       off it. What ended that is not the liveness test but the ghost: a
       member that cannot be reopened is dropped from the board now, and one
       that is merely not open is drawn on the rail like anybody else. So the
       members are the roster, and the roster is what a name is unique in.

       `nicknames` is deliberately not pruned when somebody leaves — a member
       that comes back keeps the name it had — and the channel keeps its own
       copy at write time, so an old row still reads correctly whatever
       happens to the map afterwards. */
    const live = this.#namesHeldOn(board, key)
    const held = board.nicknames[key]
    /* A member that comes back keeps the name it had — unless somebody living
       took it while it was away, in which case it is renamed rather than
       allowed to collide. Two members answering to one name is the exact state
       the nickname exists to end, and addressing depends on it. */
    if (held && !live.has(held)) return held
    const base = shortModelName(peer.model) ?? peer.agent
    let name = base
    for (let n = 2; live.has(name); n += 1) name = `${base} ${n}`
    board.nicknames[key] = name
    return name
  }

  /**
   * The names spoken for on a board: held by a member of it.
   *
   * One rule, two callers — `#nameOn` picking a name and `rename` refusing
   * one. They disagreed before, and a disagreement here is two members
   * answering to the same word.
   *
   * Membership is the whole test. It used to also require the conversation to
   * be *running*, which was the only way to keep a room from numbering its
   * agents upward forever while a board carried members that no longer
   * existed. Members are drawn whether or not they are open now, and one that
   * cannot be reopened is dropped from the board rather than kept as a ghost
   * — so the list this walks is the list on screen, and a name held by a
   * member somebody can see is a name the next member must not be given.
   * Requiring liveness here would hand a relaunched room's new Opus the name
   * the Opus above it is already answering to.
   */
  #namesHeldOn(board: Board, except?: string): Map<string, string> {
    const taken = new Map<string, string>()
    for (const member of board.members) {
      if (member === except) continue
      const name = board.nicknames[member]
      if (name) taken.set(name, name)
    }
    return taken
  }

  /** Rename a member. Refused rather than silently deduped: two members
      answering to one name is exactly the state the nickname exists to end. */
  rename(id: string, runtime: string, sessionId: string, to: string): string {
    const board = this.#boardById(id)
    const name = to.trim()
    if (name === '') return 'A member needs a name. Nothing was changed.'
    const key = keyOf(runtime as RuntimeId, sessionId)
    /* Only what a running member of this room actually answers to. Scanning
       the whole `nicknames` map refused a name whose last holder had left the
       room or stopped running — a word nobody would answer to, reserved
       forever by a row kept for return-name stability. */
    for (const held of this.#namesHeldOn(board, key).keys()) {
      if (held.toLowerCase() === name.toLowerCase()) {
        return `Refused: “${name}” is already taken in this room.`
      }
    }
    board.nicknames[key] = name
    this.#commit(board)
    return `Renamed to ${name}.`
  }

  #counts(board: Board): string {
    const count = (state: IntentState): number =>
      board.intents.filter((intent) => intent.state === state).length
    const parts: string[] = []
    for (const state of ['open', 'claimed', 'blocked', 'done'] as const) {
      const n = count(state)
      if (n > 0) parts.push(`${n} ${state}`)
    }
    return parts.length > 0 ? `The board has ${parts.join(' · ')}` : 'The board is empty'
  }

  #renderBoard(board: Board): string {
    if (board.intents.length === 0) {
      return 'The board is empty. Add work with add_intent — a title, the files it will own, and what it depends on.'
    }
    const lines = board.intents.map((intent) => {
      const status =
        intent.state === 'claimed' && intent.claim
          ? `claimed by ${this.#holderName(board, intent)} (${ago(intent.claim.at)})`
          : intent.state === 'blocked'
            ? `blocked${intent.dependsOn.length > 0 ? ` (waiting on ${intent.dependsOn.map((dep) => `#${dep}`).join(', ')})` : ''}${intent.blockedReason ? ` — ${intent.blockedReason}` : ''}`
            : intent.state
      const files = intent.files.length > 0 ? `\n    files: ${intent.files.join(', ')}` : ''
      const note = intent.state === 'done' && intent.note ? ` — ${intent.note}` : ''
      const handoff =
        intent.state === 'done' && intent.handoff
          ? `\n    context package available — get_context(${intent.id})`
          : ''
      const detail = intent.detail && intent.state !== 'done' ? `\n    ${intent.detail}` : ''
      return `#${intent.id} ${status} — ${intent.title}${note}${detail}${files}${handoff}`
    })
    return `${this.#counts(board)}.\n\n${lines.join('\n')}`
  }

  #commit(board: Board): void {
    this.#port.changed(this.#stateOf(board))
    /* Every card that becomes claimable becomes claimable here. Waking from
       the commit is what makes a wait free: nobody polls, and a seat is in
       its claim within a tick of the write that opened its card. */
    this.#wake(board)
    const stored: StoredBoard = {
      version: 1,
      id: board.id,
      name: board.name,
      root: board.root,
      members: board.members,
      nextIntent: board.nextIntent,
      nextPlan: board.nextPlan,
      plans: board.plans,
      nicknames: board.nicknames,
      roles: board.roles,
      roster: board.roster,
      messaging: board.messaging,
      intents: board.intents,
      channel: board.channel,
    }
    /* Named for the room, not the folder. A project holds several now, and
       filing them all under the folder meant the second one written erased
       the first. The old files are still read: their name is the folder, and
       `load` takes it as the room's id. */
    const file = join(this.#dir, `${encodeURIComponent(board.id)}.json`)
    this.#write(board.id, file, JSON.stringify(stored))
  }

  /**
   * Removes a board's file, through the same chain its writes go down.
   *
   * On its own queue a delete could land before a write already in flight,
   * and the room would be back on disk at the next launch having been deleted
   * in the interface — the kind of thing that looks like a ghost and is a
   * race. Queuing `null` as the content is how the writer is told to unlink
   * rather than write, so ordering is preserved by construction.
   */
  #erase(file: string): Promise<Error | null> {
    return this.#write(null, file, null)
  }

  #persistInbound(): void {
    this.#write(null, join(this.#dir, 'inbound.json'), JSON.stringify(Object.fromEntries(this.#inbound)))
  }

  /**
   * Serialised, coalesced, write-then-rename. A crash mid-write cannot
   * truncate a board; a burst of mutations becomes one write; and a failure
   * is *kept* — `problem` on every board's state until a write succeeds —
   * because mutations that report success while nothing reaches disk are a
   * board that forgets an acknowledged claim at the next restart.
   */
  /**
   * Queues one file's content, or `null` to unlink it, and answers when that
   * operation has actually happened.
   *
   * The returned promise is what a caller needs to *report* an outcome rather
   * than assume one, and only the delete uses it: a write is reported through
   * `problem` on the board's own state, which a deleted board no longer has.
   * It resolves to the error rather than rejecting, because every existing
   * caller ignores it and an unhandled rejection is not the failure mode this
   * is for.
   */
  #write(root: string | null, file: string, content: string | null): Promise<Error | null> {
    this.#queuedContent.set(file, content)
    let settle: (outcome: Error | null) => void = () => {}
    const done = new Promise<Error | null>((resolve) => {
      settle = resolve
    })
    if (this.#queuedFiles.has(file)) {
      /* Coalesced into the operation already queued, which is the one that
         will decide this file's fate. */
      const pending = this.#coalesced.get(file) ?? []
      this.#coalesced.set(file, [...pending, settle])
      return done
    }
    this.#queuedFiles.add(file)
    this.#writes = this.#writes.then(async () => {
      /* The moment this pass stops accepting coalesced callers is the moment
         it takes the ones it has — here, together, with nothing between.

         They used to be drained at the *end* of the pass, from a list the
         whole file shared, and a caller could join that list after this pass
         had already started writing: `#queuedFiles` no longer named the file,
         so the next write opened a new pass, and a write after *that*
         coalesced into the new pass while sitting in the old list. The old
         pass then settled it — told a caller its write was done while its
         content was still waiting for the next pass, and told it *success*
         even when that next pass went on to fail. Passes never overlapped on
         disk; `#writes` is one chain. What was wrong was who each pass
         reported to. #35. */
      this.#queuedFiles.delete(file)
      const waiters = this.#coalesced.get(file) ?? []
      this.#coalesced.delete(file)
      const finish = (outcome: Error | null): void => {
        settle(outcome)
        for (const waiting of waiters) waiting(outcome)
      }
      const latest = this.#queuedContent.get(file)
      this.#queuedContent.delete(file)
      if (latest === undefined) {
        finish(null)
        return
      }
      try {
        // `null` is a delete: see `#erase`. A missing file is the outcome
        // asked for, so its absence is not a failure.
        if (latest === null) {
          await rm(file, { force: true })
          if (this.#problem !== null) {
            this.#problem = null
            this.#pushStates(root)
          }
          finish(null)
          return
        }
        await mkdir(this.#dir, { recursive: true })
        const temp = `${file}.tmp`
        await writeFile(temp, latest)
        await rename(temp, file)
        if (this.#problem !== null) {
          this.#problem = null
          this.#pushStates(root)
        }
        finish(null)
      } catch (error) {
        this.#problem = `The board could not be saved: ${errorText(error)}. What is on screen is ahead of what is on disk.`
        this.#pushStates(root)
        finish(error instanceof Error ? error : new Error(errorText(error)))
      }
    })
    return done
  }

  /** Callers waiting on a file whose operation was coalesced into another. */
  readonly #coalesced = new Map<string, ((outcome: Error | null) => void)[]>()

  /** Re-pushes state so a `problem` change reaches every window. */
  #pushStates(root: string | null): void {
    const boards = root !== null ? [this.#boards.get(root)].filter(Boolean) : [...this.#boards.values()]
    for (const board of boards) {
      if (board) this.#port.changed(this.#stateOf(board))
    }
  }
}
