import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { mkdtemp, rm } from 'node:fs/promises'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createLeadJournal } from '../src/journal.js'
import { CLIENT_METHODS } from '@harnessdesk/protocol'

const secret = 'sk-test-not-real-0000' // hd-secrets-ok: synthetic test credential
const descriptor = { home: '/demo/desk', pid: 123, startedAt: 1, hostVersion: 'test', protocolVersion: 1, socketPath: '/demo/desk/lead.sock' }
const module = () => import('../src/' + 'supervisor.js')
const frame = (value: unknown) => { const body = Buffer.from(JSON.stringify(value, (_key, item) => item instanceof Map ? { $leadMap: [...item] } : item)), head = Buffer.alloc(4); head.writeUInt32BE(body.length); return Buffer.concat([head, body]) }
const decode = (stream: PassThrough, receive: (value: any) => void) => {
  let buffer = Buffer.alloc(0)
  stream.on('data', data => { buffer = Buffer.concat([buffer, data]); while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE() + 4) {
    const size = buffer.readUInt32BE(); const body = buffer.subarray(4, size + 4); buffer = buffer.subarray(size + 4); receive(JSON.parse(body.toString()))
  } })
}
const fake = (respond?: (message: any, child: any) => void) => {
  const child: any = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 4242; child.exitCode = null
  child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0, null)); return true }
  decode(child.stdin, value => {
    if (respond) respond(value, child)
    else if (value.type === 'initialize') child.stdout.write(frame({ version: 1, type: 'ready' }))
    else if (value.type === 'shutdown') child.kill()
    else if (value.type === 'request') child.stdout.write(frame({ version: 1, type: 'response', id: value.id, result: { status: 'completed' } }))
  })
  return child
}
const fixture = async (extra: any = {}) => {
  const records: any[] = [], journal = await createLeadJournal({ read: async () => [], append: async record => { records.push(record) } })
  let spawns = 0, starts = 0, exits = 0, args: any[] = []
  const child = fake()
  const { LeadSupervisor } = await module()
  const supervisor = new LeadSupervisor({ journal, bootstrap: async () => ({ key: secret, descriptor, project: { id: 'project', path: '/demo/project' }, prices: {} }),
    connectDesk: async () => null,
    resolveTool: async () => { throw new Error('unused') }, freezePlan: async (value: unknown) => value,
    readEvidence: async () => { throw new Error('unused') }, onStarted: () => { starts++ }, onExit: () => { exits++ },
    spawn: (...value: any[]) => { spawns++; args = value; return child }, startupMs: 1000, shutdownMs: 30, ...extra })
  return { supervisor, child, journal, records, counts: () => ({ spawns, starts, exits }), args: () => args }
}
const request = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect desk' }] }], maxTokens: 32 }

test('synthetic key and descriptor use framed stdin only; argv, environment and stderr stay secret-free', async () => {
  const f = await fixture(); const logs: string[] = []
  const stderrWrite = process.stderr.write
  process.stderr.write = ((chunk: unknown) => { logs.push(String(chunk)); return true }) as typeof process.stderr.write
  process.env['LEAD_TEST_SECRET'] = secret; process.env['NODE_OPTIONS'] = '--inspect'
  try {
    await f.supervisor.ensure(); f.child.stderr.write(secret)
    assert.equal(JSON.stringify(f.args()).includes(secret), false)
    assert.equal(JSON.stringify(f.args()).includes(descriptor.socketPath), false)
    assert.equal(JSON.stringify(f.args()).includes('NODE_OPTIONS'), false)
    assert.equal(JSON.stringify(logs).includes(secret), false)
    assert.equal(JSON.stringify(f.supervisor).includes(secret), false)
    assert.equal(f.supervisor.live, true)
  } finally { process.stderr.write = stderrWrite; delete process.env['LEAD_TEST_SECRET']; delete process.env['NODE_OPTIONS']; await f.supervisor.stop() }
})

test('two simultaneous sends share one startup and one child', async () => {
  const f = await fixture()
  try { await Promise.all([f.supervisor.send(request), f.supervisor.send(request)]); assert.deepEqual(f.counts(), { spawns: 1, starts: 1, exits: 0 }) }
  finally { await f.supervisor.stop() }
})

