import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { sessionId, splitContext, type Session, type TeamState } from '@harnessdesk/protocol'

import { Host, Logger, StateStore, serve } from '../src/index.js'
import { FAKE_RUNTIME_ID, FakeRuntime, type FakeSession } from './fixtures/fake-runtime.js'
import { Client } from './fixtures/harness.js'

/**
 * The attribution on the room's path. A post to a room reaches each member
 * through the team port's `send`, which is the third way words reach an
 * agent after the person's own send and the queue — and the one a test had
 * not driven. A member asked by the room signs the same way as one asked by
 * the person: once, and not again while the seat stands.
 */

const silent = new Logger('test', { level: 'error', console: false })

test('a post to a room carries the desk’s attribution to the member once', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-attribution-room-'))
  const work = await realpath(await mkdtemp(join(tmpdir(), 'hd-attribution-room-work-')))
  const runtime = new FakeRuntime()
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), version: '9.9.9' })
  host.register(runtime)
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  const client = await Client.connect(server)
  t.after(async () => {
    client.close()
    await server.close()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })

  await client.call('workspace/open', { path: work })
  const room = (await client.call('team/room/create', { root: work, name: 'Release notes' })) as TeamState
  const member = (await client.call('session/create', { runtime: FAKE_RUNTIME_ID, options: { cwd: work } })) as Session
  await client.call('team/room/join', { room: room.id, runtime: FAKE_RUNTIME_ID, sessionId: member.id })

  const post = async (text: string): Promise<string> => {
    const started = client.events.filter((event) => event.type === 'turn/started').length
    await client.call('team/post', { room: room.id, text })
    await client.until(() => client.events.filter((event) => event.type === 'turn/started').length > started)
    const live = runtime.sessions.get(sessionId(member.id)) as FakeSession
    const completed = client.events.filter((event) => event.type === 'turn/completed').length
    live.finish()
    await client.until(() => client.events.filter((event) => event.type === 'turn/completed').length > completed)
    const record = host.registry.get(FAKE_RUNTIME_ID, sessionId(member.id))
    const asked = record!.session.turns.at(-1)?.items.find((item) => item.type === 'userMessage')
    return asked?.type === 'userMessage' && asked.content[0]?.type === 'text' ? asked.content[0].text : ''
  }

  const first = splitContext(await post('Open the pull request for the release notes.'))
  assert.ok(first.text.includes('Open the pull request'), 'the post reached the member')
  assert.ok(
    first.injections.some((injection) => injection.label === 'HarnessDesk'),
    'the room’s post carried the desk’s attribution to the member',
  )
  const second = splitContext(await post('And say when it is up.'))
  assert.equal(
    second.injections.filter((injection) => injection.label === 'HarnessDesk').length,
    0,
    'the same seat is not told twice through the room either',
  )
})
