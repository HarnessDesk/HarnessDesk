import type { CodexProtocol } from '@harnessdesk/codex'

/**
 * The threads this runtime closed a handle on that Codex has not closed yet.
 *
 * `thread/unsubscribe` only stops the events. Codex keeps the thread, and
 * every tool server it started for it, loaded until the thread has been
 * unsubscribed and idle for a minute (measured on 0.160.0, `script/probe/mcp-release.mjs`);
 * then it closes the thread, the tools go with it, and it says
 * `thread/closed`. A working thread is never closed. In the minute, a resume
 * subscribes the same loaded thread again and the close never happens; in the
 * instant of the close itself a resume is refused with a hint to ask again once
 * it is over.
 *
 * Both notices that end a release are about something this runtime already
 * did, and told the desk when it did, so they are consumed here rather than
 * announced as a conversation closing underneath it.
 */

/** More than this many waiting at once means Codex is not closing them; the oldest are forgotten. */
const LIMIT = 1024

/** Codex's own words (seen in the 0.160.0 build) for a resume that arrived while it was closing the thread. */
const CLOSING = /is closing; retry thread\/resume/i

export const isClosingRefusal = (error: unknown): boolean => error instanceof Error && CLOSING.test(error.message)

interface Waiting {
  readonly closed: Promise<void>
  readonly settle: () => void
}

export class ThreadReleases {
  readonly #waiting = new Map<string, Waiting>()

  /** A handle on `id` was closed, so Codex now owes it a close. */
  expect(id: string): void {
    this.cancel(id)
    if (this.#waiting.size >= LIMIT) {
      const [oldest] = this.#waiting.keys()
      if (oldest !== undefined) this.cancel(oldest)
    }
    let settle!: () => void
    const closed = new Promise<void>((resolve) => { settle = resolve })
    this.#waiting.set(id, { closed, settle })
  }

  /** The promise that Codex closed `id`, or nothing when no close is expected. */
  closed(id: string): Promise<void> | undefined {
    return this.#waiting.get(id)?.closed
  }

  /** The thread was subscribed again or its process is gone: nothing is owed any more. */
  cancel(id: string): void {
    const waiting = this.#waiting.get(id)
    this.#waiting.delete(id)
    waiting?.settle()
  }

  clear(): void {
    for (const id of [...this.#waiting.keys()]) this.cancel(id)
  }

  /** Consumes the notice of a close this runtime was waiting for; true when it was one. */
  ends(notification: CodexProtocol.ServerNotification): boolean {
    switch (notification.method) {
      case 'thread/status/changed':
        return notification.params.status.type === 'notLoaded' && this.#waiting.has(notification.params.threadId)
      case 'thread/closed': {
        const id = notification.params.threadId
        if (!this.#waiting.has(id)) return false
        this.cancel(id)
        return true
      }
      default:
        return false
    }
  }
}
