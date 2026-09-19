import type { CeilingLevel, SeatCeiling } from './evidence.js'
import type { FlowSeat } from './flow.js'

/**
 * An Agent: **who** does the work, as opposed to which runtime runs it.
 *
 * A directory on disk, because a team's reviewer is a team decision and a
 * decision nobody can diff is a decision nobody can argue with. The brief is
 * the body of `AGENT.md`; everything above is its front matter.
 *
 * Deliberately absent: credentials and session history. Both already have a
 * plane, and two planes holding one fact are two planes that will disagree.
 */
export interface AgentDefinition {
  /** The directory name. Small, lowercase, and what a flow's `uses:` names. */
  readonly id: string
  readonly name: string
  readonly description?: string | null
  /**
   * A **ceiling**, never a grant, on `read < edit < publish < merge`. A Seat
   * gets the narrower of this and what its seating grants.
   */
  readonly ceiling: CeilingLevel
  /** The key that supplied the ceiling, so legacy and missing definitions can be flagged. */
  readonly ceilingFrom: 'ceiling' | 'permission' | 'none'
  /** The only words this Agent may report. Empty means the step decides. */
  readonly answers: readonly string[]
  /** Evidence kinds it must leave behind. */
  readonly produces: readonly string[]
  /** Skills it may load, by name. Empty means whatever the runtime already has. */
  readonly skills: readonly string[]
  /**
   * Ordered seat preference — the first candidate that is installed, signed in
   * and unspent is taken. The same grammar a flow role's `seats` uses, because
   * it is the same thing: `runtime[=model][/effort][+thinking]`.
   */
  readonly prefer: readonly FlowSeat[]
  /** The body of the file: what this Agent is for, in its author's words. */
  readonly brief: string
}

/** Where an Agent was found. Project beats user beats built-in. */
export type AgentOrigin = 'project' | 'user' | 'builtin'

/** The directory name, which an entry has even when its file does not parse. */
export type AgentId = string

/** Most characters Save as an Agent accepts for the name written into `AGENT.md`. */
export const AGENT_NAME_LIMIT = 80

/** Most characters Save as an Agent accepts for the optional description written twice into `AGENT.md`. */
export const AGENT_DESCRIPTION_LIMIT = 500

/** One Agent as a listing shows it, with what it hid. */
export interface AgentEntry {
  /**
   * Null when the file did not parse. The entry still exists so the roster can
   * show what is broken and where — an unusable Agent that vanishes from the
   * list is the same defect as a shadowed one that vanishes.
   */
  readonly definition: AgentDefinition | null
  /**
   * The directory name. Present even when `definition` is null.
   *
   * One entry is not an Agent's folder. When a project's own Agent directory
   * is not read — it leads out of the project, or cannot be read — the
   * project contributes a single entry whose id is that directory's place in
   * it, `.harnessdesk/agents`, which no Agent's folder can be called.
   */
  readonly id: AgentId
  readonly origin: AgentOrigin
  readonly path: string
  /**
   * Content hash of the file, captured so a Seat can record which brief it ran.
   *
   * Called a digest, the word `agent-inventory` uses for the same thing, and
   * deliberately *not* `brief`: `AgentDefinition.brief` is the prose twenty
   * lines above, both are strings, and a reader who fetched the wrong one would
   * get a hash where a paragraph belongs with nothing to catch it.
   *
   * Null when nothing was read — an unreadable file has no digest, and a
   * sentinel string would compare equal between two unrelated broken entries
   * exactly where a consumer is comparing digests. `library.ts` types its own
   * hollow copies the same way for the same reason.
   */
  readonly digest: string | null
  /** Same id, lower precedence. Listed and marked, never hidden. */
  readonly shadows: readonly { readonly origin: AgentOrigin; readonly path: string }[]
  readonly problems: readonly AgentProblem[]
}

