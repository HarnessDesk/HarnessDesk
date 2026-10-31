import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { LeadSupervisor } from '@harnessdesk/lead/supervisor'
import { createLeadMessages } from '@harnessdesk/lead'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createLeadJournal, type LeadJournalRecord } from '@harnessdesk/lead'
import { LeadBudgets } from '../src/lead/budgets.js'

const key = 'sk-test-not-real-0000'
const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect the plan' }] }], maxTokens: 32 }
const rig = async (t: { after(fn: () => Promise<void>): void }, hooks: { probeRuntime?: (runtime: any) => Promise<any>; onRuntimeUnavailable?: (reason: string) => void; resolveTool?: () => Promise<any>; stopOwned?: () => Promise<void>; messagesTransport?: any; seats?: unknown } = {}) => {
  const home = await mkdtemp('/tmp/hd-ls-')
  t.after(() => rm(home, { recursive: true, force: true }))
  const records: LeadJournalRecord[] = []
  const journal = await createLeadJournal({ async read() { return records }, async append(record) { records.push(record) } })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-service', caps: { usdMicros: 1000, rounds: 4 }, freshnessMs: 1000 })
  const events: string[] = [], timers = new Set<() => void>()
  const budgets = new LeadBudgets({ now: () => 100, runs: () => [], member: async () => true, interruptChecks() {}, stop: async () => {},
    schedule(callback) { timers.add(callback); return () => { timers.delete(callback) } } })
  let configured = true, spawns = 0, closes = 0, stopped = 0, process: any, supervisorOptions: any
  const bootstrap: any[] = []
  const broker = { async leadStatus() { return { configured, protection: 'synthetic cipher' } },
    async resolveLead() { if (!configured) throw new Error('lead-key-unavailable'); return key },
    async storeLead() { events.push('store'); configured = true }, async deleteLead() { events.push('delete'); configured = false } }
  const modulePath = new URL('../src/lead/service.js', import.meta.url).href
  const { LeadService } = await import(modulePath)
  const service = new LeadService({ journal, project: { id: 'synthetic', path: home }, broker, model: 'synthetic-model', prices: {},
    ...(hooks.probeRuntime === undefined ? {} : { probeRuntime: hooks.probeRuntime, runtimes: [{ binary: '/demo/electron', version: '24.19.0', electron: true, label: "this app's runtime" }] }),
    ...(hooks.onRuntimeUnavailable === undefined ? {} : { onRuntimeUnavailable: hooks.onRuntimeUnavailable }),
    messagesTransport: hooks.messagesTransport, ...(hooks.seats === undefined ? {} : { seats: hooks.seats }),
    resolveTool: hooks.resolveTool ?? (async () => { throw new Error('unused') }), freezePlan: async (proposal: unknown) => proposal, readEvidence: async () => { throw new Error('unused') },
    register: () => { events.push('register'); const close = budgets.register(journal); return { admission: {}, close: () => { events.push('unregister'); close() } } },
    childStarted: () => (budgets as any).childStarted(journal), recover: () => budgets.recover(),
    openDoor: async () => ({ descriptor: { home, pid: 123, startedAt: 1, hostVersion: 'test', protocolVersion: 1, socketPath: `${home}/test.sock` },
      close: async () => { closes++; events.push('close-door') } }),
    stopOwned: async () => { stopped++; events.push('stop-owned'); await hooks.stopOwned?.() },
    createSupervisor: (options: any) => {
      supervisorOptions = options
      process = { live: false, async ensure() { if (this.live) return; bootstrap.push(await options.bootstrap()); spawns++; this.live = true; await options.onStarted?.() },
        async send() { assert.equal(this.live, true); return { status: 'completed' } },
        async stop(reason = 'stopped') { if (!this.live) return; events.push('stop-child'); this.live = false; await options.onExit?.(reason) },
        ownershipWithdrawn(runId: string) { events.push(`withdraw:${runId}`) },
        async crash() { this.live = false; await options.onExit?.('lead-child-exited') } }
      return process
    } })
  t.after(() => service.close())
  return { service, home, journal, budgets, timers, records, events, bootstrap, options: () => supervisorOptions, process: () => process, spawns: () => spawns, closes: () => closes, stopped: () => stopped, broker }
}

test('a runtime that fails the probe reports unavailable, with its reason, without starting or registering a child', async t => {
  const logged: string[] = []
  let probes = 0
  const s = await rig(t, { probeRuntime: async () => { probes++; return { supported: false, reason: 'rejected the Lead flags (exit 9)' } }, onRuntimeUnavailable: reason => logged.push(reason) })
  assert.equal((await s.service.status('anthropic')).unavailable, undefined, 'a disabled service does not require the child runtime')
  assert.equal(probes, 0, 'a disabled service does not probe')
  await assert.rejects(s.service.send(input), /lead-disabled/)
  await s.service.setEnabled(true)
  for (let attempt = 0; attempt < 2; attempt++) {
    const status = await s.service.status('anthropic')
    assert.equal(status.unavailable, 'runtime')
    assert.equal(status.unavailableReason, "this app's runtime (Node 24.19.0) rejected the Lead flags (exit 9)")
    await assert.rejects(s.service.send(input), (error: any) => error.wireCode === 'lead-runtime-unsupported')
  }
  assert.deepEqual(logged, ["this app's runtime (Node 24.19.0) rejected the Lead flags (exit 9)"], 'the host is told once, not on every read')
  assert.equal(s.spawns(), 0)
  assert.equal(s.closes(), 0)
  assert.deepEqual(s.events, [])
  await s.service.setEnabled(false)
  assert.equal((await s.service.status('anthropic')).unavailable, undefined)
  await assert.rejects(s.service.send(input), /lead-disabled/)
})

test('two simultaneous sends start one child only after explicit enable', async t => {
  const s = await rig(t)
  await assert.rejects(s.service.send(input), /lead-disabled/)
  await s.service.setEnabled(true)
  assert.equal(s.spawns(), 0)
  await Promise.all([s.service.send(input), s.service.send(input)])
  assert.equal(s.spawns(), 1)
})

test('the seats the host composes with reach the child bootstrap, and a host without seats bootstraps without the field', async t => {
  const seats = { implement: [{ runtime: 'acme-writer', model: 'acme/writer-1' }], review: [{ runtime: 'acme-reviewer' }] }
  const withSeats = await rig(t, { seats })
  await withSeats.service.setEnabled(true); await withSeats.service.send(input)
  assert.deepEqual(withSeats.bootstrap[0].seats, seats)
  const without = await rig(t)
  await without.service.setEnabled(true); await without.service.send(input)
  assert.equal(Object.hasOwn(without.bootstrap[0], 'seats'), false)
})

test('the host lets a model reply be written down only if it carries no secret', async t => {
  const s = await rig(t)
  await s.service.setEnabled(true); await s.service.send(input)
  const admit: (text: string) => Promise<void> = s.options().admitReply
  assert.equal(typeof admit, 'function', 'the service gives the supervisor its last word on a reply')
  await admit('The first worker has started.')
  await assert.rejects(admit(`The provider key is ${key}.`), (error: any) => error.wireCode === 'lead-secret-refused')
})

test('synthetic key reaches only bootstrap; renderer metadata and journal never contain it', async t => {
  const s = await rig(t)
  await s.service.setEnabled(true); await s.service.send(input)
  assert.equal(s.bootstrap[0].key, key)
  assert.deepEqual(await s.service.status('anthropic'), { configured: true, protection: 'synthetic cipher' })
  assert.equal(JSON.stringify([await s.service.status('anthropic'), s.records, s.events]).includes(key), false)
})

for (const operation of ['replace', 'delete']) {
  test(`${operation} key stops old child and closes its door before changing broker state`, async t => {
    const s = await rig(t)
    await s.service.setEnabled(true); await s.service.send(input)
    const old = s.process()
    if (operation === 'replace') await s.service.setKey('anthropic', 'sk-test-not-real-1111')
    else await s.service.deleteKey('anthropic')
    assert.equal(old.live, false)
    assert.ok(s.events.indexOf('stop-child') < s.events.indexOf(operation === 'replace' ? 'store' : 'delete'))
    assert.ok(s.events.indexOf('close-door') < s.events.indexOf(operation === 'replace' ? 'store' : 'delete'))
    if (operation === 'delete') await assert.rejects(s.service.send(input), /lead-key-unavailable/)
    else { await s.service.send(input); assert.equal(s.spawns(), 2) }
  })
}

