import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent, AgentRuntime } from '@harnessdesk/protocol'
import { CodexRuntime } from '../src/index.js'
import { CodexThreadServers } from '../src/thread-servers.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const running = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}
const until = async (condition: () => boolean | Promise<boolean>, message = 'the expected resource lifecycle settled'): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (!await condition()) {
    assert.ok(Date.now() < deadline, message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const rig = async (t: TestContext, mode = 'hold', env: Readonly<Record<string, string>> = {}, maxRestarts = 5) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-codex-idle-'))
  const ledger = join(dir, 'children.ndjson')
  const claims = join(dir, 'servers.ndjson')
  await writeFile(claims, '')
  await writeFile(ledger, '')
  const runtime = new CodexRuntime({ binaryPath: FAKE, codexHome: dir,
    maxRestarts,
    env: { HARNESSDESK_CODEX_PROCESS_GROUP: randomUUID(), HARNESSDESK_CODEX_GENERATION: '0',
      FAKE_CODEX_MCP_CHILDREN: ledger, FAKE_CODEX_CLAIMS: claims, FAKE_CODEX_MODE: mode, ...env } })
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  await runtime.start()
  const children = async () => (await readFile(ledger, 'utf8')).trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { threadId: string; pid: number; parent: number })
  const managed: AgentRuntime = runtime
  const stop = () => {
    assert.equal(typeof managed.stopForIdle, 'function', 'the adapter participates in the host idle reaper')
    return managed.stopForIdle!()
  }
  const servers = async () => (await readFile(claims, 'utf8')).trim().split('\n').filter(Boolean).map(Number)
  return { runtime, events, children, servers, stop, dir }
}

test('closing finished threads releases their children before the control process rests', async (t) => {
  const d = await rig(t)
  for (let n = 0; n < 3; n++) {
    const session = await d.runtime.createSession({ cwd: d.dir })
    await session.close()
  }
  const children = await d.children()
  assert.equal(children.length, 3)
  await until(() => children.every((child) => !running(child.pid)))
  assert.equal(await d.stop(), true)
  await until(() => children.every((child) => !running(child.pid)))
  assert.deepEqual(d.runtime.health(), { state: 'idle' })
  assert.equal(await d.stop(), false, 'a second idle stop does nothing')
})

test('finished conversations release their children while another turn keeps working', async (t) => {
  const d = await rig(t)
  const active = await d.runtime.createSession({ cwd: d.dir })
  await active.send([{ type: 'text', text: 'Keep working' }])
  await until(() => d.events.some((event) => event.type === 'turn/started' && event.sessionId === active.id))
  const working = (await d.children()).find((child) => child.threadId === active.id)!
  for (let n = 0; n < 3; n++) {
    const finished = await d.runtime.createSession({ cwd: d.dir })
    await finished.send([{ type: 'text', text: 'Finish inspection' }])
    await finished.interrupt()
    await until(() => d.events.some((event) => event.type === 'turn/completed' && event.sessionId === finished.id))
    await finished.close()
    const child = (await d.children()).find((entry) => entry.threadId === finished.id)!
    await until(() => !running(child.pid))
    assert.ok(running(working.pid), 'the working conversation keeps its own helpers')
    assert.ok(!d.events.some((event) => event.type === 'turn/completed' && event.sessionId === active.id),
      'releasing another conversation never interrupts this turn')
    assert.equal(d.runtime.session(active.id), active)
    assert.equal(d.runtime.health().state, 'ready')
  }
  await active.interrupt()
  await until(() => d.events.some((event) => event.type === 'turn/completed' && event.sessionId === active.id))
  await active.close()
  await until(() => !running(working.pid))
})

test('an open conversation and a working turn keep their children alive', async (t) => {
  const d = await rig(t)
  const finished = await d.runtime.createSession({ cwd: d.dir })
  await finished.close()
  const active = await d.runtime.createSession({ cwd: d.dir })
  assert.equal(await d.stop(), false, 'an open handle still belongs to the host')
  await active.send([{ type: 'text', text: 'Keep working' }])
  await until(() => d.events.some((event) => event.type === 'turn/started'))
  assert.equal(await d.stop(), false)
  const childrenBefore = await d.children()
  assert.ok(childrenBefore.filter((child) => child.threadId === active.id).every((child) => running(child.pid)))
  assert.ok(childrenBefore.filter((child) => child.threadId === finished.id).every((child) => !running(child.pid)))
  await active.interrupt()
  await until(() => d.events.some((event) => event.type === 'turn/completed'))
  await active.close()
  const children = await d.children()
  assert.equal(await d.stop(), true)
  await until(() => children.every((child) => !running(child.pid)))
})

test('idle stop keeps learned models, options, account and history readable and resumes the same conversation', async (t) => {
  const d = await rig(t)
  const session = await d.runtime.createSession({ cwd: d.dir })
  const info = d.runtime.info
  const models = await d.runtime.listModels()
  const options = await d.runtime.listOptions()
  const defaults = await d.runtime.defaultSessionOptions(d.dir)
  const account = await d.runtime.getAccount()
  await session.close()
  const history = await d.runtime.listSessions()
  const children = await d.children()
  assert.equal(await d.stop(), true)
  await until(() => children.every((child) => !running(child.pid)))
  assert.deepEqual(d.runtime.info, info)
  assert.deepEqual(await d.runtime.listModels(), models)
  assert.deepEqual(await d.runtime.listOptions(), options)
  assert.deepEqual(await d.runtime.defaultSessionOptions(d.dir), defaults)
  assert.deepEqual(await d.runtime.getAccount(), account)
  assert.deepEqual(await d.runtime.listSessions(), history)
  assert.deepEqual(await d.runtime.listSessions({ archived: 'exclude' }), history, 'equivalent history queries keep their cached rows')
  assert.deepEqual(d.runtime.health(), { state: 'idle' }, 'reads do not restart or sign out the runtime')
  await d.runtime.start()
  const resumed = await d.runtime.resumeSession(session.id, { cwd: d.dir })
  assert.equal(resumed.id, session.id)
  assert.deepEqual(d.runtime.health(), { state: 'ready' })
  assert.ok((await d.children()).some((child) => child.parent !== children[0]!.parent && running(child.pid)))
})