/**
 * The most seats an Agent's `prefer` may name, and a seating's own `seats` in
 * its place. Every seat that opens and is then passed over costs a
 * conversation: deleted where its runtime can delete one, but archived where
 * it cannot, and possibly still in that runtime's own history (`SeatLeft`).
 * An Agent arrives in a clone, so an uncapped list is somebody else's
 * repository opening conversations on your agents. A longer list is refused
 * where it is read, never cut short — a list cut at the cap is a different
 * list from the one its author wrote.
 */
export const SEAT_PREFERENCE_LIMIT = 8

/** The one-line `ceiling:` update shown before an Agent file is changed. */
export interface CeilingUpdate {
  readonly path: string
  readonly digest: string
  readonly line: number
  readonly before: string | null
  readonly after: string
  readonly diff: string
}

/** One thing wrong with a definition, and where. */
export interface AgentProblem {
  readonly level: 'error' | 'warning'
  /** `ceiling`, `prefer[1]`, `brief` — where to look. */
  readonly at: string
  readonly text: string
}

/**
 * One field of a seat that opened running something other than what was
 * asked, as a fact rather than a sentence: which control, what was asked,
 * and what it runs instead.
 *
 * `asked`/`running` hold a model or effort id as a string, or thinking as a
 * boolean; a model or effort of `null` means the runtime named none. For
 * `thinking`, `asked` is `null` when the seat said nothing about it at all —
 * distinct from `false`, which a seat writes on purpose (`agent-seating.ts`'s
 * `differencesOf`).
 *
 * `fixed`, thinking only: the runtime's own words for why it cannot move the
 * switch here, when it gave a reason; absent when it can be moved, or gave
 * none.
 */
export interface SeatDifference {
  readonly field: 'model' | 'effort' | 'thinking'
  readonly asked: string | boolean | null
  readonly running: string | boolean | null
  readonly fixed?: string
}

/**
 * Why one candidate seat cannot be taken here, as a fact rather than a
 * sentence.
 *
 * The host words each of these for its own refusals and logs, with the
 * runtime's wire id in them. A surface may show neither the id nor the
 * host's sentence (it words a runtime by its presentation), so it reads this
 * instead, and the fix beside it (`SeatFix`).
 *
 * Every reason above `couldNotOpen` is known before anything is opened.
 * `couldNotOpen` is what trying and failing to open one says; only
 * `openedOtherwise`, the last, needs a conversation that actually did.
 */
export type SeatReason =
  /**
   * No runtime by this id can be asked. `added` false: nothing by that id is
   * added to the desk, and one could be. `added` true: it is added, and the
   * program it runs is not on this machine. One sentence, two fixes.
   */
  | { readonly kind: 'notInstalled'; readonly added: boolean }
  /**
   * No runtime by this id is on this desk, nor one it knows how to add:
   * neither the agents the desk knows how to run nor the public registry, as
   * last fetched, lists it. Not merely absent, as an id that could be added is.
   */
  | { readonly kind: 'unknownRuntime' }
  /**
   * It cannot be seated right now: its health is not ready — too old, crashed,
   * still starting — or asking for its health, or its account, failed
   * outright. In its own words, or the failure's.
   */
  | { readonly kind: 'unavailable'; readonly detail: string }
  /** Asked whether it is signed in, it did not answer within `after` milliseconds, and was not waited for. */
  | { readonly kind: 'noAnswer'; readonly after: number }
  | { readonly kind: 'signedOut' }
  /** An account-wide window is used up. */
  | { readonly kind: 'spent' }
  /** One model's own window is spent, while the runtime still has others to offer. */
  | { readonly kind: 'spentModel'; readonly model: string }
  /** The seat names a model and the runtime's model list could not be read, so whether it offers it is unknown. */
  | { readonly kind: 'modelsUnread'; readonly model: string }
  | { readonly kind: 'noModel'; readonly model: string }
  | { readonly kind: 'noEffort'; readonly effort: string }
  /** Asked for a conversation, and it failed to open one. */
  | { readonly kind: 'couldNotOpen'; readonly detail: string }
  /** It opened, and runs something other than the seat asked for: each field that differs, named in `differences`. */
  | { readonly kind: 'openedOtherwise'; readonly differences: readonly SeatDifference[] }
  | { readonly kind: 'unheld'; readonly level: CeilingLevel; readonly detail: string | null }