test('stop waits for the old pid to exit and rejects startup during teardown', async () => {
  const f = await fixture(); await f.supervisor.ensure()
  const stopped = f.supervisor.stop('key-replaced')
  await assert.rejects(f.supervisor.ensure(), /stopping/)
  await stopped; assert.equal(f.supervisor.live, false); assert.equal(f.counts().exits, 1)
})

test('malformed or out-of-order framed child messages terminate its pid', async () => {
  const f = await fixture(); await f.supervisor.ensure()
  f.child.stdout.write(frame({ version: 1, type: 'rpc', id: 2, operation: 'recover', args: [] }))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(f.supervisor.live, false); assert.equal(f.counts().exits, 1)
})

test('journal recovery is refused while the supervisor child is live', async () => {
  const f = await fixture(); await f.supervisor.ensure()
  try { await assert.rejects(f.journal.recover(async () => []), /live-child/) }
  finally { await f.supervisor.stop() }
  await f.journal.recover(async () => [])
})

test('runtime permission grants refuse spawning and opening an unrelated file', async () => {
  let diagnostics: any
  const f = await fixture({ spawn: (binary: string, args: string[], options: any) => {
    const child = spawn(binary, [...args.slice(0, -1), fileURLToPath(new URL('./fixtures/permission-probe.js', import.meta.url))], options)
    return child
  } })
  try { diagnostics = await f.supervisor.send(request); assert.deepEqual(diagnostics, { status: 'completed', text: 'spawn:ERR_ACCESS_DENIED;read:ERR_ACCESS_DENIED' }) }
  finally { await f.supervisor.stop() }
})

const dispatchFixture = async () => {
  const { fixture: managementFixture, contract } = await import('./fixtures/loop.js')
  const { leadReviewedResultSource } = await import('../src/recipes/reviewed-result.js')
  const management = await managementFixture(); await management.approve()
  let dispatched!: (message: any) => void
  const dispatch = new Promise<any>(resolve => { dispatched = resolve })
  let rpcReply!: (message: any) => void
  const reply = new Promise<any>(resolve => { rpcReply = resolve })
  const input = { id: 'child-attempt', stepId: 'forged-step', context: { forged: true }, request: {
    method: 'flow/start-goal', params: { root: contract.project.path, source: leadReviewedResultSource, token: 'preview-1', sentence: contract.goal,
      vars: {}, attended: true, seats: { implement: [contract.steps[0]!.assignments[0]!.seat], review: [contract.steps[0]!.assignments[1]!.seat] } },
    project: null, runId: null, start: null } }
  const child = fake((message, child) => {
    if (message.type === 'initialize') child.stdout.write(frame({ version: 1, type: 'ready' }))
    if (message.type === 'request') child.stdout.write(frame({ version: 1, type: 'rpc', id: 1, operation: 'execute', args: [input] }))
    if (message.type === 'dispatch') dispatched(message)
    if (message.type === 'reply') rpcReply(message)
    if (message.type === 'shutdown') child.kill()
  })
  const f = await fixture({ journal: management.journal, resolveTool: management.options.resolveTool, spawn: () => child })
  return { ...f, child, journal: management.journal, records: management.records, dispatch, reply }
}

test('child journal attempt and result reach the host writer while host budget updates complete mid-dispatch', async () => {
  const f = await dispatchFixture()
  const sent = f.supervisor.send(request).catch(() => {})
  const dispatched = await f.dispatch
  assert.equal(f.journal.state.attempts.get('child-attempt')?.phase, 'started')
  assert.equal(f.journal.state.attempts.get('child-attempt')?.stepId, 'work')
  await f.journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 90_000, rounds: 10 } })
  f.child.stdout.write(frame({ version: 1, type: 'dispatch-result', id: dispatched.id, ok: true,
    value: { value: { id: 'run-1' }, identity: { correlationId: 'child-attempt', runId: 'run-1', teamId: 'team-1' } } }))
  const reply = await f.reply
  assert.equal(reply.value.outcome, 'succeeded')
  assert.equal(f.records.some(record => record.type === 'attempt' && record.id === 'child-attempt'), true)
  assert.equal(f.records.some(record => record.type === 'result' && record.id === 'child-attempt' && record.outcome === 'succeeded'), true)
  await f.supervisor.stop(); await sent
})

