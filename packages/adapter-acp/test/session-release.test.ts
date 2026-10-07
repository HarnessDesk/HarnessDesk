import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpRuntime } from '../src/index.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (check: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('read resources did not rest')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

for (const close of [true, false]) {
  test(`${close ? 'shared close-capable' : 'isolated no-close'} sessions release helpers and resume without touching a sibling`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-acp-lifetime-'))
    const log = join(dir, 'lifetime.ndjson')
    const runtime = new AcpRuntime({ id: 'lifetime', name: 'Lifetime', command: process.execPath, args: [FAKE],
      env: { FAKE_ACP_STORE: join(dir, 'store.json'), FAKE_ACP_STORE_DRAFTS: '1', FAKE_ACP_LIFETIME: log,
        ...(!close ? { FAKE_ACP_NO_CLOSE: '1' } : {}) } })
    t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
    const rows = async (): Promise<{ type: string; pid: number; sessionId?: string; helper?: number }[]> =>
      (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    await runtime.start()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    await runtime.defaultSessionOptions(dir)
    t.mock.timers.tick(5_000)
    t.mock.timers.reset()
    await until(async () => (await rows()).filter(r => r.helper && alive(r.helper)).length === 0)
    assert.equal((await rows()).filter(r => r.helper && alive(r.helper)).length, 0, 'the option probe releases its helper')
    const sessions = []
    for (let n = 1; n <= 8; n++) {
      sessions.push(await runtime.createSession({ cwd: dir }))
      if ([1, 3, 8].includes(n)) {
        const observed = await rows()
        assert.equal(observed.filter(r => r.type === 'bridge' && alive(r.pid)).length, close ? 1 : n + 1)
        assert.equal(observed.filter(r => r.helper && alive(r.helper)).length, n)
      }
    }
    const first = sessions[0]!
    const sibling = sessions[1]!
    const complete = new Promise<void>(resolve => {
      const off = runtime.subscribe(event => {
        if (event.type === 'turn/completed' && event.sessionId === sibling.id) { off(); resolve() }
      })
    })
    await sibling.send([{ type: 'text', text: 'slow' }])
    await first.close()
    assert.equal((await rows()).filter(r => r.helper && alive(r.helper)).length, 7)
    await sibling.interrupt()
    await complete
    const resumed = await runtime.resumeSession(first.id)
    assert.equal(resumed.id, first.id)
    await first.close()
    assert.equal((await rows()).filter(r => r.helper && alive(r.helper)).length, 8, 'stale close cannot retire a replacement')
    await resumed.close()
    for (const session of sessions.slice(1)) await session.close()
    assert.equal((await rows()).filter(r => r.helper && alive(r.helper)).length, 0)
    assert.equal((await rows()).filter(r => r.type === 'bridge' && alive(r.pid)).length, 1)
    assert.equal(await runtime.stopForIdle(), true)
    assert.equal((await rows()).filter(r => r.type === 'bridge' && alive(r.pid)).length, 0)
  })
}

test('a refused native close drops the handle and can reopen the durable conversation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-close-refusal-'))
  const runtime = new AcpRuntime({ id: 'refusal', name: 'Refusal', command: process.execPath, args: [FAKE],
    env: { FAKE_ACP_STORE: join(dir, 'store.json'), FAKE_ACP_STORE_DRAFTS: '1', FAKE_ACP_CLOSE_FAIL: '1' } })
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  await runtime.start()
  const session = await runtime.createSession({ cwd: dir })
  await assert.rejects(session.close(), /close refused/)
  const reopened = await runtime.resumeSession(session.id)
  assert.notEqual(reopened, session)
  await assert.rejects(reopened.close(), /close refused/)
  assert.equal(await runtime.stopForIdle(), true)
})

test('a no-close peer loses only the failed session and routes task controls to its replacement', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-worker-crash-'))
  const runtime = new AcpRuntime({ id: 'workers', name: 'Workers', command: process.execPath, args: [FAKE],
    env: { FAKE_ACP_STORE: join(dir, 'store.json'), FAKE_ACP_STORE_DRAFTS: '1', FAKE_ACP_NO_CLOSE: '1', FAKE_ACP_TASKS: '1' } })
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  await runtime.start()
  const first = await runtime.createSession({ cwd: dir })
  const sibling = await runtime.createSession({ cwd: dir })
  const detached = new Promise<void>(resolve => {
    const off = runtime.subscribe(event => {
      if (event.type === 'session/detached' && event.sessionId === first.id) { off(); resolve() }
    })
  })
  runtime.connectionFor(first.id).kill()
  await detached
  assert.equal(runtime.health().state, 'ready')
  assert.equal(await runtime.resumeSession(sibling.id), sibling)
  const resumed = await runtime.resumeSession(first.id)
  const running = new Promise<string>(resolve => {
    const off = runtime.subscribe(event => {
      if (event.type === 'session/tasks' && event.sessionId === first.id && event.tasks[0]?.state === 'running') {
        off(); resolve(event.tasks[0].id)
      }
    })
  })
  await resumed.send([{ type: 'text', text: 'bg pnpm dev' }])
  assert.equal(await runtime.tasks!.stop(first.id, await running), true)
  await resumed.close()
  await sibling.close()
})

for (const close of [true, false]) {
  test(`closing a ${close ? 'native' : 'isolated'} session abandons its outstanding permission`, async (t) => {
    const runtime = new AcpRuntime({ id: 'permissions', name: 'Permissions', command: process.execPath, args: [FAKE],
      env: { ...(!close ? { FAKE_ACP_NO_CLOSE: '1' } : {}) } })
    t.after(() => runtime.dispose())
    const approvals = new Set<string>()
    const requested = new Promise<void>(resolve => runtime.subscribe(event => {
      if (event.type === 'approval/requested') { approvals.add(event.approval.id); resolve() }
      if (event.type === 'approval/resolved') approvals.delete(event.approvalId)
    }))
    await runtime.start()
    const session = await runtime.createSession({ cwd: '/tmp' })
    await session.send([{ type: 'text', text: 'use the tool' }])
    await requested
    await session.close()
    assert.equal(approvals.size, 0, 'no abandoned permission keeps the host busy after release')
  })
}

test('a closed session clears the task list the host was keeping live', async (t) => {
  const runtime = new AcpRuntime({ id: 'tasks', name: 'Tasks', command: process.execPath, args: [FAKE],
    env: { FAKE_ACP_TASKS: '1' } })
  t.after(() => runtime.dispose())
  let running = 0
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  runtime.subscribe(event => {
    if (event.type === 'session/tasks') {
      running = event.tasks.filter(task => task.state === 'running').length
      if (running > 0) ready()
    }
  })
  await runtime.start()
  const session = await runtime.createSession({ cwd: '/tmp' })
  await session.send([{ type: 'text', text: 'bg pnpm dev' }])
  await started
  await session.close()
  assert.equal(running, 0)
})