/**
 * What removes a reason, as a thing a surface can offer. Never a sentence:
 * the words are the surface's, and the runtime is named by its presentation.
 */
export type SeatFix =
  /** Nothing by this id is added: Settings › Runtimes, where one is added. */
  | { readonly kind: 'add'; readonly runtime: string }
  /** Added, with its program missing: the runtime's own page, which says how to install it. */
  | { readonly kind: 'install'; readonly runtime: string }
  | { readonly kind: 'signIn'; readonly runtime: string }
  /** Its window is spent: the usage dashboard, which says when it comes back. */
  | { readonly kind: 'usage'; readonly runtime: string }
  /** Something about the runtime itself: its page in Settings › Runtimes. */
  | { readonly kind: 'runtime'; readonly runtime: string }
  /**
   * The seat asks for what cannot be had here — a model or an effort its
   * runtime does not do, or a runtime that is not on this desk and cannot be
   * added to it (`unknownRuntime`): this Mac's seats for the Agent.
   */
  | { readonly kind: 'seats' }
  | { readonly kind: 'ceilings' }

/**
 * What a seat passed over after it opened was left as, wherever that is
 * anything but gone. Null (on `PassedOver.left`) when nothing is left: it was
 * deleted where its runtime keeps it, and the desk forgot it.
 *
 * The desk deletes only a conversation its seating opened and nobody else
 * touched. The first two kinds are ones it could not delete — a runtime with
 * no way to, or one that refused; the next two, ones it would not; the last,
 * one whose runtime was gone before it could be asked.
 */
export type SeatLeft =
  /**
   * The runtime keeps its own history and offers no way to remove a
   * conversation from it. Whether it recorded one that never took a message
   * the desk cannot tell, so it may still be there; the desk kept its name and
   * put it out of the list (`archived` says where, or that it could not).
   */
  | { readonly kind: 'kept'; readonly archived: SeatArchived }
  /**
   * The runtime was asked to delete it, and refused, in these words. The desk
   * kept its name and put it out of the list instead (`archived`).
   */
  | { readonly kind: 'undeleted'; readonly detail: string; readonly archived: SeatArchived }
  /**
   * Somebody had a hand in it while it was open — a window read it, reopened
   * it or wrote to it, or a turn started on it, or a message waited for it —
   * so it was left as it is: nothing deleted, archived or forgotten. One they
   * were already in when it was passed over keeps its handle open, so a turn
   * running there is still heard to its end; one they reached for while it was
   * being closed was only closed, as a retired seat is.
   */
  | { readonly kind: 'inUse' }
  /**
   * The runtime answered with a conversation the desk already held under that
   * id — one with its own record, name, handle and row — not a new one. The
   * seat stopped there: nothing was done to that conversation, not even a
   * close. It was never the seating's.
   */
  | { readonly kind: 'alreadyHeld' }
  /**
   * Its runtime was gone from the desk before it could be asked to delete it,
   * so it may still be in that runtime's history. The desk kept its name, and
   * had no archive to put it in: which one a runtime uses is the runtime's to
   * say.
   */
  | { readonly kind: 'unasked' }

/**
 * Where a conversation the desk could not delete was put out of the list: the
 * desk's own archive (`here`), the runtime's own (`runtime`) — always, for a
 * runtime that keeps one, since two archives would disagree — or nowhere,
 * because archiving it failed (`failed`), so it may still be listed.
 */
export type SeatArchived = 'here' | 'runtime' | 'failed'