test('malformed journal command kills a live dispatch and its host attempt becomes uncertain', async () => {
  const f = await dispatchFixture()
  const sent = f.supervisor.send(request).catch(() => {})
  await f.dispatch
  f.child.stdout.write(frame({ version: 1, type: 'rpc', id: 2, operation: 'execute', args: ['invalid'] }))
  await f.supervisor.stop(); await sent
  assert.equal(f.supervisor.live, false)
  assert.equal(f.journal.state.attempts.get('child-attempt')?.outcome, 'uncertain')
})

test('startup and shutdown deadlines terminate only their unresponsive child pid', async () => {
  let killed = 0
  const child = fake(() => {})
  child.kill = () => { killed++; queueMicrotask(() => child.emit('exit', 0, null)); return true }
  const f = await fixture({ spawn: () => child, startupMs: 15 })
  await assert.rejects(f.supervisor.ensure(), /startup/)
  await f.supervisor.stop(); assert.equal(killed > 0, true)
  const idle = fake((message, child) => { if (message.type === 'initialize') child.stdout.write(frame({ version: 1, type: 'ready' })) })
  let shutdownPid = 0
  idle.kill = () => { shutdownPid = idle.pid; queueMicrotask(() => idle.emit('exit', 0, null)); return true }
  const g = await fixture({ spawn: () => idle, shutdownMs: 15 }); await g.supervisor.ensure(); await g.supervisor.stop()
  assert.equal(shutdownPid, 4242)
})

test('withdrawn ownership ends the actual child subscription wait with a typed reason', async () => {
  const childModule = await import('../src/' + 'child.js')
  const { fixture: managementFixture } = await import('./fixtures/loop.js')
  const management = await managementFixture(), input = new PassThrough(), output = new PassThrough()
  const received: any[] = []; decode(output, message => received.push(message))
  const exits: number[] = []
  const runtime = childModule.runLeadChild({ input, output, connectDesk: async () => ({ ...management.options.desk, close: async () => {
    await management.options.desk.events()[Symbol.asyncIterator]().return()
  } }), onExit: (code: number) => exits.push(code) })
  input.write(frame({ version: 1, type: 'initialize', config: { key: secret, descriptor, project: { id: 'project', path: '/demo/project' }, model: 'fixture-model', prices: management.options.messages.prices }, state: management.journal.state }))
  for (let i = 0; i < 30; i++) await Promise.resolve()
  input.write(frame({ version: 1, type: 'ownership-withdrawn', runId: 'run-1' }))
  for (let i = 0; i < 100; i++) await Promise.resolve()
  assert.equal(received.some(message => message.type === 'wait-ended' && message.runId === 'run-1' && message.reason === 'ownership-withdrawn'), true)
  assert.deepEqual(exits, [0]); await runtime.close()
})

test('shutdown abandons a hung host scope read and fences its late journal admission', async () => {
  let release!: (value: unknown) => void, resolved!: () => void
  const started = new Promise<void>(resolve => { resolved = resolve })
  const f = await fixture({ resolveTool: () => { resolved(); return new Promise(resolve => { release = resolve }) } })
  await f.supervisor.ensure()
  f.child.stdout.write(frame({ version: 1, type: 'rpc', id: 1, operation: 'execute', args: [{ id: 'late-attempt', context: {},
    request: { method: 'library/usage', params: {}, project: null, runId: null, start: null } }] }))
  await started
  const stopped = f.supervisor.stop()
  try {
    const result = await Promise.race([stopped.then(() => 'stopped'), new Promise(resolve => setTimeout(() => resolve('timeout'), 50))])
    assert.equal(result, 'stopped')
  } finally {
    release({ project: null, runId: null, start: null, context: {} }); await stopped
  }
  assert.equal(f.journal.state.attempts.has('late-attempt'), false)
})