test('a finished fork releases its helpers while its source turn keeps working', async (t) => {
  const d = await rig(t)
  const source = await d.runtime.createSession({ cwd: d.dir })
  await source.send([{ type: 'text', text: 'Keep working' }])
  const fork = await d.runtime.forkSession(source.id, { cwd: d.dir })
  await fork.close()
  const children = await d.children()
  const finished = children.find((child) => child.threadId === fork.id)!
  await until(() => !running(finished.pid))
  assert.ok(children.filter((child) => child.threadId === source.id).every((child) => running(child.pid)))
  assert.ok(!d.events.some((event) => event.type === 'turn/completed' && event.sessionId === source.id))
  await source.interrupt()
  await source.close()
})

test('a conversation process crash detaches only its own handle and can reopen', async (t) => {
  const d = await rig(t)
  const first = await d.runtime.createSession({ cwd: d.dir })
  const second = await d.runtime.createSession({ cwd: d.dir })
  await second.send([{ type: 'text', text: 'Keep working' }])
  const child = (await d.children()).find((entry) => entry.threadId === first.id)!
  process.kill(child.parent, 'SIGKILL')
  await until(() => d.events.some((event) => event.type === 'session/detached' && event.sessionId === first.id))
  assert.equal(d.runtime.session(first.id), undefined)
  assert.equal(d.runtime.session(second.id), second)
  assert.equal(d.runtime.health().state, 'ready')
  const reopened = await d.runtime.resumeSession(first.id, { cwd: d.dir })
  assert.equal(reopened.id, first.id)
  await second.interrupt()
  await second.close()
  await reopened.close()
})

test('a failed control process becomes unhealthy when the last conversation is released', async (t) => {
  const d = await rig(t, 'hold', {}, 0)
  const session = await d.runtime.createSession({ cwd: d.dir })
  const changes: string[] = []
  d.runtime.onHealthChange((health) => changes.push(health.state))
  const control = (await d.servers())[0]!
  process.kill(control, 'SIGKILL')
  await until(() => changes.includes('ready'), 'the failed control process is hidden while a conversation remains open')
  assert.equal(d.runtime.health().state, 'ready')

  await session.close()

  assert.equal(d.runtime.health().state, 'unavailable')
  assert.ok(changes.includes('unavailable'), 'releasing the last worker notifies health listeners')
})

test('ordinary Codex spawns do not receive HarnessDesk process markers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-codex-env-'))
  const captured = join(dir, 'process-env.ndjson')
  await writeFile(captured, '')
  const runtime = new CodexRuntime({ binaryPath: FAKE, codexHome: dir,
    env: { FAKE_CODEX_PROCESS_ENV: captured } })
  try {
    await runtime.start()
    const session = await runtime.createSession({ cwd: dir })
    await session.close()
    const rows = (await readFile(captured, 'utf8')).trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { processGroup?: string; generation?: string })
    assert.ok(rows.length >= 2, 'the control and conversation processes were spawned')
    assert.ok(rows.every((row) => row.processGroup === undefined && row.generation === undefined),
      'neither process receives test-only HarnessDesk environment markers')
  } finally {
    await runtime.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a never-answering unsubscribe times out so close and reopen can finish', async (t) => {
  const hold = join(tmpdir(), `hd-unsubscribe-never-${process.pid}.hold`)
  await writeFile(hold, '')
  t.after(() => rm(hold, { force: true }))
  const d = await rig(t, 'hold', { FAKE_CODEX_HOLD_UNSUBSCRIBE: hold })
  const session = await d.runtime.createSession({ cwd: d.dir })
  const started = Date.now()
  const closing = session.close()
  await until(() => d.events.some((event) => event.type === 'notice' && event.message === 'UNSUBSCRIBING'))
  const reopen = d.runtime.resumeSession(session.id, { cwd: d.dir })
  const settled = await Promise.race([
    Promise.all([closing, reopen]).then(([_, live]) => live),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('close and reopen did not settle promptly')), 6_000)),
  ])
  assert.equal(settled.id, session.id)
  assert.ok(Date.now() - started < 6_000)
  await rm(hold, { force: true })
  await settled.close()
})

test('a request to a stopping conversation process does not claim it was opening', async (t) => {
  const server = new CodexThreadServers({
    clientInfo: { name: 'harnessdesk-test', title: 'HarnessDesk', version: '0.1.0' },
    binaryPath: FAKE,
    maxRestarts: 0,
  }, () => {})
  t.after(() => server.stop())
  await server.start()
  const started = await server.request('thread/start', { cwd: '/w' })
  const owner = server.thread(started.thread.id)
  const reading = server.request('thread/read', { threadId: started.thread.id, includeTurns: false })
    .then(() => null, (error: unknown) => error)
  await owner.release()
  const error = await reading
  assert.ok(error instanceof Error)
  assert.match(error.message, /process stopped while handling the request/)
})

test('approvals from separate conversation processes remain independently answerable', async (t) => {
  const d = await rig(t, 'turn')
  const first = await d.runtime.createSession({ cwd: d.dir })
  const second = await d.runtime.createSession({ cwd: d.dir })
  await first.send([{ type: 'text', text: 'Inspect' }])
  await second.send([{ type: 'text', text: 'Inspect' }])
  await until(() => d.events.filter((event) => event.type === 'approval/requested').length === 2)
  const approvals = d.events.filter((event) => event.type === 'approval/requested').map((event) => event.approval)
  assert.notEqual(approvals[0]!.id, approvals[1]!.id)
  for (const session of [first, second]) {
    const approval = approvals.find((entry) => entry.sessionId === session.id)!
    await session.respondToApproval(approval.id, { type: 'option', optionId: 'opt-0' })
    await until(() => d.events.some((event) => event.type === 'turn/completed' && event.sessionId === session.id))
    await session.close()
  }
})