/** One candidate seat, as a dry run or a refusal shows it. */
export interface SeatCandidate {
  /** The seat as written, for the surface that edits this machine's seats. Never shown. */
  readonly seat: FlowSeat
  /** How it reads: "Claude · Opus 5 · High". The runtime's name and the runtime's own labels, never the spec. */
  readonly label: string
  /** The runtime as the desk calls it, even when nothing by that id is added here. */
  readonly runtimeName: string
  /** Would be taken, was passed over, or was never reached because one above it would be taken. */
  readonly state: 'taken' | 'passed' | 'untried'
  /** Why it was passed over; null unless `state` is `passed`. */
  readonly reason: SeatReason | null
  /** What removes the reason; null unless `state` is `passed`. */
  readonly fix: SeatFix | null
  /** What opening it left behind; only on a candidate passed over after it was opened. */
  readonly left?: SeatLeft | null
}

/**
 * Which seat an Agent would take here, and why not the others — the reads a
 * seating makes before it chooses, and nothing it opens. A candidate the plan
 * takes can still be passed over by the real seating once open, when what it
 * runs is read back; the plan knows only what is knowable before.
 */
export interface SeatPlan {
  readonly id: AgentId
  /**
   * Where the candidates came from: the Agent's own `prefer`, or this
   * machine's entry in `seating.json`, which replaces `prefer` here rather
   * than merging with it.
   */
  readonly from: 'prefer' | 'machine'
  /** Every candidate, in the order the seating would try them. Empty when the Agent names none. */
  readonly candidates: readonly SeatCandidate[]
  /** Where in `candidates` the seat that would be taken is; null when none can be. */
  readonly winner: number | null
  /**
   * Why this Agent cannot be weighed at all — its file does not parse, or
   * nobody defined it — in the host's words; null otherwise. When it is set
   * `candidates` is empty and `winner` null.
   */
  readonly blocked: string | null
  /** Effective would-be ceiling and whether the chosen runtime declares it held. */
  readonly ceiling: SeatCeiling | null
  /**
   * The Agent's own `prefer`, weighed against the same readings, when this
   * machine's seats replace it here (`from: 'machine'`) — what its page lists
   * under *Seats*, muted, beside the list in force. Absent otherwise: when
   * `prefer` is the list in force, `candidates` already is it.
   */
  readonly own?: readonly SeatCandidate[]
}

/** One thing wrong with this machine's seating file, and whose entry it is in. */
export interface SeatingProblem {
  /** The Agent whose entry it is; null when the file as a whole could not be read. */
  readonly id: AgentId | null
  /** Where in the entry — `[2]` — or empty for the entry or the file as a whole. */
  readonly at: string
  readonly text: string
}

/**
 * This machine's seats for its Agents, as `seating.json` holds them: every
 * entry that reads, in the file's order, and every one that does not, with why.
 * An entry replaces its Agent's `prefer` here; it never merges with it.
 */
export interface MachineSeating {
  /**
   * Host order for this whole state. It increases on every write that changes
   * `seating.json` and is persisted with the file, so renderer windows and a
   * restarted desk compare answers by the state they carry, not request order.
   */
  readonly revision: number
  /** Where the file is: `seating.json` in the desk's state directory. */
  readonly path: string
  readonly entries: readonly { readonly id: AgentId; readonly seats: readonly FlowSeat[] }[]
  readonly problems: readonly SeatingProblem[]
}

/**
 * Effort ids as a person says them, for a runtime that did not label them.
 * An id not here is said as written — a vendor adds levels faster than this
 * table learns them, and a word borrowed for one would lie about the next.
 *
 * Shared between the host, which builds `SeatCandidate.label` from it
 * (`describeSeat` in `packages/server/src/agent-seating.ts`, which re-exports
 * this rather than keeping its own copy), and the renderer, which words a
 * refusal from the same vocabulary (`reasonWords` in
 * `packages/ui/src/lib/agents.ts`) — one table, so an effort never reads two
 * different ways depending on which side of the wire is talking about it.
 */
const EFFORT_WORDS: Readonly<Record<string, string>> = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
}

export const effortWord = (effort: string): string =>
  Object.hasOwn(EFFORT_WORDS, effort) ? (EFFORT_WORDS[effort] ?? effort) : effort
