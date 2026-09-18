import type { FlowPermission, FlowSeat } from './flow.js'

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
   * A **ceiling**, never a grant. A Seat gets the narrower of this and the
   * step's grant, and a step grants `read` unless it says otherwise — so
   * writing needs the Agent and the step to agree.
   */
  readonly permission: FlowPermission
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
 * its place. Every seat that opens and is then passed over leaves a closed,
 * empty conversation in that runtime's history, and an Agent arrives in a
 * clone: an uncapped list is somebody else's repository littering your agents'
 * histories. A longer list is refused where it is read, never cut short — a
 * list cut at the cap is a different list from the one its author wrote.
 */
export const SEAT_PREFERENCE_LIMIT = 8

/** One thing wrong with a definition, and where. */
export interface AgentProblem {
  readonly level: 'error' | 'warning'
  /** `permission`, `prefer[1]`, `brief` — where to look. */
  readonly at: string
  readonly text: string
}