test('a replacement waits until the departed child exit cleanup finishes', async () => {
  let release!: () => void, cleaning!: () => void, spawned = 0
  const cleanup = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { cleaning = resolve })
  const children: any[] = []
  const f = await fixture({ spawn: () => { spawned++; const child = fake(); children.push(child); return child }, onExit: async () => { cleaning(); await cleanup } })
  await f.supervisor.ensure(); children[0].kill(); await started
  const next = f.supervisor.ensure()
  await new Promise(resolve => setTimeout(resolve, 20))
  try { assert.equal(spawned, 1) } finally { release(); await next; await f.supervisor.stop() }
})

test('a refused journal lifetime latch still observes the killed child exit', async () => {
  const f = await fixture({ startupMs: 15 })
  f.journal.setChildLive = (live: boolean) => { if (live) throw new Error('recovery-active') }
  await assert.rejects(f.supervisor.ensure())
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.supervisor.live, false)
})

test('a malformed successful dispatch result cannot record a succeeded attempt', async () => {
  const f = await dispatchFixture(), sent = f.supervisor.send(request).catch(() => {})
  const dispatched = await f.dispatch
  f.child.stdout.write(frame({ version: 1, type: 'dispatch-result', id: dispatched.id, ok: true,
    value: { value: 'forged', identity: { correlationId: 'child-attempt', runId: 'run-1', teamId: 'team-1' }, unexpected: true } }))
  await new Promise(resolve => setTimeout(resolve, 10)); await f.supervisor.stop(); await sent
  assert.equal(f.journal.state.attempts.get('child-attempt')?.outcome, 'uncertain')
})

test('journal refuses child admission as soon as recovery is queued', async () => {
  const journal = await createLeadJournal({ read: async () => [], append: async () => {} })
  const recovered = journal.recover(async () => [])
  try { assert.throws(() => journal.setChildLive(true), /recovery-active/) }
  finally { journal.setChildLive(false); await recovered }
  journal.setChildLive(true); journal.setChildLive(false)
})

test('malformed journal and a forged success in the same stdout chunk cannot overtake termination', async () => {
  const f = await dispatchFixture(), sent = f.supervisor.send(request).catch(() => {})
  const dispatched = await f.dispatch
  f.child.kill = () => { setTimeout(() => f.child.emit('exit', 0, null), 10); return true }
  f.child.stdout.write(Buffer.concat([
    frame({ version: 1, type: 'rpc', id: 2, operation: 'execute', args: ['invalid'] }),
    frame({ version: 1, type: 'dispatch-result', id: dispatched.id, ok: true,
      value: { value: {}, identity: { correlationId: 'child-attempt', runId: 'run-1', teamId: 'team-1' } } }),
  ]))
  await f.supervisor.stop(); await sent
  assert.equal(f.journal.state.attempts.get('child-attempt')?.outcome, 'uncertain')
})

test('actual child and all transitive modules load using only precise production read grants', async () => {
  const f = await fixture(); await f.supervisor.ensure()
  const [binary, args, options] = f.args()
  const entry = args.at(-1)
  const child = spawn(binary, [...args.slice(0, -1), '--input-type=module', '--eval',
    `await import(${JSON.stringify(new URL('file://' + entry).href)}); process.stdout.write('loaded')`], options)
  let stdout = '', stderr = ''
  child.stdout!.on('data', chunk => { stdout += chunk.toString() }); child.stderr!.on('data', chunk => { stderr += chunk.toString() })
  try {
    const exit = await new Promise(resolve => child.once('exit', code => resolve(code)))
    assert.equal(exit, 0, stderr); assert.equal(stdout, 'loaded')
  } finally { await f.supervisor.stop() }
})

test('stop retains its fence for an exited child until asynchronous cleanup completes', async () => {
  let release!: () => void, cleaning!: () => void
  const cleanup = new Promise<void>(resolve => { release = resolve }), began = new Promise<void>(resolve => { cleaning = resolve })
  const f = await fixture({ onExit: async () => { cleaning(); await cleanup } })
  await f.supervisor.ensure(); f.child.kill(); await began
  let stopped = false; const stop = f.supervisor.stop().then(() => { stopped = true })
  await new Promise(resolve => setTimeout(resolve, 5))
  try { assert.equal(stopped, false) } finally { release(); await stop }
})

