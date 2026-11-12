import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createLeadClientAuthority } from '../src/lead/client-authority.js'
import type { Host } from '../src/host.js'

test('chat notification read authority checks the target live and refuses missing or failed admission', async t => {
  const directory = await mkdtemp('/tmp/hd-chat-authority-')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const project = await realpath(directory)
  const host = { clientScopeViews: () => [], call: async () => { throw new Error('Transcript read is forbidden in notification admission.') } } as unknown as Pick<Host, 'call' | 'clientScopeViews'>
  const request = { id: 0, method: 'lead/chat/read', params: { id: 'demo:session-1' } } as const
  const closed = await createLeadClientAuthority({ host, project, owned: [] })
  assert.equal(await closed.authorize(request), 'leadScope')
  let admitted = true
  const checked: string[] = []
  const authority = await createLeadClientAuthority({ host, project, owned: [], readChatTarget: async id => { checked.push(id); return admitted } })
  assert.equal(await authority.authorize(request), null)
  admitted = false
  assert.equal(await authority.authorize(request), 'leadScope')
  assert.deepEqual(checked, ['demo:session-1', 'demo:session-1'])
  const failed = await createLeadClientAuthority({ host, project, owned: [], readChatTarget: async () => { throw new Error('Synthetic stale session') } })
  assert.equal(await failed.authorize(request), 'leadScope')
})

test('desk-wide allowance and skill counts reach dispatch without project-scoped transcript authority', async t => {
  const directory = await mkdtemp('/tmp/hd-usage-authority-')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const authority = await createLeadClientAuthority({ project: directory, owned: [], host: {
    clientScopeViews: () => [], call: async () => { throw new Error('No transcript read') },
  } as unknown as Pick<Host, 'call' | 'clientScopeViews'> })
  for (const method of ['lead/usage/summary', 'library/usage'] as const)
    assert.equal(await authority.authorize({ id: 1, method, params: {} }), null)
})

test('the Lead door refuses every run call but a stop while a request awaits its plan, whatever the journal admitted', async t => {
  const directory = await mkdtemp('/tmp/hd-request-authority-')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const project = await realpath(directory)
  const host = { clientScopeViews: () => [], call: async () => { throw new Error('No host effect is authorized') } } as unknown as Pick<Host, 'call' | 'clientScopeViews'>
  let awaits = true
  const authority = await createLeadClientAuthority({ host, project, owned: [], awaitsPlan: () => awaits, authorizeStart: () => true })
  const start = { id: 1, method: 'lead/chat/start', params: { text: 'Fix it' } } as const
  const send = { id: 2, method: 'lead/chat/send', params: { id: 'demo:session-1', text: 'Fix it' } } as const
  const flow = { id: 3, method: 'flow/start-goal', params: { root: project, sentence: 'Fix it', source: 'recipe' } } as never
  const workspace = { id: 4, method: 'workspace/open', params: { path: project } } as never
  for (const request of [start, send, flow, workspace]) assert.equal(await authority.authorize(request), 'leadPlanNotApproved')
  assert.equal(await authority.authorize({ id: 5, method: 'lead/chat/stop', params: { id: 'demo:session-1' } }), null)
  assert.equal(await authority.authorize({ id: 6, method: 'lead/desk/summary', params: {} }), null)
  awaits = false
  for (const request of [start, send, flow, workspace]) assert.equal(await authority.authorize(request), null)
})
