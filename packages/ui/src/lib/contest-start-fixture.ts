import type { FlowPolicy } from '@harnessdesk/protocol'

/** Synthetic New Team policy matching the shipped optional-check contest. */
export const CONTEST_START_POLICY: FlowPolicy = {
  version: 2, name: 'Mechanical contest', inputs: [{ id: 'task', label: 'Task' }],
  roles: [
    { id: 'competitor', kind: 'agent', uses: ['implementer'], seats: [], count: 2, isolate: true, grant: 'edit', independentOf: [] },
    { id: 'referee', kind: 'person', outcomes: ['merged', 'dropped'] },
  ],
  rules: [{ id: 'to-person', on: 'competitor', then: { role: 'referee', title: 'Choose and merge an attempt' } }],
  complete: { referee: ['merged', 'dropped'] },
  seed: { role: 'competitor', title: '{{task}}' }, messaging: 'board-only', wait: 240,
  budget: { rounds: 3, withoutProgress: 2 }, layout: { frontDoor: { contexts: ['project'] } },
}