test('disable and host shutdown latch sends closed before yielding', async t => {
  const s = await rig(t)
  await s.service.setEnabled(true); await s.service.send(input)
  const disabling = s.service.setEnabled(false)
  await assert.rejects(s.service.send(input), /lead-disabled/)
  await disabling
  assert.equal(s.process().live, false)
  await s.service.setEnabled(true); await s.service.send(input)
  const closing = s.service.close()
  await assert.rejects(s.service.send(input), /lead-closed/)
  await closing
  assert.equal(s.process().live, false)
})

test('a goal a crashed host left in flight is shown stopped for the person to resume, and a settled one is left alone', async t => {
  const s = await rig(t)
  await s.service.setEnabled(true)
  // Nothing latched it: the host ended without its shutdown, and no process watches the goal now.
  await s.journal.setManagementPhase('planning')
  await s.service.recoverInterrupted()
  assert.equal(s.journal.state.phase, 'waiting-for-user')
  assert.equal(s.journal.state.managementReason, 'lead-host-shutdown')
  assert.equal(s.spawns(), 0)
  const seq = s.journal.state.seq
  await s.service.recoverInterrupted()
  assert.equal(s.journal.state.seq, seq)
})

test('child exit stops owned work, unregisters budgets and cancels cleanup retries before recovery', async t => {
  const s = await rig(t)
  await s.service.setEnabled(true); await s.service.send(input)
  await assert.rejects(s.service.recover(), /lead-child-live/)
  await s.process().crash()
  assert.equal(s.stopped(), 1)
  assert.ok(s.events.includes('unregister'))
  assert.equal(s.timers.size, 0)
  // No stale owner: a new child can register this same logical goal.
  await s.service.send(input)
  assert.equal(s.spawns(), 2)
  assert.equal(s.journal.state.phase, 'waiting-for-user', 'recovery never silently resumes work')
})

test('ownership withdrawn mid-wait sends a typed withdrawal and stops owned work', async t => {
  const s = await rig(t)
  await s.service.setEnabled(true); await s.service.send(input)
  await s.service.ownershipWithdrawn('run-synthetic')
  assert.ok(s.events.includes('withdraw:run-synthetic'))
  assert.ok(s.stopped() > 0)
  assert.equal(s.journal.state.phase, 'waiting-for-user')
})

for (const operation of ['close', 'disable', 'replace']) {
  test(`${operation} still terminates child and closes door when the journal latch fails`, async t => {
    const s = await rig(t)
    await s.service.setEnabled(true); await s.service.send(input)
    const setPhase = s.journal.setManagementPhase.bind(s.journal)
    s.journal.setManagementPhase = async () => { throw new Error('synthetic write failure') }
    const action = operation === 'close' ? s.service.close() : operation === 'disable' ? s.service.setEnabled(false) : s.service.setKey('anthropic', key)
    await assert.rejects(action, /synthetic write failure/)
    s.journal.setManagementPhase = setPhase
    assert.equal(s.process().live, false)
    assert.equal(s.closes(), 1)
    assert.equal(s.events.includes('store'), false, 'failed latch cannot change key')
  })
}

test('failed owned-work cleanup fences replacement children', async t => {
  const s = await rig(t, { stopOwned: async () => { throw new Error('synthetic stop failure') } })
  await s.service.setEnabled(true); await s.service.send(input)
  await assert.rejects(s.process().crash(), /synthetic stop failure/)
  await assert.rejects(s.service.send(input), /lead-cleanup-pending/)
  assert.equal(s.spawns(), 1)
})

for (const operation of ['close', 'disable', 'replace', 'withdraw']) {
  test(`a pending tool resolution cannot grant authority after ${operation}`, async t => {
    let release!: () => void, entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    const s = await rig(t, { resolveTool: async () => { entered(); await wait; return { project: null, runId: null, start: null, context: {} } } })
    await s.service.setEnabled(true); await s.service.send(input)
    const resolving = s.options().resolveTool({ method: 'flow/executions', params: {} })
    await enteredPromise
    if (operation === 'close') await s.service.close()
    else if (operation === 'disable') await s.service.setEnabled(false)
    else if (operation === 'replace') await s.service.setKey('anthropic', key)
    else await s.service.ownershipWithdrawn('run-synthetic')
    release()
    await assert.rejects(resolving, /lead-(closed|disabled|lifecycle-changed)/)
  })
}

test('a widening repository policy blocks management before any child or door starts', async t => {
  const s = await rig(t)
  await s.journal.setPolicy({ version: 1, revision: 2, mode: 'plan', rules: [] })
  const root = s.home
  await mkdir(`${root}/.harnessdesk`)
  await writeFile(`${root}/.harnessdesk/lead.json`, JSON.stringify({ version: 1, revision: 3, mode: 'manage', rules: [] }))
  await s.service.setEnabled(true)
  await assert.rejects(s.service.send(input), /widening.*blocks management/)
  assert.equal(s.spawns(), 0)
  assert.equal(s.bootstrap.length, 0)
  assert.equal(s.events.includes('register'), false)
})


test('deleteKey removes the stored key after a failed latch killed the child, and preserves the cleanup fence', async t => {
  const s = await rig(t)
  await s.service.setEnabled(true); await s.service.send(input)
  const original = s.journal.setManagementPhase.bind(s.journal)
  s.journal.setManagementPhase = async () => { throw new Error('synthetic latch failure') }
  try {
    await assert.rejects(s.service.deleteKey('anthropic'), /synthetic latch failure/)
    assert.equal(s.process().live, false)
    assert.equal(s.events.includes('delete'), true)
    assert.equal((await s.service.status('anthropic')).configured, false)
    await assert.rejects(s.service.send(input), /lead-cleanup-pending/)
  } finally { s.journal.setManagementPhase = original }
})


test('host provider-send attaches a transient key and returns only bounded, redacted response fields', async t => {
  const requests: any[] = []
  let body = JSON.stringify({ text: 'synthetic response', usage: { input_tokens: 1, output_tokens: 1 } })
  const s = await rig(t, { messagesTransport: { send: async (request: any) => {
    requests.push(request)
    return { status: 200, body, retryAfter: '1', processing: 'unknown', extra: key }
  } } })
  await s.service.setEnabled(true); await s.service.send(input)
  const signal = new AbortController().signal
  const requestId = 'provider-redaction', requestBody = providerBody()
  await providerReserve(s.journal, requestId, requestBody)
  assert.equal(typeof s.options().providerSend, 'function')
  assert.deepEqual(await s.options().providerSend(requestId, requestBody, signal), { status: 200, body, retryAfter: '1', processing: 'unknown' })
  assert.equal(requests[0].requestId, requestId)
  assert.equal(requests[0].body, requestBody)
  assert.equal(requests[0].headers['x-api-key'], key)
  assert.equal(requests[0].origin, 'https://api.anthropic.com')
  assert.equal(requests[0].path, '/v1/messages')
  assert.equal(requests[0].method, 'POST')
  for (const escaped of [false, true]) {
    body = JSON.stringify({ type: 'message', usage: { input_tokens: 1, output_tokens: 1 }, error: key })
    if (escaped) body = body.replace('test', '\\u0074est')
    const redactionId = `provider-redaction-${escaped ? 'escaped' : 'literal'}`
    await providerReserve(s.journal, redactionId, requestBody)
    await assert.rejects(s.options().providerSend(redactionId, requestBody, signal), /lead-provider-failed/)
  }
  body = 'x'.repeat(1_048_577)
  await providerReserve(s.journal, 'provider-oversized', requestBody)
  await assert.rejects(s.options().providerSend('provider-oversized', requestBody, signal), /lead-provider-failed/)
  await s.service.deleteKey('anthropic')
  await assert.rejects(s.options().providerSend(requestId, requestBody, signal))
  assert.equal(requests.length, 4)
})

