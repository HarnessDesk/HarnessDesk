import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  runtimeId,
  sessionId,
  type Page,
  type Session,
  type SessionDeletion,
  type SessionSummary,
} from '@harnessdesk/protocol'

import { Host, Logger, StateStore, serve, type RunningServer } from '../src/index.js'
import { SessionArchive } from '../src/archive.js'
import { FakeRuntime, type FakeSession } from './fixtures/fake-runtime.js'
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
  readonly server: RunningServer
  readonly stateDir: string
  close(): Promise<void>
}

const start = async (capabilities?: { archiveHistory?: boolean; deleteHistory?: boolean }, name?: string): Promise<Rig> => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-archive-'))
  const runtime = new FakeRuntime({ ...(capabilities ? { capabilities } : {}), ...(name ? { name } : {}) })
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
    server,
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

test('deleting tells every window to drop it, not only the one that asked', async () => {
  const rig = await start({ archiveHistory: false })
  // A second window, drawing the same conversation, that asked for nothing.
  const other = await Client.connect(rig.server)
  try {
    rig.runtime.history.push(summary('a'))
    await rig.client.call('session/delete', { runtime: 'fake', sessionId: 'a' })
    await other.until(
      () =>
        other.notifications.some(
          (one) =>
            'method' in one &&
            one.method === 'session/removed' &&
            String(one.params.runtime) === 'fake' &&
            String(one.params.sessionId) === 'a',
        ),
      2_000,
      'session/removed in the window that did not ask',
    )
  } finally {
    other.close()
    await rig.close()
  }
})

