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
 * Nothing here depends on the reviewer starting after that first item, though
 * both versions send them in that order. A turn Codex announced and never
 * ended is, once a review opens over it, the reviewer's — it is told as ended
 * when the review is, so it cannot spin in the transcript for good.
 *
 * The reviewer's turn is kept, because it is the one Codex holds as running:
 * `turn/interrupt` naming the review's own turn is refused ("expected active
 * turn id … but found …"), naming the reviewer's stops the review, and before
 * the reviewer has started, a stop that names no turn at all — Codex's own
 * "startup interrupt" — stops it too. Each ends the review under its own
 * turn, `interrupted`; measured on both versions by the same probe.
 * `interruptible` says which to send.
 */
export class ReviewTurns {
  /**
   * Per thread, the review running on it: its turn; the reviewer's turn, once
   * Codex has announced it; the reviewer's turn when it was announced before
   * the review opened, and so was told as a turn of its own; and whether the
   * findings are in.
   */
  readonly #open = new Map<
    string,
    { readonly turnId: string; reviewer: string | null; readonly early: string | null; exited: boolean }
  >()
  /** Per thread, the turn Codex announced and has not ended. */
  readonly #running = new Map<string, string>()

  /** What to handle in place of `notification`: nothing, itself, or that with what it opens or closes. */
  see(notification: Notification): Notification[] {
    switch (notification.method) {
      case 'turn/started': {
        const { threadId, turn } = notification.params
        const open = this.#open.get(threadId)
        if (open && open.turnId !== turn.id) {
          open.reviewer = turn.id
          return []
        }
        this.#running.set(threadId, turn.id)
        return [notification]
      }
      case 'item/started': {
        const { threadId, turnId, item } = notification.params
        const open = this.#open.get(threadId)
        if (open?.turnId === turnId && !open.exited && item.type === 'agentMessage') return []
        if (item.type !== 'enteredReviewMode' || open?.turnId === turnId) return [notification]
        const running = this.#running.get(threadId) ?? null
        // Announced by Codex itself: the review's own turn, already told.
        if (running === turnId) {
          this.#open.set(threadId, { turnId, reviewer: null, early: null, exited: false })
          return [notification]
        }
        // Another turn still running is the reviewer's, started first.
        this.#open.set(threadId, { turnId, reviewer: running, early: running, exited: false })
        this.#running.set(threadId, turnId)
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
      case 'turn/completed': {
        const { threadId, turn } = notification.params
        if (this.#running.get(threadId) === turn.id) this.#running.delete(threadId)
        return this.#open.get(threadId)?.turnId === turn.id
          ? [notification, ...this.#close(threadId)]
          : [notification]
      }
      case 'thread/status/changed': {
        // A thread that is not working has no review, and no turn, running on
        // it, however they ended — the fallback for a completion never seen.
        const { threadId, status } = notification.params
        if (status.type === 'active') return [notification]
        this.#running.delete(threadId)
        return [notification, ...this.#close(threadId)]
      }
      default:
        return [notification]
    }
  }

  /** Ends the review on `threadId`, and with it a reviewer turn that was told as a turn. */
  #close(threadId: string): Notification[] {
    const open = this.#open.get(threadId)
    this.#open.delete(threadId)
    if (!open?.early) return []
    return [
      {
        method: 'turn/completed',
        params: {
          threadId,
          turn: {
            id: open.early,
            items: [],
            itemsView: 'notLoaded',
            status: 'completed',
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        },
      },
    ]
  }

  /**
   * What `turn/interrupt` has to name to stop `turnId` on `threadId`: the
   * reviewer's turn while `turnId` is a review whose reviewer has started, no
   * turn at all (`''`) while it is one whose reviewer has not, and `turnId`
   * itself otherwise.
   */
  interruptible(threadId: string, turnId: string): string {
    const open = this.#open.get(threadId)
    return open?.turnId === turnId ? (open.reviewer ?? '') : turnId
  }

  /**
   * Forgets one thread, as it is opened here or let go: this desk stops
   * hearing a thread it has let go of, and a review it heard start there
   * would otherwise stay open for good and swallow the next turn's start.
   */
  forget(threadId: string): void {
    this.#open.delete(threadId)
    this.#running.delete(threadId)
  }

  /** Forgets every thread: the app-server they ran on is gone. */
  clear(): void {
    this.#open.clear()
    this.#running.clear()
  }
}
