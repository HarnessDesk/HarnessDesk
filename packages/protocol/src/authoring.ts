import type { CeilingLevel } from './evidence.js'
import type { FlowSeat } from './flow.js'
import type { FlowFileEdit, FlowPreview, FlowUpdateResult } from './flow-policy.js'

/**
 * Authoring: the files a person edits to start an Agent, a Goal or a team —
 * an `AGENT.md`, a flow and a project's triggers — read and changed as the
 * files they are.
 *
 * Nothing here is a second format. A shape is a phase-6 flow, an Agent is
 * its `AGENT.md`, and a trigger is Intake's own entry; each owning parser
 * stays the only judge of what a document means, and every source this
 * vocabulary carries is re-read by that parser before anything uses it. A
 * target names an origin and an id, never a path: the host decides where a
 * project's, a person's or a built-in file lives, and a built-in one is never
 * written.
 */

/** Which file a person means. `root` is the project it is read through; a user or built-in flow still resolves against one. */
export type AuthoringTarget =
  | { readonly kind: 'agent'; readonly origin: 'project' | 'user' | 'builtin'; readonly id: string; readonly root?: string }
  | { readonly kind: 'flow'; readonly origin: 'project' | 'user' | 'builtin'; readonly id: string; readonly root: string }
  | { readonly kind: 'triggers'; readonly origin: 'project'; readonly root: string }

/** One thing in the way of using a document or a shortcut in it: where, what, and what fixes it. */
export interface AuthoringIssue {
  readonly at: string
  readonly text: string
  readonly fix: string
}

/**
 * A file as it is on disk, exactly: the bytes (as text), their digest, and
 * the path a person opens. `exists` is false only for a project's triggers
 * file that is not there yet — it is saved with `expected: null`, which
 * creates and never overwrites.
 */
export interface AuthoringDocument {
  readonly target: AuthoringTarget
  readonly source: string
  readonly digest: string
  readonly exists: boolean
  readonly displayPath: string
  readonly writable: boolean
  readonly issues: readonly AuthoringIssue[]
}

/**
 * One field of an Agent's front matter, edited in place. The host encodes the
 * value; no caller ever sends the text that is written.
 */
export type AgentFieldEdit =
  | { readonly key: 'name' | 'description'; readonly value: string }
  | { readonly key: 'ceiling'; readonly value: CeilingLevel }
  | { readonly key: 'answers' | 'produces'; readonly value: readonly string[] }
  | { readonly key: 'prefer'; readonly value: readonly FlowSeat[] }

/**
 * What a start is about. Each is an input the host resolves — a branch to its
 * head, a pull request to its head and base, a diff to two commits, a working
 * tree to a bounded snapshot — never a fact a caller asserts.
 */
export type StartContext =
  | { readonly kind: 'project'; readonly root: string }
  | { readonly kind: 'branch'; readonly root: string; readonly branch: string }
  | { readonly kind: 'pull-request'; readonly root: string; readonly number: number }
  | { readonly kind: 'diff'; readonly root: string; readonly from: string; readonly to: string }
  | { readonly kind: 'working-diff'; readonly root: string }

export const START_CONTEXT_KINDS: readonly StartContext['kind'][] = ['project', 'branch', 'pull-request', 'diff', 'working-diff']

/** Which resolved fact of a start context fills a flow input. */
export type ShapeBindingValue = 'branch' | 'base' | 'head' | 'pr' | 'diff'
export const SHAPE_BINDING_VALUES: readonly ShapeBindingValue[] = ['branch', 'base', 'head', 'pr', 'diff']

/**
 * What a flow's reserved `layout:` says to the authoring surfaces: where it
 * sits on the front door, which contexts it starts from, which of its inputs
 * a context fills, and where each role sits on the graph. The engine never
 * reads it; nothing in it grants, seats or routes anything.
 */
