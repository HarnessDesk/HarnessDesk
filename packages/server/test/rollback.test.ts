import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import type { Session } from '@harnessdesk/protocol'

import { FAKE_RUNTIME_ID, type FakeSession } from './fixtures/fake-runtime.js'
import { Client, start, stop } from './fixtures/harness.js'

const until = async (what: string, check: () => boolean): Promise<void> => {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

test('a rollback reaches the transcript store, so a restart does not bring the dropped turns back (#156)', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const session = (await client.call('session/create', { runtime: FAKE_RUNTIME_ID, options: { cwd: '/w' } })) as Session
  const live = harness.runtime.sessions.get(session.id) as FakeSession
  // The fake keeps no history of its own to undo; what a rollback trims is the host's copy.
  ;(live as unknown as { rollback(turns: number): Promise<void> }).rollback = async () => {}

  for (const text of ['one', 'two', 'three']) {
    const done = client.events.filter((event) => event.type === 'turn/completed').length
    await client.call('turn/send', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, input: [{ type: 'text', text }] })
    live.finish()
    await client.until(() => client.events.filter((event) => event.type === 'turn/completed').length > done)
  }
  const folder = join(harness.stateDir, 'transcripts', FAKE_RUNTIME_ID)
  const file = () => join(folder, readdirSync(folder).find((name) => name.endsWith('.json')) ?? 'none.json')
  const turnsOnDisk = (): number => (JSON.parse(readFileSync(file(), 'utf8')) as { turns: unknown[] }).turns.length
  await until('three turns on disk', () => existsSync(folder) && existsSync(file()) && turnsOnDisk() === 3)

  await client.call('session/rollback', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, turns: 1 })
  await until('two turns on disk', () => turnsOnDisk() === 2)

  // Every turn rolled back leaves nothing to record, and the file goes rather than keeping the last two.
  const onDisk = file()
  await client.call('session/rollback', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, turns: 2 })
  assert.equal(existsSync(onDisk), false)
})