test('a hung exit hook hits the shutdown deadline while replacement remains fenced', async () => {
  let release!: () => void
  const cleanup = new Promise<void>(resolve => { release = resolve })
  const f = await fixture({ onExit: () => cleanup, shutdownMs: 10 })
  await f.supervisor.ensure()
  const stop = f.supervisor.stop()
  try {
    const result = await Promise.race([stop.then(() => 'resolved', () => 'rejected'), new Promise(resolve => setTimeout(() => resolve('timeout'), 80))])
    assert.equal(result, 'rejected')
    assert.equal(f.counts().spawns, 1)
  } finally { release(); await stop.catch(() => {}) }
})

test('a timed out bootstrap cannot launch a parallel replacement before its late settlement', async () => {
  let release!: (value: unknown) => void, bootstraps = 0
  const f = await fixture({ startupMs: 10, bootstrap: () => { bootstraps++; return new Promise(resolve => { release = resolve }) } })
  await assert.rejects(f.supervisor.ensure(), /startup-timeout/)
  const second = f.supervisor.ensure().catch(() => {})
  try { assert.equal(bootstraps, 1) }
  finally { release({ key: secret, descriptor, project: { id: 'project', path: '/demo/project' }, prices: {} }); await second; await f.supervisor.stop() }
})

test('the actual child survives a healthy subscription-changed gap', async () => {
  const { runLeadChild } = await import('../src/' + 'child.js')
  const { fixture: managementFixture, project } = await import('./fixtures/loop.js')
  const management = await managementFixture()
  const child: any = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 4242
  const runtime = runLeadChild({ input: child.stdin, output: child.stdout,
    connectDesk: async () => ({ ...management.options.desk, call: async (method: string, params: unknown) => {
      if (method === 'client/subscribe') management.emit({ type: 'gap', reason: 'subscription-changed' })
      return management.options.desk.call(method, params)
    }, close: () => { void management.options.desk.events()[Symbol.asyncIterator]().return() } }), onExit: () => child.emit('exit', 0, null) })
  child.kill = () => { void runtime.close().then(() => child.emit('exit', 0, null)); return true }
  const f = await fixture({ journal: management.journal, resolveTool: management.options.resolveTool,
    bootstrap: async () => ({ key: secret, descriptor, project, model: 'fixture-model', prices: management.options.messages.prices }), spawn: () => child })
  try { await f.supervisor.ensure(); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.supervisor.live, true) }
  finally { await f.supervisor.stop(); await runtime.close() }
})

test('permission model grants network for the desk socket and fixed provider HTTPS transport', async () => {
  const f = await fixture(); await f.supervisor.ensure()
  const [binary, args, options] = f.args()
  const child = spawn(binary, [...args.slice(0, -1), '--eval', "process.stdout.write(String(process.permission.has('net')))"], options)
  let stdout = ''
  child.stdout!.on('data', chunk => { stdout += chunk.toString() })
  try {
    const exit = await new Promise(resolve => child.once('exit', code => resolve(code)))
    assert.equal(exit, 0); assert.equal(stdout, 'false')
  } finally { await f.supervisor.stop() }
})

test('the actual child returns a typed refusal for a paused management request without exiting', async () => {
  const { runLeadChild } = await import('../src/' + 'child.js')
  const { fixture: managementFixture, project } = await import('./fixtures/loop.js')
  const management = await managementFixture()
  await management.journal.setManagementPhase('waiting-for-user', 'lead-request-refused')
  const child: any = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 4242
  const runtime = runLeadChild({ input: child.stdin, output: child.stdout,
    connectDesk: async () => ({ ...management.options.desk, close: () => { void management.options.desk.events()[Symbol.asyncIterator]().return() } }),
    onExit: () => child.emit('exit', 0, null) })
  child.kill = () => { void runtime.close().then(() => child.emit('exit', 0, null)); return true }
  const f = await fixture({ journal: management.journal, resolveTool: management.options.resolveTool,
    bootstrap: async () => ({ key: secret, descriptor, project, model: 'fixture-model', prices: management.options.messages.prices }), spawn: () => child })
  try {
    assert.deepEqual(await f.supervisor.send(request), { status: 'refused', reason: 'lead-management-paused' })
    assert.equal(f.supervisor.live, true)
  } finally { await f.supervisor.stop(); await runtime.close() }
})

