/**
 * The background-task extension to ACP, agent side.
 *
 * ACP has no vocabulary for work that outlives a turn, so this rides its
 * extension channel: `extNotification` for the push, `extMethod` for the two
 * things a client can ask. Methods outside the specification carry a leading
 * underscore by ACP's own convention, and a client that has never heard of
 * them simply never calls them — the notification is the only thing sent
 * unasked, and an unknown notification is ignored by every conforming client.
 *
 * These four strings are duplicated in `@harnessdesk/transport-acp`, which is
 * the client half. They are copied rather than shared on purpose: this bridge
 * has no HarnessDesk dependency and is meant to keep it that way, so any ACP
 * client can drive it. Change one, change the other.
 */

/** Agent → client: the whole list, whenever it changes. */
export const TASKS_NOTIFICATION = '_harnessdesk/tasks/changed'
/** Client → agent: the whole list, for a pane that just opened. */
export const TASKS_LIST = '_harnessdesk/tasks/list'
/** Client → agent: end one. Answers `{ stopped }`. */
export const TASKS_STOP = '_harnessdesk/tasks/stop'
/** Client → agent: forget the finished ones. Running tasks are untouched. */
export const TASKS_CLEAR = '_harnessdesk/tasks/clear'

/** What the agent declares in `initialize`'s `_meta` when it serves all four. */
export const TASKS_CAPABILITY = 'backgroundTasks'

/**
 * The session-delete extension to ACP, agent side.
 *
 * ACP can start, load, resume, fork, list, prompt and cancel a session. It
 * cannot delete one, and it cannot archive one either. A client can keep an
 * archive itself — it is only a mark — but a delete has to reach the store,
 * and only something that knows where the agent writes can do that. This
 * bridge does: `~/.claude/projects`.
 *
 * Client → agent: `{ sessionId }`. Answers `{ removed, disposition }` —
 * the paths that moved and where they went. An id the agent has nothing
 * stored for answers with an empty list, which is not an error: a session
 * that never took a turn was never written down.
 *
 * Copied into `@harnessdesk/transport-acp`, the client half, for the same
 * reason as the task strings above. Change one, change the other.
 */
export const SESSION_DELETE = '_harnessdesk/session/delete'

/** What the agent declares in `initialize`'s `_meta` when it serves it. */
export const SESSION_DELETE_CAPABILITY = 'deleteSession'
