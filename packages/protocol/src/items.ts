import type { ItemId } from './ids.js'
import type { SessionCost, TokenUsage } from './session.js'
import type { UserContext } from './user-context.js'

/**
 * The content model.
 *
 * Every runtime adapter projects its native transcript into this union. The UI
 * renders only this union, which is what lets a Codex session and a future
 * Claude or Gemini session share one conversation view.
 */

/** Lifecycle shared by every item that can be in flight. */
export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined'

export interface ItemBase {
  readonly id: ItemId
  /** Unix epoch milliseconds when the item first appeared. */
  readonly startedAt?: number
  readonly completedAt?: number
  readonly durationMs?: number
}

// ---------------------------------------------------------------- user input

/** A span the composer attached to the user's text (mention, skill, file). */
export interface TextSpan {
  readonly start: number
  readonly end: number
  readonly kind: 'mention' | 'skill' | 'file'
  readonly label: string
  readonly path?: string
}

export type UserContent =
  | { readonly type: 'text'; readonly text: string; readonly spans?: readonly TextSpan[] }
  /**
   * An image the user attached, as a `data:` URL or an `https:` link. `name`
   * is what the user called it — the file name, or `Pasted image` — and is
   * for display only; no runtime receives it.
   */
  | { readonly type: 'image'; readonly url: string; readonly name?: string; readonly detail?: 'low' | 'high' | 'auto' }
  | { readonly type: 'localImage'; readonly path: string; readonly detail?: 'low' | 'high' | 'auto' }
  | { readonly type: 'skill'; readonly name: string; readonly path: string }
  | { readonly type: 'mention'; readonly name: string; readonly path: string }

export interface UserMessageItem extends ItemBase {
  readonly type: 'userMessage'
  readonly content: readonly UserContent[]
  /**
   * Scaffolding the agent's own client wrapped around the message before
   * sending it — ambient UI state, injected reminders, a slash command's
   * caveat. Kept out of `content` so the bubble is what the person said, and
   * kept at all so the transcript can still show what the model was told.
   * See `peelContext`.
   */
  readonly context?: readonly UserContext[]
}

// ------------------------------------------------------------------ assistant

/**
 * Assistant prose. `phase` distinguishes narration emitted mid-turn from the
 * final answer, so the UI can style running commentary differently.
 */
export interface AssistantMessageItem extends ItemBase {
  readonly type: 'assistantMessage'
  readonly text: string
  readonly phase?: 'commentary' | 'final'
  /** Present when the runtime attributes the message to stored memory. */
  readonly citation?: { readonly label: string; readonly href?: string }
}

/** Chain-of-thought surfaced by the runtime, split into summary and detail. */
export interface ReasoningItem extends ItemBase {
  readonly type: 'reasoning'
  readonly summary: readonly string[]
  readonly content: readonly string[]
}

// -------------------------------------------------------------------- command

/** Best-effort classification of what a shell command does, for friendly display. */
export type CommandAction =
  | { readonly type: 'read'; readonly command: string; readonly name: string; readonly path: string }
  | { readonly type: 'listFiles'; readonly command: string; readonly path?: string }
  | { readonly type: 'search'; readonly command: string; readonly query?: string; readonly path?: string }
  | { readonly type: 'unknown'; readonly command: string }

/** Who initiated the command: the agent, or the user via an embedded terminal. */
export type CommandOrigin = 'agent' | 'user'

export interface CommandItem extends ItemBase {
  readonly type: 'command'
  readonly command: string
  readonly cwd: string
  readonly origin: CommandOrigin
  readonly status: ItemStatus
  readonly actions: readonly CommandAction[]
  /** stdout and stderr interleaved, as the runtime aggregated them. */
  readonly output?: string
  readonly exitCode?: number | null
  /** Set when the runtime exposes a live PTY for this command. */
  readonly processId?: string | null
}

// ---------------------------------------------------------------- file change

export type FileChangeKind =
  | { readonly type: 'add' }
  | { readonly type: 'delete' }
  | { readonly type: 'update'; readonly movePath?: string | null }

export interface FileChange {
  readonly path: string
  readonly kind: FileChangeKind
  /** Unified diff for `update`; full file content for `add`. */
  readonly diff: string
}

export interface FileChangeItem extends ItemBase {
  readonly type: 'fileChange'
  readonly changes: readonly FileChange[]
  readonly status: ItemStatus
}

// ------------------------------------------------------------------ tool call

