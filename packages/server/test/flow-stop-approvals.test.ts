import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WireNotification } from '@harnessdesk/protocol'
import { claimed, desk, E2E, start, TASK } from './fixtures/flow-host-evidence.js'

const FLOW = `version: 2
name: Investigation
inputs: { task: { label: Task } }
roles:
  researcher:
    kind: agent
    uses: [researcher]
    grant: edit
    independentOf: []
seed: { role: researcher, title: "{{task}}" }
rules: []
messaging: board-only
`

test('stopping an investigation settles a pending command approval for every window', E2E, async t => {
  const d = await desk(t)
  const run = await start(d, FLOW, TASK)
  const [card] = await claimed(d, run.goal, 'researcher', 1)
  const runtime = d.runtimes.find(one => one.info.id === card!.claim!.runtime)!
  const session = runtime.sessions.get(card!.claim!.sessionId)!
  const notifications: WireNotification[] = []
  const unsubscribe = d.host.addBroadcaster(notification => notifications.push(notification))
  t.after(unsubscribe)
  void session.askApproval('stopping-command' as never)
  assert.equal(d.host.registry.hasApproval(runtime.info.id, session.id, 'stopping-command' as never), true)
  await d.host.call('flow/execution/stop', { run: run.id, reason: 'The person stopped the investigation.' })
  assert.equal(d.host.registry.hasApproval(runtime.info.id, session.id, 'stopping-command' as never), false)
  assert.ok(notifications.some(notification => notification.method === 'event' && notification.params.event.type === 'approval/resolved' && notification.params.event.approvalId === 'stopping-command'), 'the visible approval must leave every window too')
})
