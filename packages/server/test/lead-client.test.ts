import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { EventEmitter } from 'node:events'
import { Server } from 'node:http'
import { WebSocketServer } from 'ws'
import type { ClientTier } from '@harnessdesk/protocol'
import type { ClientDoor } from '../src/client-door.js'
import { createLeadClientAuthority, openLeadClientDoor, type LeadClientAuthorityOptions } from '../src/lead/client-authority.js'
import { Host, StateStore } from '../src/index.js'
import { silent } from './fixtures/harness.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

/** No listener is opened: only the HTTP/WebSocket transport is replaced. The real
 * door owns validation, queueing, host dispatch, subscriptions and auditing. */
class MemorySocket extends EventEmitter {
  readonly OPEN = 1
  readyState = this.OPEN
  readonly frames: any[] = []
  send(raw: string) { this.frames.push(JSON.parse(raw)); this.emit('frame') }
  close() { this.readyState = 3; this.emit('close') }
}
class Peer {
  private next = 0
  readonly socket = new MemorySocket()
  readonly messages = this.socket.frames
  call(method: string, params: unknown): Promise<any> {
    const id = ++this.next
    return new Promise(resolve => {
      const received = () => {
        const response = this.messages.find(frame => frame.id === id)
        if (response) { this.socket.off('frame', received); resolve(response) }
      }
      this.socket.on('frame', received)
      this.socket.emit('message', Buffer.from(JSON.stringify({ id, method, params })))
    })
  }
  hello(extra: object = {}) {
    return this.call('client/hello', { client: { name: 'synthetic', version: '1' }, protocol: 1, ...extra })
  }
}

const memoryListener = (t: TestContext) => {
  let server: Server
  t.mock.method(Server.prototype, 'listen', function (this: Server, path: string, ready: () => void) {
    server = this
    void writeFile(path, '').then(ready)
    return this
  })
  t.mock.method(Server.prototype, 'close', function (this: Server, ready: () => void) { ready(); return this })
  let connecting: Peer
  t.mock.method(WebSocketServer.prototype, 'handleUpgrade', (_request: unknown, _socket: unknown, _head: unknown, ready: (socket: unknown) => void) => ready(connecting.socket))
  return () => {
    connecting = new Peer()
    server.emit('upgrade', { url: '/client' }, {}, Buffer.alloc(0))
    return connecting
  }
}

const source = `version: 2
name: Synthetic
roles:
  decide: { kind: person, outcomes: [done] }
seed: { role: decide, title: Decide }
rules: []
`