const providerPrice = { inputUsdMicrosPerMillion: 1, outputUsdMicrosPerMillion: 1, cacheReadUsdMicrosPerMillion: 1, cacheWriteUsdMicrosPerMillion: 1 }
// Capture the real builder's closed tool catalogue without exporting private tool definitions.
const providerTemplate = await (async () => {
  let body = ''
  const messages = createLeadMessages({ apiKey: key, model: 'synthetic-model', prices: { 'synthetic-model': providerPrice },
    journal: { updateBudget: async () => {} } as any, now: () => 100, nextId: () => 'template', countInput: async () => 1, wait: async () => {},
    transport: { send: async request => { body = request.body; throw new Error('synthetic capture only') } },
    resolveTool: async () => { throw new Error('unused') }, dispatch: async () => { throw new Error('unused') } })
  await messages.request({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect the plan' }] }], maxTokens: 32 }, new AbortController().signal)
  assert.ok(body)
  return JSON.parse(body) as object
})()
const providerBody = (patch: object = {}) => JSON.stringify({ ...providerTemplate, ...patch })
const providerReserve = (journal: any, requestId: string, body = providerBody(), maxOutputTokens = 32) => journal.updateBudget({
  version: 1, type: 'reserve', now: 100, requestId, inputTokens: Buffer.byteLength(body) + 1024, maxOutputTokens, ...providerPrice,
})
const providerFrame = (message: unknown) => {
  const body = Buffer.from(JSON.stringify(message)), head = Buffer.alloc(4)
  head.writeUInt32BE(body.length); return Buffer.concat([head, body])
}
const providerUntil = async (predicate: () => boolean) => {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(predicate(), 'provider boundary did not answer')
}
/** Real service, supervisor and journal; only the child pipes, broker and provider are synthetic. */
const providerRig = async (t: any, send: (request: any) => Promise<any>, hooks: { resolveLead?: () => Promise<string>; holdExit?: boolean; journal?: Awaited<ReturnType<typeof createLeadJournal>>; prices?: Record<string, typeof providerPrice> } = {}) => {
  const home = await mkdtemp('/tmp/hd-provider-')
  t.after(() => rm(home, { recursive: true, force: true }))
  const journal = hooks.journal ?? await createLeadJournal({ read: async () => [], append: async () => {} })
  if (!journal.state.budget) {
    await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
    await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'provider-boundary', caps: { usdMicros: 100_000, rounds: 4 }, freshnessMs: 1000 })
  }
  const child: any = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  let killed = false, stopped = 0, rpcId = 0, settings: any, pending = Buffer.alloc(0)
  const replies: any[] = [], waiters = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  const journalRpc = (operation: string, args: unknown[]) => {
    const id = ++rpcId
    const reply = new Promise<any>((resolve, reject) => { waiters.set(id, { resolve, reject }) })
    child.stdout.write(providerFrame({ version: 1, type: 'rpc', id, operation, args }))
    return reply
  }
  const rpc = (requestId: string, body: string) => journalRpc('provider-send', [requestId, body])
  child.kill = () => { killed = true; if (!hooks.holdExit) queueMicrotask(() => child.emit('exit', 0, null)); return true }
  child.stdin.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 4 && pending.length >= pending.readUInt32BE() + 4) {
      const size = pending.readUInt32BE(), message = JSON.parse(pending.subarray(4, size + 4).toString()); pending = pending.subarray(size + 4)
      if (message.type === 'initialize') child.stdout.write(providerFrame({ version: 1, type: 'ready' }))
      if (message.type === 'reply') {
        replies.push(message)
        const waiter = waiters.get(message.id); waiters.delete(message.id)
        if (message.ok) waiter?.resolve(message.value); else waiter?.reject(new Error('synthetic provider refusal'))
      }
      if (message.type === 'shutdown' && !hooks.holdExit) child.kill()
    }
  })
  const { LeadService } = await import('../src/lead/service.js')
  let supervisor!: LeadSupervisor
  const service = new LeadService({ journal, project: { id: 'synthetic', path: home }, model: 'synthetic-model', prices: hooks.prices ?? { 'synthetic-model': providerPrice },
    messagesTransport: { send }, broker: { leadStatus: async () => ({ configured: true, protection: 'synthetic' }),
      resolveLead: hooks.resolveLead ?? (async () => key), storeLead: async () => {}, deleteLead: async () => {} },
    resolveTool: async () => { throw new Error('unused') }, freezePlan: async proposal => proposal, readEvidence: async () => { throw new Error('unused') },
    register: () => ({ admission: {} as any, close() {} }), childStarted: () => () => {}, recover: async () => {},
    openDoor: async () => ({ descriptor: { home, pid: 1, startedAt: 1, hostVersion: 'test', protocolVersion: 1, socketPath: home + '/desk.sock' }, close: async () => {} }) as any,
    stopOwned: async () => { stopped++ }, createSupervisor: options => {
      settings = options
      // Exit still awaits journal recovery writes. Keep the short deadline only
      // for cases deliberately holding exit; normal cleanup gets the real grace.
      return supervisor = new LeadSupervisor({ ...options, spawn: () => child, connectDesk: async () => null, startupMs: 1000,
        ...(hooks.holdExit ? { shutdownMs: 20 } : {}) })
    } })
  t.after(async () => { if (hooks.holdExit) child.emit('exit', 0, null); await service.close() })
  await service.setEnabled(true); await supervisor.ensure()
  return { service, supervisor, journal, child, rpc, journalRpc, replies, settings, killed: () => killed, stopped: () => stopped }
}

for (const name of ['unreserved', 'body', 'max_tokens', 'model', 'stream', 'json', 'uncertain', 'settled'] as const) {
  test(`provider reservation refuses ${name} before key resolution or transport`, async t => {
    let calls = 0, resolutions = 0
    const s = await providerRig(t, async () => { calls++; return { status: 200, body: '{}' } }, { resolveLead: async () => { resolutions++; return key } })
    if (name !== 'unreserved') await providerReserve(s.journal, 'reserved')
    if (name === 'uncertain') await s.journal.updateBudget({ version: 1, type: 'uncertain', now: 100, requestId: 'reserved' })
    if (name === 'settled') await s.journal.updateBudget({ version: 1, type: 'settle', now: 100, requestId: 'reserved', inputTokens: 0, outputTokens: 0 })
    const body = name === 'body' ? providerBody({ system: 'oversized' }) : name === 'max_tokens' ? providerBody({ max_tokens: 33 })
      : name === 'model' ? providerBody({ model: 'another-model' }) : name === 'stream' ? providerBody({ stream: true }) : name === 'json' ? '{' : providerBody()
    const before = resolutions
    void s.rpc('reserved', body).catch(() => {})
    await providerUntil(() => s.replies.length > 0 || s.killed())
    assert.equal(s.supervisor.live, true, 'policy refusal must keep child live')
    assert.equal(s.replies[0]?.ok, false)
    assert.equal(s.replies[0]?.value, null)
    assert.equal(calls, 0); assert.equal(resolutions, before)
    assert.equal(s.stopped(), 0)
  })
}

for (const mode of ['duplicate', 'third'] as const) test(`provider reservation refuses ${mode} concurrent send`, async t => {
  let calls = 0, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const s = await providerRig(t, async () => { calls++; await held; return { status: 429, body: '{}', processing: 'not-started' } })
  t.after(release)
  try {
    for (const id of ['one', 'two', 'three']) await providerReserve(s.journal, id)
    const first = s.rpc('one', providerBody()); void first.catch(() => {})
    await providerUntil(() => calls === 1)
    const second = mode === 'third' ? s.rpc('two', providerBody()) : null; void second?.catch(() => {})
    if (second) await providerUntil(() => calls === 2)
    void s.rpc(mode === 'duplicate' ? 'one' : 'three', providerBody()).catch(() => {})
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, mode === 'third' ? 2 : 1, 'refused send must never reach transport')
    await providerUntil(() => s.replies.length > 0 || s.killed())
    assert.equal(s.supervisor.live, true)
    assert.equal(s.replies[0]?.ok, false)
    assert.equal(calls, mode === 'third' ? 2 : 1)
    release(); await first; await second
    // A sequential retry on the same reservation remains admitted after 429.
    assert.equal((await s.rpc('one', providerBody())).status, 429)
  } finally { release() }
})

