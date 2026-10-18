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
  const host = new Host({ logger: silent, state: new StateStore(join(home, 'state.json')), version: 'test', catalogRefreshMs: 0 })
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