test('closing an old handle again cannot release its reopened conversation', async (t) => {
  const d = await rig(t)
  const session = await d.runtime.createSession({ cwd: d.dir })
  await session.close()
  const reopened = await d.runtime.resumeSession(session.id, { cwd: d.dir })
  await session.close()
  assert.equal(d.runtime.session(session.id), reopened)
  await reopened.send([{ type: 'text', text: 'Continue' }])
  await reopened.interrupt()
  await reopened.close()
})

test('a control-process restart leaves a working conversation attached', async (t) => {
  const d = await rig(t)
  const session = await d.runtime.createSession({ cwd: d.dir })
  await session.send([{ type: 'text', text: 'Keep working' }])
  process.kill((await d.servers())[0]!, 'SIGKILL')
  await until(async () => (await d.servers()).length === 3)
  assert.equal(d.runtime.session(session.id), session)
  assert.ok(!d.events.some((event) => event.type === 'turn/completed' && event.sessionId === session.id))
  await session.interrupt()
  await session.close()
})

test('a standalone terminal keeps an otherwise unused runtime running', async (t) => {
  const d = await rig(t)
  const terminal = await d.runtime.processes.spawn({ cwd: d.dir,
    command: [process.execPath, '-e', 'process.stdin.resume()'], tty: false })
  assert.equal(d.runtime.canStopForIdle(), false, 'the resource observation must also refuse a live terminal')
  assert.equal(await d.stop(), false, 'idle stop must preserve a terminal outside a conversation')
  const exited = new Promise<void>((resolve) => terminal.onExit(() => resolve()))
  await terminal.kill()
  await exited
  assert.equal(await d.stop(), true)
})

test('idle usage reads retain the observed rate limits and account activity without restarting', async (t) => {
  const d = await rig(t, 'hold', { FAKE_CODEX_WINDOWS: '1' })
  const limits = await d.runtime.getRateLimits()
  const activity = await d.runtime.getAccountActivity()
  assert.ok(limits?.windows?.length)
  assert.equal(activity?.lifetimeTokens, 4200)
  assert.equal(await d.stop(), true)
  assert.deepEqual(await d.runtime.getRateLimits(), limits)
  assert.deepEqual(await d.runtime.getAccountActivity(), activity)
  assert.equal(d.runtime.health().state, 'idle')
})

test('an active file watch prevents idle shutdown until unsubscribed', async (t) => {
  const d = await rig(t)
  const unwatch = await d.runtime.files.watch(d.dir, () => {})
  assert.equal(d.runtime.canStopForIdle(), false, 'the resource observation must also refuse a live watch')
  assert.equal(await d.stop(), false, 'a live file subscription still needs this process')
  unwatch()
  assert.equal(await d.stop(), true)
})

test('deletion invalidates retained alternate history pages before idle snapshots', async (t) => {
  const d = await rig(t)
  const query = { pageSize: 20 }
  const before = await d.runtime.listSessions(query)
  const id = before.data.find((row) => row.id === 'thread-2')!.id
  await d.runtime.deleteSession(id)
  assert.equal(await d.stop(), true)
  assert.ok(!(await d.runtime.listSessions()).data.some((row) => row.id === id))
  assert.equal(d.runtime.canReadWhileIdle({ method: 'listSessions', query }), false,
    'the stale page must be fetched through the host start barrier')
  await assert.rejects(() => d.runtime.listSessions(query), /not been read/)
})

for (const archived of [true, false]) {
  test(`${archived ? 'archiving' : 'unarchiving'} invalidates both sides of retained history`, async (t) => {
    const d = await rig(t, 'hold', { FAKE_CODEX_MUTABLE_HISTORY: '1' })
    const id = 'thread-2' as never
    if (!archived) await d.runtime.archiveSession(id, true)
    const active = { pageSize: 20 }
    const archive = { pageSize: 20, archived: 'only' as const }
    await d.runtime.listSessions(active)
    await d.runtime.listSessions(archive)
    await d.runtime.archiveSession(id, archived)
    assert.equal(await d.stop(), true)
    for (const query of [active, archive]) {
      assert.equal(d.runtime.canReadWhileIdle({ method: 'listSessions', query }), false)
      await assert.rejects(() => d.runtime.listSessions(query), /not been read/)
    }
    assert.equal((await d.runtime.listSessions()).data.some((row) => row.id === id), !archived)
    assert.equal((await d.runtime.listSessions({ archived: 'only' })).data.some((row) => row.id === id), archived)
  })
}

test('renaming a conversation invalidates retained history titles', async (t) => {
  const d = await rig(t, 'hold', { FAKE_CODEX_MUTABLE_HISTORY: '1' })
  const session = await d.runtime.resumeSession('thread-2' as never, { cwd: d.dir })
  const query = { pageSize: 20 }
  await d.runtime.listSessions(query)
  await session.setTitle('Updated title')
  await until(() => d.events.some((event) => event.type === 'session/title' && event.title === 'Updated title'))
  assert.equal(d.runtime.canReadWhileIdle({ method: 'listSessions', query }), false, 'the title notification invalidates the page immediately')
  await session.close()
  assert.equal(await d.stop(), true)
  assert.equal(d.runtime.canReadWhileIdle({ method: 'listSessions', query }), false)
  assert.equal((await d.runtime.listSessions()).data.find((row) => row.id === session.id)?.title, 'Updated title')
})

test('a history read completed after deletion cannot refill the invalidated cache', async (t) => {
  const d = await rig(t, 'hold', { FAKE_CODEX_HOLD_HISTORY_PAGE: '1' })
  const query = { pageSize: 20 }
  const listing = d.runtime.listSessions(query)
  await d.runtime.deleteSession('thread-2' as never)
  assert.ok((await listing).data.some((row) => row.id === 'thread-2'), 'the controlled read captured the older store')
  assert.equal(d.runtime.canReadWhileIdle({ method: 'listSessions', query }), false)
  assert.equal(await d.stop(), true)
  await assert.rejects(() => d.runtime.listSessions(query), /not been read/)
})