for (const failure of [false, true]) test(`real Messages reservation round-trip ${failure ? 'keeps transport failure uncertain and child live' : 'settles successfully'}`, async t => {
  let calls = 0, builtBody = ''
  const s = await providerRig(t, async request => {
    assert.equal(request.body, builtBody, 'host serialization equals the real Messages body')
    calls++; assert.equal(request.headers['x-api-key'], key)
    if (failure) throw new Error('synthetic ETIMEDOUT')
    return { status: 200, body: JSON.stringify({ id: 'synthetic', type: 'message', role: 'assistant', model: 'synthetic-model',
      content: [{ type: 'text', text: 'Ready' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } }) }
  })
  const messages = createLeadMessages({ apiKey: 'host-owned-provider-key', model: 'synthetic-model', prices: { 'synthetic-model': providerPrice }, // hd-secrets-ok: public child marker, never a credential
    journal: { ...s.journal, updateBudget: (event: any) => s.journalRpc('updateBudget', [event]) } as any, now: () => 100, nextId: () => 'real-messages', countInput: async body => Buffer.byteLength(body) + 1024, wait: async () => {},
    transport: { send: request => { builtBody = request.body; return s.rpc((request as any).requestId, request.body) } }, resolveTool: async () => { throw new Error('unused') }, dispatch: async () => { throw new Error('unused') } })
  const result = await Promise.race([messages.request({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect the plan' }] }], maxTokens: 32 }, new AbortController().signal), new Promise<null>(resolve => setTimeout(() => resolve(null), 1100))])
  assert.ok(result, 'Messages must receive a reply')
  assert.equal(result.status, failure ? 'uncertain' : 'completed')
  assert.equal(calls, 1); assert.equal(s.supervisor.live, true); assert.equal(s.stopped(), 0)
  assert.equal(s.replies[0]?.ok, true, 'reservation crossed budget IPC')
  assert.equal(s.replies[1]?.ok, !failure)
  if (failure) { assert.equal(s.replies[1]?.value, null); assert.equal(s.journal.state.budget?.requests[0]?.uncertain, true) }
  else {
    assert.equal(s.journal.state.budget?.settled[0]?.id, 'real-messages')
    assert.equal(s.journal.state.budget?.leadUsdMicros, 4, 'all four provider usage fields are charged')
    assert.equal(s.journal.state.budget?.reservedUsdMicros, 0)
    assert.equal(s.replies[2]?.ok, true, 'settlement crossed budget IPC')
  }
})

test('killing a child aborts its held provider send before exit arrives', async t => {
  let signal: AbortSignal | undefined
  const s = await providerRig(t, async request => { signal = request.signal; return new Promise(() => {}) }, { holdExit: true })
  await providerReserve(s.journal, 'held')
  void s.rpc('held', providerBody()).catch(() => {})
  await providerUntil(() => signal !== undefined || s.killed())
  assert.ok(signal)
  const stopping = s.supervisor.stop('synthetic-stop')
  await providerUntil(s.killed)
  try { assert.equal(signal.aborted, true) }
  finally { s.child.emit('exit', 0, null); await stopping }
})

test('key replacement during resolveLead refuses the old send before transport', async t => {
  let hold = false, entered = false, release!: () => void, calls = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const s = await providerRig(t, async () => { calls++; return { status: 200, body: '{}' } }, { resolveLead: async () => {
    if (hold) { entered = true; await held }; return key
  } })
  await providerReserve(s.journal, 'old')
  hold = true
  const sending = s.settings.providerSend('old', providerBody(), new AbortController().signal)
  await providerUntil(() => entered)
  const replacement = s.service.setKey('anthropic', 'sk-test-not-real-0001')
  release()
  await assert.rejects(sending, /lead-provider-failed/)
  await replacement
  assert.equal(calls, 0)
})

for (const field of ['inputUsdMicrosPerMillion', 'outputUsdMicrosPerMillion', 'cacheReadUsdMicrosPerMillion', 'cacheWriteUsdMicrosPerMillion', 'unconfigured'] as const) {
  test(`host budget refuses untrusted reserve ${field}`, async t => {
    let calls = 0
    const s = await providerRig(t, async () => { calls++; return { status: 200, body: '{}' } }, field === 'unconfigured' ? { prices: {} } : {})
    void s.journalRpc('updateBudget', [{ version: 1, type: 'reserve', now: 100, requestId: 'lying-price',
      inputTokens: 2000, maxOutputTokens: 1000, ...providerPrice, ...(field === 'unconfigured' ? {} : { [field]: 0 }) }])
    await providerUntil(() => s.replies.length > 0 || s.killed())
    assert.equal(s.killed(), true, 'a lying reserve is a protocol failure')
    assert.equal(s.replies.length, 0)
    assert.equal(s.journal.state.budget?.requests.length, 0)
    assert.equal(calls, 0)
  })
}

for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'zero'] as const) {
  test(`host budget refuses first lying settle ${field}`, async t => {
    let calls = 0
    const reported = { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 30, cacheWriteTokens: 40 }
    const s = await providerRig(t, async () => { calls++; return { status: 200, body: JSON.stringify({ usage: {
      input_tokens: reported.inputTokens, output_tokens: reported.outputTokens,
      cache_read_input_tokens: reported.cacheReadTokens, cache_creation_input_tokens: reported.cacheWriteTokens } }) } })
    await s.journalRpc('updateBudget', [{ version: 1, type: 'reserve', now: 100, requestId: 'lying-usage',
      inputTokens: Buffer.byteLength(providerBody()) + 1024, maxOutputTokens: 1000, ...providerPrice }])
    await s.rpc('lying-usage', providerBody())
    const before = s.replies.length
    void s.journalRpc('updateBudget', [{ version: 1, type: 'settle', now: 100, requestId: 'lying-usage',
      ...reported, ...(field === 'zero' ? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } : { [field]: 0 }) }])
    await providerUntil(() => s.replies.length > before || s.killed())
    assert.equal(s.killed(), true, 'the first lying settle must stop the child')
    assert.equal(s.replies.length, before)
    assert.equal(calls, 1)
    assert.equal(s.journal.state.budget?.settled.length, 0)
    assert.ok(s.journal.state.budget!.reservedUsdMicros > 0)
  })
}

const refusedBodies: Record<string, string> = {
  'server tool': providerBody({ tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 50 }] }),
  'image URL': providerBody({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://collector.example.com/image' } }] }] }),
  'document URL': providerBody({ messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://collector.example.com/document' } }] }] }),
  'string stream': providerBody({ stream: 'true' }),
  'duplicate keys': providerBody().replace('{', '{"model":"other","max_tokens":1000000,"stream":true,'),
  'unknown key': providerBody({ unknown: true }),
  'missing max_tokens': providerBody({ max_tokens: undefined }),
  'string max_tokens': providerBody({ max_tokens: '10' }),
  'float max_tokens': providerBody({ max_tokens: 10.5 }),
  'zero max_tokens': providerBody({ max_tokens: 0 }),
}
for (const [name, body] of Object.entries(refusedBodies)) test(`provider schema refuses ${name} before key resolution or transport`, async t => {
  let calls = 0, resolutions = 0
  const s = await providerRig(t, async () => { calls++; return { status: 200, body: '{}' } }, { resolveLead: async () => { resolutions++; return key } })
  await providerReserve(s.journal, 'schema', body)
  const before = resolutions
  await assert.rejects(s.rpc('schema', body), /synthetic provider refusal/)
  assert.equal(s.supervisor.live, true)
  assert.equal(s.replies[0]?.ok, false)
  assert.equal(s.replies[0]?.value, null)
  assert.equal(calls, 0); assert.equal(resolutions, before)
  assert.equal(s.stopped(), 0)
})

for (const mode of ['no sends', 'all not-started'] as const) test(`host budget permits zero settle with ${mode}`, async t => {
  let calls = 0
  const s = await providerRig(t, async () => { calls++; return { status: 429, body: '{}', processing: 'not-started' } })
  await reserveThroughChild(s, 'zero')
  if (mode === 'all not-started') for (let i = 0; i < 3; i++) await s.rpc('zero', providerBody())
  await s.journalRpc('updateBudget', [{ version: 1, type: 'settle', now: 100, requestId: 'zero', inputTokens: 0, outputTokens: 0 }])
  assert.equal(s.journal.state.budget?.leadUsdMicros, 0)
  assert.equal(s.journal.state.budget?.reservedUsdMicros, 0)
  assert.equal(calls, mode === 'no sends' ? 0 : 3)
  assert.equal(s.supervisor.live, true)
})

for (const mode of ['unknown', 'throw', 'malformed usage', 'in-flight', 'unknown then success'] as const) test(`host budget refuses unproven zero settle after ${mode}`, async t => {
  let calls = 0, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const s = await providerRig(t, async () => {
    calls++
    if (mode === 'in-flight') await held
    if (mode === 'throw') throw new Error('synthetic timeout')
    if (mode === 'malformed usage') return { status: 200, body: '{"usage":{"input_tokens":-1,"output_tokens":0}}' }
    if (mode === 'unknown then success' && calls > 1) return { status: 200, body: '{"usage":{"input_tokens":0,"output_tokens":0}}' }
    return { status: 500, body: '{}', processing: 'unknown' }
  })
  try {
    await reserveThroughChild(s, 'unproven')
    const sending = s.rpc('unproven', providerBody()).catch(() => {})
    if (mode === 'in-flight') await providerUntil(() => calls === 1)
    else await sending
    if (mode === 'unknown then success') {
      await assert.rejects(s.rpc('unproven', providerBody()), /synthetic provider refusal/)
      assert.equal(calls, 1, 'a successful retry cannot erase the unknown first bill')
    }
    const before = s.replies.length
    void s.journalRpc('updateBudget', [{ version: 1, type: 'settle', now: 100, requestId: 'unproven', inputTokens: 0, outputTokens: 0 }])
    await providerUntil(() => s.killed() || s.replies.length > before)
    assert.equal(s.killed(), true, 'unproven billing cannot be settled to zero')
    assert.equal(s.journal.state.budget?.settled.length, 0)
  } finally { release() }
})

test('host budget retains an uncertain reservation until full write-off', async t => {
  const s = await providerRig(t, async () => { throw new Error('synthetic timeout') })
  await providerReserve(s.journal, 'write-off')
  const reserved = s.journal.state.budget!.reservedUsdMicros
  await assert.rejects(s.rpc('write-off', providerBody()))
  await s.journalRpc('updateBudget', [{ version: 1, type: 'uncertain', now: 100, requestId: 'write-off' }])
  await s.journalRpc('updateBudget', [{ version: 1, type: 'write-off', now: 100, requestId: 'write-off' }])
  assert.equal(s.journal.state.budget?.leadUsdMicros, reserved)
  assert.equal(s.journal.state.budget?.reservedUsdMicros, 0)
  assert.equal(s.supervisor.live, true)
})

test('host serializes a valid body before checking its reservation and forwarding', async t => {
  const canonical = providerBody(), bodies: string[] = []
  const s = await providerRig(t, async request => { bodies.push(request.body); return { status: 429, body: '{}', processing: 'not-started' } })
  await providerReserve(s.journal, 'normalized', canonical)
  await s.rpc('normalized', JSON.stringify(JSON.parse(canonical), null, 2))
  assert.deepEqual(bodies, [canonical])
})

test('host budget closes provider admission before a zero settlement becomes durable', async t => {
  let calls = 0
  const s = await providerRig(t, async () => { calls++; return { status: 200, body: '{"usage":{"input_tokens":1,"output_tokens":1}}' } })
  await reserveThroughChild(s, 'settling')
  const settling = s.journalRpc('updateBudget', [{ version: 1, type: 'settle', now: 100, requestId: 'settling', inputTokens: 0, outputTokens: 0 }])
  const sending = s.rpc('settling', providerBody())
  await assert.rejects(sending, /synthetic provider refusal/)
  await settling
  assert.equal(calls, 0)
  assert.equal(s.journal.state.budget?.leadUsdMicros, 0)
  assert.equal(s.supervisor.live, true)
})


const reserveThroughChild = (s: Awaited<ReturnType<typeof providerRig>>, requestId: string) => s.journalRpc('updateBudget', [{
  version: 1, type: 'reserve', now: 100, requestId, inputTokens: Buffer.byteLength(providerBody()) + 1024, maxOutputTokens: 32, ...providerPrice,
}])
const settleThroughChild = (s: Awaited<ReturnType<typeof providerRig>>, requestId: string, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0) =>
  s.journalRpc('updateBudget', [{ version: 1, type: 'settle', now: 100, requestId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }])

test('a cap tightened before durable reservation refuses without killing or granting authority', async t => {
  let sends = 0
  const s = await providerRig(t, async () => { sends++; return { status: 200, body: '{}' } })
  const update = s.journal.updateBudget.bind(s.journal)
  let tightened = false
  s.journal.updateBudget = async (event, ...rest) => {
    if (event.type === 'reserve' && event.requestId === 'cap-race' && !tightened) {
      tightened = true
      await update({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 1, rounds: 4 } })
    }
    return update(event, ...rest)
  }
  const result = reserveThroughChild(s, 'cap-race').then(() => 'accepted', () => 'refused')
  await providerUntil(() => s.killed() || s.replies.length > 0)
  assert.equal(s.killed(), false, 'capacity refusal must not poison the child')
  assert.equal(await result, 'refused')
  assert.equal(s.replies[0].state.budget.caps.usdMicros, 1, 'refusal synchronizes the durable host state')
  assert.equal(s.journal.state.budget!.requests.length, 0)
  await assert.rejects(s.settings.providerSend('cap-race', providerBody(), new AbortController().signal))
  assert.equal(sends, 0)
  // A different host-owned reservation with the same id must not turn the
  // rejected child's earlier attempt into settlement authority.
  await update({ version: 1, type: 'reserve', now: 100, requestId: 'cap-race', inputTokens: 0, maxOutputTokens: 0,
    inputUsdMicrosPerMillion: 0, outputUsdMicrosPerMillion: 0, cacheReadUsdMicrosPerMillion: 0, cacheWriteUsdMicrosPerMillion: 0 })
  void settleThroughChild(s, 'cap-race').catch(() => {})
  await providerUntil(s.killed)
  assert.equal(s.journal.state.budget!.settled.length, 0, 'refused reserve cannot authorize settlement')
})

for (const kind of ['duplicate', 'price'] as const) test(`capacity does not excuse a ${kind} reserve`, async t => {
  const s = await providerRig(t, async () => { assert.fail('forged reserve must not send') })
  if (kind === 'duplicate') await reserveThroughChild(s, 'existing')
  await s.journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 1, rounds: 4 } })
  const before = s.replies.length
  void s.journalRpc('updateBudget', [{ version: 1, type: 'reserve', now: 100,
    requestId: kind === 'duplicate' ? 'existing' : 'forged', inputTokens: 2000, maxOutputTokens: 32,
    ...providerPrice, ...(kind === 'price' ? { inputUsdMicrosPerMillion: 0 } : {}) }]).catch(() => {})
  await providerUntil(() => s.killed() || s.replies.length > before)
  assert.equal(s.killed(), true)
  assert.equal(s.replies.length, before)
})
const refusedSettle = async (s: Awaited<ReturnType<typeof providerRig>>, requestId: string, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0) => {
  const before = s.replies.length
  void settleThroughChild(s, requestId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens)
  await providerUntil(() => s.killed() || s.replies.length > before)
  assert.equal(s.killed(), true, 'unproven settlement must stop the child')
  assert.equal(s.journal.state.budget?.settled.length, 0)
}

