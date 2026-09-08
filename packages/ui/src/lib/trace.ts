import type { AgentItem, Session } from '@harnessdesk/protocol'

import { editOf } from './handoff'
import { SHELL_TOOLS } from './group-items'
import { TEST_COMMAND } from './turn-summary'

/**
 * Where a conversation is right now, as one word.
 *
 * Parallel agents are only understandable if each can be read at a glance:
 * planning, editing, testing, running something, waiting for the user, or
 * done. The word comes from the latest thing the agent actually did in its
 * current turn — the items, never the prose — so it encodes real activity
 * rather than decorating it.
 */

export type TraceState =
  | 'waiting'
  | 'planning'
  | 'editing'
  | 'testing'
  | 'running'
  | 'thinking'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'idle'

export const TRACE_LABEL: Record<TraceState, string> = {
  waiting: 'Waiting for you',
  planning: 'Planning',
  editing: 'Editing',
  testing: 'Testing',
  running: 'Running',
  thinking: 'Thinking',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  idle: '',
}

/** States in which the agent is busy and the row should say what with. */
export const ACTIVE_STATES: ReadonlySet<TraceState> = new Set(['planning', 'editing', 'testing', 'running', 'thinking'])

const PLAN_TOOLS = /^(todowrite|todo_write|update_plan|plan|task_list|create_plan)\b/i

const stepState = (item: AgentItem): TraceState | null => {
  switch (item.type) {
    case 'plan':
      return 'planning'
    case 'fileChange':
      return 'editing'
    case 'command':
      return TEST_COMMAND.test(item.command) ? 'testing' : 'running'
    case 'toolCall': {
      if (PLAN_TOOLS.test(item.tool)) return 'planning'
      if (editOf(item)) return 'editing'
      if (SHELL_TOOLS.test(item.tool)) {
        const args = typeof item.args === 'object' && item.args !== null ? (item.args as Record<string, unknown>) : {}
        const command = typeof args['command'] === 'string' ? args['command'] : ''
        return TEST_COMMAND.test(command) ? 'testing' : 'running'
      }
      return 'running'
    }
    case 'webSearch':
    case 'subagent':
      return 'running'
    case 'reasoning':
      return 'thinking'
    default:
      return null
  }
}

/**
 * @param waiting  whether an approval or question for this session is pending
 */
export const traceOf = (session: Pick<Session, 'turns' | 'status'>, waiting: boolean): TraceState => {
  if (waiting) return 'waiting'
  const turn = session.turns[session.turns.length - 1]
  if (!turn) return 'idle'
  if (turn.status === 'inProgress') {
    for (let index = turn.items.length - 1; index >= 0; index -= 1) {
      const state = stepState(turn.items[index]!)
      if (state) return state
    }
    return 'thinking'
  }
  if (turn.status === 'failed') return 'failed'
  if (turn.status === 'interrupted') return 'stopped'
  const lastProse = [...turn.items].reverse().find((item) => item.type === 'assistantMessage' && item.phase !== 'commentary')
  if (lastProse?.type === 'assistantMessage' && /\?\s*$/.test(lastProse.text.trim())) return 'waiting'
  return 'done'
}
