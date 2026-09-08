import type { ApprovalId, ItemId, RuntimeId, SessionId, TurnId } from './ids.js'
import type { AgentItem, ItemDelta } from './items.js'
import type { Approval, ApprovalResolution } from './approval.js'
import type { BackgroundTask } from './tasks.js'
import type { ConfigOption } from './options.js'
import type {
  PlanStep,
  RateLimits,
  Session,
  SessionGoal,
  SessionQueue,
  SessionSettings,
  SessionStatus,
  SessionUsage,
  Turn,
} from './session.js'

/**
 * The single ordered stream every adapter emits.
 *
 * Ordering guarantee: within a session, events are delivered in the order the
 * adapter produced them. `item/started` always precedes deltas for that item,
 * and `item/completed` always carries the fully materialised item so a client
 * that dropped deltas still converges.
 */

export type NoticeLevel = 'info' | 'warning' | 'error'

export interface AgentError {
  readonly message: string
  /**
   * Stable classification the UI keys messaging off. Adapters map their native
   * error taxonomy onto this; `unknown` is always allowed.
   */
  readonly code:
    | 'auth'
    | 'credits'
    | 'rateLimit'
    | 'versionGate'
    | 'sandboxDenied'
    | 'network'
    | 'interrupted'
    | 'runtimeUnavailable'
    | 'protocol'
    | 'unknown'
  readonly retrying?: boolean
  readonly details?: string | null
}

export type AgentEvent =
  // -- session lifecycle
  | { readonly type: 'session/started'; readonly session: Session }
  | { readonly type: 'session/status'; readonly sessionId: SessionId; readonly status: SessionStatus }
  | { readonly type: 'session/title'; readonly sessionId: SessionId; readonly title: string | null }
  | { readonly type: 'session/settings'; readonly sessionId: SessionId; readonly settings: SessionSettings }
  | {
      /** The whole option list, replacing the previous one. */
      readonly type: 'session/options'
      readonly sessionId: SessionId
      readonly options: readonly ConfigOption[]
    }
  | { readonly type: 'session/memory'; readonly sessionId: SessionId; readonly enabled: boolean }
  | {
      readonly type: 'session/goal'
      readonly sessionId: SessionId
      readonly goal: SessionGoal | null
    }
  | {
      /**
       * What the user has waiting for this conversation, whole list replacing
       * the previous one — the `session/options` convention, for the same
       * reason: one queued message moving changes every other one's position.
       *
       * Emitted by the host, never by an adapter: the queue is the shell's,
       * because no backend has the concept.
       */
      readonly type: 'session/queue'
      readonly sessionId: SessionId
      readonly queue: SessionQueue
    }
  | {
      /**
       * What this conversation has running in the background, whole list
       * replacing the previous one — the `session/queue` convention, for the
       * same reason: a task ending changes the shape of the whole panel, and
       * a runtime that reports its live set as a list has no deltas to send.
       *
       * Emitted by an adapter with a `RuntimeTasks` behind it, and by the
       * host when it drops the finished ones on the user's say-so.
       */
      readonly type: 'session/tasks'
      readonly sessionId: SessionId
      readonly tasks: readonly BackgroundTask[]
    }
  | { readonly type: 'session/closed'; readonly sessionId: SessionId }
  // -- turn lifecycle
  | { readonly type: 'turn/started'; readonly sessionId: SessionId; readonly turn: Turn }
  | { readonly type: 'turn/completed'; readonly sessionId: SessionId; readonly turn: Turn }
  | {
      readonly type: 'turn/diff'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly diff: string
    }
  | {
      readonly type: 'turn/plan'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly steps: readonly PlanStep[]
    }
  // -- items
  | {
      readonly type: 'item/started'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly item: AgentItem
    }
  | {
      readonly type: 'item/delta'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly itemId: ItemId
      readonly delta: ItemDelta
    }
  | {
      readonly type: 'item/completed'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly item: AgentItem
    }
  // -- approvals
  | { readonly type: 'approval/requested'; readonly approval: Approval }
  | {
      readonly type: 'approval/resolved'
      readonly sessionId: SessionId
      readonly approvalId: ApprovalId
      readonly resolution: ApprovalResolution
    }
  // -- ambient
  | { readonly type: 'usage/updated'; readonly sessionId: SessionId; readonly usage: SessionUsage }
  | { readonly type: 'limits/updated'; readonly runtime: RuntimeId; readonly limits: RateLimits }
  | {
      /** Runtime-wide options changed; the whole list, replacing the previous one. */
      readonly type: 'runtime/options'
      readonly runtime: RuntimeId
      readonly options: readonly ConfigOption[]
    }
  // -- account
  | {
      /**
       * A sign-in started through `AgentRuntime.login` has ended, one way or
       * the other. `loginId` is null when the runtime cannot say which one —
       * a flow started outside the interface, for instance.
       */
      readonly type: 'account/loginCompleted'
      readonly runtime: RuntimeId
      readonly loginId: string | null
      readonly success: boolean
      readonly error?: string | null
    }
  | {
      /**
       * What the runtime offers — models, modes, levels — was re-read and may
       * differ; listeners re-read the draft options rather than patching.
       * Live sessions say so for themselves through `session/options`.
       */
      readonly type: 'catalog/changed'
      readonly runtime: RuntimeId
    }
  | {
      /**
       * Who the runtime is signed in as has changed. Carries no payload on
       * purpose: what else changed with it — models, limits — is the
       * runtime's business, so the listener re-reads rather than patching.
       */
      readonly type: 'account/changed'
      readonly runtime: RuntimeId
    }
  | {
      readonly type: 'notice'
      readonly sessionId?: SessionId
      readonly level: NoticeLevel
      readonly message: string
    }
  | { readonly type: 'error'; readonly sessionId?: SessionId; readonly error: AgentError }

export type AgentEventType = AgentEvent['type']
