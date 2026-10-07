import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '../src/index.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))

test('an idle stop reaps the bridge and serves cached models, account, and history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hd-acp-idle-'))
  const store = join(directory, 'sessions.json')
  await writeFile(store, JSON.stringify({
    older: {
      sessionId: 'older',
      cwd: '/tmp/old-project',
      title: 'Earlier session',
      updatedAt: '2026-09-30T00:00:00.000Z',
    },
  }))
  const runtime = new AcpRuntime({
    id: 'idle-fake',
    name: 'Idle Fake',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_STORE: store },
  })
  t.after(async () => {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  await runtime.start()
  const skills = await runtime.listSkills()
  assert.deepEqual(skills.map((skill) => skill.name), ['forget', 'rehearse'])
  const models = await runtime.knownModels()
  assert.ok(models)
  const options = await runtime.defaultSessionOptions()
  assert.ok(options.length > 0)
  const account = await runtime.getAccount()
  const history = await runtime.listSessions()
  assert.equal(history.data[0]?.title, 'Earlier session')
  const pid = Number(runtime.info.version)
  assert.ok(Number.isInteger(pid) && pid > 0)
  assert.deepEqual(runtime.resourceProcessIds(), [pid])

  // Taken at the stop, not earlier: the agent's command list (which sets `skills`) arrives on its own schedule after the
  // session starts, and once the process is gone this snapshot is exactly what the idle runtime must keep serving.
  const info = runtime.info
  assert.equal(await runtime.stopForIdle(), true)
  assert.deepEqual(runtime.resourceProcessIds(), [], 'an idle stop releases the observed root')
  assert.equal(runtime.health().state, 'idle')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.deepEqual(await runtime.listModels(), models)
  assert.deepEqual(await runtime.defaultSessionOptions(), options)
  assert.deepEqual(await runtime.getAccount(), account)
  assert.deepEqual(runtime.info.capabilities, info.capabilities)
  assert.deepEqual(runtime.info.presentation, info.presentation)
  assert.deepEqual(await runtime.listSessions(), history)
  assert.deepEqual(await runtime.listSkills(), skills, 'the cached skills remain available while idle')
  assert.equal(runtime.health().state, 'idle', 'reading cached skills does not restart the helper')

  await runtime.start()
  assert.equal(runtime.health().state, 'ready')
  assert.notEqual(Number(runtime.info.version), pid)
})

test('releasing a conversation allows idle stop and resumes the same agent history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hd-acp-release-'))
  const store = join(directory, 'sessions.json')
  const runtime = new AcpRuntime({
    id: 'release-fake', name: 'Release Fake', command: process.execPath,
    args: [FAKE], env: { FAKE_ACP_STORE: store },
  })
  t.after(async () => {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  await runtime.start()
  const session = await runtime.createSession({ cwd: directory })
  const completed = new Promise<void>((resolve) => {
    const off = runtime.subscribe((event) => {
      if (event.type === 'turn/completed' && event.sessionId === session.id) { off(); resolve() }
    })
  })
  await session.send([{ type: 'text', text: 'Remember the review context.' }])
  await completed
  const history = await readFile(store, 'utf8')
  assert.equal(await runtime.stopForIdle(), false, 'a live handle still holds the process')
  await session.close()
  assert.equal(await readFile(store, 'utf8'), history, 'release leaves the agent store untouched')
  assert.equal(await runtime.stopForIdle(), true, 'close removes the adapter handle')
  await runtime.start()
  const resumed = await runtime.resumeSession(session.id)
  assert.equal(resumed.id, session.id)
  const transcript = await runtime.readSession(session.id)
  assert.ok(transcript.turns.some((turn) => turn.items.some((item) =>
    item.type === 'userMessage' && item.content.some((part) => part.type === 'text' && part.text.includes('review context')))))
  await session.close()
  assert.equal(await runtime.stopForIdle(), false, 'a stale close must not drop the new handle')
  await resumed.close()
  assert.equal(await runtime.stopForIdle(), true)
})

for (const noList of [false, true]) {
  test(`a released ${noList ? 'no-list' : 'listed'} conversation can be read without retaining a handle`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hd-acp-read-release-'))
    const runtime = new AcpRuntime({
      id: 'read-release', name: 'Read Release', command: process.execPath, args: [FAKE],
      env: { FAKE_ACP_STORE: join(directory, 'sessions.json'), ...(noList ? { FAKE_ACP_NO_LIST: '1' } : {}) },
    })
    t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
    await runtime.start()
    const session = await runtime.createSession({ cwd: directory })
    const completed = new Promise<void>((resolve) => {
      const off = runtime.subscribe((event) => {
        if (event.type === 'turn/completed' && event.sessionId === session.id) { off(); resolve() }
      })
    })
    await session.send([{ type: 'text', text: 'Keep this context.' }])
    await completed
    await session.close()
    assert.equal(await runtime.stopForIdle(), true)
    await runtime.start()
    const [read, alsoRead] = await Promise.all([runtime.readSession(session.id), runtime.readSession(session.id)])
    assert.deepEqual(alsoRead, read, 'concurrent bookkeeping reads share the complete replay')
    assert.equal(read.id, session.id)
    assert.equal(read.cwd, directory)
    assert.equal(await runtime.stopForIdle(), true, 'a bookkeeping read must release its temporary handle')
    await runtime.start()
    const resumed = await runtime.resumeSession(session.id)
    assert.equal(resumed.id, session.id)
    assert.equal(await runtime.stopForIdle(), false, 'an explicit resume retains its handle')
    await resumed.close()
    assert.equal(await runtime.stopForIdle(), true)
  })
}


for (const second of ['read', 'resume'] as const) {
  test(`a ${second} during a bookkeeping replay waits for its history and keeps the right owner`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hd-acp-read-owner-'))
    const store = join(directory, 'sessions.json')
    const opens = join(directory, 'opens.ndjson')
    await writeFile(store, JSON.stringify({ saved: { sessionId: 'saved', cwd: directory,
      turns: [['Keep the review context.']], updatedAt: '2026-09-30T00:00:00.000Z' } }))
    const runtime = new AcpRuntime({ id: 'read-owner', name: 'Read Owner', command: process.execPath, args: [FAKE],
      env: { FAKE_ACP_STORE: store, FAKE_ACP_OPENS: opens, FAKE_ACP_LOAD_DELAY_MS: '100' } })
    t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
    await runtime.start()
    const first = runtime.readSession('saved' as never)
    const deadline = Date.now() + 5_000
    while (!(await readFile(opens, 'utf8').catch(() => '')).includes('session/load')) {
      assert.ok(Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const next = second === 'read' ? runtime.readSession('saved' as never) : runtime.resumeSession('saved' as never)
    const [read, result] = await Promise.all([first, next])
    assert.ok(read.turns.length > 0)
    if (second === 'read') {
      assert.deepEqual(result, read, 'a second read waits for the entire replay')
      assert.equal(await runtime.stopForIdle(), true)
    } else {
      assert.equal(await runtime.stopForIdle(), false, 'an explicit resume owns the loaded conversation')
      await (result as Awaited<ReturnType<typeof runtime.resumeSession>>).close()
      assert.equal(await runtime.stopForIdle(), true)
    }
  })
}
