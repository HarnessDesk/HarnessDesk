import type { HarnessContext, HarnessPlugin } from '@harnessdesk/cordis-host'
import { PLAN_ARRAY_KEYS, planLabel, planStatus, type PlanStatus, type ScopeQuery } from '@harnessdesk/protocol'

/**
 * A task list, for an agent whose own runtime gives it none.
 *
 * DeepSeek Harness ships `dsh-tool-todo` and it is one of the highest-leverage
 * tools an agent has: a long task drifts without one, and the list doubles as
 * something the user can read to see whether the agent understood the job.
 * Claude Code, Cursor and Codex each have their own; this is the one for the
 * agents that do not.
 *
 * It used to draw the sidebar's Tasks panel itself, and that was the wrong
 * shape twice over. The kernel is one object for the whole app, so a single
 * closure variable made every conversation share one list — the panel showed
 * the previous agent's plan under the next agent's session. And it was only
 * ever *this* tool's list, so an agent that planned with its own tool left the
 * panel showing something stale that nothing could replace.
 *
 * The panel is the app's now, read from the conversation itself (see
 * `sessionPlan` in the renderer), which is one list per session by
 * construction and replaced by whatever the agent last wrote. This tool
 * writes into that same record like any other: one call carries the whole
 * list with its statuses, so the transcript always holds the current plan.
 * What is kept here is only what `todo_read` and the turn context need.
 */

export type TodoStatus = PlanStatus

export interface TodoItem {
  readonly task: string
  readonly status: Exclude<TodoStatus, 'cancelled'>
}

/**
 * Where a call's list can be. The schema names `tasks`, but an agent sends the
 * list under whatever key its own plan tool uses — Claude Code and Cursor say
 * `todos` (`PLAN_ARRAY_KEYS`). `tasks` is read first, as the schema asks.
 */
const LIST_KEYS = ['tasks', ...PLAN_ARRAY_KEYS.filter((name) => name !== 'tasks')]

/** Renders the list the way it will be shown to the model and to the user. */
export const renderTodos = (items: readonly TodoItem[]): string => {
  if (items.length === 0) return 'The task list is empty.'
  const mark = (status: TodoStatus): string =>
    status === 'done' ? '[x]' : status === 'inProgress' ? '[~]' : '[ ]'
  return items.map((item, index) => `${mark(item.status)} ${index + 1}. ${item.task}`).join('\n')
}

/**
 * The list a call belongs to.
 *
 * Keyed by runtime *and* session, the way every session is identified across
 * this codebase (`sessionKey`): two agents can mint the same session id, and
 * one of them would then have been reading the other's list.
 *
 * A caller the host could not resolve to a session — a direct kernel call, an
 * ACP bridge whose correlation token expired — lands on one shared list under
 * the empty key, which is the behaviour every caller had before lists were
 * split. It degrades to the old shape rather than losing the tasks.
 */
const listKey = (scope: ScopeQuery | undefined): string =>
  `${scope?.runtime ?? ''}\u0000${scope?.sessionId ?? ''}`

/**
 * How many conversations' lists are kept. They are small and live only as long
 * as the app, but keying them by session in a desk left open for days is an
 * unbounded map with no lid on it. The least recently *written* list is the
 * one dropped; a session still being worked on keeps moving back to the front.
 */
const MAX_LISTS = 50

/**
 * One entry of the tool's array argument, as a model may have written it.
 *
 * A `null` status means the entry did not say — a bare string, or an object
 * with only the text. Distinguished from `pending` on purpose: a model that
 * re-sends the list to add an item, without repeating the statuses, must not
 * silently reopen everything already finished.
 *
 * Both halves are `@harnessdesk/protocol`'s, shared with the renderer that
 * draws the Tasks panel. Reading the status here as an exact match against
 * three words while the panel matched substrings meant a model answering
 * `completed` — which is what Claude Code sends, and `TODO_STATUS_COMPLETED`
 * is what Cursor sends — had its task drawn as done and handed back to it as
 * still pending, every turn.
 */
