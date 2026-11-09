import type { ClientMethodName } from '@harnessdesk/protocol'

/** Human vocabulary for the closed client surface. Raw methods remain hover facts. */
export const PERMISSION_LABELS = {
  'lead/desk/summary': 'Read the desk summary',
  'lead/chat/list': 'List project chats', 'lead/chat/read': 'Read a project chat', 'lead/chat/start': 'Start a project chat',
  'lead/chat/send': 'Message a project chat', 'lead/chat/stop': 'Stop a project chat',
  'client/hello': 'Connect to the desk', 'client/subscribe': 'Watch desk activity', 'session/loadout': 'Read conversation context',
  'attachment/seat': 'Read worker attachments', 'goal/list': 'List Teams', 'goal/read': 'Read a Team', 'team/intent': 'Update a Team',
  'flow/catalog': 'Browse Flows', 'flow/source': 'Read a Flow', 'flow/preview': 'Preview a run', 'flow/start-goal': 'Start a run',
  'workspace/open': 'Open a project', 'flow/execution': 'Read a run', 'flow/execution/stop': 'Stop a run', 'flow/executions': 'List runs',
  'finding/run': 'Read run findings', 'finding/list': 'List findings', 'evidence/board': 'Read board evidence', 'evidence/seat': 'Read worker evidence',
  'insight/goal': 'Read Team insights', 'library/read': 'Browse the library', 'library/definition': 'Read a library item', 'library/usage': 'Count skill use',
} satisfies Record<ClientMethodName, string>

/** One vocabulary for host-observed desk operations; unknown calls stay Thinking. */
export const LEAD_ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  'lead/desk/summary': 'Reading the desk',
  'lead/chat/list': 'Finding chats',
  'lead/chat/read': 'Reading a chat',
  'lead/chat/start': 'Starting a chat',
  'lead/chat/send': 'Messaging a chat',
  'lead/chat/stop': 'Stopping a chat',
  'flow/catalog': 'Finding workflows',
  'flow/source': 'Reading a workflow',
  'flow/preview': 'Checking the plan',
  'flow/start-goal': 'Starting work',
  'flow/execution': 'Checking work',
  'flow/execution/stop': 'Stopping work',
  'flow/executions': 'Checking runs',
  'goal/list': 'Finding Teams',
  'goal/read': 'Reading a Team',
  'insight/goal': 'Checking a Team',
  'evidence/board': 'Reading the board',
  'evidence/seat': 'Checking a worker',
  'library/usage': 'Counting skill use',
}

export const leadActivityLabel = (method?: string | null): string =>
  method && Object.hasOwn(LEAD_ACTIVITY_LABELS, method) ? LEAD_ACTIVITY_LABELS[method]! : 'Thinking'
