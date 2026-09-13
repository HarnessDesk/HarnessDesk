import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runtimeId, sessionId, type Page, type SessionSummary } from '@harnessdesk/protocol'

import { Host, Logger, StateStore, serve } from '../src/index.js'
import { SessionNames } from '../src/names.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client } from './fixtures/harness.js'

/**
 * Naming a conversation, from the wire down.
 *
 * The property that matters is the archive's, one field over: *every* agent
 * can be told a name, whether or not it can keep one. A runtime that keeps its
 * own is asked; a runtime that cannot gets the host's, and its listings wear
 * it. Nothing is ever written down for a runtime that has its own — two names
 * disagreeing is worse than one.
 *
 * Before this, `setTitle` reached the ACP adapter and threw. The rename was
 * offered in the interface, went all the way through the store, and failed at
 * the bottom — so three Cursor conversations on one board stayed three rows
 * all called "Cursor", which is exactly the case where a name is the only
 * thing telling them apart.
 */

const silent = new Logger('test', { level: 'error', console: false })

const summary = (id: string): SessionSummary => ({
  id: sessionId(id),
  runtime: runtimeId('fake'),
  title: `session ${id}`,
  preview: null,
  cwd: '/w',
  status: { type: 'idle' },
  createdAt: 1,
  updatedAt: 2,
})

interface Rig {
  readonly runtime: FakeRuntime
  readonly client: Client
  readonly stateDir: string
  close(): Promise<void>
}

const start = async (nameHistory: boolean): Promise<Rig> => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-names-'))
  const runtime = new FakeRuntime({ capabilities: { nameHistory } })
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
  })
  host.register(runtime)
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  const client = await Client.connect(server)
  return {
    runtime,
    client,
    stateDir,
    close: async () => {
      client.close()
      await server.close()
      await host.dispose()
      await rm(stateDir, { recursive: true, force: true })
    },
  }
}

const list = (client: Client): Promise<Page<SessionSummary>> =>
  client.call('session/list', { runtime: 'fake' }) as Promise<Page<SessionSummary>>

test('an agent that cannot keep a name still takes one, and the host holds it', async () => {
  const rig = await start(false)
  try {
    rig.runtime.history.push(summary('a'), summary('b'))

    await rig.client.call('session/setTitle', {
      runtime: 'fake',
      sessionId: 'a',
      title: 'gpt-5.3-codex-xhigh',
    })

    const rows = await list(rig.client)
    assert.deepEqual(
      rows.data.map((row) => row.title),
      ['gpt-5.3-codex-xhigh', 'session b'],
      'the named one wears the name; the other is untouched',
    )

    // The runtime was never asked: it cannot keep a name, and being asked
    // would have thrown — which is the whole bug this closes.
    assert.equal(rig.runtime.titles.length, 0)

    // And it survives a restart, because it is on disk.
    const stored = JSON.parse(await readFile(join(rig.stateDir, 'names.json'), 'utf8')) as {
      entries: readonly { sessionId: string; name: string }[]
    }
    assert.deepEqual(stored.entries, [{ runtime: 'fake', sessionId: 'a', name: 'gpt-5.3-codex-xhigh' }])
  } finally {
    await rig.close()
  }
})

test('an empty name gives the conversation its own back', async () => {
  const rig = await start(false)
  try {
    rig.runtime.history.push(summary('a'))
    await rig.client.call('session/setTitle', { runtime: 'fake', sessionId: 'a', title: 'temporary' })
    assert.equal((await list(rig.client)).data[0]?.title, 'temporary')

    await rig.client.call('session/setTitle', { runtime: 'fake', sessionId: 'a', title: '  ' })
    assert.equal(
      (await list(rig.client)).data[0]?.title,
      'session a',
      'clearing the name is not naming it the empty string',
    )
  } finally {
    await rig.close()
  }
})

test('an agent that keeps its own name is the one asked, and nothing is written here', async () => {
  const rig = await start(true)
  try {
    // Its own name lives on the session, so there has to be one open.
    const created = (await rig.client.call('session/create', {
      runtime: 'fake',
      options: { cwd: '/w' },
    })) as { id: string }
    await rig.client.call('session/setTitle', {
      runtime: 'fake',
      sessionId: created.id,
      title: 'the agent’s own',
    })

    assert.deepEqual(rig.runtime.titles, ['the agent’s own'], 'the runtime was asked')
    await assert.rejects(
      readFile(join(rig.stateDir, 'names.json'), 'utf8'),
      'nothing is written down for a runtime that has its own',
    )
  } finally {
    await rig.close()
  }
})

test('concurrent load calls both await reading and observe populated names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-names-load-'))
  try {
    const file = join(dir, 'names.json')
    const initial = {
      version: 1,
      entries: [
        { runtime: 'fake', sessionId: 's1', name: 'Name One' },
        { runtime: 'fake', sessionId: 's2', name: 'Name Two' },
      ],
    }
    await writeFile(file, JSON.stringify(initial))

    const names = new SessionNames(file)
    let secondSawName: string | null = null
    const p1 = names.load()
    const p2 = (async () => {
      await names.load()
      secondSawName = names.nameOf(runtimeId('fake'), sessionId('s1'))
    })()

    await Promise.all([p1, p2])
    assert.equal(secondSawName, 'Name One', 'the concurrent load caller saw the populated name')
    assert.equal(names.nameOf(runtimeId('fake'), sessionId('s2')), 'Name Two')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent set calls serialize without temp file collision or lost updates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-names-write-'))
  try {
    const file = join(dir, 'names.json')
    const names = new SessionNames(file)
    await names.load()

    // Control: single set works before and after
    await names.set(runtimeId('fake'), sessionId('s0'), 'Zero')
    assert.equal(names.nameOf(runtimeId('fake'), sessionId('s0')), 'Zero')

    // Concurrently set multiple session names
    await Promise.all([
      names.set(runtimeId('fake'), sessionId('s1'), 'Session One'),
      names.set(runtimeId('fake'), sessionId('s2'), 'Session Two'),
      names.set(runtimeId('fake'), sessionId('s3'), 'Session Three'),
    ])

    assert.equal(names.nameOf(runtimeId('fake'), sessionId('s1')), 'Session One')
    assert.equal(names.nameOf(runtimeId('fake'), sessionId('s2')), 'Session Two')
    assert.equal(names.nameOf(runtimeId('fake'), sessionId('s3')), 'Session Three')

    // Control: reloading from disk verifies durable write of all entries
    const reloaded = new SessionNames(file)
    await reloaded.load()
    assert.equal(reloaded.nameOf(runtimeId('fake'), sessionId('s1')), 'Session One')
    assert.equal(reloaded.nameOf(runtimeId('fake'), sessionId('s2')), 'Session Two')
    assert.equal(reloaded.nameOf(runtimeId('fake'), sessionId('s3')), 'Session Three')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