test('stored history survives conversation release and a control idle restart', async (t) => {
  const d = await rig(t)
  const session = await d.runtime.resumeSession('thread-legacy' as never)
  await session.rollback!(1)
  assert.equal((await d.runtime.readSession(session.id)).turns.length, 1)
  await session.close()
  assert.equal(await d.stop(), true)
  await d.runtime.start()
  const reopened = await d.runtime.resumeSession(session.id)
  assert.equal((await d.runtime.readSession(reopened.id)).turns.length, 1, 'the stored edit survives both process replacements')
  await reopened.close()
})

test('a resume arriving during close waits for the retiring conversation owner', async (t) => {
  const hold = join(tmpdir(), `hd-unsubscribe-${process.pid}.hold`)
  t.after(() => rm(hold, { force: true }))
  const d = await rig(t, 'hold', { FAKE_CODEX_HOLD_UNSUBSCRIBE: hold })
  const session = await d.runtime.createSession({ cwd: d.dir })
  await writeFile(hold, '')
  const closing = session.close()
  await until(() => d.events.some((event) => event.type === 'notice' && event.message === 'UNSUBSCRIBING'))
  const opening = d.runtime.resumeSession(session.id, { cwd: d.dir })
  const outcome = opening.then((live) => ({ live }), (error: unknown) => ({ error }))
  // Round trips through the retiring owner while its unsubscribe is held.
  await d.runtime.readSession(session.id)
  await rm(hold)
  await closing
  const result = await outcome
  assert.ok('live' in result, 'error' in result ? String(result.error) : '')
  const reopened = result.live
  assert.equal(d.runtime.session(session.id), reopened)
  await reopened.send([{ type: 'text', text: 'Continue' }])
  await reopened.interrupt()
  await reopened.close()
})

test('a conversation that crashes during catalogue loading is never registered as live', async (t) => {
  const hold = join(tmpdir(), `hd-catalogue-${process.pid}.hold`)
  t.after(() => rm(hold, { force: true }))
  const d = await rig(t, 'hold', { FAKE_CODEX_HOLD_CATALOGUE: hold })
  await writeFile(hold, '')
  const opening = d.runtime.createSession({ cwd: d.dir })
  const outcome = opening.then((live) => ({ live }), (error: unknown) => ({ error }))
  await until(() => d.events.some((event) => event.type === 'notice' && event.message === 'CATALOGUE_HELD'))
  const child = (await d.children())[0]!
  process.kill(child.parent, 'SIGKILL')
  await until(() => d.events.some((event) => event.type === 'session/detached' && event.sessionId === child.threadId))
  await rm(hold)
  const result = await outcome
  assert.ok('error' in result, 'opening a dead owner must fail instead of publishing a live handle')
  assert.match(String(result.error), /stopped|not running/)
  assert.equal(d.runtime.session(child.threadId as never), undefined)
})

test('a failed catalogue load releases its conversation process and helpers', async (t) => {
  const hold = join(tmpdir(), `hd-failed-catalogue-${randomUUID()}.hold`)
  t.after(() => rm(hold, { force: true }))
  const d = await rig(t, 'hold', { FAKE_CODEX_HOLD_CATALOGUE: hold }, 0)
  await writeFile(hold, '')
  const opening = d.runtime.createSession({ cwd: d.dir })
  const outcome = opening.then(() => null, (error: unknown) => error)
  await until(() => d.events.some((event) => event.type === 'notice' && event.message === 'CATALOGUE_HELD'))
  const child = (await d.children())[0]!
  process.kill((await d.servers())[0]!, 'SIGKILL')
  assert.ok(await outcome instanceof Error, 'the control failure rejects the catalogue load')
  await until(() => !running(child.parent) && !running(child.pid), 'failed registration must release its process and helper')
  assert.equal(d.runtime.session(child.threadId as never), undefined)
  assert.equal(d.runtime.health().state, 'unavailable', 'no leaked worker masks the failed control process')
})

for (const mode of ['turn', 'delegated-approval']) {
  for (const ending of ['close', 'crash']) {
    test(`${ending} abandons the pending ${mode === 'turn' ? 'root' : 'delegated'} approval once`, async (t) => {
      const d = await rig(t, mode)
      const session = await d.runtime.createSession({ cwd: d.dir })
      const other = await d.runtime.createSession({ cwd: d.dir })
      await session.send([{ type: 'text', text: 'Inspect' }])
      await other.send([{ type: 'text', text: 'Keep inspecting' }])
      await until(() => d.events.filter((event) => event.type === 'approval/requested').length === 2)
      const approvals = d.events.filter((event) => event.type === 'approval/requested').map((event) => event.approval)
      const target = mode === 'turn' ? String(session.id) : `${session.id}-child`
      const approval = approvals.find((entry) => String(entry.sessionId) === target)!
      assert.ok(approval)
      if (ending === 'close') await session.close()
      else {
        process.kill((await d.children()).find((child) => child.threadId === session.id)!.parent, 'SIGKILL')
        await until(() => d.events.some((event) => event.type === 'session/detached' && event.sessionId === session.id))
      }
      const resolved = d.events.filter((event) => event.type === 'approval/resolved')
      assert.equal(resolved.length, 1, 'the other conversation keeps its pending approval')
      assert.equal(resolved[0]!.approvalId, approval.id)
      assert.equal(resolved[0]!.sessionId, approval.sessionId)
      assert.deepEqual(resolved[0]!.resolution, { outcome: 'abandoned', reason:
        ending === 'close' && mode === 'turn' ? 'The conversation was closed.' : 'The conversation process stopped.' })
      assert.equal(d.runtime.session(other.id), other)
      await other.close()
    })
  }
}

