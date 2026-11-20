import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClientMessage } from '@harnessdesk/protocol'
import { Client, start, stop } from './fixtures/harness.js'

test('host advertises a stable epoch and samples its clock over the authenticated wire', async t => {
  const rig = await start()
  t.after(() => stop(rig))
  const client = await Client.connect(rig.server)
  t.after(() => client.close())
  const hello = await client.call('host/hello', { clientVersion: 'old' }) as { capabilities?: { hostClock?: boolean } }
  assert.equal(hello.capabilities?.hostClock, true)
  const before = Date.now()
  const first = await client.call('host/clock' as never, {} as never) as { hostNowMs: number; clockEpoch: string }
  const second = await client.call('host/clock' as never, {} as never) as { hostNowMs: number; clockEpoch: string }
  assert.ok(first.hostNowMs >= before && first.hostNowMs <= Date.now())
  assert.ok(first.clockEpoch.length > 0)
  assert.equal(first.clockEpoch, second.clockEpoch)
})

test('host clock accepts only an empty object as parameters', () => {
  assert.deepEqual(parseClientMessage({ id: 1, method: 'host/clock', params: {} }).params, {})
  for (const params of [null, [], { unexpected: true }]) {
    assert.throws(() => parseClientMessage({ id: 1, method: 'host/clock', params }))
  }
})