test('a child cannot attest that a dispatched start created nothing', async () => {
  const f = await dispatchFixture(), sent = f.supervisor.send(request).catch(() => {})
  const dispatched = await f.dispatch
  f.child.stdout.write(frame({ version: 1, type: 'dispatch-result', id: dispatched.id, ok: true,
    value: { value: {}, identity: null, created: false } }))
  await new Promise(resolve => setTimeout(resolve, 10)); await f.supervisor.stop(); await sent
  assert.equal(f.journal.state.attempts.get('child-attempt')?.outcome, 'uncertain')
})

test('the actual child tool proxy journals its subscription while host budget updates run during dispatch', async () => {
  const { runLeadChild } = await import('../src/' + 'child.js')
  const { fixture: managementFixture, project } = await import('./fixtures/loop.js')
  const management = await managementFixture()
  let announce!: () => void, release!: () => void
  const dispatched = new Promise<void>(resolve => { announce = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const child: any = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 4242
  const runtime = runLeadChild({ input: child.stdin, output: child.stdout,
    connectDesk: async () => ({ ...management.options.desk, call: async (method: string, params: unknown) => {
      if (method === 'client/subscribe') { announce(); await held }
      return management.options.desk.call(method, params)
    }, close: () => { void management.options.desk.events()[Symbol.asyncIterator]().return() } }),
    onExit: () => child.emit('exit', 0, null) })
  child.kill = () => { release(); void runtime.close().then(() => child.emit('exit', 0, null)); return true }
  const f = await fixture({ journal: management.journal, resolveTool: management.options.resolveTool,
    bootstrap: async () => ({ key: secret, descriptor, project, model: 'fixture-model', prices: management.options.messages.prices }), spawn: () => child })
  try {
    await f.supervisor.ensure(); await dispatched
    const attempt = [...management.journal.state.attempts.values()].find(attempt => attempt.method === 'client/subscribe')!
    assert.equal(attempt.phase, 'started')
    await management.journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 90_000, rounds: 10 } })
    release()
    for (let index = 0; index < 200; index++) await Promise.resolve()
    assert.equal(management.journal.state.attempts.get(attempt.id)?.outcome, 'succeeded')
    assert.equal(management.records.some(record => record.type === 'result' && record.id === attempt.id && record.outcome === 'succeeded'), true)
    assert.equal(management.journal.state.budget!.caps.usdMicros, 90_000)
    assert.equal(f.supervisor.live, true)
  } finally { release(); await f.supervisor.stop(); await runtime.close() }
})


test('initial stdin has neither the provider key nor a connectable desk descriptor', async () => {
  const received: any[] = []
  const child = fake((message, child) => {
    received.push(message)
    if (message.type === 'initialize') child.stdout.write(frame({ version: 1, type: 'ready' }))
    if (message.type === 'shutdown') child.kill()
  })
  const f = await fixture({ spawn: () => child })
  try {
    await f.supervisor.ensure()
    assert.equal(JSON.stringify(received).includes(secret), false)
    assert.equal(JSON.stringify(received).includes(descriptor.socketPath), false)
    assert.equal(Object.hasOwn(received[0].config, 'key'), false)
    assert.equal(Object.hasOwn(received[0].config, 'descriptor'), false)
  } finally { await f.supervisor.stop() }
})