export interface ShapeLayout {
  readonly frontDoor?: {
    readonly order?: number
    readonly contexts?: readonly StartContext['kind'][]
    readonly bindings?: readonly { readonly input: string; readonly value: ShapeBindingValue }[]
  }
  readonly positions?: Readonly<Record<string, { readonly x: number; readonly y: number }>>
}

/** The most bindings or positions a layout may name, and how far a position may sit from the origin. */
export const SHAPE_LAYOUT_LIMIT = 128
export const SHAPE_POSITION_LIMIT = 10000

// ------------------------------------------------------------------- saving

/**
 * A save, shown before it happens: every file it would create or replace,
 * each with its exact bytes before and after, in the order they would be
 * written — new Agents first, then the file that names them. `token` is null
 * when something is in the way; `issues` says what and how to fix it.
 * `resuming` marks the recorded save an interrupted one is finished from.
 */
export interface AuthoringSavePreview {
  readonly token: string | null
  readonly edits: readonly FlowFileEdit[]
  readonly issues: readonly AuthoringIssue[]
  readonly resuming: boolean
}

export type AuthoringSaveResult = FlowUpdateResult

/**
 * What a save asks for. `expected` is the digest the file was read at, or
 * null to create it — never to overwrite one. `agents` are new, complete
 * Agents the saved flow names, created first in the same place; an existing
 * folder is copied with `agent/copy` instead, so its other files come too.
 */
export interface AuthoringSaveInput {
  readonly target: WritableAuthoringTarget
  readonly expected: string | null
  readonly source: string
  readonly agents?: readonly { readonly id: string; readonly source: string }[]
}

/** A target a save may write: a project's or this person's, never a built-in one. */
export type WritableAuthoringTarget =
  | { readonly kind: 'agent'; readonly origin: 'project' | 'user'; readonly id: string; readonly root?: string }
  | { readonly kind: 'flow'; readonly origin: 'project' | 'user'; readonly id: string; readonly root: string }
  | { readonly kind: 'triggers'; readonly origin: 'project'; readonly root: string }

/**
 * A save that began and did not finish: the files it meant to write, the ones
 * it knows landed, and what a person can do — resume it, which checks each
 * file on disk before writing what is missing, or discard the record, which
 * leaves every file as it is.
 */
export interface AuthoringPending {
  readonly id: string
  readonly scope: 'project' | 'user'
  readonly root: string | null
  readonly files: readonly string[]
  readonly written: readonly string[]
  readonly message: string
}

/** The most new Agents one save may create beside its flow. */
export const AUTHORING_AGENT_LIMIT = 16

// -------------------------------------------------------------- front door

/**
 * A start from the front door: what it is about, the exact shape source, the
 * inputs a person typed, and — to reuse one — the empty Goal it lands on at
 * the revision the person saw. The host resolves the context itself.
 */
export interface FrontDoorPreviewInput {
  readonly context: StartContext
  readonly source: string
  readonly vars: Readonly<Record<string, string>>
  readonly goal?: { readonly id: string; readonly revision: number }
}

/**
 * What a front-door start was bound to, as the host resolved it: the commits
 * a review judges, or a working tree's snapshot — which is never a committed
 * head (`head` is null and `dirty` true). `independence` is `unknown` unless
 * the author is itself a role of this shape.
 */
export interface FrontDoorTarget {
  readonly label: string
  readonly base: string | null
  readonly head: string | null
  readonly dirty: boolean
  readonly independence: 'known' | 'unknown'
}

/**
 * The dry run a front door shows before Start: the phase-6 preview (whose
 * token is strict — every Seat must hold its ceiling), the target it is bound
 * to, the inputs the context filled, and the sentence the Goal is started
 * with. Starting is still `flow/start-goal` with this token and source.
 */
export interface FrontDoorPreview {
  readonly flow: FlowPreview
  readonly target: FrontDoorTarget
  readonly vars: Readonly<Record<string, string>>
  readonly source: string
  readonly sentence: string
  readonly goal: { readonly id: string; readonly revision: number } | null
}
