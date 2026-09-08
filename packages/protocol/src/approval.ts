import type { ApprovalId, ItemId, SessionId, TurnId } from './ids.js'
import type { CommandAction, FileChange } from './items.js'

/**
 * Approvals — the moments a runtime stops and asks the user.
 *
 * Every runtime has some version of this. Normalising it here is what lets one
 * approval dialog serve every backend, and what keeps approval policy out of
 * runtime-specific React code.
 */

export interface ApprovalBase {
  readonly id: ApprovalId
  readonly sessionId: SessionId
  readonly turnId?: TurnId
  /** The transcript item this approval belongs to, so the UI can anchor it. */
  readonly itemId?: ItemId
  readonly requestedAt: number
  /** Runtime-supplied rationale, e.g. "needs network access to install". */
  readonly reason?: string | null
}

/** Extra scope an approval may grant beyond the single action. */
export interface ApprovalGrant {
  /** Remember this decision for the rest of the session. */
  readonly forSession?: boolean
  /** Additional filesystem root the agent may write to from now on. */
  readonly grantRoot?: string | null
  /** Hosts the agent may reach from now on. */
  readonly grantHosts?: readonly string[]
}

export interface CommandApproval extends ApprovalBase {
  readonly type: 'command'
  /**
   * What is being approved. `command` — the default, and what every approval
   * was before Codex 0.153.0 — asks to run `command`. `stdin` asks to type
   * `input` into the process that `command` started and is still running;
   * a policy rule written for commands must not answer it, because "yes" to
   * a running program's prompt is a different act from starting the program.
   */
  readonly kind?: 'command' | 'stdin'
  readonly command: string
  readonly cwd: string
  /** The text to be sent to the running command, when `kind` is `stdin`. */
  readonly input?: string
  readonly actions: readonly CommandAction[]
  /** Which buttons to offer, in the order the runtime prefers. */
  readonly options: readonly ApprovalOption[]
}

export interface FileChangeApproval extends ApprovalBase {
  readonly type: 'fileChange'
  readonly changes: readonly FileChange[]
  readonly grantRoot?: string | null
  readonly options: readonly ApprovalOption[]
}

/** A request to widen the sandbox itself, rather than to run one thing. */
export interface PermissionApproval extends ApprovalBase {
  readonly type: 'permission'
  readonly summary: string
  readonly filesystem?: readonly string[]
  readonly network?: readonly string[]
  readonly options: readonly ApprovalOption[]
}

export interface QuestionOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

/** A tool asking the user a structured question mid-turn. */
export interface UserInputApproval extends ApprovalBase {
  readonly type: 'userInput'
  readonly tool: string
  readonly questions: readonly {
    readonly id: string
    readonly question: string
    readonly header?: string
    readonly multiSelect: boolean
    readonly options: readonly QuestionOption[]
  }[]
}

/** An MCP server requesting structured input via the elicitation protocol. */
export interface ElicitationApproval extends ApprovalBase {
  readonly type: 'elicitation'
  readonly server: string
  readonly message: string
  /** JSON Schema describing the requested object. Rendered by a schema form. */
  readonly schema: unknown
}

export type Approval =
  | CommandApproval
  | FileChangeApproval
  | PermissionApproval
  | UserInputApproval
  | ElicitationApproval

export type ApprovalType = Approval['type']

/**
 * One button. `id` is opaque to the UI and meaningful only to the adapter that
 * produced it, which is how runtime-specific choices (execpolicy amendments,
 * network rules) survive normalisation without leaking their shape.
 */
export interface ApprovalOption {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly intent: 'approve' | 'approveAlways' | 'deny' | 'cancel'
}

export type ApprovalDecision =
  | { readonly type: 'option'; readonly optionId: string }
  | { readonly type: 'answers'; readonly answers: Readonly<Record<string, readonly string[]>> }
  | { readonly type: 'content'; readonly value: unknown }
  | { readonly type: 'cancel' }

/** Why an approval left the queue, for auditing and for UI messaging. */
export type ApprovalResolution =
  | { readonly outcome: 'decided'; readonly decision: ApprovalDecision }
  | { readonly outcome: 'timedOut' }
  | { readonly outcome: 'abandoned'; readonly reason: string }
