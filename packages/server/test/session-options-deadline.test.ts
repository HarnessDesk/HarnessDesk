import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Session } from '@harnessdesk/protocol'
import { Client, start, stop, until } from './fixtures/harness.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

test('a dispatched setting still in flight returns an unconfirmed outcome at the caller deadline', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hd-options-deadline-'))
  for (const name of ['agents', 'flows', 'library']) await mkdir(join(root, name))
  const runtime = new FakeRuntime()
  const harness = await start({ builtinAgents: join(root, 'agents'), builtinFlows: join(root, 'flows'), libraryHome: join(root, 'library'), catalogRefreshMs: 0 }, root, runtime)
  const client = await Client.connect(harness.server)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), began = new Promise<void>(resolve => { entered = resolve })
  t.after(async () => { release(); client.close(); await stop(harness) })
  const session = await client.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const live = runtime.sessions.get(session.id)!
  const original = live.setOption.bind(live)
  let calls = 0
  let complete!: () => void
  const completed = new Promise<void>(resolve => { complete = resolve })
  live.setOption = async (id, value) => { calls++; entered(); await gate; try { return await original(id, value) } finally { complete() } }
  const response = client.call('session/options/set', { runtime: runtime.info.id, sessionId: session.id, optionId: 'model', value: 'fake-2' })
    .then(() => ({ kind: 'resolved' as const, message: '' }), error => ({ kind: 'error' as const, message: String(error.message) }))
  try {
    await began
    const result = await Promise.race([response, new Promise<{ kind: 'pending'; message: string }>(resolve => setTimeout(() => resolve({ kind: 'pending', message: '' }), 7_000))])
    assert.equal(result.kind, 'error', 'the public caller is bounded while the native operation remains held')
    assert.match(result.message, /may still|unconfirmed/i)
    assert.equal(calls, 1)
    release()
    await completed
    await client.until(() => client.events.some(event => event.type === 'session/options' && event.sessionId === session.id && event.options.some(option => option.id === 'model' && option.currentValue === 'fake-2')), 5_000, 'the late authoritative option event')
    assert.equal(calls, 1)
  } finally {
    release()
    await response
  }
})

test('an acquisition that outlives the caller deadline never dispatches that setting', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hd-options-acquire-'))
  for (const name of ['agents', 'flows', 'library']) await mkdir(join(root, name))
  const runtime = new FakeRuntime()
  const harness = await start({ builtinAgents: join(root, 'agents'), builtinFlows: join(root, 'flows'), libraryHome: join(root, 'library'), catalogRefreshMs: 0 }, root, runtime)
  const client = await Client.connect(harness.server)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), began = new Promise<void>(resolve => { entered = resolve })
  t.after(async () => { release(); client.close(); await stop(harness) })
  const session = await client.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const params = { runtime: runtime.info.id, sessionId: session.id }
  const live = runtime.sessions.get(session.id)!, originalSet = live.setOption.bind(live)
  let calls = 0
  live.setOption = async (id, value) => { calls++; return originalSet(id, value) }
  await client.call('session/close', params)
  runtime.resumeAttemptGate = gate
  const originalBegin = runtime.beginResumeAttempt.bind(runtime)
  let finished!: Promise<unknown>
  runtime.beginResumeAttempt = (...args) => { const attempt = originalBegin(...args); finished = attempt.result; entered(); return attempt }
  const response = client.call('session/options/set', { ...params, optionId: 'model', value: 'fake-2' })
    .then(() => ({ kind: 'resolved' as const, message: '' }), error => ({ kind: 'error' as const, message: String(error.message) }))
  try {
    await began
    const result = await Promise.race([response, new Promise<{ kind: 'pending'; message: string }>(resolve => setTimeout(() => resolve({ kind: 'pending', message: '' }), 7_000))])
    assert.equal(result.kind, 'error', 'the total caller wait includes acquisition')
    assert.match(result.message, /not sent/i)
    assert.equal(calls, 0)
    release()
    await finished
    await until(() => harness.host.registry.get(runtime.info.id, session.id)?.live === live, 5_000, 'the Host to publish the reopened handle')
    assert.equal(calls, 0, 'late acquisition must not dispatch the expired call')
    assert.equal(await client.call('session/options/set', { ...params, optionId: 'model', value: 'fake-2' }), null)
    assert.equal(calls, 1, 'a separate explicit call remains usable')
  } finally {
    release()
    await response
  }
})

