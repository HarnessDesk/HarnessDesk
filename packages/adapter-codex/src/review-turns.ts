import type { CodexProtocol } from '@harnessdesk/codex'

type Notification = CodexProtocol.ServerNotification

/**
 * Codex's inline review, told as a turn like any other.
 *
 * A review runs as a turn of the thread it was asked on, and Codex never
 * announces that turn: its items and its `turn/completed` name a turn no
 * `turn/started` opened. Codex says so in its own source — "Review turns
 * currently rely on `spawn_task` for TurnComplete but do not emit a parent
 * TurnStarted" (codex-rs/core/src/session/review.rs, 0.155.0; the same code
 * in 0.145.0). What arrives instead is the reviewer sub-agent's own
 * `turn/started`, forwarded under the sub-agent's turn id, which nothing
 * names again; and an `agentMessage` for each thing the reviewer writes,
 * started and never completed, because Codex withholds the reviewer's own
 * words in favour of the findings it renders afterwards. Measured on 0.145.0
 * and 0.155.0 with `script/probe/review-side-thread.mjs --shapes`.
 *
 * Folded as it comes, that is a turn that never ends and holds nothing: every
 * reader keys items to a turn it has seen start, so the findings were dropped
 * and the conversation showed as working for good. So the review's first
 * item, `enteredReviewMode`, opens its turn; until that turn ends, another
 * `turn/started` on the thread is the reviewer's and goes no further, and so
 * does an `agentMessage` started before the review is over.
 *
 * The reviewer's turn is kept all the same, because it is the one Codex holds
 * as running: `turn/interrupt` naming the review's own turn is refused
 * ("expected active turn id … but found …"), and naming the reviewer's stops
 * the review, which then ends under its own turn — measured on both versions
 * by the same probe. `interruptible` says which to name.
 */
export class ReviewTurns {
  /**
   * Per thread, the review running on it: its turn, the reviewer's turn once
   * Codex has announced it, and whether the findings are in.
   */
  readonly #open = new Map<string, { readonly turnId: string; reviewer: string | null; exited: boolean }>()
  /** Per thread, the last turn Codex announced itself, so a review it did announce is not opened twice. */
  readonly #started = new Map<string, string>()

  /** What to handle in place of `notification`: nothing, itself, or its turn's start and then itself. */
  see(notification: Notification): Notification[] {
    switch (notification.method) {
      case 'turn/started': {
        const { threadId, turn } = notification.params
        const open = this.#open.get(threadId)
        if (open && open.turnId !== turn.id) {
          open.reviewer = turn.id
          return []
        }
        this.#started.set(threadId, turn.id)
        return [notification]
      }
      case 'item/started': {
        const { threadId, turnId, item } = notification.params
        const open = this.#open.get(threadId)
        if (open?.turnId === turnId && !open.exited && item.type === 'agentMessage') return []
        if (item.type !== 'enteredReviewMode' || open?.turnId === turnId) return [notification]
        this.#open.set(threadId, { turnId, reviewer: null, exited: false })
        if (this.#started.get(threadId) === turnId) return [notification]
        this.#started.set(threadId, turnId)
        const opened: Notification = {
          method: 'turn/started',
          params: {
            threadId,
            turn: {
              id: turnId,
              items: [],
              itemsView: 'notLoaded',
              status: 'inProgress',
              error: null,
              startedAt: Math.floor(notification.params.startedAtMs / 1000),
              completedAt: null,
              durationMs: null,
            },
          },
        }
        return [opened, notification]
      }
      case 'item/completed': {
        const { threadId, turnId, item } = notification.params
        const open = this.#open.get(threadId)
        if (open?.turnId === turnId && item.type === 'exitedReviewMode') open.exited = true
        return [notification]
      }
      case 'turn/completed':
        if (this.#open.get(notification.params.threadId)?.turnId === notification.params.turn.id) {
          this.#open.delete(notification.params.threadId)
        }
        return [notification]
      case 'thread/status/changed':
        // A thread that is not working has no review running on it, however
        // its turn ended — the fallback for a completion never seen.
        if (notification.params.status.type !== 'active') this.#open.delete(notification.params.threadId)
        return [notification]
      default:
        return [notification]
    }
  }

  /**
   * The turn `turn/interrupt` has to name to stop `turnId` on `threadId`:
   * the reviewer's, while `turnId` is a review whose reviewer has started,
   * and `turnId` itself otherwise.
   */
  interruptible(threadId: string, turnId: string): string {
    const open = this.#open.get(threadId)
    return open?.turnId === turnId && open.reviewer !== null ? open.reviewer : turnId
  }

  /**
   * Forgets one thread, as it is opened here or let go: this desk stops
   * hearing a thread it has let go of, and a review it heard start there
   * would otherwise stay open for good and swallow the next turn's start.
   */
  forget(threadId: string): void {
    this.#open.delete(threadId)
    this.#started.delete(threadId)
  }

  /** Forgets every thread: the app-server they ran on is gone. */
  clear(): void {
    this.#open.clear()
    this.#started.clear()
  }
}
