import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client, start, stop } from './fixtures/harness.js'
import { UsageHistory } from '../src/usage/history.js'

test('unregister starts disposal before waiting for history cleanup', async t => {
  const desk = await start()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.after(async () => { release(); await stop(desk) })
  const forgetting = t.mock.method(UsageHistory.prototype, 'forgetWithoutRead', async () => { await gate })
  const disposal = t.mock.method(desk.runtime, 'dispose')
  const removing = desk.host.unregister(desk.runtime.info.id)
  try {
    assert.equal(forgetting.mock.callCount(), 1)
    assert.equal(disposal.mock.callCount(), 1, 'the runtime starts stopping even while disk cleanup is blocked')
  } finally { release(); await removing }
})

test('a history cleanup failure warns but does not turn a successful runtime logout into failure', async t => {
  const desk = await start()
  t.after(() => stop(desk))
  const client = await Client.connect(desk.server)
  t.after(() => client.close())
  const path = join(desk.stateDir, 'usage-last-observation.json.epoch')
  await rm(path, { force: true, recursive: true })
  await mkdir(path)
  const result = await client.call('runtime/logout', { runtime: desk.runtime.info.id })
  assert.equal(result, null)
  assert.equal(desk.runtime.loggedOut, true)
  const warning = client.notifications.find(item => 'method' in item && item.method === 'event' && item.params.event.type === 'notice' && item.params.event.message.includes('could not be cleared'))
  assert.ok(warning, 'a sanitized warning reaches the client')
  assert.doesNotMatch(JSON.stringify(warning), /EISDIR|usage-last-observation|harnessdesk-test/)
})
