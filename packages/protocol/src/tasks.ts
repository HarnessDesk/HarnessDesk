import type { ItemId } from './ids.js'

/**
 * Background tasks — work an agent started that outlives the turn that
 * started it.
 *
 * This is not the same thing as "a command that is currently running". A
 * command belongs to the turn: it starts inside one, it ends inside one, and
 * when the turn is over it is history. A background task is deliberately
 * detached — the agent asked for it to keep going, walked away, and will come
 * back for the output later. Nothing in a transcript can represent that,
 * because the transcript's unit is the turn, which is why both agents that
 * have the concept keep a *registry* beside their conversation and not a row
 * inside it.
 *
 * Two runtimes have it natively, and they disagree about what is worth
 * knowing, which is why this type carries the union rather than the
 * intersection:
 *
 * - One reports the live set as a whole list whenever it changes, with a
 *   description written for a person, and announces each ending with a
 *   one-line summary and the file it wrote — but says nothing about the
 *   process.
 * - The other answers a poll with the *running* set only, carrying the OS
 *   process id, its CPU share and its resident size — but keeps no memory of
 *   what has finished and writes no summary.
 *
 * So: `summary` and `endedAt` are usually the first one's, `osPid`,
 * `cpuPercent` and `rssKb` usually the second's, and a field a runtime cannot
 * answer is absent rather than zero. The one thing both can always say is
 * whether the task is still going, which is the field the interface leans on.
 */

/**
 * Where a task is in its life.
 *
 * `stopped` is separate from `completed` on purpose: a task the user killed
 * did not succeed and did not fail, and collapsing it into either would make
 * the panel lie about work the person themselves ended.
 */
export type BackgroundTaskState = 'running' | 'completed' | 'failed' | 'stopped'

/**
 * What kind of work is running. Coarse by design: the interface uses it to
 * pick an icon and a noun, not to decide behaviour, and a runtime that
 * invents a fifth kind of task should land on `other` rather than force a
 * protocol change.
 */
export type BackgroundTaskKind = 'command' | 'agent' | 'other'

export interface BackgroundTask {
  /** The runtime's own handle. Unique within a session, opaque here. */
  readonly id: string
  /**
   * What to call it. The agent's own description where there is one — it was
   * written for a person to read — and the command otherwise.
   */
  readonly label: string
  readonly kind: BackgroundTaskKind
  readonly state: BackgroundTaskState
  /** The command line, when the task is one. */
  readonly command?: string
  readonly cwd?: string
  /** Unix epoch milliseconds. Absent when the runtime never said. */
  readonly startedAt?: number
  readonly endedAt?: number
  /** One line the runtime wrote about how it went. */
  readonly summary?: string
  /**
   * What it printed — the whole of it, or the tail when the runtime capped
   * what it would carry. Absent while a runtime has nothing to show yet: a
   * shell that reports only when it ends has no output to give while it
   * runs, and a panel must not draw an empty block as if it were silence.
   */
  readonly output?: string
  /** True when `output` is the tail of something longer. */
  readonly outputTruncated?: boolean
  /**
   * True when the runtime went looking for the output and it was never
   * there — the file the notification named did not appear in the time it
   * was willing to wait. Distinct from `output` being absent, which is also
   * what "still fetching" looks like: a panel has to be able to say "never
   * found" and "not yet" as two different things.
   */
  readonly outputMissing?: boolean
  readonly exitCode?: number | null
  /** The transcript row that started it, for a panel that can point at it. */
  readonly itemId?: ItemId
  /** Live process figures, from a runtime that measures them. */
  readonly osPid?: number | null
  readonly cpuPercent?: number | null
  /** Resident set size in kilobytes. */
  readonly rssKb?: number | null
  /**
   * Whether this client can end it. False for a finished task, and for a
   * running one the runtime will not kill on our say-so — a stop button that
   * always fails is worse than no button.
   */
  readonly stoppable: boolean
}

/** True for the states that mean the work is over, whichever way it went. */
export const isFinishedTask = (task: BackgroundTask): boolean => task.state !== 'running'

/**
 * Running first, then the finished ones newest first.
 *
 * Sorting belongs here rather than in the interface because the host and the
 * renderer both show these lists and must agree on the order; a runtime's own
 * ordering is its business and is not preserved.
 */
export const orderTasks = (tasks: readonly BackgroundTask[]): readonly BackgroundTask[] =>
  [...tasks].sort((left, right) => {
    if (isFinishedTask(left) !== isFinishedTask(right)) return isFinishedTask(left) ? 1 : -1
    if (isFinishedTask(left)) return (right.endedAt ?? 0) - (left.endedAt ?? 0)
    return (left.startedAt ?? 0) - (right.startedAt ?? 0)
  })
