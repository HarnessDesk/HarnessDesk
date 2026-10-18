import type { ClientMethodName } from '@harnessdesk/protocol'

/** Human vocabulary for the closed client surface. Raw methods remain hover facts. */
export const PERMISSION_LABELS = {
  'client/hello': 'Connect to the desk', 'client/subscribe': 'Watch desk activity', 'session/loadout': 'Read conversation context',
  'attachment/seat': 'Read worker attachments', 'goal/list': 'List Teams', 'goal/read': 'Read a Team', 'team/intent': 'Update a Team',
  'flow/catalog': 'Browse Flows', 'flow/source': 'Read a Flow', 'flow/preview': 'Preview a run', 'flow/start-goal': 'Start a run',
  'workspace/open': 'Open a project', 'flow/execution': 'Read a run', 'flow/execution/stop': 'Stop a run', 'flow/executions': 'List runs',
  'finding/run': 'Read run findings', 'finding/list': 'List findings', 'evidence/board': 'Read board evidence', 'evidence/seat': 'Read worker evidence',
  'insight/goal': 'Read Team insights', 'library/read': 'Browse the library', 'library/definition': 'Read a library item', 'library/usage': 'Read library usage',
} satisfies Record<ClientMethodName, string>
