import assert from 'node:assert/strict'
import test from 'node:test'
import type { FlowExecution } from '@harnessdesk/protocol'
import { Flows, type FlowPort } from '../src/flows.js'
import type { FlowExecutions } from '../src/flow-execution.js'
import type { Team } from '../src/team.js'
import { dispatch, type HostContext } from '../src/methods/index.js'

test('listing runs preserves stored start time, newest first, with active, Team and project filters', async () => {
  const records = [
    { id: 'a', goal: 'g1', root: '/one', state: 'running', startedAt: 30 },
    { id: 'b', goal: 'g2', root: '/two', state: 'stalled', startedAt: 10 },
    { id: 'c', goal: 'g1', root: '/one', state: 'settled', startedAt: 20 },
    { id: 'd', goal: 'g1', root: '/one', state: 'stopped', startedAt: 40 },
  ]
  const runs = records.map(r => ({ ...r, document: { flow: { name: 'Demo' } }, rounds: [{ n: 2, role: 'writer' }], reason: null })) as unknown as FlowExecution[]
  const executions = {
    runs: (goal?: string) => runs.filter(r => goal === undefined || r.goal === goal),
    stored: (id: string) => records.find(r => r.id === id),
  } as unknown as FlowExecutions
  const flows = new Flows('/tmp/unused', {} as Team, { recovery: { goal: (id: string) => ({ exists: true, writable: true, root: records.find(r => r.goal === id)?.root }) } } as FlowPort, undefined, executions)
  const ctx = { flows } as HostContext
  const list = (params: object) => dispatch(ctx, 'flow/executions', params) as Promise<readonly { id: string; startedAt: number; round: number | null }[]>
  assert.deepEqual((await list({})).map(r => r.id), ['a', 'b'])
  const all = await list({ active: false })
  assert.deepEqual(all.map(r => r.startedAt), [40, 30, 20, 10])
  assert.equal(all[0]?.round, 2)
  assert.deepEqual((await list({ team: 'g1' })).map(r => r.id), ['a'])
  assert.deepEqual((await list({ project: '/two' })).map(r => r.id), ['b'])
  assert.deepEqual(await list({ team: 'g1', project: '/two' }), [])
})