test('an agent that cannot delete is refused before anything is thrown away', async () => {
  // #102: the refusal named the runtime by its internal name.
  const rig = await start({ archiveHistory: false, deleteHistory: false }, 'fake-internal')
  try {
    rig.runtime.history.push(summary('a'))
    await assert.rejects(rig.client.call('session/delete', { runtime: 'fake', sessionId: 'a' }), (error: Error) => {
      assert.match(error.message, /Fake Runtime cannot delete a stored conversation/)
      assert.doesNotMatch(error.message, /fake-internal/)
      return true
    })
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

test('concurrent load calls both await reading and observe populated entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-archive-load-'))
  try {
    const file = join(dir, 'archive.json')
    const initial = {
      version: 1,
      entries: [
        { runtime: 'fake', sessionId: 's1', archivedAt: 123 },
        { runtime: 'fake', sessionId: 's2', archivedAt: 456 },
      ],
    }
    await writeFile(file, JSON.stringify(initial))

    const archive = new SessionArchive(file)
    let secondSawCount = -1
    const p1 = archive.load()
    const p2 = (async () => {
      await archive.load()
      secondSawCount = archive.count(runtimeId('fake'))
    })()

    await Promise.all([p1, p2])
    assert.equal(secondSawCount, 2, 'the concurrent load caller saw the populated archive entries')
    assert.equal(archive.has(runtimeId('fake'), sessionId('s1')), true)
    assert.equal(archive.has(runtimeId('fake'), sessionId('s2')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a write failure in session archive rejects the caller and does not poison subsequent writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-archive-fail-'))
  try {
    const sub = join(dir, 'sub')
    await writeFile(sub, 'blocking-file')
    const archive = new SessionArchive(join(sub, 'archive.json'))
    await archive.load()

    // The write must reject when filesystem fails (#307)
    await assert.rejects(archive.set(runtimeId('fake'), sessionId('s1'), true))

    // Once the obstruction is cleared, subsequent writes succeed and are not poisoned
    await rm(sub)
    await assert.doesNotReject(archive.set(runtimeId('fake'), sessionId('s2'), true))
    assert.equal(archive.has(runtimeId('fake'), sessionId('s2')), true)

    // The control: a reloaded archive reads back the successfully written entry
    const reloaded = new SessionArchive(join(sub, 'archive.json'))
    await reloaded.load()
    assert.equal(reloaded.has(runtimeId('fake'), sessionId('s2')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('session/archive wire call rejects when host archive cannot be persisted', async () => {
  const rig = await start({ archiveHistory: false })
  try {
    rig.runtime.history.push(summary('a'))
    // Obstruct persistence by placing a directory at archive.json path
    const archivePath = join(rig.stateDir, 'archive.json')
    await mkdir(archivePath)

    await assert.rejects(
      rig.client.call('session/archive', { runtime: 'fake', sessionId: 'a', archived: true }),
    )
  } finally {
    await rig.close()
  }
})



test('archiving a resumable conversation releases its handle and leaves a sibling open', async () => {
  const rig = await start({ archiveHistory: false })
  try {
    const first = await rig.client.call('session/create', { runtime: 'fake', options: { cwd: '/tmp' } }) as { id: string }
    const sibling = await rig.client.call('session/create', { runtime: 'fake', options: { cwd: '/tmp' } }) as { id: string }
    await rig.client.call('session/archive', { runtime: 'fake', sessionId: first.id, archived: true })
    const record = rig.host.registry.get(runtimeId('fake'), sessionId(first.id))!
    assert.equal(record.live, null)
    assert.equal(record.detached, false)
    assert.ok(rig.host.registry.get(runtimeId('fake'), sessionId(sibling.id))?.live)
    await rig.client.call('session/archive', { runtime: 'fake', sessionId: first.id, archived: false })
    await rig.client.call('session/resume', { runtime: 'fake', sessionId: first.id })
    assert.ok(record.live, 'opening after unarchive resumes the stored conversation')
  } finally { await rig.close() }
})

test('an archive that was stored succeeds even if its quiet handle refuses close', async () => {
  const rig = await start({ archiveHistory: false })
  try {
    const opened = await rig.client.call('session/create', { runtime: 'fake', options: { cwd: '/tmp' } }) as { id: string }
    const record = rig.host.registry.get(runtimeId('fake'), sessionId(opened.id))!
    record.live!.close = async () => { throw new Error('close refused') }
    await rig.client.call('session/archive', { runtime: 'fake', sessionId: opened.id, archived: true })
    assert.equal(record.live, null)
    assert.equal((await list(rig.client, 'only')).data[0]?.id, opened.id)
  } finally { await rig.close() }
})

test('archive preserves work, approvals, queued input and running tasks', async () => {
  const rig = await start({ archiveHistory: false })
  try {
    for (const busy of ['turn', 'approval', 'queue', 'task'] as const) {
      const opened = await rig.client.call('session/create', { runtime: 'fake', options: { cwd: '/tmp' } }) as { id: string }
      const record = rig.host.registry.get(runtimeId('fake'), sessionId(opened.id))!
      const live = record.live
      let closes = 0
      record.live!.close = async () => { closes++ }
      if (busy === 'turn') record.running.add('working' as never)
      if (busy === 'approval') record.approvals.set('approval', {} as never)
      if (busy === 'queue') record.queue = { ...record.queue, messages: [{ id: 'queued' } as never] }
      if (busy === 'task') record.tasks = [{ id: 'task', state: 'running' } as never]
      await rig.client.call('session/archive', { runtime: 'fake', sessionId: opened.id, archived: true })
      assert.equal(closes, 0, busy)
      assert.equal(record.live, live, busy)
    }
  } finally { await rig.close() }
})

const until = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3_000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'the host did not settle')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** A conversation the agent has been prompted in, with that turn finished: quiet, and one a reopen can find. */
const openWithATurn = async (rig: Rig) => {
  const opened = await rig.client.call('session/create', { runtime: 'fake', options: { cwd: '/tmp' } }) as { id: string }
  const params = { runtime: 'fake', sessionId: opened.id }
  await rig.client.call('turn/send', { ...params, input: [{ type: 'text', text: 'First' }] })
  const record = rig.host.registry.get(runtimeId('fake'), sessionId(opened.id))!
  const live = record.live as FakeSession
  await until(() => record.session.turns.length > 0)
  live.finish('Done')
  await until(() => record.running.size === 0)
  return { params, record, live }
}

const heldPicks = (options: Session['options']): Record<string, unknown> =>
  Object.fromEntries((options ?? []).filter(option => ['model', 'tone'].includes(option.id))
    .map(option => [option.id, option.currentValue]))

test('archive keeps the picks a quiet conversation held, as the rest does', async () => {
  const rig = await start({ archiveHistory: false })
  try {
    const { params, record } = await openWithATurn(rig)
    await rig.client.call('session/options/set', { ...params, optionId: 'model', value: 'fake-2' })
    await rig.client.call('session/options/set', { ...params, optionId: 'tone', value: 'cheerful' })
    await rig.client.call('session/archive', { ...params, archived: true })
    assert.equal(record.live, null)
    // The agent forgets what it was told while the conversation rests, so the
    // handle it hands back answers with its own defaults.
    rig.runtime.sessions.delete(params.sessionId)
    await rig.client.call('session/archive', { ...params, archived: false })
    const resumed = await rig.client.call('session/resume', params) as Session
    assert.deepEqual(heldPicks(resumed.options), { model: 'fake-2', tone: 'cheerful' })
  } finally { await rig.close() }
})

test('archive does not release a conversation while a send is on its way to the agent', async () => {
  const rig = await start({ archiveHistory: false })
  try {
    const { params, record, live } = await openWithATurn(rig)
    const send = live.send.bind(live)
    let arrived!: () => void
    const reached = new Promise<void>(resolve => { arrived = resolve })
    let proceed!: () => void
    const gate = new Promise<void>(resolve => { proceed = resolve })
    live.send = async (input, options) => { arrived(); await gate; return send(input, options) }
    const sending = rig.client.call('turn/send', { ...params, input: [{ type: 'text', text: 'Next' }] })
    await reached
    await rig.client.call('session/archive', { ...params, archived: true })
    assert.equal(record.live, live, 'the handle the send is using is still the conversation\'s')
    proceed()
    await sending
  } finally { await rig.close() }
})
