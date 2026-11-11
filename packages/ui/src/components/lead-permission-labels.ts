import type { ClientMethodName } from '@harnessdesk/protocol'

/** One human vocabulary for permission cards and host-observed activity. Unknown calls stay Thinking. */
const LEAD_METHOD_LABELS: Readonly<Record<ClientMethodName, { readonly permission: string; readonly activity?: string }>> = {
  'lead/usage/summary': { permission: 'Read account allowance', activity: 'Checking what is left' },
  'lead/desk/summary': { permission: 'Read the desk summary', activity: 'Reading the desk' },
  'lead/chat/list': { permission: 'List project chats', activity: 'Finding chats' },
  'lead/chat/read': { permission: 'Read a project chat', activity: 'Reading a chat' },
  'lead/chat/start': { permission: 'Start a project chat', activity: 'Starting a chat' },
  'lead/chat/send': { permission: 'Message a project chat', activity: 'Messaging a chat' },
  'lead/chat/stop': { permission: 'Stop a project chat', activity: 'Stopping a chat' },
  'lead/context/use': { permission: 'Read its own context use', activity: 'Checking its context' },
  'client/hello': { permission: 'Connect to the desk' },
  'client/subscribe': { permission: 'Watch desk activity' },
  'session/loadout': { permission: 'Read conversation context' },
  'attachment/seat': { permission: 'Read worker attachments' },
  'goal/list': { permission: 'List Teams', activity: 'Finding Teams' },
  'goal/read': { permission: 'Read a Team', activity: 'Reading a Team' },
  'team/intent': { permission: 'Update a Team' },
  'flow/catalog': { permission: 'Browse Flows', activity: 'Finding workflows' },
  'flow/source': { permission: 'Read a Flow', activity: 'Reading a workflow' },
  'flow/preview': { permission: 'Preview a run', activity: 'Checking the plan' },
  'flow/start-goal': { permission: 'Start a run', activity: 'Starting work' },
  'workspace/open': { permission: 'Open a project' },
  'flow/execution': { permission: 'Read a run', activity: 'Checking work' },
  'flow/execution/stop': { permission: 'Stop a run', activity: 'Stopping work' },
  'flow/executions': { permission: 'List runs', activity: 'Checking runs' },
  'finding/run': { permission: 'Read run findings' },
  'finding/list': { permission: 'List findings' },
  'evidence/board': { permission: 'Read board evidence', activity: 'Reading the board' },
  'evidence/seat': { permission: 'Read worker evidence', activity: 'Checking a worker' },
  'insight/goal': { permission: 'Read Team insights', activity: 'Checking a Team' },
  'library/read': { permission: 'Browse the library' },
  'library/definition': { permission: 'Read a library item' },
  'library/usage': { permission: 'Count skill use', activity: 'Counting skill use' },
  'lead/work/list': { permission: 'List tracked work', activity: 'Checking the work list' },
  'lead/work/read': { permission: 'Read a work item', activity: 'Reading a work item' },
  'lead/work/note': { permission: 'Note on a work item', activity: 'Noting progress' },
  'lead/memory/propose': { permission: 'Offer a note to keep', activity: 'Offering a note to keep' },
  'lead/memory/search': { permission: 'Search its notes and earlier conversation', activity: 'Looking back' },
  'lead/reminder/set': { permission: 'Set a reminder', activity: 'Setting a reminder' },
  'lead/reminder/cancel': { permission: 'Cancel a reminder', activity: 'Cancelling a reminder' },
}
export const PERMISSION_LABELS = Object.fromEntries(Object.entries(LEAD_METHOD_LABELS)
  .map(([method, labels]) => [method, labels.permission])) as Record<ClientMethodName, string>
export const leadActivityLabel = (method?: string | null): string =>
  method && Object.hasOwn(LEAD_METHOD_LABELS, method) ? LEAD_METHOD_LABELS[method as ClientMethodName].activity ?? 'Thinking' : 'Thinking'
