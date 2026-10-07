import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent, AgentRuntime } from '@harnessdesk/protocol'
import { CodexRuntime } from '../src/index.js'

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
/** `released` makes Codex close an unsubscribed idle thread at once rather than after its minute. */
const released = { FAKE_CODEX_UNLOAD_MS: '1' } as const
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

test('closing finished threads releases their children before the process rests', async (t) => {
  const d = await rig(t, 'hold', released)
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
  const d = await rig(t, 'hold', released)
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
  const d = await rig(t, 'hold', released)
  const finished = await d.runtime.createSession({ cwd: d.dir })
  await finished.close()
  const active = await d.runtime.createSession({ cwd: d.dir })
  assert.equal(await d.stop(), false, 'an open handle still belongs to the host')
  await active.send([{ type: 'text', text: 'Keep working' }])
  await until(() => d.events.some((event) => event.type === 'turn/started'))
  assert.equal(await d.stop(), false)
  const childrenBefore = await d.children()
  await until(() => childrenBefore.filter((child) => child.threadId === finished.id).every((child) => !running(child.pid)), 'the finished conversation was released')
  assert.ok(childrenBefore.filter((child) => child.threadId === active.id).every((child) => running(child.pid)))
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
  const d = await rig(t, 'hold', released)
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
    assert.equal(rows.length, 1, 'one process serves the runtime and its conversation')
    assert.ok(rows.every((row) => row.processGroup === undefined && row.generation === undefined),
      'the process receives no test-only HarnessDesk environment markers')
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

test('approvals from separate conversations in one process remain independently answerable', async (t) => {
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

test('a standalone terminal keeps an otherwise unused runtime running', async (t) => {
  const d = await rig(t)
  const terminal = await d.runtime.processes.spawn({ cwd: d.dir,
    command: [process.execPath, '-e', 'process.stdin.resume()'], tty: false })
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

test('a resume arriving while the close is in flight waits for it', async (t) => {
  const hold = join(tmpdir(), `hd-unsubscribe-${process.pid}.hold`)
  t.after(() => rm(hold, { force: true }))
  const d = await rig(t, 'hold', { FAKE_CODEX_HOLD_UNSUBSCRIBE: hold })
  const session = await d.runtime.createSession({ cwd: d.dir })
  await writeFile(hold, '')
  const closing = session.close()
  await until(() => d.events.some((event) => event.type === 'notice' && event.message === 'UNSUBSCRIBING'))
  const opening = d.runtime.resumeSession(session.id, { cwd: d.dir })
  const outcome = opening.then((live) => ({ live }), (error: unknown) => ({ error }))
  // Round trips to the process while its unsubscribe is held.
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

test('a process that crashes while a conversation is opening never registers it as live', async (t) => {
  const hold = join(tmpdir(), `hd-catalogue-${process.pid}.hold`)
  t.after(() => rm(hold, { force: true }))
  const d = await rig(t, 'hold', { FAKE_CODEX_HOLD_CATALOGUE: hold })
  await writeFile(hold, '')
  const opening = d.runtime.createSession({ cwd: d.dir })
  const outcome = opening.then((live) => ({ live }), (error: unknown) => ({ error }))
  await until(() => d.events.some((event) => event.type === 'notice' && event.message === 'CATALOGUE_HELD'))
  const child = (await d.children())[0]!
  process.kill(child.parent, 'SIGKILL')
  await until(async () => (await d.servers()).length === 2 && d.runtime.health().state === 'ready', 'the runtime started its process again')
  await rm(hold)
  const result = await outcome
  assert.ok('error' in result, 'opening in a dead process must fail instead of publishing a live handle')
  assert.match(String(result.error), /stopped|not running|shutting down|exited/)
  assert.equal(d.runtime.session(child.threadId as never), undefined)
})
test('a failed catalogue load gives its thread back so its helpers are released', async (t) => {
  const failing = join(tmpdir(), `hd-failed-catalogue-${randomUUID()}.fail`)
  t.after(() => rm(failing, { force: true }))
  const d = await rig(t, 'hold', { FAKE_CODEX_FAIL_CATALOGUE: failing, ...released })
  const kept = await d.runtime.createSession({ cwd: d.dir })
  await writeFile(failing, '')
  // Another folder, so the refused read is not one an earlier open already cached.
  await assert.rejects(() => d.runtime.createSession({ cwd: join(d.dir, 'refused') }), /could not be listed/)
  const [own, started] = await d.children()
  assert.ok(started, 'the refused conversation had started a thread, and tools with it')
  await until(() => !running(started!.pid), 'the thread of a failed registration was released')
  assert.ok(running(own!.pid), 'the conversation that opened is untouched')
  assert.equal(d.runtime.session(started!.threadId as never), undefined)
  assert.equal(d.runtime.session(kept.id), kept)
  assert.equal((await d.servers()).length, 1)
  await kept.close()
})
for (const mode of ['turn', 'delegated-approval']) {
  test(`closing a conversation abandons its pending ${mode === 'turn' ? 'root' : 'delegated'} approval once`, async (t) => {
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
    await session.close()
    const resolved = d.events.filter((event) => event.type === 'approval/resolved')
    assert.equal(resolved.length, 1, 'the other conversation keeps its pending approval')
    assert.equal(resolved[0]!.approvalId, approval.id)
    assert.equal(resolved[0]!.sessionId, approval.sessionId)
    assert.deepEqual(resolved[0]!.resolution, { outcome: 'abandoned', reason: 'The conversation was closed.' })
    assert.equal(d.runtime.session(other.id), other)
    await other.close()
  })
}

test('a crashed process abandons every pending approval, each once', async (t) => {
  const d = await rig(t, 'turn')
  const first = await d.runtime.createSession({ cwd: d.dir })
  const second = await d.runtime.createSession({ cwd: d.dir })
  await first.send([{ type: 'text', text: 'Inspect' }])
  await second.send([{ type: 'text', text: 'Keep inspecting' }])
  await until(() => d.events.filter((event) => event.type === 'approval/requested').length === 2)
  const approvals = d.events.filter((event) => event.type === 'approval/requested').map((event) => event.approval)
  process.kill((await d.servers())[0]!, 'SIGKILL')
  await until(() => d.events.filter((event) => event.type === 'approval/resolved').length === 2)
  const resolved = d.events.filter((event) => event.type === 'approval/resolved')
  assert.deepEqual(resolved.map((event) => event.approvalId).sort(), approvals.map((approval) => approval.id).sort())
  assert.ok(resolved.every((event) => JSON.stringify(event.resolution) === JSON.stringify({ outcome: 'abandoned', reason: 'The Codex runtime restarted.' })))
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(d.events.filter((event) => event.type === 'approval/resolved').length, 2, 'and none twice')
})

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

test('tool settings are sent once, to the one process, whatever conversations are open', async (t) => {
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
    ['mcpServer/oauth/login', () => d.runtime.extensions.mcpLogin('github')],
  ] as const) {
    await writeFile(calls, '')
    await run()
    const asked = (await readFile(calls, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { method: string; generation: string })
    assert.deepEqual(asked.filter((call) => call.method === method).map((call) => Number(call.generation)), [0], method)
  }
  await first.close()
  await second.close()
})