const readItem = (value: unknown): { task: string; status: TodoStatus | null } | null => {
  if (typeof value === 'string') {
    const task = value.trim()
    return task ? { task, status: null } : null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const task = planLabel(record)?.trim()
  if (!task) return null
  return { task, status: planStatus(record['status']) }
}

export const todoPlugin: HarnessPlugin = {
  manifest: {
    id: 'todo',
    name: 'Task list',
    description: 'A checklist the agent keeps for multi-step work, visible in every turn.',
    // Held entirely in memory for the life of the app: a task list that
    // outlived its session would be worse than none. No permissions — the
    // list reaches the window through the transcript, like every other tool
    // call, rather than through a UI contribution of its own.
    permissions: {},
  },
  plugin: {
    name: 'todo',
    inject: ['tools', 'context'],
    apply(ctx: HarnessContext) {
      const lists = new Map<string, readonly TodoItem[]>()

      const listFor = (key: string): readonly TodoItem[] => lists.get(key) ?? []

      const store = (key: string, items: readonly TodoItem[]): void => {
        // Re-inserting moves the key to the back of the Map's own order, so
        // the first key is always the least recently written list.
        lists.delete(key)
        lists.set(key, items)
        while (lists.size > MAX_LISTS) {
          const oldest = lists.keys().next().value
          if (oldest === undefined) break
          lists.delete(oldest)
        }
      }

      ctx.tools.register({
        name: 'todo_write',
        description:
          'Write the task list for this conversation. Send the whole list every time, each task with its status — the call replaces what was there, and it is what the user sees in the Tasks panel. Use it when you plan multi-step work, call it again as each task finishes, and send an empty list when the plan no longer applies.',
        inputSchema: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              description: 'The full list, in order.',
              items: {
                type: 'object',
                properties: {
                  task: { type: 'string', description: 'What is to be done.' },
                  status: {
                    type: 'string',
                    enum: ['pending', 'inProgress', 'done'],
                    description:
                      'Defaults to pending, or to what this task already was. Common spellings — completed, in_progress — are understood too.',
                  },
                },
                required: ['task'],
              },
            },
          },
          required: ['tasks'],
        },
        // The whole list, every call. A tool that changed one task by id kept
        // the statuses here and nowhere else, so the transcript — the thing
        // the panel and every hand-off read — held a list that had stopped
        // being true after the first status change.
        execute: (args: Readonly<Record<string, unknown>>, scope: ScopeQuery) => {
          const key = listKey(scope)
          // Statuses an entry does not state are carried over by task text, so
          // re-sending the list to append one item does not silently reopen
          // everything already finished.
          const previous = new Map(listFor(key).map((item) => [item.task, item.status]))
          /* The list, under any key an agent uses for one. Read from `tasks`
             alone, a list sent as `todos` arrived as nothing — and nothing is
             how a plan is put down, so the plan was wiped (#57). A call that
             names no list at all is refused rather than read as an empty one:
             putting a plan down is `tasks: []`, said on purpose. */
          const named = LIST_KEYS.find((name) => args?.[name] !== undefined)
          if (named === undefined) {
            return `todo_write takes the whole list, as "tasks". The list is unchanged:\n${renderTodos(listFor(key))}`
          }
          const sent = args[named]
          // The schema says an array; a model that sends a bare string would
          // otherwise take `.map` with it and come back a runtime TypeError
          // instead of something it can act on.
          if (!Array.isArray(sent)) {
            return `"${named}" has to be a list. The list is unchanged:\n${renderTodos(listFor(key))}`
          }
          const readable = sent
            .map(readItem)
            .filter((entry): entry is { task: string; status: TodoStatus | null } => entry !== null)
          // Sending nothing is how a plan is put down, and is honoured. Sending
          // tasks that cannot be read is a malformed call, and emptying the
          // list on one would look exactly like the agent having finished. So
          // it is judged on what could be read, before cancelled tasks leave:
          // judged after, cancelling every task — the other way a plan ends —
          // was refused as unreadable (#58).
          if (sent.length > 0 && readable.length === 0) {
            return `None of those ${sent.length} entries had readable text. Each task is a string, or an object with a "task". The list is unchanged:\n${renderTodos(listFor(key))}`
          }
          const items = readable
            .map((entry) => ({
              task: entry.task,
              status: entry.status ?? previous.get(entry.task) ?? ('pending' as const),
            }))
            // A task the agent cancelled is off the list, not on it as
            // pending — which is how it would otherwise reach the next agent
            // as work still to do.
            .filter((item): item is TodoItem => item.status !== 'cancelled')
          store(key, items)
          return renderTodos(items)
        },
      })

      ctx.tools.register({
        name: 'todo_read',
        description: 'Read the current task list.',
        inputSchema: { type: 'object', properties: {} },
        execute: (_args: unknown, scope: ScopeQuery) => renderTodos(listFor(listKey(scope))),
      })

      // The list is small and always relevant while it exists, so it goes in as
      // context rather than costing a tool call every turn.
      ctx.context.register({
        label: 'Task list',
        resolve: (scope: ScopeQuery) => {
          const items = listFor(listKey(scope))
          return items.length === 0
            ? ''
            : `Your current task list:\n${renderTodos(items)}\n\nCall todo_write with the whole list again as each task finishes.`
        },
      })
    },
  },
}
