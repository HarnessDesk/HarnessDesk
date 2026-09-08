import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  runtimeId,
  sessionId,
  type Page,
  type SessionDeletion,
  type SessionSummary,
} from '@harnessdesk/protocol'

import { Host, Logger, StateStore, serve } from '../src/index.js'
import { SessionArchive } from '../src/archive.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client } from './fixtures/harness.js'

/**
 * Archiving and deleting, from the wire down.
 *
 * The property that matters: *every* agent can archive, whether or not it has
 * an archive. A runtime that keeps one is asked; a runtime that does not gets
 * the host's own mark, and its listings are filtered by it. Nothing is ever
 * written down for a runtime that has its own — two archives disagreeing is
 * worse than one.
 */

const silent = new Logger('test', { level: 'error', console: false })

const summary = (id: string, cwd = '/w'): SessionSummary => ({
  id: sessionId(id),
  runtime: runtimeId('fake'),
  title: `session ${id}`,
  preview: null,
  cwd,
  status: { type: 'idle' },
  createdAt: 1,
  updatedAt: 2,
})

interface Rig {
  readonly host: Host
  readonly runtime: FakeRuntime
  readonly client: Client
  readonly stateDir: string
  close(): Promise<void>
}

const start = async (capabilities?: { archiveHistory?: boolean; deleteHistory?: boolean }): Promise<Rig> => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-archive-'))
  const runtime = new FakeRuntime(capabilities ? { capabilities } : {})
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
    host,
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

const list = (client: Client, archived?: 'only'): Promise<Page<SessionSummary>> =>
  client.call('session/list', {
    runtime: 'fake',
    ...(archived ? { archived } : {}),
  }) as Promise<Page<SessionSummary>>

test('an agent with no archive of its own still archives, and the host holds the mark', async () => {
  const rig = await start({ archiveHistory: false })
  try {
    rig.runtime.history.push(summary('a'), summary('b'))

    await rig.client.call('session/archive', { runtime: 'fake', sessionId: 'a', archived: true })

    const open = await list(rig.client)
    assert.deepEqual(open.data.map((row) => String(row.id)), ['b'])

    const archived = await list(rig.client, 'only')
    assert.deepEqual(archived.data.map((row) => String(row.id)), ['a'])
    // The flag is filled in, so a screen showing the archive does not have to
    // infer it from the fact that it asked.
    assert.equal(archived.data[0]?.archived, true)

    // The runtime was never asked: it has no archive, and being asked would
    // have thrown.
    assert.deepEqual([...rig.runtime.archived], [])

    // And it survives a restart, because it is on disk.
    const stored = JSON.parse(await readFile(join(rig.stateDir, 'archive.json'), 'utf8')) as {
      entries: readonly { runtime: string; sessionId: string }[]
    }
    assert.deepEqual(stored.entries.map((entry) => entry.sessionId), ['a'])
  } finally {
    await rig.close()
  }
})

test('unarchiving puts it straight back in the ordinary list', async () => {
  const rig = await start({ archiveHistory: false })
  try {
    rig.runtime.history.push(summary('a'))
    await rig.client.call('session/archive', { runtime: 'fake', sessionId: 'a', archived: true })
    assert.equal((await list(rig.client)).data.length, 0)

    await rig.client.call('session/archive', { runtime: 'fake', sessionId: 'a', archived: false })
    assert.deepEqual((await list(rig.client)).data.map((row) => String(row.id)), ['a'])
    assert.equal((await list(rig.client, 'only')).data.length, 0)
  } finally {
    await rig.close()
  }
})

test("an agent with its own archive is the authority, and nothing is written down here", async () => {
  const rig = await start({ archiveHistory: true })
  try {
    rig.runtime.history.push(summary('a'), summary('b'))

    await rig.client.call('session/archive', { runtime: 'fake', sessionId: 'a', archived: true })

    assert.deepEqual([...rig.runtime.archived], ['a'])
    assert.deepEqual((await list(rig.client)).data.map((row) => String(row.id)), ['b'])
    assert.deepEqual((await list(rig.client, 'only')).data.map((row) => String(row.id)), ['a'])

    // No shadow copy: the runtime's answer is the whole answer.
    await assert.rejects(readFile(join(rig.stateDir, 'archive.json'), 'utf8'))
  } finally {
    await rig.close()
  }
})

test('deleting reports what happened and clears the mark the host was holding', async () => {
  const rig = await start({ archiveHistory: false })
  try {
    rig.runtime.history.push(summary('a'))
    await rig.client.call('session/archive', { runtime: 'fake', sessionId: 'a', archived: true })

    const outcome = (await rig.client.call('session/delete', {
      runtime: 'fake',
      sessionId: 'a',
    })) as SessionDeletion
    assert.equal(outcome.disposition, 'removed')
    assert.deepEqual(rig.runtime.deleted, ['a'])

    // Gone from both sides. A mark left behind would hide the next session
    // that happened to be given the same id.
    assert.equal((await list(rig.client, 'only')).data.length, 0)
    const archive = new SessionArchive(join(rig.stateDir, 'archive.json'))
    await archive.load()
    assert.equal(archive.has(runtimeId('fake'), sessionId('a')), false)
  } finally {
    await rig.close()
  }
})

test('an agent that cannot delete is refused before anything is thrown away', async () => {
  const rig = await start({ archiveHistory: false, deleteHistory: false })
  try {
    rig.runtime.history.push(summary('a'))
    await assert.rejects(
      rig.client.call('session/delete', { runtime: 'fake', sessionId: 'a' }),
      /cannot delete a stored conversation/,
    )
    assert.deepEqual(rig.runtime.deleted, [])
    assert.deepEqual((await list(rig.client)).data.map((row) => String(row.id)), ['a'])
  } finally {
    await rig.close()
  }
})

test('the archive file survives being unreadable, and reads back what it wrote', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-archive-store-'))
  try {
    const file = join(dir, 'archive.json')
    await writeFile(file, 'not json at all')

    const broken = new SessionArchive(file)
    await broken.load()
    assert.equal(broken.count(runtimeId('claude-code')), 0)

    await broken.set(runtimeId('claude-code'), sessionId('x'), true)
    // Setting the same mark twice is not two entries.
    await broken.set(runtimeId('claude-code'), sessionId('x'), true)

    const reopened = new SessionArchive(file)
    await reopened.load()
    assert.equal(reopened.has(runtimeId('claude-code'), sessionId('x')), true)
    assert.equal(reopened.count(runtimeId('claude-code')), 1)
    assert.equal(reopened.has(runtimeId('cursor'), sessionId('x')), false, 'ids are per agent')
    assert.notEqual(reopened.archivedAt(runtimeId('claude-code'), sessionId('x')), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