test('R9 refused inherited reserve cannot authorize a restarted child to zero settle billed usage', async t => {
  const home = await mkdtemp('/tmp/hd-provider-r9-'), path = home + '/journal.json'
  t.after(() => rm(home, { recursive: true, force: true }))
  await writeFile(path, '[]')
  const reopen = () => createLeadJournal({ read: async () => JSON.parse(await readFile(path, 'utf8')),
    append: async record => { const records = JSON.parse(await readFile(path, 'utf8')); records.push(record); await writeFile(path, JSON.stringify(records)) } })
  let billed = 0
  const first = await providerRig(t, async () => {
    billed++
    return { status: 200, body: '{"usage":{"input_tokens":2000,"output_tokens":1000}}' }
  }, { journal: await reopen() })
  await reserveThroughChild(first, 'inherited-r9')
  await first.rpc('inherited-r9', providerBody())
  assert.equal(billed, 1)
  const reserved = first.journal.state.budget!.reservedUsdMicros
  assert.ok(reserved > 0)
  await first.service.close()

  const second = await providerRig(t, async () => { assert.fail('inherited request must not send again') }, { journal: await reopen() })
  assert.equal(second.journal.state.budget?.requests.length, 0)
  const before = second.replies.length
  void reserveThroughChild(second, 'inherited-r9')
  await providerUntil(() => second.stopped() === 1 || second.replies.length > before)
  assert.equal(second.killed(), true, 'duplicate reserve must stop child 1')
  assert.equal(second.replies.length, before)
  assert.equal(second.journal.state.budget?.requests.length, 0)
  assert.equal(second.journal.state.budget?.reservedUsdMicros, 0)
  assert.equal(second.journal.state.budget?.leadUsdMicros, 2)

  await second.supervisor.ensure()
  assert.equal(second.supervisor.live, true)
  // The restarted synthetic child starts a fresh IPC request sequence.
  second.child.stdout.write(providerFrame({ version: 1, type: 'rpc', id: 1, operation: 'updateBudget', args: [
    { version: 1, type: 'settle', now: 100, requestId: 'inherited-r9', inputTokens: 0, outputTokens: 0 },
  ] }))
  await providerUntil(() => second.stopped() === 2 || second.replies.length > before)
  assert.equal(second.stopped(), 2, 'zero settle must stop child 2; refused reserve grants no lifetime evidence')
  assert.equal(second.replies.length, before)
  assert.deepEqual(second.journal.state.budget?.settled, [{ id: 'inherited-r9', digest: '1jk.rs.0.0', usdMicros: 2 }])
  await second.service.close()

  const recovered = await providerRig(t, async () => { assert.fail('write-off must not send') }, { journal: await reopen() })
  await assert.rejects(recovered.service.recover(), /lead-child-live/)
  assert.equal(recovered.journal.state.budget?.leadUsdMicros, 2)
  assert.equal(recovered.journal.state.budget?.reservedUsdMicros, 0)
  assert.deepEqual(recovered.journal.state.budget?.settled, [{ id: 'inherited-r9', digest: '1jk.rs.0.0', usdMicros: 2 }])
})