test('idle rest refuses a conversation still loading its catalogue', async (t) => {
  const hold = join(tmpdir(), `hd-opening-catalogue-${randomUUID()}.hold`)
  const calls = `${hold}.log`
  await writeFile(calls, '')
  t.after(async () => { await rm(hold, { force: true }); await rm(calls, { force: true }) })
  const d = await rig(t, 'hold', { FAKE_CODEX_HOLD_CATALOGUE: hold, FAKE_CODEX_PROCESS_CALLS: calls })
  await d.runtime.defaultSessionOptions()
  await writeFile(hold, '')
  const opening = d.runtime.createSession({ cwd: d.dir })
  const outcome = opening.then((live) => ({ live }), (error: unknown) => ({ error }))
  await until(() => d.events.some((event) => event.type === 'notice' && event.message === 'CATALOGUE_HELD'))
  await writeFile(calls, '')
  assert.equal(await d.stop(), false, 'an opening worker prevents idle rest before snapshot reads')
  assert.equal(await readFile(calls, 'utf8'), '', 'no idle snapshots are requested while registration is pending')
  await rm(hold)
  const result = await outcome
  assert.ok('live' in result, 'error' in result ? String(result.error) : '')
  await result.live.close()
})

test('idle rest rechecks opening conversations after its snapshot reads', async (t) => {
  const hold = join(tmpdir(), `hd-snapshot-${randomUUID()}.hold`)
  const catalogue = `${hold}.catalogue`
  t.after(async () => { await rm(hold, { force: true }); await rm(catalogue, { force: true }) })
  const d = await rig(t, 'hold', { FAKE_CODEX_HOLD_ACCOUNT: hold, FAKE_CODEX_HOLD_CATALOGUE: catalogue })
  await d.runtime.defaultSessionOptions()
  await writeFile(hold, '')
  const resting = d.stop()
  await until(() => d.events.some((event) => event.type === 'notice' && event.message === 'ACCOUNT_HELD'))
  await writeFile(catalogue, '')
  const opening = d.runtime.createSession({ cwd: d.dir })
  const outcome = opening.then((live) => ({ live }), (error: unknown) => ({ error }))
  await until(() => d.events.some((event) => event.type === 'notice' && event.message === 'CATALOGUE_HELD'))
  await rm(hold)
  assert.equal(await resting, false, 'an opening worker prevents idle rest after snapshot reads')
  await rm(catalogue)
  const result = await outcome
  assert.ok('live' in result, 'error' in result ? String(result.error) : '')
  await result.live.close()
})

for (const during of [false, true]) {
  test(`tool updates skip a process stopping ${during ? 'during' : 'before'} the control request`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-stopping-tools-'))
    const calls = join(dir, 'calls.ndjson')
    const hold = join(dir, 'reload.hold')
    await writeFile(calls, '')
    const server = new CodexThreadServers({ binaryPath: FAKE,
      clientInfo: { name: 'harnessdesk-test', title: 'HarnessDesk', version: '0.1.0' },
      env: { HARNESSDESK_CODEX_PROCESS_GROUP: randomUUID(), HARNESSDESK_CODEX_GENERATION: '0',
        FAKE_CODEX_PROCESS_CALLS: calls, FAKE_CODEX_HOLD_MCP_RELOAD: hold },
    }, () => {})
    let releaseStop!: () => void
    const stopping = new Promise<void>((resolve) => { releaseStop = resolve })
    t.after(async () => { releaseStop(); await rm(hold, { force: true }); await server.stop(); await rm(dir, { recursive: true, force: true }) })
    let held = false
    server.onNotification((event) => { if (event.method === 'warning' && event.params.message === 'MCP_RELOAD_HELD') held = true })
    await server.start()
    const started = await server.request('thread/start', { cwd: dir })
    const owner = server.thread(started.thread.id).server
    const stopOwner = owner.stop.bind(owner)
    // Hold the public process-stop boundary: roots still exist while its stop is pending.
    owner.stop = async () => { await stopping; await stopOwner() }
    if (during) await writeFile(hold, '')
    const stopped = during ? undefined : server.stop()
    const updating = server.request('config/mcpServer/reload', undefined)
    const result = updating.then(() => null, (error: unknown) => error)
    if (during) await until(() => held)
    const stoppedDuring = during ? server.stop() : undefined
    await rm(hold, { force: true })
    assert.equal(await result, null, 'stopping workers cannot fail a successful control update')
    const asked = (await readFile(calls, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { method: string; generation: string })
    assert.deepEqual(asked.filter((call) => call.method === 'config/mcpServer/reload')
      .map((call) => Number(call.generation)), [0])
    releaseStop()
    await (stopped ?? stoppedDuring)
  })
}