/** Where a tool came from, so the UI can badge it and group by provider. */
export type ToolSource =
  | { readonly kind: 'mcp'; readonly server: string; readonly pluginId?: string | null }
  | { readonly kind: 'builtin' }
  | { readonly kind: 'dynamic'; readonly namespace?: string | null }

export type ToolResultContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly url: string; readonly mimeType?: string }
  | { readonly type: 'json'; readonly value: unknown }

export interface ToolCallItem extends ItemBase {
  readonly type: 'toolCall'
  readonly tool: string
  readonly source: ToolSource
  readonly status: ItemStatus
  readonly args: unknown
  readonly result?: readonly ToolResultContent[]
  readonly error?: string
}

// ----------------------------------------------------------------------- misc

/**
 * A nested agent run: the agent delegating part of the work to another agent.
 *
 * Distinct from a tool call because it has its own transcript, its own model,
 * and its own lifetime — rendering it as one more tool row loses all three.
 */
export interface SubagentItem extends ItemBase {
  readonly type: 'subagent'
  /** What the parent asked for: spawn, send, wait, cancel. */
  readonly action: string
  readonly status: ItemStatus
  readonly prompt?: string | null
  readonly model?: string | null
  /** Sessions this call created or addressed, so the UI can link into them. */
  readonly members: readonly {
    readonly sessionId: string
    readonly nickname?: string | null
    readonly role?: string | null
    readonly state?: string | null
    /**
     * The model this child ran on, where it differs from the call's.
     *
     * All three runtimes now let one delegation address children on different
     * models — DSH 0.1.2 gives the caller provider, model, effort and maximum
     * output length per child — so the call's single `model` is the default,
     * not the answer.
     */
    readonly model?: string | null
    /** What this child spent, where the runtime attributes it per child. */
    readonly usage?: TokenUsage | null
    /**
     * False when `sessionId` is a handle rather than a conversation.
     *
     * Codex gives a child a thread of its own, which can be opened. Claude
     * Code runs one inside the parent's own process and the only handle
     * either side has is the id of the tool call that spawned it — there is
     * nothing to open. Defaults to true, so a runtime that says nothing is
     * taken at its word, and the interface offers no link rather than one
     * that fails after the press.
     */
    readonly openable?: boolean
  }[]
  /**
   * What this delegation spent, across its children.
   *
   * Reported, never derived: only the runtime knows which API calls belonged
   * to a child. Absent where the runtime cannot attribute spend to the call,
   * which is not the same as a delegation that cost nothing.
   */
  readonly usage?: TokenUsage | null
  /** What that came to in money, for the runtimes that price a delegation. */
  readonly cost?: SessionCost | null
}

export interface WebSearchItem extends ItemBase {
  readonly type: 'webSearch'
  readonly query: string
  readonly status: ItemStatus
  readonly results?: readonly { readonly title: string; readonly url: string }[]
}

export interface PlanItem extends ItemBase {
  readonly type: 'plan'
  readonly text: string
}

export interface ImageItem extends ItemBase {
  readonly type: 'image'
  readonly path: string
  /** Set when the runtime generated the image rather than merely viewing one. */
  readonly generated?: { readonly prompt?: string | null; readonly status: string }
}

/**
 * A boundary marker where the runtime compacted context. Rendered as a thin
 * divider rather than conversation content.
 */
export interface CompactionItem extends ItemBase {
  readonly type: 'compaction'
  readonly summary?: string
}

/**
 * A line of the runtime's own housekeeping: a slash command it ran for us, a
 * background task reporting back, a turn the person interrupted.
 *
 * Not speech. It reaches the transcript because the agent records it as one —
 * Claude Code writes a `/model` command echo whenever the model changes, ours
 * included — and replaying it as a user message puts words in the person's
 * mouth. Rendered as one dim row instead, it stays true and stays quiet.
 */
export interface NoticeItem extends ItemBase {
  readonly type: 'notice'
  readonly text: string
}

/** Entering or leaving a runtime-managed review sub-mode. */
export interface ReviewItem extends ItemBase {
  readonly type: 'review'
  readonly phase: 'entered' | 'exited'
  readonly review: string
}

/**
 * A turn-level failure rendered inline in the transcript. Distinct from a
 * transport error, which never becomes an item.
 */
export interface ErrorItem extends ItemBase {
  readonly type: 'error'
  readonly message: string
  readonly code?: string
}

/**
 * Something on a git forge that a conversation published or touched through
 * the desk — a pull request opened or updated, a review or a comment posted.
 * Recorded by the host at the moment the desk's own tool did it, so the
 * transcript can draw the object rather than a line of shell output, and the
 * same shape the branch bar and the repository pane read for a pull request
 * they found on their own.
 */