test('provider-send round-trips only the bounded body through the host operation', async () => {
  let reply!: (message: any) => void
  const received = new Promise<any>(resolve => { reply = resolve })
  const child = fake((message, child) => {
    if (message.type === 'initialize') child.stdout.write(frame({ version: 1, type: 'ready' }))
    if (message.type === 'request') child.stdout.write(frame({ version: 1, type: 'rpc', id: 1, operation: 'provider-send', args: ['{"model":"fixture"}'] }))
    if (message.type === 'reply') reply(message)
    if (message.type === 'shutdown') child.kill()
  })
  const calls: unknown[] = []
  const f = await fixture({ spawn: () => child, providerSend: async (body: string) => {
    calls.push(body); return { status: 200, body: 'synthetic reply' }
  } })
  const sent = f.supervisor.send(request).catch(() => {})
  try {
    const message = await Promise.race([received, new Promise(resolve => setTimeout(() => resolve(null), 100))])
    assert.ok(message, 'provider operation was rejected instead of answered')
    assert.deepEqual(calls, ['{"model":"fixture"}'])
    assert.deepEqual(message.value, { status: 200, body: 'synthetic reply' })
  } finally { await f.supervisor.stop(); await sent }
})

test('extended permission probe refuses writes, workers, addons and both Unix and TCP connects', async () => {
  const f = await fixture({ spawn: (binary: string, args: string[], options: any) => spawn(binary,
    [...args.slice(0, -1), fileURLToPath(new URL('./fixtures/permission-probe.js', import.meta.url))], options) })
  try {
    const result = await f.supervisor.send({ ...request, system: 'permission-extended' })
    assert.equal(result.status, 'completed')
    assert.deepEqual(JSON.parse((result as any).text), { write: 'ERR_ACCESS_DENIED', worker: 'ERR_ACCESS_DENIED',
      addon: 'ERR_DLOPEN_DISABLED', unix: 'ERR_ACCESS_DENIED', tcp: 'ERR_ACCESS_DENIED' })
  } finally { await f.supervisor.stop() }
})

test('well-formed forged result identity kills the child and leaves the attempt uncertain', async () => {
  const f = await dispatchFixture(), sent = f.supervisor.send(request).catch(() => {})
  try {
    const dispatched = await f.dispatch
    f.child.stdout.write(frame({ version: 1, type: 'dispatch-result', id: dispatched.id, ok: true,
      value: { value: { id: 'run-1' }, identity: { correlationId: 'another-attempt', runId: 'run-1', teamId: 'team-1' } } }))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(f.supervisor.live, false)
    assert.equal(f.child.exitCode, 0)
    assert.equal(f.journal.state.attempts.get('child-attempt')?.outcome, 'uncertain')
  } finally { await f.supervisor.stop(); await sent }
})

test('valid execute with id 2 first kills the child without admitting an attempt', async () => {
  const child = fake((message, child) => {
    if (message.type === 'initialize') child.stdout.write(frame({ version: 1, type: 'ready' }))
    if (message.type === 'request') child.stdout.write(frame({ version: 1, type: 'rpc', id: 2, operation: 'execute',
      args: [{ id: 'skipped-attempt', request: { method: 'client/subscribe', params: { topics: ['runs'], scope: { run: 'run-1' } } }, context: {} }] }))
    if (message.type === 'dispatch') child.stdout.write(frame({ version: 1, type: 'dispatch-result', id: message.id, ok: true, value: { value: {}, identity: null } }))
    if (message.type === 'shutdown') child.kill()
  })
  const f = await fixture({ spawn: () => child, resolveTool: async () => ({ project: null, runId: 'run-1', start: null,
    context: { desk: { version: 1, revision: 1, mode: 'manage', rules: [] }, synchronized: true } }) })
  const sent = f.supervisor.send(request).catch(() => {})
  try {
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(f.supervisor.live, false)
    assert.equal(child.exitCode, 0)
    const attempt = f.journal.state.attempts.get('skipped-attempt')
    assert.equal(attempt === undefined || attempt.outcome === 'uncertain', true)
  } finally { await f.supervisor.stop(); await sent }
})