test('real Codex peer can report an authoritative option after the caller deadline', { timeout: 25_000 }, async t => {
  const { existsSync } = await import('node:fs')
  const { writeFile, readFile, rm } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { CodexRuntime } = await import('@harnessdesk/adapter-codex')
  const { runtimeId } = await import('@harnessdesk/protocol')
  const { Host, StateStore, serve } = await import('../src/index.js')
  const { silent } = await import('./fixtures/harness.js')
  const root = await mkdtemp(join(tmpdir(), 'hd-options-codex-'))
  const control = join(root, 'control'), home = join(root, 'codex'), cwd = join(root, 'work')
  for (const path of [control, home, cwd, join(root, 'agents'), join(root, 'flows')]) await mkdir(path)
  const codex = runtimeId('codex')
  const runtime = new CodexRuntime({ id: codex, codexHome: home, binaryPath: fileURLToPath(new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url)), env: { CODEX_HOME: home, HOME: root, HD2030_CONTROL: control, FAKE_CODEX_PROCESS_CALLS: join(root, 'calls.jsonl') } })
  const accounts = { canAdd: () => false, slotOf: () => null, add: async () => { throw new Error('unused') }, remove: async () => { throw new Error('unused') } }
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), version: '9.9.9', catalogRefreshMs: 0, accounts, builtinAgents: join(root, 'agents'), builtinFlows: join(root, 'flows') } as never)
  host.register(runtime)
  const other = new FakeRuntime({ id: runtimeId('other'), name: 'Other Agent', accountLabel: 'Jane Doe' })
  host.register(other)
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  const client = await Client.connect(server)
  t.after(async () => { await Promise.all([1, 2].map(round => writeFile(join(control, `release-${round}`), 'cleanup').catch(() => {}))); client.close(); await server.close(); await host.dispose(); await rm(root, { recursive: true, force: true }) })
  const first = await client.call('session/create', { runtime: codex, options: { cwd } }) as Session
  const second = await client.call('session/create', { runtime: codex, options: { cwd } }) as Session
  assert.notEqual(first.id, second.id)
  const otherSession = await client.call('session/create', { runtime: other.info.id, options: { cwd } }) as Session
  const set = (sessionId: Session['id'], value: string) => client.call('session/options/set', { runtime: codex, sessionId, optionId: 'permissions', value })
  assert.equal(await set(first.id, ':danger-full-access'), null)
  assert.equal(await set(second.id, ':read-only'), null)
  assert.equal(await set(second.id, ':workspace'), null)
  await writeFile(join(control, 'target.json'), JSON.stringify({ threadId: second.id, value: ':danger-full-access', round: 1 }))
  const pending = set(second.id, ':danger-full-access').then(() => null, error => error as Error & { code: string })
  await until(() => existsSync(join(control, 'held-1.json')), 5_000, 'fake Codex to receive the setting')
  const before = client.events.length
  assert.equal(await client.call('session/options/set', { runtime: other.info.id, sessionId: otherSession.id, optionId: 'model', value: 'fake-2' }), null)
  const error = await Promise.race([pending, new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 7_000))])
  assert.notEqual(error, 'pending', 'the real Codex caller is bounded while its response is held')
  assert.ok(error && error !== 'pending')
  assert.equal(error.code, 'methodFailed')
  assert.match(error.message, /may still/i)
  assert.equal(client.events.slice(before).filter(event => event.type === 'session/options' && event.sessionId === second.id).length, 0)
  await writeFile(join(control, 'release-1'), 'release')
  await until(() => existsSync(join(control, 'released-1.json')), 5_000, 'fake Codex to release the response')
  await client.until(() => client.events.slice(before).some(event => event.type === 'session/options' && event.sessionId === second.id && event.options.some(option => option.id === 'permissions' && option.currentValue === ':danger-full-access')), 5_000, 'late Codex options event')
  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string; threadId: string })
  assert.equal(calls.filter(call => call.method === 'thread/settings/update' && call.threadId === second.id).length, 3, 'the two controls and held request were sent exactly once')
  await writeFile(join(control, 'target.json'), JSON.stringify({ threadId: second.id, value: ':workspace', round: 2 }))
  const oldOwner = set(second.id, ':workspace').then(() => null, error => error as Error)
  await until(() => existsSync(join(control, 'held-2.json')), 5_000, 'old Codex owner to receive another setting')
  const old = JSON.parse(await readFile(join(control, 'held-2.json'), 'utf8')) as { pid: number }
  process.kill(old.pid, 'SIGKILL')
  const death = await oldOwner
  assert.ok(death)
  assert.match(death.message, /app-server exited/i)
  await until(() => runtime.health().state === 'ready', 10_000, 'replacement Codex owner to start')
  const fresh = await client.call('session/create', { runtime: codex, options: { cwd } }) as Session
  assert.equal(await set(fresh.id, ':read-only'), null)

})