export interface ForgeReference {
  readonly kind: 'pullRequest' | 'issue' | 'review' | 'comment'
  /** What the conversation did to it; absent for something merely looked up. */
  readonly action?: 'opened' | 'updated' | 'posted'
  /**
   * What a review or a comment is on, said rather than guessed: the row
   * reads "Commented on the issue" because the plugin said so, never
   * because the reference happened to carry no size.
   */
  readonly subject?: 'pullRequest' | 'issue'
  /** `owner/name`, as the forge spells it. */
  readonly repo: string
  readonly number: number
  readonly url: string
  readonly title: string | null
  readonly state: 'open' | 'draft' | 'merged' | 'closed' | null
  /** The forge login of whoever it is authored as. */
  readonly author: string | null
  readonly additions: number | null
  readonly deletions: number | null
  readonly files: number | null
  /** The opening of the body, as the forge holds it, for the card. */
  readonly excerpt: string | null
  /** How the desk reached the forge: the person's own `gh`, or the desk's app. */
  readonly via: 'gh' | 'app'
  /** The line the desk signed it with, when it signed. */
  readonly signature: string | null
}

const FORGE_KINDS = new Set(['pullRequest', 'issue', 'review', 'comment'])
const FORGE_STATES = new Set(['open', 'draft', 'merged', 'closed'])

/**
 * Whether a value is a forge reference in its required parts and types.
 * Checked where a reference crosses a trust boundary — a plugin in the
 * child process handing one to the host — so that what lands in every
 * window's transcript is at least the shape the renderer expects.
 */
export const isForgeReference = (value: unknown): value is ForgeReference => {
  if (typeof value !== 'object' || value === null) return false
  const ref = value as Record<string, unknown>
  const optionalString = (field: unknown): boolean => field === null || field === undefined || typeof field === 'string'
  const optionalNumber = (field: unknown): boolean =>
    field === null || field === undefined || (typeof field === 'number' && Number.isFinite(field))
  return (
    typeof ref['kind'] === 'string' &&
    FORGE_KINDS.has(ref['kind']) &&
    typeof ref['repo'] === 'string' &&
    typeof ref['number'] === 'number' &&
    Number.isFinite(ref['number']) &&
    typeof ref['url'] === 'string' &&
    /^https?:\/\//.test(ref['url']) &&
    (ref['via'] === 'gh' || ref['via'] === 'app') &&
    (ref['state'] === null || ref['state'] === undefined || (typeof ref['state'] === 'string' && FORGE_STATES.has(ref['state']))) &&
    optionalString(ref['title']) &&
    optionalString(ref['author']) &&
    optionalString(ref['excerpt']) &&
    optionalString(ref['signature']) &&
    optionalNumber(ref['additions']) &&
    optionalNumber(ref['deletions']) &&
    optionalNumber(ref['files'])
  )
}

/** A publication: what a conversation put on the forge, through the desk. */
export interface PublicationItem extends ItemBase {
  readonly type: 'publication'
  readonly reference: ForgeReference
}

export type AgentItem =
  | UserMessageItem
  | AssistantMessageItem
  | ReasoningItem
  | CommandItem
  | FileChangeItem
  | ToolCallItem
  | SubagentItem
  | WebSearchItem
  | PlanItem
  | ImageItem
  | CompactionItem
  | NoticeItem
  | ReviewItem
  | PublicationItem
  | ErrorItem

export type AgentItemType = AgentItem['type']

// --------------------------------------------------------------------- deltas

/**
 * Incremental updates to an item already announced by `item/started`.
 *
 * Deltas are additive and ordered. A client that misses one cannot reconstruct
 * the item, which is why `item/completed` always carries the whole item.
 */
export type ItemDelta =
  | { readonly kind: 'assistantText'; readonly text: string }
  | { readonly kind: 'reasoningSummary'; readonly index: number; readonly text: string }
  | { readonly kind: 'reasoningSummaryPart'; readonly index: number }
  | { readonly kind: 'reasoningText'; readonly index: number; readonly text: string }
  | { readonly kind: 'commandOutput'; readonly stream: 'stdout' | 'stderr'; readonly chunk: string }
  | { readonly kind: 'planText'; readonly text: string }
  | { readonly kind: 'fileChangePatch'; readonly changes: readonly FileChange[] }
  | { readonly kind: 'toolProgress'; readonly message?: string; readonly progress?: number }