test('permission-restricted actual child round-trips the desk on fd 3 and Messages through provider-send', async t => {
  const { fixture: managementFixture, project } = await import('./fixtures/loop.js')
  const { message } = await import('./fixtures/fake-messages.js')
  const management = await managementFixture()
  const journal = await createLeadJournal({ read: async () => [], append: async () => {} })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', now: Date.now(), logicalGoalId: 'fd-roundtrip',
    caps: { usdMicros: 100_000, rounds: 10 }, freshnessMs: 60_000 })
  const permission = spawnSync(process.execPath, ['--eval', "const s = require('node:net').createServer(); s.on('error', e => { process.stderr.write(e.code); process.exitCode = 1 }); s.listen('/tmp/hd-lead-listen-' + process.pid + '.sock', () => s.close())"], { encoding: 'utf8' })
  assert.equal(permission.status, 0, `Unix listener unavailable in this environment: ${permission.stderr}`)
  const directory = await mkdtemp('/tmp/hd-lead-fd-'), socketPath = `${directory}/desk.sock`
  t.after(() => rm(directory, { recursive: true, force: true }))
  const server = createServer(), websocket = new WebSocketServer({ server })
  const deskCalls: string[] = [], providerCalls: string[] = []
  websocket.on('connection', peer => peer.on('message', raw => {
    const call = JSON.parse(raw.toString()); deskCalls.push(call.method)
    const result = call.method === 'client/hello' ? { protocolVersion: 1, hostVersion: 'test', desk: 'synthetic', tiers: ['read', 'run'], methods: Object.keys(CLIENT_METHODS) }
      : call.method === 'client/subscribe' ? { baseline: 0 }
      : call.method === 'flow/executions' || call.method === 'goal/list' ? [] : {}
    peer.send(JSON.stringify({ id: call.id, ok: true, result }))
  }))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  t.after(async () => { for (const peer of websocket.clients) peer.terminate(); websocket.close(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const { LeadSupervisor } = await module()
  const supervisor = new LeadSupervisor({ journal, bootstrap: async () => ({ key: secret, descriptor: { ...descriptor, socketPath }, project,
    model: 'fixture-model', prices: management.options.messages.prices }),
    resolveTool: management.options.resolveTool, freezePlan: async (value: unknown) => value, readEvidence: async () => { throw new Error('unused') },
    providerSend: async (body: string) => { providerCalls.push(body); return message() }, startupMs: 2000, shutdownMs: 100 })
  t.after(() => supervisor.stop())
  const result = await supervisor.send(request)
  assert.equal(result.status, 'completed')
  assert.ok(deskCalls.includes('client/hello'))
  assert.ok(deskCalls.includes('client/subscribe'))
  assert.equal(providerCalls.length, 1)
  assert.equal(providerCalls[0]!.includes(secret), false)
  for (const peer of websocket.clients) peer.terminate()
  for (let i = 0; i < 100 && supervisor.live; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(supervisor.live, false, 'loss of inherited fd must end the child')
})

test('actual child sends Messages through the host port with a key-free memory-visible config', async () => {
  const { runLeadChild } = await import('../src/' + 'child.js')
  const { fixture: managementFixture, project } = await import('./fixtures/loop.js')
  const { message } = await import('./fixtures/fake-messages.js')
  const management = await managementFixture()
  const journal = await createLeadJournal({ read: async () => [], append: async () => {} })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', now: Date.now(), logicalGoalId: 'provider-roundtrip',
    caps: { usdMicros: 100_000, rounds: 10 }, freshnessMs: 60_000 })
  const child: any = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 4242
  let config: unknown, calls = 0
  const runtime = runLeadChild({ input: child.stdin, output: child.stdout, connectDesk: async (value: unknown) => {
    config = value
    return { ...management.options.desk, close: () => { void management.options.desk.events()[Symbol.asyncIterator]().return() } }
  }, onExit: () => child.emit('exit', 0, null) })
  child.kill = () => { void runtime.close().then(() => child.emit('exit', 0, null)); return true }
  const f = await fixture({ journal, spawn: () => child, bootstrap: async () => ({ key: secret, descriptor, project,
    model: 'fixture-model', prices: management.options.messages.prices }), resolveTool: management.options.resolveTool,
    providerSend: async (body: string) => { calls++; assert.equal(body.includes(secret), false); return message() } })
  try {
    const result = await f.supervisor.send(request)
    assert.equal(result.status, 'completed')
    assert.equal(calls, 1)
    assert.equal(JSON.stringify(config).includes(secret), false)
    assert.equal(Object.hasOwn(config as object, 'key'), false)
    assert.equal(Object.hasOwn(config as object, 'descriptor'), false)
  } finally { await f.supervisor.stop(); await runtime.close() }
})