test('tool settings reach the control process and every open conversation', async (t) => {
  const calls = join(tmpdir(), `hd-settings-${randomUUID()}.log`)
  await writeFile(calls, '')
  t.after(() => rm(calls, { force: true }))
  const d = await rig(t, 'hold', { FAKE_CODEX_PROCESS_CALLS: calls })
  const first = await d.runtime.createSession({ cwd: d.dir })
  const second = await d.runtime.createSession({ cwd: d.dir })
  for (const [method, run] of [
    ['config/mcpServer/reload', () => d.runtime.extensions.reloadMcp()],
    ['skills/config/write', () => d.runtime.setSkillEnabled({ name: 'release-notes' }, true)],
    ['plugin/install', () => d.runtime.extensions.install('official', 'helper')],
    ['plugin/uninstall', () => d.runtime.extensions.uninstall('helper')],
  ] as const) {
    await writeFile(calls, '')
    await run()
    const asked = (await readFile(calls, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { method: string; generation: string })
    assert.deepEqual(asked.filter((call) => call.method === method).map((call) => Number(call.generation)).sort(),
      [0, 1, 2], method)
  }
  await first.close()
  await second.close()
})

test('tool updates include conversations opened while the control request is held', async (t) => {
  const hold = join(tmpdir(), `hd-reload-${randomUUID()}.hold`)
  const calls = `${hold}.log`
  await writeFile(calls, '')
  t.after(async () => { await rm(hold, { force: true }); await rm(calls, { force: true }) })
  const d = await rig(t, 'hold', { FAKE_CODEX_PROCESS_CALLS: calls, FAKE_CODEX_HOLD_MCP_RELOAD: hold })
  const first = await d.runtime.createSession({ cwd: d.dir })
  await writeFile(hold, '')
  const reloading = d.runtime.extensions.reloadMcp()
  await until(() => d.events.some((event) => event.type === 'notice' && event.message === 'MCP_RELOAD_HELD'))
  const second = await d.runtime.createSession({ cwd: d.dir })
  await rm(hold)
  await reloading
  const asked = (await readFile(calls, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { method: string; generation: string })
  assert.deepEqual(asked.filter((call) => call.method === 'config/mcpServer/reload')
    .map((call) => Number(call.generation)).sort(), [0, 1, 2])
  await first.close()
  await second.close()
})

for (const [method, update] of [
  ['config/mcpServer/reload', (runtime: CodexRuntime) => runtime.extensions.reloadMcp()],
  ['skills/config/write', (runtime: CodexRuntime) => runtime.setSkillEnabled({ name: 'release-notes' }, true)],
  ['plugin/install', (runtime: CodexRuntime) => runtime.extensions.install('official', 'helper')],
  ['plugin/uninstall', (runtime: CodexRuntime) => runtime.extensions.uninstall('helper')],
] as const) {
  test(`${method} waits for an opening conversation to register before updating it`, async (t) => {
    const hold = join(tmpdir(), `hd-opening-update-${randomUUID()}.hold`)
    const controlHold = `${hold}.reload`
    const calls = `${hold}.log`
    await writeFile(calls, '')
    t.after(async () => { await rm(hold, { force: true }); await rm(controlHold, { force: true }); await rm(calls, { force: true }) })
    const d = await rig(t, 'hold', { FAKE_CODEX_PROCESS_CALLS: calls,
      FAKE_CODEX_HOLD_THREAD_OPEN: hold, FAKE_CODEX_HOLD_MCP_RELOAD: controlHold })
    const first = await d.runtime.createSession({ cwd: d.dir })
    const runUpdate = () => update(d.runtime).then(() => null, (error: unknown) => error)
    if (method === 'config/mcpServer/reload') await writeFile(controlHold, '')
    const heldUpdate = method === 'config/mcpServer/reload' ? runUpdate() : undefined
    if (heldUpdate) await until(() => d.events.some((event) => event.type === 'notice' && event.message === 'MCP_RELOAD_HELD'))
    await writeFile(hold, '')
    const opening = d.runtime.createSession({ cwd: d.dir })
    const opened = opening.then((live) => ({ live }), (error: unknown) => ({ error }))
    await until(() => d.events.some((event) => event.type === 'notice' && event.message === 'THREAD_OPEN_HELD'))
    const updated = heldUpdate ?? runUpdate()
    if (heldUpdate) await rm(controlHold)
    const readCalls = async () => (await readFile(calls, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { method: string; generation: string })
    await until(async () => (await readCalls()).some((call) => call.method === method && call.generation === '1'))
    await rm(hold)
    const second = await opened
    assert.ok('live' in second, 'error' in second ? String(second.error) : '')
    assert.equal(await updated, null)
    const asked = await readCalls()
    assert.deepEqual(asked.filter((call) => call.method === method)
      .map((call) => Number(call.generation)).sort(), [0, 1, 2])
    assert.deepEqual(asked.filter((call) => call.generation === '2').map((call) => call.method)
      .filter((call) => call === 'thread/start' || call === 'thread/opened' || call === method),
    ['thread/start', 'thread/opened', method], 'the update follows root registration')
    await first.close()
    await second.live.close()
  })
}

for (const method of ['thread/resume', 'thread/fork'] as const) {
  test(`tool updates wait for a pending ${method} in a fresh process`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-opening-tools-'))
    const calls = join(dir, 'calls.ndjson')
    const hold = join(dir, 'opening.hold')
    await writeFile(calls, '')
    const server = new CodexThreadServers({ binaryPath: FAKE,
      clientInfo: { name: 'harnessdesk-test', title: 'HarnessDesk', version: '0.1.0' },
      env: { HARNESSDESK_CODEX_PROCESS_GROUP: randomUUID(), HARNESSDESK_CODEX_GENERATION: '0',
        FAKE_CODEX_PROCESS_CALLS: calls, FAKE_CODEX_HOLD_THREAD_OPEN: hold },
    }, () => {})
    t.after(async () => { await rm(hold, { force: true }); await server.stop(); await rm(dir, { recursive: true, force: true }) })
    let held = false
    server.onNotification((event) => { if (event.method === 'warning' && event.params.message === 'THREAD_OPEN_HELD') held = true })
    await server.start()
    const source = await server.request('thread/start', { cwd: dir })
    if (method === 'thread/resume') await server.thread(source.thread.id).release()
    await writeFile(hold, '')
    const opening = server.request(method, { threadId: source.thread.id })
    const opened = opening.then((result) => ({ result }), (error: unknown) => ({ error }))
    await until(() => held)
    const updating = server.request('config/mcpServer/reload', undefined)
    const updated = updating.then(() => null, (error: unknown) => error)
    const readCalls = async () => (await readFile(calls, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { method: string; generation: string })
    await until(async () => (await readCalls()).some((call) => call.method === 'config/mcpServer/reload' && call.generation === '0'))
    await rm(hold)
    const result = await opened
    assert.ok('result' in result, 'error' in result ? String(result.error) : '')
    assert.equal(await updated, null)
    const asked = await readCalls()
    assert.deepEqual(asked.filter((call) => call.generation === '2').map((call) => call.method)
      .filter((call) => call === method || call === 'thread/opened' || call === 'config/mcpServer/reload'),
    [method, 'thread/opened', 'config/mcpServer/reload'])
  })
}

for (const ending of ['abort', 'stop'] as const) {
  test(`a tool update skips an opening ended by ${ending}`, { timeout: 10_000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-ended-opening-'))
    const calls = join(dir, 'calls.ndjson')
    const hold = join(dir, 'opening.hold')
    await writeFile(calls, '')
    await writeFile(hold, '')
    const server = new CodexThreadServers({ binaryPath: FAKE,
      clientInfo: { name: 'harnessdesk-test', title: 'HarnessDesk', version: '0.1.0' },
      env: { HARNESSDESK_CODEX_PROCESS_GROUP: randomUUID(), HARNESSDESK_CODEX_GENERATION: '0',
        FAKE_CODEX_PROCESS_CALLS: calls, FAKE_CODEX_HOLD_THREAD_OPEN: hold },
    }, () => {})
    t.after(async () => { await rm(hold, { force: true }); await server.stop(); await rm(dir, { recursive: true, force: true }) })
    let held = false
    server.onNotification((event) => { if (event.method === 'warning' && event.params.message === 'THREAD_OPEN_HELD') held = true })
    await server.start()
    const controller = new AbortController()
    const opening = server.request('thread/start', { cwd: dir }, { signal: controller.signal })
    const opened = opening.then(() => null, (error: unknown) => error)
    await until(() => held)
    const updating = server.request('config/mcpServer/reload', undefined)
    const updated = updating.then(() => null, (error: unknown) => error)
    // A later control round trip puts cancellation after the update's response.
    await server.request('config/read', { includeLayers: false })
    if (ending === 'abort') controller.abort()
    else await server.stop()
    assert.ok(await opened instanceof Error)
    assert.equal(await updated, null, 'the successful control update settles without a failed recipient')
    const asked = (await readFile(calls, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { method: string; generation: string })
    assert.deepEqual(asked.filter((call) => call.method === 'config/mcpServer/reload')
      .map((call) => Number(call.generation)), [0])
  })
}

test('MCP login starts one authorization flow on the control process', async (t) => {
  const calls = join(tmpdir(), `hd-login-${randomUUID()}.log`)
  await writeFile(calls, '')
  t.after(() => rm(calls, { force: true }))
  const d = await rig(t, 'hold', { FAKE_CODEX_PROCESS_CALLS: calls })
  const first = await d.runtime.createSession({ cwd: d.dir })
  const second = await d.runtime.createSession({ cwd: d.dir })
  assert.equal(await d.runtime.extensions.mcpLogin('github'), 'https://auth.example/mcp/github')
  const asked = (await readFile(calls, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { method: string; generation: string })
  assert.deepEqual(asked.filter((call) => call.method === 'mcpServer/oauth/login')
    .map((call) => Number(call.generation)), [0], 'only the control process opens a login flow')
  await first.close()
  await second.close()
})

test('host environment process markers reach distinct conversation processes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-codex-inherited-env-'))
  const captured = join(dir, 'process-env.ndjson')
  await writeFile(captured, '')
  const keys = ['HARNESSDESK_CODEX_PROCESS_GROUP', 'HARNESSDESK_CODEX_GENERATION'] as const
  const before = keys.map((key) => process.env[key])
  t.after(() => keys.forEach((key, index) => {
    const value = before[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }))
  process.env.HARNESSDESK_CODEX_PROCESS_GROUP = randomUUID()
  process.env.HARNESSDESK_CODEX_GENERATION = '0'
  const runtime = new CodexRuntime({ binaryPath: FAKE, codexHome: dir,
    env: { FAKE_CODEX_PROCESS_ENV: captured } })
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  await runtime.start()
  const first = await runtime.createSession({ cwd: dir })
  const second = await runtime.createSession({ cwd: dir })
  assert.notEqual(first.id, second.id)
  const rows = (await readFile(captured, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { processGroup: string; generation: string })
  assert.deepEqual(rows.map((row) => row.generation), ['0', '1', '2'])
  assert.ok(rows.every((row) => row.processGroup === process.env.HARNESSDESK_CODEX_PROCESS_GROUP))
})

test('native server selection suppresses unused helpers on create, resume and fork while another seat works', async (t) => {
  const previousVersion = process.env['FAKE_CODEX_VERSION']
  process.env['FAKE_CODEX_VERSION'] = '0.160.0'
  t.after(() => { if (previousVersion === undefined) delete process.env['FAKE_CODEX_VERSION']; else process.env['FAKE_CODEX_VERSION'] = previousVersion })
  const d = await rig(t, 'hold', { FAKE_CODEX_VERSION: '0.160.0', FAKE_CODEX_NATIVE_SERVERS: '["docs","simulator.v2"]' })
  const selected = { runtimeServers: ['docs'] }
  const working = await d.runtime.createSession({ cwd: d.dir })
  const reviewer = await d.runtime.createSession({ cwd: d.dir, ...selected })
  const selectedChildren = async (id: string) => (await d.children()).filter(one => one.threadId === id) as (Awaited<ReturnType<typeof d.children>>[number] & { name: string })[]
  assert.deepEqual((await selectedChildren(reviewer.id)).map(one => one.name), ['docs'])
  assert.equal((await selectedChildren(working.id)).length, 2)
  const fork = await d.runtime.forkSession(reviewer.id)
  assert.deepEqual((await selectedChildren(fork.id)).map(one => one.name), ['docs'])
  await reviewer.close()
  const resumed = await d.runtime.resumeSession(reviewer.id, { cwd: d.dir, ...selected })
  assert.deepEqual((await selectedChildren(resumed.id)).filter(one => running(one.pid)).map(one => one.name), ['docs'])
  const none = await d.runtime.createSession({ cwd: d.dir, runtimeServers: [] } as Parameters<typeof d.runtime.createSession>[0])
  assert.equal((await selectedChildren(none.id)).length, 0)
  assert.ok((await selectedChildren(working.id)).every(one => running(one.pid)))
})

test('tool reload does not widen a native server selection on an open worker', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-native-reload-'))
  const calls = join(dir, 'calls.ndjson')
  await writeFile(calls, '')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const previousVersion = process.env['FAKE_CODEX_VERSION']
  process.env['FAKE_CODEX_VERSION'] = '0.160.0'
  t.after(() => { if (previousVersion === undefined) delete process.env['FAKE_CODEX_VERSION']; else process.env['FAKE_CODEX_VERSION'] = previousVersion })
  const d = await rig(t, 'hold', { FAKE_CODEX_NATIVE_SERVERS: '["docs","simulator"]', FAKE_CODEX_PROCESS_CALLS: calls })
  await d.runtime.createSession({ cwd: d.dir, runtimeServers: ['docs'] })
  await d.runtime.extensions.reloadMcp()
  const reloads = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string; generation: string }).filter(one => one.method === 'config/mcpServer/reload')
  assert.deepEqual(reloads.map(one => one.generation), ['0'])
})

test('no-cwd resume and fork reread native configuration in the source thread folder', async (t) => {
  const previousVersion = process.env['FAKE_CODEX_VERSION']
  process.env['FAKE_CODEX_VERSION'] = '0.160.0'
  t.after(() => { if (previousVersion === undefined) delete process.env['FAKE_CODEX_VERSION']; else process.env['FAKE_CODEX_VERSION'] = previousVersion })
  const d = await rig(t, 'hold', { FAKE_CODEX_NATIVE_SERVERS: '["user"]', FAKE_CODEX_PROJECT_NATIVE_SERVERS: '{"/tmp/native-project":["projonly"]}' })
  const childrenOf = async (id: string) => (await d.children()).filter(one => one.threadId === id && running(one.pid)) as (Awaited<ReturnType<typeof d.children>>[number] & { name: string })[]
  for (const name of ['user', 'projonly']) {
    const source = await d.runtime.createSession({ cwd: '/tmp/native-project', runtimeServers: [name] })
    assert.deepEqual((await childrenOf(source.id)).map(one => one.name), [name])
    await source.close()
    await d.stop()
    await d.runtime.start()
    const resumed = await d.runtime.resumeSession(source.id)
    assert.deepEqual((await childrenOf(resumed.id)).map(one => one.name), [name])
    const fork = await d.runtime.forkSession(source.id)
    assert.deepEqual((await childrenOf(fork.id)).map(one => one.name), [name])
    await resumed.close()
    await fork.close()
  }
})

test('native selection accepts runtime server characters and diagnoses bad characters separately', async (t) => {
  const previousVersion = process.env['FAKE_CODEX_VERSION']
  process.env['FAKE_CODEX_VERSION'] = '0.160.0'
  t.after(() => { if (previousVersion === undefined) delete process.env['FAKE_CODEX_VERSION']; else process.env['FAKE_CODEX_VERSION'] = previousVersion })
  const names = ['GitHub', '_local', 'plugin@acme/docs.v2:read-only']
  const d = await rig(t, 'hold', { FAKE_CODEX_NATIVE_SERVERS: JSON.stringify(names) })
  const source = await d.runtime.createSession({ cwd: d.dir, runtimeServers: names })
  assert.deepEqual((await d.children()).filter(one => one.threadId === source.id).map(one => (one as typeof one & { name: string }).name), names)
  await assert.rejects(d.runtime.createSession({ cwd: d.dir, runtimeServers: ['bad$name'] }), /native server names.*letters.*digits/i)
})

test('a detached side review starts only the source Seat native servers', async (t) => {
  const previousVersion = process.env['FAKE_CODEX_VERSION']
  process.env['FAKE_CODEX_VERSION'] = '0.160.0'
  t.after(() => { if (previousVersion === undefined) delete process.env['FAKE_CODEX_VERSION']; else process.env['FAKE_CODEX_VERSION'] = previousVersion })
  const d = await rig(t, 'hold', { FAKE_CODEX_NATIVE_SERVERS: '["docs","simulator"]' })
  const source = await d.runtime.createSession({ cwd: d.dir, runtimeServers: ['docs'] })
  const side = await source.review!({ type: 'uncommitted', delivery: 'detached' })
  assert.ok(side)
  assert.notEqual(side.id, source.id)
  const children = (await d.children()).filter(one => one.threadId === side.id)
  assert.deepEqual(children.map(one => (one as typeof one & { name: string }).name), ['docs'])
})

test('a removed native server refuses reopen with recovery guidance', async (t) => {
  const previousVersion = process.env['FAKE_CODEX_VERSION']
  process.env['FAKE_CODEX_VERSION'] = '0.160.0'
  t.after(() => { if (previousVersion === undefined) delete process.env['FAKE_CODEX_VERSION']; else process.env['FAKE_CODEX_VERSION'] = previousVersion })
  const d = await rig(t, 'hold', { FAKE_CODEX_NATIVE_SERVERS: '["docs","simulator"]' })
  const source = await d.runtime.createSession({ cwd: d.dir, runtimeServers: ['docs'] })
  await source.close()
  // A fresh process has no remembered selection; the host supplies the frozen list.
  const changed = await rig(t, 'hold', { FAKE_CODEX_NATIVE_SERVERS: '["simulator"]' })
  await assert.rejects(changed.runtime.resumeSession(source.id, { cwd: d.dir, runtimeServers: ['docs'] }),
    /No native server named docs is configured here\. Restore the server or start a new Seat\./)
  assert.equal((await changed.children()).length, 0, 'a failed reopen never starts default helpers')
})

test('resource observations track only live control and conversation roots without restarting', async (t) => {
  const d = await rig(t)
  const opened = await d.runtime.createSession({ cwd: d.dir })
  assert.deepEqual(new Set(d.runtime.resourceProcessIds()), new Set(await d.servers()))
  await opened.close()
  assert.equal(d.runtime.resourceProcessIds().length, 1)
  await d.stop()
  assert.deepEqual(d.runtime.resourceProcessIds(), [])
  assert.equal(d.runtime.health().state, 'idle')
})