test('timely outcomes retain errors, validate before dispatch, and clear caller timers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hd-options-timely-'))
  for (const name of ['agents', 'flows', 'library']) await mkdir(join(root, name))
  const runtime = new FakeRuntime()
  const harness = await start({ builtinAgents: join(root, 'agents'), builtinFlows: join(root, 'flows'), libraryHome: join(root, 'library'), catalogRefreshMs: 0 }, root, runtime)
  const client = await Client.connect(harness.server)
  t.after(async () => { client.close(); await stop(harness) })
  const session = await client.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const params = { runtime: runtime.info.id, sessionId: session.id }
  const live = runtime.sessions.get(session.id)!, original = live.setOption.bind(live)
  let calls = 0
  live.setOption = async (id, value) => { calls++; if (value === 'fake-2') throw new Error('native refusal'); return original(id, value) }
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout
  const captured: { timer: NodeJS.Timeout; referenced: boolean }[] = []
  const cleared = new Set<unknown>()
  globalThis.setTimeout = ((handler: (...args: never[]) => void, delay?: number, ...args: never[]) => {
    const timer = realSetTimeout(handler, delay, ...args)
    if (delay === 5_000) captured.push({ timer, referenced: timer.hasRef() })
    return timer
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
    cleared.add(timer)
    realClearTimeout(timer)
  }) as typeof clearTimeout
  const checkedTimer = (baseline: number) => {
    assert.equal(captured.length, baseline + 1, 'this call armed exactly one five-second timer')
    const { timer, referenced } = captured[baseline]!
    assert.equal(referenced, true, 'the caller timer keeps the process alive while waiting')
    assert.ok(cleared.has(timer), 'the completed caller cleared its own timer')
  }
  try {
    let baseline = captured.length
    assert.equal(await client.call('session/options/set', { ...params, optionId: 'model', value: 'fake-1' }), null)
    checkedTimer(baseline)
    baseline = captured.length
    await assert.rejects(client.call('session/options/set', { ...params, optionId: 'model', value: 'fake-2' }), /native refusal/)
    checkedTimer(baseline)
    baseline = captured.length
    await assert.rejects(client.call('session/options/set', { ...params, optionId: 'model', value: 'invalid' }))
    checkedTimer(baseline)
    assert.equal(calls, 2, 'validation did not invoke the setter')
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})

test('a late rejection is observed while other sessions and callers remain usable', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hd-options-late-reject-'))
  for (const name of ['agents', 'flows', 'library']) await mkdir(join(root, name))
  const runtime = new FakeRuntime()
  const harness = await start({ builtinAgents: join(root, 'agents'), builtinFlows: join(root, 'flows'), libraryHome: join(root, 'library'), catalogRefreshMs: 0 }, root, runtime)
  const client = await Client.connect(harness.server)
  let release!: () => void, entered!: () => void, completed!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), began = new Promise<void>(resolve => { entered = resolve }), done = new Promise<void>(resolve => { completed = resolve })
  t.after(async () => { release(); client.close(); await stop(harness) })
  const first = await client.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const second = await client.call('session/create', { runtime: runtime.info.id, options: { cwd: root } }) as Session
  const live = runtime.sessions.get(first.id)!, original = live.setOption.bind(live)
  let calls = 0
  live.setOption = async (id, value) => { calls++; if (value === 'fake-2') { entered(); await gate; completed(); throw new Error('late native refusal') }; return original(id, value) }
  const set = (sessionId: Session['id'], value: string) => client.call('session/options/set', { runtime: runtime.info.id, sessionId, optionId: 'model', value })
  const pending = set(first.id, 'fake-2')
  const caught = assert.rejects(pending, /may still take effect/i)
  await began
  assert.equal(await set(first.id, 'fake-1'), null)
  assert.equal(await set(second.id, 'fake-2'), null)
  await caught
  assert.equal(calls, 2, 'only the two explicit calls reached the held session')
  release()
  await done
  // Let the observed rejection propagate through its actual promise chain.
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(calls, 2)
})

test('an overdue acquisition cannot dispatch when the timer callback is delayed', { timeout: 10_000 }, async () => {
  const { sessionMethods } = await import('../src/methods/sessions.js')
  let calls = 0
  const live = { options: () => [{ id: 'model', type: 'select', currentValue: 'old', choices: [{ value: 'new', label: 'New' }] }], setOption: () => { calls++; return Promise.resolve() } }
  const ctx = { sessions: { live: () => {
    // The acquisition finishes in a microtask after blocking the event loop;
    // the overdue timer cannot fire until after that continuation has run.
    const start = performance.now()
    while (performance.now() - start < 5_050) { /* hold the event loop */ }
    return Promise.resolve(live)
  } } }
  await assert.rejects(sessionMethods['session/options/set'](ctx as never, { runtime: 'fake', sessionId: 'fake', optionId: 'model', value: 'new' } as never), /not sent/i)
  assert.equal(calls, 0)
})