test('R7 interrupted reservation is written off at exit and refuses zero settle after persisted restart', async t => {
  const home = await mkdtemp('/tmp/hd-provider-restart-'), path = home + '/journal.json'
  t.after(() => rm(home, { recursive: true, force: true }))
  await writeFile(path, '[]')
  const reopen = () => createLeadJournal({ read: async () => JSON.parse(await readFile(path, 'utf8')),
    append: async record => { const records = JSON.parse(await readFile(path, 'utf8')); records.push(record); await writeFile(path, JSON.stringify(records)) } })
  const first = await providerRig(t, async () => { throw new Error('synthetic interrupted provider') }, { journal: await reopen() })
  await reserveThroughChild(first, 'inherited')
  await assert.rejects(first.rpc('inherited', providerBody()))
  const reserved = first.journal.state.budget!.reservedUsdMicros
  await first.service.close()
  const second = await providerRig(t, async () => { assert.fail('inherited settle must not send') }, { journal: await reopen() })
  assert.equal(second.journal.state.budget?.requests.length, 0)
  const before = second.replies.length
  void settleThroughChild(second, 'inherited', 0, 0)
  await providerUntil(() => second.killed() || second.replies.length > before)
  assert.equal(second.killed(), true)
  assert.equal(second.replies.length, before)
  assert.deepEqual(second.journal.state.budget?.settled, [{ id: 'inherited', digest: 'write-off', usdMicros: reserved }])
  await second.service.close()
  const recovered = await providerRig(t, async () => { assert.fail('recovery must not send') }, { journal: await reopen() })
  await assert.rejects(recovered.service.recover(), /lead-child-live/)
  assert.equal(recovered.journal.state.budget?.requests.length, 0)
  await recovered.journalRpc('updateBudget', [{ version: 1, type: 'write-off', now: 100, requestId: 'inherited' }])
  assert.equal(recovered.journal.state.budget?.leadUsdMicros, reserved)
  assert.equal(recovered.journal.state.budget?.reservedUsdMicros, 0)
  assert.equal(recovered.journal.state.budget?.settled[0]?.digest, 'write-off')
  assert.equal(recovered.supervisor.live, true)
})

for (const billed of [false, true]) test(`host refuses uncertain reservation settlement with ${billed ? 'matching provider usage' : 'no send'}`, async t => {
  const s = await providerRig(t, async () => ({ status: 200, body: '{"usage":{"input_tokens":1,"output_tokens":2}}' }))
  await reserveThroughChild(s, 'uncertain-settle')
  if (billed) await s.rpc('uncertain-settle', providerBody())
  await s.journalRpc('updateBudget', [{ version: 1, type: 'uncertain', now: 100, requestId: 'uncertain-settle' }])
  await refusedSettle(s, 'uncertain-settle', billed ? 1 : 0, billed ? 2 : 0)
})

test('R8 zero settle while resolveLead holds a send stops the child', async t => {
  let hold = false, entered = false, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const s = await providerRig(t, async () => ({ status: 200, body: '{"usage":{"input_tokens":1,"output_tokens":2}}' }), {
    resolveLead: async () => { if (hold) { entered = true; await held }; return key },
  })
  await reserveThroughChild(s, 'resolving')
  hold = true
  void s.rpc('resolving', providerBody()).catch(() => {})
  await providerUntil(() => entered)
  try { await refusedSettle(s, 'resolving') }
  finally { release() }
})

test('kill while resolveLead holds a send refuses before calling transport', async t => {
  let hold = false, entered = false, release!: () => void, calls = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const s = await providerRig(t, async () => { calls++; return { status: 200, body: '{"usage":{"input_tokens":1,"output_tokens":2}}' } }, {
    holdExit: true, resolveLead: async () => { if (hold) { entered = true; await held }; return key },
  })
  await reserveThroughChild(s, 'killed-resolving')
  hold = true
  const sending = s.rpc('killed-resolving', providerBody()).then(() => true, () => false)
  await providerUntil(() => entered)
  const stopping = s.supervisor.stop('synthetic-stop')
  await providerUntil(s.killed)
  try {
    release()
    const sent = await sending
    assert.equal(calls, 0, 'an aborted send must not call transport')
    assert.equal(sent, false, 'the aborted provider RPC replies ok:false')
  } finally { release(); s.child.emit('exit', 0, null); await stopping }
})

test('R5b success then not-started preserves billed usage and refuses zero settle', async t => {
  let calls = 0
  const s = await providerRig(t, async () => ++calls === 1
    ? { status: 200, body: '{"usage":{"input_tokens":1,"output_tokens":2}}' }
    : { status: 429, body: '{}', processing: 'not-started' })
  await reserveThroughChild(s, 'billed-retry')
  await s.rpc('billed-retry', providerBody()); await s.rpc('billed-retry', providerBody())
  await refusedSettle(s, 'billed-retry')
  assert.equal(calls, 2)
})

for (const sum of [true, false]) test(`two successful sends ${sum ? 'settle the sum of all usage' : 'refuse the second usage alone'}`, async t => {
  let calls = 0
  const s = await providerRig(t, async () => ({ status: 200, body: JSON.stringify({ usage: ++calls === 1
    ? { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }
    : { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 } }) }))
  await reserveThroughChild(s, 'two-sends')
  await s.rpc('two-sends', providerBody()); await s.rpc('two-sends', providerBody())
  if (sum) {
    const before = s.replies.length
    const settling = settleThroughChild(s, 'two-sends', 6, 8, 10, 12)
    await providerUntil(() => s.killed() || s.replies.length > before)
    assert.equal(s.killed(), false, 'the summed usage must be admitted')
    await settling
    assert.equal(s.journal.state.budget?.leadUsdMicros, 4, 'all four summed usage fields are charged')
    assert.equal(s.journal.state.budget?.reservedUsdMicros, 0)
    assert.equal(s.supervisor.live, true)
  } else await refusedSettle(s, 'two-sends', 5, 6, 7, 8)
  assert.equal(calls, 2)
})