const rig = async (t: TestContext, settings: Pick<LeadClientAuthorityOptions, 'maximumTiers' | 'authorizeStart' | 'readOwned'> = {}) => {
  const directory = await mkdtemp('/tmp/hd-lead-client-')
  const home = join(directory, 'home')
  await mkdir(home)
  const host = new Host({ leadEnabled: true, logger: silent, state: new StateStore(join(home, 'state.json')), version: 'test', catalogRefreshMs: 0 })
  host.register(new FakeRuntime())
  await host.start()
  const h = { host }
  const connect = memoryListener(t)
  let door: ClientDoor | null = null
  const peers: Peer[] = []
  t.after(async () => {
    for (const peer of peers) peer.socket.close()
    await door?.close(); await host.dispose()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  await h.host.call('workspace/open', { path: home })
  const launch = async () => {
    const preview = await h.host.call('flow/preview', { root: home, source })
    return h.host.call('flow/start-goal', { root: home, source, sentence: 'Synthetic goal', token: preview.token! })
  }
  const owned = await launch()
  const unrelated = await launch()
  const authority = await createLeadClientAuthority({ host, project: home, owned: [{ goal: owned.goal, run: owned.id }], ...settings })
  door = await openLeadClientDoor({ host, logger: silent, home, directory, hostVersion: 'test', authority })
  assert.ok(door)
  const peer = connect()
  peers.push(peer)
  return { h, home, directory, door, peer, owned, unrelated, authority, connect, host }
}

test('Lead cannot answer a person card after clientsMayAnswer is enabled mid-connection', async t => {
  const { h, peer, owned } = await rig(t)
  await peer.hello()
  await h.host.call('app/state/set', { patch: { clientsMayAnswer: true } })
  const result = await peer.call('team/intent', { room: owned.goal, id: 1, action: 'done', outcome: 'done' })
  assert.equal(result.ok, false, 'Lead answered the person card')
  assert.equal(result.error.code, 'tierNotGranted')
  assert.equal((await h.host.call('goal/read', { goal: owned.goal })).board.intents[0]!.state, 'open')
})

test('Lead cannot reach person actions or run a counted check even with all person tiers enabled', async t => {
  const { h, peer, owned } = await rig(t)
  await peer.hello()
  await h.host.call('app/state/set', { patch: { clientsMayAnswer: true } })
  for (const [method, params] of [
    ['lead/action/perform', { id: 'worker', contractDigest: 'a'.repeat(64), choice: 'yes-once' }],
    ['lead/action/perform', { id: 'check', contractDigest: 'a'.repeat(64), choice: 'run' }],
    ['evidence/check/run', { room: owned.goal, card: 1, name: 'verify' }],
  ] as const) {
    const result = await peer.call(method, params)
    assert.equal(result.ok, false, method)
    assert.equal(result.error.code, 'notOnClientSurface', method)
  }
})

test('spoofed hello identity, pid, tiers and project never widen Lead authority or audit attribution', async t => {
  const { h, home, peer } = await rig(t)
  await h.host.call('app/state/set', { patch: { clientsMayAnswer: true } })
  const forged = await peer.hello({ tiers: ['read', 'run', 'answer'], project: '/tmp/unrelated' })
  assert.equal(forged.error.code, 'badRequest')
  const hello = await peer.hello({ client: { name: 'window', version: 'spoofed' }, pid: process.pid })
  assert.equal(hello.ok, true)
  assert.deepEqual(hello.result.tiers, ['read', 'run'])
  await h.host.call('audit/query', {})
  const audit = (await readFile(join(home, 'audit.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(audit.some(entry => entry.kind === 'client/connected' && entry.client === 'lead' && entry.statedPid === null))
})

test('a Lead run grant cannot stop an unrelated execution', async t => {
  const { h, peer, unrelated } = await rig(t)
  await peer.hello()
  const result = await peer.call('flow/execution/stop', { run: unrelated.id, reason: 'Synthetic stop' })
  assert.equal(result.ok, false, 'Lead stopped an unrelated execution')
  assert.equal(result.error.code, 'leadScope')
  assert.notEqual((await h.host.call('flow/execution', { run: unrelated.id })).state, 'stopped')
})

test('lowering desk grants mid-connection narrows the next Lead hello and request', async t => {
  const { h, peer, owned } = await rig(t)
  let grants: readonly ClientTier[] = ['read', 'run']
  h.host.clientTiers = () => grants
  assert.deepEqual((await peer.hello()).result.tiers, ['read', 'run'])
  grants = ['read', 'answer']
  const result = await peer.call('flow/execution/stop', { run: owned.id, reason: 'Synthetic stop' })
  assert.equal(result.error.code, 'tierNotGranted')
  assert.deepEqual((await peer.hello()).result.tiers, ['read'])
})

test('Lead starts fail closed while the host-approved start hook is unset', async t => {
  const { h, home, peer } = await rig(t)
  await peer.hello()
  const preview = await h.host.call('flow/preview', { root: home, source })
  const result = await peer.call('flow/start-goal', { root: home, source, sentence: 'Unapproved', token: preview.token! })
  assert.equal(result.ok, false, 'A run grant started unapproved work')
  assert.equal(result.error.code, 'leadStartNotApproved')
})

test('Lead rejects project claims outside the canonical approved project', async t => {
  const { peer, directory } = await rig(t)
  const other = join(directory, 'other')
  await mkdir(other)
  await peer.hello()
  const result = await peer.call('workspace/open', { path: other })
  assert.equal(result.ok, false, 'Lead opened another project')
  assert.equal(result.error.code, 'leadScope')
})

test('Lead reads and subscriptions require approved project or owned identities', async t => {
  const { peer, home, owned, unrelated } = await rig(t)
  await peer.hello()
  assert.equal((await peer.call('goal/list', {})).error?.code, 'leadScope')
  assert.equal((await peer.call('goal/list', { root: home })).ok, true)
  assert.equal((await peer.call('goal/read', { goal: unrelated.goal })).error?.code, 'leadScope')
  assert.equal((await peer.call('flow/execution', { run: unrelated.id })).error?.code, 'leadScope')
  assert.equal((await peer.call('flow/execution', { run: owned.id })).ok, true)
  assert.equal((await peer.call('client/subscribe', { topics: ['teams'] })).error?.code, 'leadScope')
  assert.equal((await peer.call('client/subscribe', { topics: ['teams'], scope: { project: home } })).ok, true)
  assert.equal((await peer.call('client/subscribe', { topics: ['runs'], scope: { run: unrelated.id } })).error?.code, 'leadScope')
})

test('Lead cancellation stays bound to owned execution cards and permits an owned stop', async t => {
  const { h, peer, owned, unrelated } = await rig(t)
  await peer.hello()
  const denied = await peer.call('team/intent', { room: unrelated.goal, id: 1, action: 'abandon', reason: 'Synthetic' })
  assert.equal(denied.error?.code, 'leadScope')
  assert.equal((await h.host.call('goal/read', { goal: unrelated.goal })).board.intents[0]!.state, 'open')
  assert.equal((await peer.call('flow/execution/stop', { run: owned.id, reason: 'Synthetic stop' })).ok, true)
})

for (const [name, scope] of [
  ['empty', {}], ['null fields', { team: null, run: null, project: null }], ['missing', undefined],
] as const) test(`Lead refuses ${name} subscription scope without delivering another project`, async t => {
  const { host, peer, directory } = await rig(t)
  const other = join(directory, 'other-project')
  await mkdir(other)
  await host.call('workspace/open', { path: other })
  const preview = await host.call('flow/preview', { root: other, source })
  const foreign = await host.call('flow/start-goal', { root: other, source, sentence: 'Other project goal', token: preview.token! })
  await peer.hello()
  const before = peer.messages.length
  const reply = await peer.call('client/subscribe', { topics: ['teams', 'runs'], scope })
  assert.equal(peer.messages.slice(before).some(frame => frame.method === 'goal/changed' && frame.params.view.goal.id === foreign.goal), false,
    'another project Goal was delivered')
  assert.equal(reply.error?.code, 'leadScope')
})

test('Lead project lists and subscriptions agree with ownership-scoped single reads', async t => {
  const { peer, host, home, owned, unrelated } = await rig(t)
  await peer.hello()
  assert.equal((await peer.call('goal/read', { goal: unrelated.goal })).error?.code, 'leadScope')
  const goals = await peer.call('goal/list', { root: home })
  const runs = await peer.call('flow/executions', { project: home })
  const before = peer.messages.length
  const subscription = await peer.call('client/subscribe', { topics: ['teams', 'runs', 'cards'], scope: { project: home } })
  assert.equal(subscription.ok, true)
  const baseline = peer.messages.slice(before)
  const visibleGoals = baseline.filter(frame => frame.method === 'goal/changed').map(frame => frame.params.view.goal.id)
  const visibleRuns = baseline.filter(frame => frame.method === 'flow/execution-changed').map(frame => frame.params.execution.id)
  const after = peer.messages.length
  await host.call('flow/execution/stop', { run: unrelated.id, reason: 'Synthetic stop' })
  await peer.hello() // Drain broadcasts queued before this request.
  assert.deepEqual({ goals: goals.result.map((view: any) => view.goal.id), runs: runs.result.map((run: any) => run.id), visibleGoals, visibleRuns },
    { goals: [owned.goal], runs: [owned.id], visibleGoals: [owned.goal], visibleRuns: [owned.id] })
  assert.equal(baseline.some(frame => frame.method === 'team/changed' && frame.params.state.id === unrelated.goal), false)
  assert.equal(peer.messages.slice(after).some(frame => frame.method === 'flow/execution-changed' && frame.params.execution.id === unrelated.id), false)
})

test('Lead refuses desk-wide library usage', async t => {
  const { peer } = await rig(t)
  await peer.hello()
  assert.equal((await peer.call('library/usage', {})).error?.code, 'leadScope')
})

test('Lead library definitions require the approved canonical project cwd', async t => {
  const { peer, home, directory } = await rig(t)
  await peer.hello()
  const params = { kind: 'skill', name: 'synthetic', path: join(home, 'SKILL.md') }
  assert.equal((await peer.call('library/definition', params)).error?.code, 'leadScope')
  assert.equal((await peer.call('library/definition', { ...params, cwd: directory })).error?.code, 'leadScope')
  const alias = join(directory, 'project-alias')
  await symlink(home, alias)
  assert.equal((await peer.call('library/definition', { ...params, cwd: alias })).ok, true)
})

test('Lead live run subscription loses authority when host ownership is withdrawn', async t => {
  let ownership: readonly { goal: string; run: string }[] = []
  const { peer, host, owned } = await rig(t, { readOwned: () => ownership })
  ownership = [{ goal: owned.goal, run: owned.id }]
  await peer.hello()
  assert.equal((await peer.call('client/subscribe', { topics: ['runs'], scope: { run: owned.id } })).ok, true)
  ownership = []
  const before = peer.messages.length
  await host.call('flow/execution/stop', { run: owned.id, reason: 'Synthetic host stop' })
  await peer.hello()
  assert.equal((await peer.call('flow/execution', { run: owned.id })).error?.code, 'leadScope')
  assert.equal(peer.messages.slice(before).filter(frame => frame.method === 'flow/execution-changed').length, 0)
})

test('Lead listener is separate, private and undiscoverable; descriptor and cleanup stay host-owned', async t => {
  const { directory, door } = await rig(t)
  const privateDirectory = dirname(door.socketPath)
  assert.notEqual(privateDirectory, directory)
  assert.equal((await lstat(privateDirectory)).mode & 0o777, 0o700)
  assert.equal((await lstat(door.socketPath)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(privateDirectory), [door.socketPath.slice(privateDirectory.length + 1)])
  assert.equal(door.descriptor.socketPath, door.socketPath)
  assert.equal(door.descriptor.protocolVersion, 1)
  await door.close()
  await assert.rejects(lstat(privateDirectory), { code: 'ENOENT' })
})

test('host journal ownership updates authorize new executions without trusting child claims', async t => {
  const { host, home, unrelated } = await rig(t)
  let owned: readonly { goal: string; run: string }[] = []
  const options = { host, project: home, owned: [], readOwned: () => owned }
  const authority = await createLeadClientAuthority(options)
  const request = { id: 1, method: 'flow/execution/stop' as const, params: { run: unrelated.id, reason: 'Synthetic stop' } }
  assert.equal(await authority.authorize(request), 'leadScope')
  owned = [{ goal: unrelated.goal, run: unrelated.id }]
  assert.equal(await authority.authorize(request), null)
  owned = []
  assert.equal(await authority.authorize(request), 'leadScope')
})

test('only the host start hook can admit approved arguments; the result can enter host ownership', async t => {
  let approved: unknown = null
  let owned: readonly { goal: string; run: string }[] = []
  const { peer, home, host } = await rig(t, { readOwned: () => owned,
    authorizeStart: params => JSON.stringify(params) === JSON.stringify(approved) })
  await peer.hello()
  const preview = await peer.call('flow/preview', { root: home, source })
  approved = { root: home, source, token: preview.result.token, sentence: 'Approved synthetic goal' }
  assert.equal((await peer.call('flow/start-goal', { ...approved as object, sentence: 'Other goal' })).error?.code, 'leadStartNotApproved')
  const started = await peer.call('flow/start-goal', approved)
  assert.equal(started.ok, true)
  assert.equal((await peer.call('flow/execution/stop', { run: started.result.id, reason: 'Synthetic stop' })).error?.code, 'leadScope')
  owned = [{ goal: started.result.goal, run: started.result.id }]
  assert.equal((await peer.call('flow/execution/stop', { run: started.result.id, reason: 'Synthetic stop' })).ok, true)
  assert.equal((await host.call('flow/execution', { run: started.result.id })).state, 'stopped')
})

test('desk revocation during an awaited start authorization wins before dispatch', async t => {
  let entered!: () => void
  let release!: () => void
  const authorizing = new Promise<void>(resolve => { entered = resolve })
  const authorized = new Promise<void>(resolve => { release = resolve })
  const { peer, home, host } = await rig(t, { authorizeStart: async () => { entered(); await authorized; return true } })
  t.after(() => release())
  await peer.hello()
  const preview = await peer.call('flow/preview', { root: home, source })
  const before = await host.call('flow/executions', { project: home })
  const starting = peer.call('flow/start-goal', { root: home, source, token: preview.result.token, sentence: 'Synthetic goal' })
  await authorizing
  host.clientTiers = () => ['read']
  release()
  assert.equal((await starting).error?.code, 'tierNotGranted')
  assert.deepEqual(await host.call('flow/executions', { project: home }), before)
})

test('canonical project aliases are admitted and retargeted aliases are refused on the next request', async t => {
  const { peer, home, directory } = await rig(t)
  const alias = join(directory, 'alias')
  const other = join(directory, 'other')
  await mkdir(other)
  await symlink(home, alias)
  await peer.hello()
  assert.equal((await peer.call('goal/list', { root: alias })).ok, true)
  await rm(alias)
  await symlink(other, alias)
  assert.equal((await peer.call('goal/list', { root: alias })).error?.code, 'leadScope')
})

test('host maximum tiers cannot accidentally grant answer and remain frozen after opening', async t => {
  const maximum: ClientTier[] = ['read', 'answer']
  const { peer, host, home } = await rig(t, { maximumTiers: maximum })
  host.clientTiers = () => ['read', 'run', 'answer']
  maximum.push('run')
  assert.deepEqual((await peer.hello()).result.tiers, ['read'])
  assert.equal((await peer.call('workspace/open', { path: home })).error?.code, 'tierNotGranted')
})

for (const withdrawal of ['journal', 'membership'] as const) {
  test(`real host ${withdrawal} withdrawal tells the child to end its wait`, async t => {
    const { createLeadJournal } = await import('@harnessdesk/lead')
    const { LeadSupervisor } = await import('@harnessdesk/lead/supervisor')
    const { CredentialBroker } = await import('../src/credentials.js')
    const { PassThrough } = await import('node:stream')
    const { host, home, connect } = await rig(t)
    const project = join(home, 'synthetic-project')
    await mkdir(project)
    await host.call('workspace/open', { path: project })
    const preview = await host.call('flow/preview', { root: project, source })
    const owned = await host.call('flow/start-goal', { root: project, source, sentence: 'Synthetic goal', token: preview.token! })
    t.mock.method(CredentialBroker.prototype, 'resolveLead', async () => 'sk-test-not-real-0000')
    const journal = await createLeadJournal({ read: async () => [], append: async () => {} })
    await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
    await journal.updateBudget({ version: 1, type: 'initialize', now: Date.now(), logicalGoalId: 'synthetic-host-owner',
      caps: { usdMicros: 1000, rounds: 4 }, freshnessMs: 1000 })
    let ownership = [{ correlationId: 'synthetic-start', runId: owned.id, teamId: owned.goal }]
    const getState = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(journal), 'state')!.get!
    t.mock.getter(journal, 'state', () => ({ ...getState.call(journal), runs: ownership }))
    const child: any = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 4242
    const received: any[] = [], answered: any[] = []
    const encode = (message: unknown) => { const body = Buffer.from(JSON.stringify(message)), head = Buffer.alloc(4); head.writeUInt32BE(body.length); return Buffer.concat([head, body]) }
    const answer = (message: any) => { answered.push(message); child.stdout.write(encode(message)) }
    child.kill = () => { queueMicrotask(() => child.emit('exit', 0, null)); return true }
    let pending = Buffer.alloc(0)
    child.stdin.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 4 && pending.length >= pending.readUInt32BE() + 4) {
        const size = pending.readUInt32BE(), message = JSON.parse(pending.subarray(4, size + 4).toString()); pending = pending.subarray(size + 4)
        received.push(message)
        if (message.type === 'initialize') answer({ version: 1, type: 'ready' })
        if (message.type === 'request') answer({ version: 1, type: 'response', id: message.id, result: { status: 'completed' } })
        if (message.type === 'ownership-withdrawn') { answer({ version: 1, type: 'wait-ended', runId: message.runId, reason: 'ownership-withdrawn' }); child.kill() }
        if (message.type === 'shutdown') child.kill()
      }
    })
    const service = host.createLeadService({ journal, project: { id: 'synthetic-project', path: project }, prices: {},
      resolveTool: async () => { throw new Error('unused') }, freezePlan: async (proposal: unknown) => proposal, readEvidence: async () => { throw new Error('unused') },
      createSupervisor: (settings: any) => new LeadSupervisor({ ...settings, connectDesk: async () => null, spawn: () => child }),
    } as any)
    await service.setEnabled(true)
    await service.send({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Wait for owned work' }] }], maxTokens: 32 })
    const peer = connect()
    await peer.hello()
    assert.equal((await peer.call('client/subscribe', { topics: ['runs'], scope: { run: owned.id } })).ok, true)
    if (withdrawal === 'journal') {
      ownership = []
      await journal.setManagementPhase('waiting-for-user', 'lead-ownership-withdrawn')
    } else {
      // Rename the pinned project, so re-authorization through the real door fails.
      const { rename } = await import('node:fs/promises')
      const renamed = `${project}-moved`
      await rename(project, renamed)
      await host.call('flow/execution/stop', { run: owned.id, reason: 'Synthetic host stop' })
    }
    for (let i = 0; i < 100 && !answered.some(message => message.type === 'wait-ended'); i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(received.some(message => message.type === 'ownership-withdrawn' && message.runId === owned.id))
    assert.ok(answered.some(message => message.type === 'wait-ended' && message.reason === 'ownership-withdrawn'))
    peer.socket.close()
  })
}

  test('project subscription stays allowed while loss of its only run tells the child ownership-withdrawn', async t => {
    const { createLeadJournal } = await import('@harnessdesk/lead')
    const { LeadSupervisor } = await import('@harnessdesk/lead/supervisor')
    const { CredentialBroker } = await import('../src/credentials.js')
    const { PassThrough } = await import('node:stream')
    const { host, home, connect } = await rig(t)
    const project = join(home, 'synthetic-project')
    await mkdir(project)
    await host.call('workspace/open', { path: project })
    const preview = await host.call('flow/preview', { root: project, source })
    const owned = await host.call('flow/start-goal', { root: project, source, sentence: 'Synthetic goal', token: preview.token! })
    t.mock.method(CredentialBroker.prototype, 'resolveLead', async () => 'sk-test-not-real-0000')
    const journal = await createLeadJournal({ read: async () => [], append: async () => {} })
    await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
    await journal.updateBudget({ version: 1, type: 'initialize', now: Date.now(), logicalGoalId: 'synthetic-host-owner',
      caps: { usdMicros: 1000, rounds: 4 }, freshnessMs: 1000 })
    let ownership = [{ correlationId: 'synthetic-start', runId: owned.id, teamId: owned.goal }]
    const getState = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(journal), 'state')!.get!
    t.mock.getter(journal, 'state', () => ({ ...getState.call(journal), runs: ownership }))
    const child: any = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 4242
    const received: any[] = [], answered: any[] = []
    const encode = (message: unknown) => { const body = Buffer.from(JSON.stringify(message)), head = Buffer.alloc(4); head.writeUInt32BE(body.length); return Buffer.concat([head, body]) }
    const answer = (message: any) => { answered.push(message); child.stdout.write(encode(message)) }
    child.kill = () => { queueMicrotask(() => child.emit('exit', 0, null)); return true }
    let pending = Buffer.alloc(0)
    child.stdin.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 4 && pending.length >= pending.readUInt32BE() + 4) {
        const size = pending.readUInt32BE(), message = JSON.parse(pending.subarray(4, size + 4).toString()); pending = pending.subarray(size + 4)
        received.push(message)
        if (message.type === 'initialize') answer({ version: 1, type: 'ready' })
        if (message.type === 'request') answer({ version: 1, type: 'response', id: message.id, result: { status: 'completed' } })
        if (message.type === 'ownership-withdrawn') { answer({ version: 1, type: 'wait-ended', runId: message.runId, reason: 'ownership-withdrawn' }); child.kill() }
        if (message.type === 'shutdown') child.kill()
      }
    })
    const service = host.createLeadService({ journal, project: { id: 'synthetic-project', path: project }, prices: {},
      resolveTool: async () => { throw new Error('unused') }, freezePlan: async (proposal: unknown) => proposal, readEvidence: async () => { throw new Error('unused') },
      createSupervisor: (settings: any) => new LeadSupervisor({ ...settings, connectDesk: async () => null, spawn: () => child }),
    } as any)
    await service.setEnabled(true)
    await service.send({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Wait for owned work' }] }], maxTokens: 32 })
    const peer = connect()
    await peer.hello()
    assert.equal((await peer.call('client/subscribe', { topics: ['runs'], scope: { project } })).ok, true)
    const selection = { topics: ['runs'] as const, scope: { project } }
    const authority = await createLeadClientAuthority({ host, project, owned: [], readOwned: () => ownership.map(item => ({ goal: item.teamId, run: item.runId })) })
    ownership = []
    assert.equal(await authority.authorize({ id: 0, method: 'client/subscribe', params: selection }), null)
    assert.equal(await authority.authorize({ id: 0, method: 'flow/execution', params: { run: owned.id } }), 'leadScope')
    await host.call('flow/execution/stop', { run: owned.id, reason: 'Synthetic host stop' })
    for (let i = 0; i < 100 && !answered.some(message => message.type === 'wait-ended'); i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(received.some(message => message.type === 'ownership-withdrawn' && message.runId === owned.id))
    assert.ok(answered.some(message => message.type === 'wait-ended' && message.reason === 'ownership-withdrawn'))
    peer.socket.close()
  })

test('a Lead connection refuses window controls including chat ownership before parsing their params', async t => {
  const { host, peer, authority } = await rig(t)
  await host.call('app/state/set', { patch: { clientsMayAnswer: true } })
  await peer.hello()
  for (const method of ['lead/chats/control', 'lead/chat/takeOver', 'lead/chat/handBack', 'lead/thread/read', 'lead/thread/send', 'lead/card/decide', 'lead/settings/read', 'lead/settings/update', 'lead/resume', 'lead/stop']) {
    const result = await peer.call(method, { child: 'cannot impersonate a click' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'notOnClientSurface')
    assert.equal(await authority.authorize({ id: 1, method, params: {} } as never), 'leadScope')
  }
})

test('Lead run reads and live notifications do not wait for evidence-bearing Goal views', async t => {
  const { host, home, peer, owned } = await rig(t)
  await peer.hello()
  assert.equal((await peer.call('client/subscribe', { topics: ['runs'], scope: { project: home } })).ok, true)
  const before = peer.messages.length
  const call = host.call.bind(host)
  const richReads: string[] = []
  t.mock.method(host, 'call', (method: any, params: any) => {
    if (method === 'goal/read' || method === 'goal/list') {
      richReads.push(method)
      throw new Error('Evidence reads are unavailable while work is running')
    }
    return call(method, params)
  })
  await host.call('flow/execution/stop', { run: owned.id, reason: 'Synthetic stop' })
  const response = await peer.call('flow/execution', { run: owned.id })
  assert.equal(response.ok, true, 'scope authorization must use live ownership and project identity without reading evidence')
  assert.ok(peer.messages.slice(before).some(message => message.method === 'flow/execution-changed' && message.params.execution.id === owned.id && message.params.execution.state === 'stopped'))
  assert.deepEqual(richReads, [])
})
