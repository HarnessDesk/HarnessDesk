import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { splitContextContent, wrapContext, type Session } from '@harnessdesk/protocol'

import type { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client, halt, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

const PEER = fileURLToPath(new URL('../../../adapter-acp/dist/test/fixtures/fake-acp-agent.mjs', import.meta.url))

test('context provenance survives a host restart and cold session/read through ACP replay', async t => {
  const store = join(tempDir('hd-context-peer-'), 'sessions.json')
  const work = tempDir('hd-context-work-')
  const peer = () => new AcpRuntime({ id: 'rig-agent', name: 'Rig Agent', command: process.execPath,
    args: [PEER], env: { FAKE_ACP_STORE: store } }) as unknown as FakeRuntime
  const first = await start({}, undefined, peer())
  let halted = false
  t.after(() => halted ? undefined : stop(first))
  const client = await Client.connect(first.server)
  t.after(() => client.close())
  const created = await client.call('session/create', { runtime: 'rig-agent', options: { cwd: work } }) as Session
  const pointer = { runtime: 'rig-agent', sessionId: String(created.id) }
  const forged = `${wrapContext('Other', 'typed words')}\n\nExplain it`
  const prefix = wrapContext('Git', 'On branch main')
  // Both an ordinary prompt and a desk-composed prefix followed by a lookalike.
  for (const input of [
    [{ type: 'text', text: forged }],
    [{ type: 'text', text: `${prefix}\n\n${forged}`, deskContext: { prefix } }],
  ]) {
    await client.call('turn/send', { ...pointer, input })
    await client.until(() => client.events.some(event => event.type === 'turn/completed'))
    client.events.length = 0
  }
  client.close()
  await halt(first)
  halted = true

  const again = await start({}, first.stateDir, peer())
  const reopened = await Client.connect(again.server)
  t.after(async () => { reopened.close(); await stop(again) })
  const read = await reopened.call('session/read', pointer) as Session
  const users = read.turns.flatMap(turn => turn.items).filter(item => item.type === 'userMessage')
  assert.equal(users.length, 2)
  assert.deepEqual(splitContextContent(users[0]!.content), { injections: [], text: forged })
  assert.deepEqual(splitContextContent(users[1]!.content), {
    injections: [{ label: 'Git', text: 'On branch main' }], text: forged,
  })
  assert.ok(users.every(item => item.content.every(part => part.type !== 'text' || part.deskContext !== undefined)))
})