test('public Lead state scans resolve the synthetic key transiently and refuse literal or JSON-escaped echoes', async t => {
  const s = await rig(t)
  for (const value of [key, { summary: key }, { [key]: 'hidden in a field name' }, JSON.stringify(key).replaceAll('s', '\\u0073')]) {
    await assert.rejects(s.service.assertPublic(value), error => {
      assert.equal((error as Error).message, 'lead-secret-refused')
      assert.equal(String(error).includes(key), false)
      return true
    })
  }
  await s.service.assertPublic({ summary: 'Ready for a person', key: { configured: true, protection: 'encrypted' } })
  assert.equal(s.spawns(), 0, 'projection reads never start a child')
  assert.equal(JSON.stringify([s.records, s.events]).includes(key), false)
})


test('public scans resolve once per revision and invalidate after key lifecycle changes', async t => {
  const s = await rig(t)
  let resolutions = 0
  const resolve = s.broker.resolveLead
  s.broker.resolveLead = async () => { resolutions++; return resolve() }
  const { LeadControls } = await import('../src/lead/controls.js')
  const controls = new LeadControls({ journal: s.journal, service: s.service, project: { id: 'demo', path: '/workspace/demo' }, model: 'synthetic-model', now: () => 100,
    nextId: () => 'card', push() {}, decidePerson: async () => {}, decideResult: async () => {} })
  t.after(() => controls.close())
  await Promise.all([controls.readThread(), controls.readSettings()])
  await controls.readThread()
  assert.equal(resolutions, 1)
  await s.journal.settingsChanged(); await controls.readThread()
  assert.equal(resolutions, 2)
  controls.close()
  await s.service.deleteKey('anthropic'); await s.service.assertPublic(key)
  assert.equal(resolutions, 2)
})
test('public scan broker failure is protection-unavailable with no echoed secret', async t => {
  const s = await rig(t)
  s.broker.resolveLead = async () => { throw new Error(key) }
  await assert.rejects(s.service.assertPublic('Ready'), (error: any) =>
    error.wireCode === 'lead-protection-unavailable' && error.message === 'lead-protection-unavailable')
})


test('host card admission refuses the second large plan before journal append and leaves a readable window', async t => {
  const s = await rig(t)
  const { parseLeadAcceptanceContract } = await import('@harnessdesk/protocol')
  const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Review', project: { id: 'demo', path: '/workspace/demo' }, policyRevision: 1, caps: { usdMicros: 1000, rounds: 4 }, assertions: [{ id: 'check', kind: 'check', description: 'Tests pass' }], steps: [{ id: 'work', title: 'Review', flow: 'lead-reviewed-result', sourceRevision: 'recipe-1', variables: {}, attendance: 'attended', assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture', model: 'fixture' }, ceiling: 'edit' }] }] })
  const { LeadControls } = await import('../src/lead/controls.js')
  const big = 'x'.repeat(16000)
  const c = parseLeadAcceptanceContract({ ...contract, steps: Array.from({ length: 6 }, (_, i) => ({ ...contract.steps[0]!, id: `s${i}`, title: 'Large plan',
    variables: Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`v${k}`, big])) })) })
  const one = { version: 1 as const, id: 'one', revision: 1, type: 'plan' as const, contractDigest: c.digest, contract: c }, two = { ...one, id: 'two' }
  assert.equal(typeof s.options().admitCardOffer, 'function')
  const offers = await Promise.allSettled([one, two].map(card => (s.journal.offerCard as any)(card, s.options().admitCardOffer)))
  assert.equal(offers[0]!.status, 'fulfilled')
  assert.equal(offers[1]!.status, 'rejected')
  assert.equal((offers[1] as PromiseRejectedResult).reason.wireCode, 'lead-card-too-large')
  const controls = new LeadControls({ journal: s.journal, service: s.service, project: c.project, model: 'synthetic-model', now: () => 100,
    nextId: () => 'card', push() {}, decidePerson: async () => {}, decideResult: async () => {} })
  t.after(() => controls.close())
  assert.equal((await controls.readThread()).thread.cards.length, 1)
})

test('a failed public scan recovers at the same revision and arbitrary values are always scanned', async t => {
  const s = await rig(t), resolve = s.broker.resolveLead
  let broken = true
  s.broker.resolveLead = async () => { if (broken) throw new Error('locked'); return resolve() }
  const revision = s.journal.state.seq
  await assert.rejects(s.service.assertPublic('Ready', revision), (error: any) => error.wireCode === 'lead-protection-unavailable')
  broken = false
  await assert.rejects(s.service.assertPublic({ text: key }, revision), (error: any) => error.wireCode === 'lead-secret-refused')
  await s.service.assertPublic('Ready', revision)
  await assert.rejects(s.service.assertPublic(key), (error: any) => error.wireCode === 'lead-secret-refused')
  assert.equal(s.journal.state.seq, revision)
})

test('the service preserves the send deadline latch reason after child exit', async t => {
  const s = await rig(t)
  await s.service.setEnabled(true); await s.service.send(input)
  await s.process().stop('lead-send-deadline')
  assert.equal(s.journal.state.phase, 'waiting-for-user')
  assert.equal(s.journal.state.managementReason, 'lead-send-deadline')
})

test('child exit writes off an interrupted bounded request without permanently losing known spend', async t => {
  const s = await rig(t)
  await s.service.setEnabled(true); await s.service.send(input)
  await s.journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'interrupted-bounded', inputTokens: 10, maxOutputTokens: 20,
    inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000, cacheReadUsdMicrosPerMillion: 1_000_000, cacheWriteUsdMicrosPerMillion: 1_000_000 })
  await s.process().crash()
  await s.budgets.idle()
  assert.equal(s.journal.state.budget!.leadUsdMicros, 30)
  assert.equal(s.journal.state.budget!.reservedUsdMicros, 0)
  assert.equal(s.journal.state.budget!.requests.length, 0)
  assert.equal(s.journal.state.budget!.stop, null, 'a complete conservative charge is known spend below the cap')
  assert.equal(s.journal.state.phase, 'waiting-for-user')
  await s.service.recover()
  assert.equal(s.journal.state.budget!.leadUsdMicros, 30, 'retry never double charges')
})

for (const failure of ['transport', 'unknown-response', 'missing-usage'] as const) test(`provider refuses same-id resend after ${failure} leaves usage ambiguous`, async t => {
  let calls = 0, resolutions = 0
  const s = await providerRig(t, async () => {
    calls++
    if (failure === 'transport') throw new Error('synthetic interrupted send')
    return failure === 'unknown-response' ? { status: 503, body: '{}', processing: 'unknown' } : { status: 200, body: '{}' }
  }, { resolveLead: async () => { resolutions++; return key } })
  await providerReserve(s.journal, 'ambiguous-send')
  if (failure === 'unknown-response') await s.rpc('ambiguous-send', providerBody())
  else await assert.rejects(s.rpc('ambiguous-send', providerBody()))
  const before = resolutions
  await assert.rejects(s.rpc('ambiguous-send', providerBody()), /synthetic provider refusal/)
  assert.equal(calls, 1, 'one reservation must never cover a second possibly billed send')
  assert.equal(resolutions, before, 'ambiguous resend refuses before resolving the key')
  assert.equal(s.supervisor.live, true)
})


test('person stop ends the child and its owned work before a new logical goal can register', async t => {
  const s = await rig(t)
  await s.service.setEnabled(true); await s.service.send(input)
  const old = s.process(), budget = s.journal.state.budget!
  await s.journal.stop(() => s.service.stopGoal())
  assert.equal(old.live, false); assert.equal(s.stopped(), 1)
  assert.equal(s.journal.state.stopEffectsPending, null)
  await s.journal.beginGoal('next-logical-goal', 101)
  assert.equal(s.journal.state.completedBudgets[0]!.logicalGoalId, budget.logicalGoalId)
  await s.service.send(input)
  assert.equal(s.spawns(), 2); assert.equal(s.process().live, true)
  assert.ok(s.events.indexOf('stop-child') < s.events.lastIndexOf('register'))
})

