import {
  orderTasks,
  type BackgroundTask,
  type BackgroundTaskKind,
  type BackgroundTaskState,
  type RuntimeTasks,
  type SessionId,
} from '@harnessdesk/protocol'
import {
  ACP_TASKS_CLEAR,
  ACP_TASKS_LIST,
  ACP_TASKS_STOP,
  type AcpBackgroundTask,
  type AcpConnection,
} from '@harnessdesk/transport-acp'

/**
 * Background tasks over ACP's extension channel.
 *
 * ACP has no vocabulary for work that outlives a turn, so an agent that has
 * such work says so through `_meta` and three extension methods — see
 * `ACP_TASKS_NOTIFICATION` and friends for the shape and why it is where it
 * is. This class is the client half: it holds the last list each session
 * pushed, answers `list` from it, and forwards `stop` and `clear`.
 *
 * Held rather than fetched, because the agent is the only one who knows. A
 * poll would be both slower and wrong: a task can end at any moment, and the
 * push is what makes "you will be told when it finishes" true rather than
 * "you will find out within four seconds of asking".
 *
 * Nothing here is Claude-specific, or specific to any agent. An ACP agent
 * that implements the extension gets the panel; one that does not is never
 * given this object at all, so the capability is false and the interface
 * shows no surface rather than an empty one.
 */

const KINDS: readonly BackgroundTaskKind[] = ['command', 'agent', 'other']
const STATES: readonly BackgroundTaskState[] = ['running', 'completed', 'failed', 'stopped']

const kindOf = (value: string | undefined): BackgroundTaskKind =>
  KINDS.find((kind) => kind === value) ?? 'other'

/**
 * An unrecognised state counts as running. The alternative — filing it under
 * "completed" — would quietly retire a task that is still burning CPU, and a
 * row that is wrongly live is at least a row someone can press stop on.
 */
const stateOf = (value: string | undefined): BackgroundTaskState =>
  STATES.find((state) => state === value) ?? 'running'

export class AcpTasks implements RuntimeTasks {
  readonly #lists = new Map<string, readonly BackgroundTask[]>()

  constructor(
    private readonly connection: AcpConnection,
    /** Announces a changed list; the runtime turns it into `session/tasks`. */
    private readonly publish: (session: SessionId, tasks: readonly BackgroundTask[]) => void,
  ) {}

  async list(session: SessionId): Promise<readonly BackgroundTask[]> {
    const held = this.#lists.get(session)
    if (held) return held
    // Nothing has been pushed yet — a pane opened on a conversation the agent
    // has had no reason to say anything about. Ask once; the answer is held
    // and every later change arrives unasked.
    try {
      const response = await this.connection.request<{ tasks?: readonly AcpBackgroundTask[] }>(
        ACP_TASKS_LIST,
        { sessionId: session },
      )
      const tasks = this.#adopt(session, response?.tasks ?? [])
      return tasks
    } catch {
      // An agent that declared the capability and then refused the call has a
      // bug; an empty list is the honest thing to show for it, and it is what
      // an agent with nothing running would have answered anyway.
      return []
    }
  }

  async stop(session: SessionId, taskId: string): Promise<boolean> {
    try {
      const response = await this.connection.request<{ stopped?: boolean }>(ACP_TASKS_STOP, {
        sessionId: session,
        taskId,
      })
      return response?.stopped === true
    } catch {
      return false
    }
  }

  async clear(session: SessionId): Promise<void> {
    try {
      await this.connection.request(ACP_TASKS_CLEAR, { sessionId: session })
    } catch {
      // The host drops its own copy either way; an agent that cannot forget
      // will simply push its list again and the finished rows come back,
      // which is the truth about that agent rather than a failure here.
    }
    const held = this.#lists.get(session)
    if (!held) return
    // Announced as well as held: rewriting the copy alone left every
    // subscriber with the rows the clear had removed (#40).
    const kept = held.filter((task) => task.state === 'running')
    this.#lists.set(session, kept)
    this.publish(session, kept)
  }

  /** One `_harnessdesk/tasks/changed` notification, straight from the agent. */
  accept(sessionId: string, tasks: readonly AcpBackgroundTask[]): void {
    this.publish(sessionId as SessionId, this.#adopt(sessionId, tasks))
  }

  /** A session closed, or the agent died; its list means nothing now. */
  forget(session: SessionId): void {
    this.#lists.delete(session)
  }

  #adopt(sessionId: string, tasks: readonly AcpBackgroundTask[]): readonly BackgroundTask[] {
    const adopted = orderTasks(
      tasks
        .filter((task) => typeof task?.id === 'string' && task.id.length > 0)
        .map((task) => {
          const state = stateOf(task.state)
          return {
            id: task.id,
            label: typeof task.label === 'string' && task.label.length > 0 ? task.label : task.id,
            kind: kindOf(task.kind),
            state,
            // The agent's own word on whether it can be stopped, but never a
            // stop button on something already over.
            stoppable: state === 'running' && task.stoppable !== false,
            ...(typeof task.command === 'string' ? { command: task.command } : {}),
            ...(typeof task.cwd === 'string' ? { cwd: task.cwd } : {}),
            ...(typeof task.startedAt === 'number' ? { startedAt: task.startedAt } : {}),
            ...(typeof task.endedAt === 'number' && state !== 'running' ? { endedAt: task.endedAt } : {}),
            ...(typeof task.summary === 'string' ? { summary: task.summary } : {}),
            ...(typeof task.output === 'string' ? { output: task.output } : {}),
            ...(task.outputTruncated === true ? { outputTruncated: true } : {}),
            ...(task.outputMissing === true ? { outputMissing: true } : {}),
          }
        }),
    )
    this.#lists.set(sessionId, adopted)
    return adopted
  }
}
