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