test('a desk closing while the Lead already waits for the person keeps the person\'s wait', async t => {
  const s = await rig(t)
  await s.service.setEnabled(true)
  await s.journal.setManagementPhase('waiting-for-user', 'lead-run-not-started')
  await s.service.close()
  assert.equal(s.journal.state.phase, 'waiting-for-user')
  assert.equal(s.journal.state.managementReason, 'lead-run-not-started')
})

test('host screens nested and JSON-encoded tool results before provider transport', async t => {
  const requests: unknown[] = []
  const s = await providerRig(t, async request => { requests.push(request); return { status: 429, body: '{}' } })
  for (const [i, secret] of [key, 'Authorization: Bearer demo-value', 'ghp_' + 'a'.repeat(36), { Authorization: 'Bearer demo-value' }, { toolArgument: true }].entries()) {
    const content = JSON.stringify({ tail: JSON.stringify({ text: secret }).replaceAll('test', '\\u0074est') })
    const body = providerBody({ messages: [
      { role: 'user', content: [{ type: 'text', text: 'Read evidence' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'use', name: 'desk_read', input: i === 4 ? { Authorization: 'Bearer demo-value' } : {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'use', content, is_error: false }] },
    ] })
    const id = `outbound-screen-${i}`
    await providerReserve(s.journal, id, body)
    await assert.rejects(s.settings.providerSend(id, body, new AbortController().signal), /lead-provider-failed/)
  }
  assert.deepEqual(requests, [])
})

test('Flow token fields retain value screening and other token fields remain private', async t => {
  const requests: unknown[] = []
  const s = await providerRig(t, async request => { requests.push(request); return { status: 429, body: '{}' } })
  const token = '11111111-1111-4111-8111-111111111111' // hd-secrets-ok: synthetic offline provider credential
  const cases = [
    { name: 'flow_preview', input: {}, result: { token: key } },
    { name: 'flow_preview', input: {}, result: { token: 'ghp_' + 'a'.repeat(36) } },
    { name: 'flow_preview', input: {}, result: { token, nested: { token: 'demo-private-value' } } },
    { name: 'flow_preview', input: {}, result: { token, Authorization: 'Bearer demo-value' } },
    { name: 'evidence_board', input: {}, result: { token } },
    { name: 'flow_preview', input: { token }, result: {} },
    { name: 'flow_start_goal', input: {}, result: { token } },
    { name: 'flow_start_goal', input: { token: key }, result: {} },
    { name: 'flow_start_goal', input: { token: 'ghp_' + 'b'.repeat(36) }, result: {} },
    { name: 'flow_start_goal', input: { token, vars: { token: 'demo-private-value' } }, result: {} },
  ]
  for (const [i, item] of cases.entries()) {
    const body = providerBody({ messages: [
      { role: 'user', content: [{ type: 'text', text: 'Continue approved work' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'use', name: item.name, input: item.input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'use', content: JSON.stringify(item.result), is_error: false }] },
    ] })
    const id = `flow-value-screen-${i}`
    await providerReserve(s.journal, id, body)
    await assert.rejects(s.settings.providerSend(id, body, new AbortController().signal), /lead-provider-failed/)
  }
  assert.deepEqual(requests, [])
})

test('a Flow token equal to the resolved key never reaches provider transport', async t => {
  const token = '22222222-2222-4222-8222-222222222222', requests: unknown[] = [] // hd-secrets-ok: synthetic offline provider credential
  const s = await providerRig(t, async request => { requests.push(request); return { status: 429, body: '{}' } }, { resolveLead: async () => token })
  for (const name of ['flow_preview', 'flow_start_goal']) {
    const body = providerBody({ messages: [
      { role: 'user', content: [{ type: 'text', text: 'Continue approved work' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'use', name, input: name === 'flow_start_goal' ? { token } : {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'use', content: JSON.stringify(name === 'flow_preview' ? { token } : {}), is_error: false }] },
    ] })
    await providerReserve(s.journal, name, body)
    await assert.rejects(s.settings.providerSend(name, body, new AbortController().signal), /lead-provider-failed/)
  }
  assert.deepEqual(requests, [])
})

test('preview-result duplicate fields refuse before provider transport', async t => {
  const requests: unknown[] = []
  const s = await providerRig(t, async request => { requests.push(request); return { status: 429, body: '{}' } })
  const token = '11111111-1111-4111-8111-111111111111' // hd-secrets-ok: synthetic offline provider credential
  const encodedKey = [...key].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('')
  const cases = [
    ['token', `{"token":${JSON.stringify(key)},"token":"${token}"}`],
    ['escaped token name and value', `{"token":"${encodedKey}","to\\u006ben":"${token}"}`],
    ['nested field', `{"token":"${token}","details":{"text":${JSON.stringify(key)},"text":"Ready"}}`],
    ['nested array field', `{"token":"${token}","items":[{"details":{"text":${JSON.stringify(key)},"text":"Ready"}}]}`],
    ['replaced object', `{"token":"${token}","details":{"text":${JSON.stringify(key)}},"details":{"text":"Ready"}}`],
    ['JSON-encoded nested field', JSON.stringify({ token, details: `{"text":"${encodedKey}","text":"Ready"}` })],
    ['ordinary duplicate', `{"token":"${token}","title":"First","title":"Last"}`],
  ] as const
  for (const [i, [name, content]] of cases.entries()) await t.test(name, async () => {
    const body = providerBody({ messages: [
      { role: 'user', content: [{ type: 'text', text: 'Preview approved work' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'preview', name: 'flow_preview', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'preview', content, is_error: false }] },
    ] })
    const id = `preview-duplicate-${i}`
    await providerReserve(s.journal, id, body)
    await assert.rejects(s.settings.providerSend(id, body, new AbortController().signal), /lead-provider-failed/)
    assert.deepEqual(requests, [])
  })
})

test('preview results may repeat field names in distinct objects and preserve their original content', async t => {
  const requests: any[] = []
  const s = await providerRig(t, async request => { requests.push(request); return { status: 429, body: '{}' } })
  const content = JSON.stringify({ token: '11111111-1111-4111-8111-111111111111', // hd-secrets-ok: synthetic offline provider credential
    items: [{ title: 'First', text: 'A quoted key: "title": {}' }, { title: 'Second', text: 'Ready' }] })
  const body = providerBody({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'Preview approved work' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'preview', name: 'flow_preview', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'preview', content, is_error: false }] },
  ] })
  await providerReserve(s.journal, 'preview-distinct-fields', body)
  await s.settings.providerSend('preview-distinct-fields', body, new AbortController().signal)
  assert.equal(requests.length, 1)
  assert.equal(JSON.parse(requests[0].body).messages.at(-1).content[0].content, content)
})

test('a host-journaled repair resumes without starting or waiting for a management child', async t => {
  const s = await rig(t), state = s.journal.state
  t.mock.getter(s.journal, 'state', () => ({ ...state, phase: 'running' as const, handbacks: [{ stage: 'prepared' }] as any }))
  await s.service.setEnabled(true)
  await s.service.recoverInterrupted()
  assert.equal(s.records.some(record => record.type === 'management'), false)
  assert.equal(s.spawns(), 0)
})

test('live child activity keeps the service cancellable after send returns and clears independently of durable reservations', async t => {
  const s = await rig(t)
  await s.service.setEnabled(true); await s.service.send(input)
  assert.equal(s.service.requestInFlight, false)
  const before = s.journal.state.seq
  s.options().onActivity(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(s.service.requestInFlight, true)
  assert.ok(s.journal.state.seq > before, 'activity publishes a new projection revision')
  const activeRevision = s.journal.state.seq
  s.options().onActivity(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(s.journal.state.seq, activeRevision, 'repeated busy frames do not churn revisions')
  s.options().onActivity(false)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(s.service.requestInFlight, false)
  assert.ok(s.journal.state.seq > activeRevision)
  s.options().onActivity(true)
  await s.service.stopGoal()
  assert.equal(s.service.requestInFlight, false)
})
