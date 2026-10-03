import assert from 'node:assert/strict'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import WebSocket from 'ws'
import { runtimeId, approvalId, type SeatActivity, type WireNotification } from '@harnessdesk/protocol'
import * as doorModule from '../src/client-door.js'
import { Client, silent, start, stop } from './fixtures/harness.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

const load = async () => doorModule

class Peer {
  readonly messages: any[] = []
  private next = 0
  private pending = new Map<number, (value: any) => void>()
  constructor(readonly socket: WebSocket) {
    socket.on('message', raw => {
      const value = JSON.parse(raw.toString())
      this.messages.push(value)
      if ('id' in value) { this.pending.get(value.id)?.(value); this.pending.delete(value.id) }
    })
  }
  static async open(path: string) {
    const socket = new WebSocket(`ws+unix://${path}:/client`)
    const peer = new Peer(socket)
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    return peer
  }
  call(method: string, params: unknown): Promise<any> {
    const id = ++this.next
    return new Promise(resolve => { this.pending.set(id, resolve); this.socket.send(JSON.stringify({ id, method, params })) })
  }
  hello(protocol = 1) { return this.call('client/hello', { client: { name: 'test', version: '1' }, protocol, pid: 42 }) }
  async until(predicate: () => boolean) {
    for (let n = 0; n < 500; n++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)) }
    assert.fail('notification did not arrive')
  }
}

const rig = async (t: any) => {
  const directory = await mkdtemp('/tmp/hd-door-')
  const home = join(directory, 'home')
  await mkdir(home)
  const h = await start({ catalogRefreshMs: 0 }, home)
  let door: doorModule.ClientDoor | null = null
  t.after(async () => { await door?.close(); await stop(h); await rm(directory, { recursive: true, force: true }) })
  const module = await load()
  door = await module.openClientDoor({ host: h.host, logger: silent, home, directory, hostVersion: '9.9.9' })
  assert.ok(door)
  return { directory, home, h, door, module }
}

test('paths, private socket and pointer, live refusal and shutdown cleanup', async t => {
  const { directory, home, h, door, module } = await rig(t)
  const paths = module.clientDoorPaths(await realpath(home), directory)
  assert.equal(door.socketPath, paths.socketPath)
  assert.match(paths.socketPath, /[a-f0-9]{16}\.sock$/)
  assert.equal((await lstat(paths.socketPath)).mode & 0o777, 0o600)
  assert.equal((await lstat(paths.pointerPath)).mode & 0o777, 0o600)
  const pointer = JSON.parse(await readFile(paths.pointerPath, 'utf8'))
  assert.equal(pointer.pid, process.pid)
  assert.equal(pointer.home, await realpath(home))
  assert.equal(await module.openClientDoor({ host: h.host, logger: silent, home, directory, hostVersion: '9.9.9' }), null)
  const peer = await Peer.open(door.socketPath)
  await peer.hello()
  await door.close()
  await peer.until(() => peer.messages.some(m => m.method === 'host/shutdown'))
  await assert.rejects(lstat(paths.pointerPath), { code: 'ENOENT' })
})

test('directory checks refuse wrong mode, links and another owner without changing them', async t => {
  const { directory, home, h, door, module } = await rig(t)
  await door.close()
  const options = { host: h.host, logger: silent, home, directory, hostVersion: 'test' }
  await chmod(directory, 0o755)
  assert.equal(await module.openClientDoor(options), null)
  assert.equal((await lstat(directory)).mode & 0o777, 0o755)
  await chmod(directory, 0o1700)
  const special = await module.openClientDoor(options)
  t.after(() => special?.close())
  assert.equal(special, null)
  await chmod(directory, 0o700)
  const alias = `${directory}-link`
  await symlink(directory, alias)
  t.after(() => rm(alias))
  assert.equal(await module.openClientDoor({ ...options, directory: alias }), null)
  const fs = await import('node:fs/promises')
  assert.equal(await module.openClientDoor(options, { ...fs, lstat: async (path: string) => {
    const stat = await fs.lstat(path)
    return Object.assign(stat, { uid: (process.getuid?.() ?? 0) + 1 })
  } }), null)
})

test('a stale socket is reclaimed', async t => {
  const { directory, home, h, door, module } = await rig(t)
  await door.close()
  const path = door.socketPath
  const child = spawn(process.execPath, ['--input-type=module', '-e', 'import net from "node:net"; net.createServer().listen(process.argv[1], () => process.stdout.write("ready"))', path], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject) })
  child.kill('SIGKILL')
  await new Promise<void>(resolve => child.once('exit', () => resolve()))
  assert.ok((await lstat(path)).isSocket())
  const reopened = await module.openClientDoor({ host: h.host, logger: silent, home, directory, hostVersion: 'test' })
  assert.ok(reopened)
  await reopened.close()
})

test('refusal order and hello version are independent of off-surface params', async t => {
  const { h, door, module } = await rig(t)
  const peer = await Peer.open(door.socketPath)
  t.after(() => peer.socket.close())
  assert.equal(peer.messages.length, 0)
  for (const params of [{ runtime: 'test', sessionId: 's', cwd: '/tmp' }, null]) {
    assert.equal((await peer.call('terminal/open', params)).error.code, 'notOnClientSurface')
  }
  assert.equal((await peer.call('missing/method', null)).error.code, 'notOnClientSurface')
  assert.equal((await peer.call('goal/list', null)).error.code, 'helloFirst')
  assert.equal((await peer.hello()).result.tiers.join(), 'read,run')
  assert.equal((await peer.call('goal/list', null)).error.code, 'badRequest')
  assert.equal((await peer.call('goal/list', {})).ok, true)
  assert.equal(module.clientRefusal('goal/list', true, []), 'tierNotGranted')
  const old = await Peer.open(door.socketPath)
  const incompatible = await old.hello(99)
  assert.equal(incompatible.error.code, 'incompatible')
  assert.deepEqual(incompatible.error.data, { clientProtocol: 99, hostProtocol: 1 })
  const window = await Client.connect(h.server)
  t.after(() => window.close())
  await assert.rejects(window.call('client/hello', { client: { name: 'test', version: '1' }, protocol: 1 }), { code: 'clientDoorOnly' })
  await assert.rejects(window.call('client/subscribe', { topics: [] }), { code: 'clientDoorOnly' })
})

const source = `version: 2
name: Demo
roles:
  decide: { kind: person, outcomes: [done] }
seed: { role: decide, title: Decide }
rules: []
`

test('topic baselines, replacement, scope, filtered broadcasts and request audit', async t => {
  const { directory, home, h, door, module } = await rig(t)
  await h.host.call('workspace/open', { path: home })
  const preview = await h.host.call('flow/preview', { root: home, source })
  assert.ok(preview.token)
  const run = await h.host.call('flow/start-goal', { root: home, source, sentence: 'Demo', token: preview.token! })
  const peer = await Peer.open(door.socketPath)
  t.after(() => peer.socket.close())
  await peer.hello()
  const acknowledged = await peer.call('client/subscribe', { topics: ['waiting', 'teams', 'notices'], scope: { team: run.goal } })
  await peer.until(() => peer.messages.some(m => m.method === 'goal/changed'))
  assert.deepEqual(acknowledged.result, { baseline: 3 })
  assert.equal(peer.messages.slice(peer.messages.indexOf(acknowledged) + 1).filter(m => 'method' in m).length, acknowledged.result.baseline)
  assert.ok(peer.messages.some(m => m.method === 'team/changed'))
  assert.ok(peer.messages.some(m => m.method === 'flow/execution-changed'))
  assert.ok(!peer.messages.some(m => m.method === 'sync'))
  assert.deepEqual(module.topicsOf(h.host.syncPayload()), [])
  assert.deepEqual(module.topicsOf({ method: 'event', params: { event: { type: 'turn/started' } } } as WireNotification), [])
  assert.deepEqual(module.topicsOf({ method: 'event', params: { event: { type: 'approval/resolved' } } } as WireNotification), ['waiting'])
  for (const scope of [{ run: run.id }, { project: home }]) {
    const before = peer.messages.length
    await peer.call('client/subscribe', { topics: ['runs', 'cards', 'teams'], scope })
    await peer.until(() => peer.messages.slice(before).some(m => m.method === 'goal/changed'))
    assert.ok(peer.messages.slice(before).some(m => m.method === 'flow/execution-changed'))
  }
  const before = peer.messages.length
  await peer.call('client/subscribe', { topics: ['runs', 'cards', 'teams'], scope: { team: 'other' } })
  await new Promise(r => setTimeout(r, 25))
  assert.equal(peer.messages.slice(before).filter(m => 'method' in m).length, 0)
  await peer.call('client/subscribe', { topics: ['waiting'], scope: { run: run.id } })
  const changed = peer.messages.length
  const view = await h.host.call('goal/read', { goal: run.goal })
  await h.host.call('team/intent', { room: view.board.id, id: view.board.intents[0]!.id, action: 'done', outcome: 'done' })
  await peer.until(() => peer.messages.slice(changed).some(m => m.method === 'flow/execution-changed' && m.params.execution.state === 'settled'))
  await peer.call('flow/execution', { run: 'absent' })
  await peer.call('terminal/open', {})
  await peer.call('flow/executions', {})
  await door.close()
  await peer.until(() => peer.socket.readyState === WebSocket.CLOSED)
  await h.host.call('audit/query', {})
  let entries: any[]
  entries = (await readFile(join(home, 'audit.ndjson'), 'utf8')).trim().split('\n').map(s => JSON.parse(s)).filter(e => e.via === 'client')
  assert.ok(entries.some(e => e.kind === 'client/connected' && e.client === 'test@1' && e.statedPid === 42))
  assert.ok(entries.some(e => e.kind === 'client/call' && e.outcome === 'failed'))
  assert.ok(entries.some(e => e.kind === 'client/refused' && e.code === 'notOnClientSurface'))
  assert.ok(entries.some(e => e.kind === 'client/call' && e.outcome === 'ok'))
})

test("a Team scope's baseline carries the Team's newest Run after it ends; an unscoped baseline carries only active Runs", async t => {
  const { home, h, door } = await rig(t)
  await h.host.call('workspace/open', { path: home })
  const preview = await h.host.call('flow/preview', { root: home, source })
  const run = await h.host.call('flow/start-goal', { root: home, source, sentence: 'Demo', token: preview.token! })
  const view = await h.host.call('goal/read', { goal: run.goal })
  let detach = () => {}
  const settled = new Promise<void>(resolve => {
    detach = h.host.addBroadcaster(message => {
      if (message.method === 'flow/execution-changed' && message.params.execution.id === run.id && message.params.execution.state === 'settled') resolve()
    })
  })
  t.after(() => detach())
  await h.host.call('team/intent', { room: view.board.id, id: view.board.intents[0]!.id, action: 'done', outcome: 'done' })
  await settled
  const peer = await Peer.open(door.socketPath)
  t.after(() => peer.socket.close())
  await peer.hello()
  const unscoped = await peer.call('client/subscribe', { topics: ['runs'] })
  assert.deepEqual(unscoped.result, { baseline: 0 })
  const before = peer.messages.length
  const scoped = await peer.call('client/subscribe', { topics: ['runs'], scope: { team: run.goal } })
  assert.deepEqual(scoped.result, { baseline: 1 })
  await peer.until(() => peer.messages.slice(before).some(m => m.method === 'flow/execution-changed'))
  const baseline = peer.messages.slice(peer.messages.indexOf(scoped) + 1).filter(m => 'method' in m)
  assert.equal(baseline.length, scoped.result.baseline)
  assert.equal(baseline[0].params.execution.id, run.id)
  assert.equal(baseline[0].params.execution.state, 'settled')
})

test('unscoped notices include a loose session', async t => {
  const { home, h, door } = await rig(t)
  const session = await h.host.call('session/create', { runtime: h.runtime.info.id, options: { cwd: home } })
  const peer = await Peer.open(door.socketPath)
  t.after(() => peer.socket.close())
  await peer.hello()
  await peer.call('client/subscribe', { topics: ['notices'] })
  await h.host.teamPlane.notify({ where: 'inbox', title: 'Synthetic notice' }, { runtime: h.runtime.info.id, sessionId: session.id })
  await peer.until(() => peer.messages.some(m => m.method === 'person/notice'))
})


test('waiting replays and resolves member approvals, without loose-session approvals', async t => {
  const { home, h, door } = await rig(t)
  await h.host.call('workspace/open', { path: home })
  const goal = await h.host.call('goal/create', { root: home, sentence: 'Synthetic Team' })
  const run = await h.host.call('flow/start', { room: goal.goal.id, source: 'name: Synthetic\nroles:\n  worker: { kind: agent, seat: fake, permission: read, outcomes: [done], order: Read the card. }\nseed: { role: worker, title: Read }\nrules: []\n' })
  const session = run.seats[0]!
  const peer = await Peer.open(door.socketPath)
  t.after(() => peer.socket.close())
  await peer.hello()
  const live = h.runtime.sessions.get(session.sessionId)!
  const approval = live.askApproval(approvalId('member'))
  const acknowledged = await peer.call('client/subscribe', { topics: ['waiting'], scope: { team: goal.goal.id } })
  await peer.until(() => peer.messages.some(m => m.method === 'event' && m.params.event.type === 'approval/requested'))
  assert.deepEqual(acknowledged.result, { baseline: 2 })
  assert.equal(peer.messages.slice(peer.messages.indexOf(acknowledged) + 1).filter(m => 'method' in m).length, acknowledged.result.baseline)
  const call = h.host.call.bind(h.host)
  Object.defineProperty(h.host, 'call', { value: async (method: string, params: unknown) => {
    const result = await call(method as never, params as never)
    return method === 'goal/list' ? (result as unknown as { members: unknown[] }[]).map(view => ({ ...view, members: [] })) : result
  } })
  await h.host.call('approval/respond', { runtime: h.runtime.info.id, sessionId: session.sessionId as never, approvalId: approvalId('member'), decision: { type: 'option', optionId: 'opt-1' } })
  await approval
  await peer.until(() => peer.messages.some(m => m.method === 'event' && m.params.event.type === 'approval/resolved'))
  const loose = await h.host.call('session/create', { runtime: h.runtime.info.id, options: { cwd: home } })
  const looseApproval = h.runtime.sessions.get(loose.id)!.askApproval(approvalId('loose'))
  const before = peer.messages.length
  await peer.call('client/subscribe', { topics: ['waiting'] })
  await new Promise(r => setTimeout(r, 30))
  assert.ok(!peer.messages.slice(before).some(m => m.method === 'event' && m.params.event.approval?.id === 'loose'))
  await h.host.call('approval/respond', { runtime: h.runtime.info.id, sessionId: loose.id, approvalId: approvalId('loose'), decision: { type: 'option', optionId: 'opt-1' } })
  await looseApproval
})

test('a failed hello stays unanswered as hello and records its failed result', async t => {
  const { h, door } = await rig(t)
  const call = h.host.call.bind(h.host)
  Object.defineProperty(h.host, 'call', { value: async (method: string, params: unknown) => {
    if (method === 'runtime/health') throw new Error('Synthetic health failure')
    return call(method as never, params as never)
  } })
  const peer = await Peer.open(door.socketPath)
  t.after(() => peer.socket.close())
  const result = await Promise.race([peer.hello(), new Promise<null>(resolve => setTimeout(() => resolve(null), 300))])
  assert.equal(result?.error.code, 'methodFailed')
  assert.equal((await peer.call('goal/list', {})).error.code, 'helloFirst')
})

test('a notice raised while subscribe reads its baseline is delivered', async t => {
  const { home, h, door } = await rig(t)
  const session = await h.host.call('session/create', { runtime: h.runtime.info.id, options: { cwd: home } })
  const peer = await Peer.open(door.socketPath)
  t.after(() => peer.socket.close())
  await peer.hello()
  const call = h.host.call.bind(h.host)
  let release!: () => void
  let reading!: () => void
  const entered = new Promise<void>(resolve => { reading = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let first = true
  Object.defineProperty(h.host, 'call', { value: async (method: string, params: unknown) => {
    if (method === 'goal/list' && first) { first = false; reading(); await held }
    return call(method as never, params as never)
  } })
  const subscribed = peer.call('client/subscribe', { topics: ['notices'] })
  await entered
  await h.host.teamPlane.notify({ where: 'inbox', title: 'During baseline' }, { runtime: h.runtime.info.id, sessionId: session.id })
  release()
  await subscribed
  await new Promise(r => setTimeout(r, 40))
  assert.ok(peer.messages.some(m => m.method === 'person/notice' && m.params.notice.title === 'During baseline'))
})

const holdNextRead = (host: Awaited<ReturnType<typeof start>>['host'], methodToHold = 'goal/list') => {
  const call = host.call.bind(host)
  let release!: () => void
  let reading!: () => void
  const entered = new Promise<void>(resolve => { reading = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let first = true
  Object.defineProperty(host, 'call', { value: async (method: string, params: unknown) => {
    if (method === methodToHold && first) { first = false; reading(); await held }
    return call(method as never, params as never)
  } })
  return { entered, release }
}

test('an accepted replacement filters queued broadcasts by its final topics and scope', async t => {
  const { home, h, door } = await rig(t)
  await h.host.call('workspace/open', { path: home })
  const goal = await h.host.call('goal/create', { root: home, sentence: 'Synthetic Team' })
  const run = await h.host.call('flow/start', { room: goal.goal.id, source: 'name: Synthetic\nroles:\n  worker: { kind: agent, seat: fake, permission: read, outcomes: [done], order: Read the card. }\nseed: { role: worker, title: Read }\nrules: []\n' })
  const member = run.seats[0]!
  const loose = await h.host.call('session/create', { runtime: h.runtime.info.id, options: { cwd: home } })
  const peer = await Peer.open(door.socketPath)
  t.after(() => peer.socket.close())
  await peer.hello()
  assert.equal((await peer.call('client/subscribe', { topics: ['teams'] })).ok, true)
  await peer.call('goal/list', {})
  // Only subscription collection reads this method; an older broadcast can
  // still read goal/list while the previous selection is active.
  const { entered, release } = holdNextRead(h.host, 'flow/executions')
  t.after(release)
  const replacement = peer.call('client/subscribe', { topics: ['notices'], scope: { team: goal.goal.id } })
  await entered
  await h.host.call('goal/create', { root: home, sentence: 'Other synthetic Team' })
  await h.host.teamPlane.notify({ where: 'inbox', title: 'Candidate in scope' }, { runtime: h.runtime.info.id, sessionId: member.sessionId as never })
  await h.host.teamPlane.notify({ where: 'inbox', title: 'Candidate outside scope' }, { runtime: h.runtime.info.id, sessionId: loose.id })
  release()
  const accepted = await replacement
  assert.equal(accepted.ok, true)
  await peer.call('goal/list', {})
  const boundary = peer.messages.findIndex(m => m.id === accepted.id)
  const notifications = peer.messages.slice(boundary + 1).filter(m => 'method' in m)
  assert.deepEqual(notifications.map(m => [m.method, m.params.notice?.title]), [['person/notice', 'Candidate in scope']])
})

test('a refused replacement retains notices raised during and after its baseline read', async t => {
  const { home, h, door } = await rig(t)
  const session = await h.host.call('session/create', { runtime: h.runtime.info.id, options: { cwd: home } })
  const peer = await Peer.open(door.socketPath)
  t.after(() => peer.socket.close())
  await peer.hello()
  assert.equal((await peer.call('client/subscribe', { topics: ['notices'] })).ok, true)
  const { entered, release } = holdNextRead(h.host)
  t.after(release)
  const replacement = peer.call('client/subscribe', { topics: ['teams'], scope: { run: 'missing' } })
  await entered
  await h.host.teamPlane.notify({ where: 'inbox', title: 'During refused replacement' }, { runtime: h.runtime.info.id, sessionId: session.id })
  release()
  const refused = await replacement
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'methodFailed')
  assert.equal(refused.error.message, 'There is no flow run missing.')
  await h.host.teamPlane.notify({ where: 'inbox', title: 'After refused replacement' }, { runtime: h.runtime.info.id, sessionId: session.id })
  // This reply follows all notifications already enqueued on the connection.
  assert.equal((await peer.call('goal/list', {})).ok, true)
  assert.deepEqual(peer.messages.filter(m => m.method === 'person/notice').map(m => m.params.notice.title), [
    'During refused replacement', 'After refused replacement',
  ])
})

test('a refused replacement retains a shown approval resolution and the waiting subscription', async t => {
  const { home, h, door } = await rig(t)
  await h.host.call('workspace/open', { path: home })
  const goal = await h.host.call('goal/create', { root: home, sentence: 'Synthetic Team' })
  const run = await h.host.call('flow/start', { room: goal.goal.id, source: 'name: Synthetic\nroles:\n  worker: { kind: agent, seat: fake, permission: read, outcomes: [done], order: Read the card. }\nseed: { role: worker, title: Read }\nrules: []\n' })
  const session = run.seats[0]!
  const live = h.runtime.sessions.get(session.sessionId)!
  const peer = await Peer.open(door.socketPath)
  t.after(() => peer.socket.close())
  await peer.hello()
  const approval = live.askApproval(approvalId('during-refusal'))
  assert.equal((await peer.call('client/subscribe', { topics: ['waiting'], scope: { team: goal.goal.id } })).ok, true)
  await peer.call('goal/list', {})
  assert.ok(peer.messages.some(m => m.method === 'event' && m.params.event.type === 'approval/requested' && m.params.event.approval.id === 'during-refusal'))
  const { entered, release } = holdNextRead(h.host)
  t.after(release)
  const replacement = peer.call('client/subscribe', { topics: ['teams'], scope: { run: 'missing' } })
  await entered
  await h.host.call('approval/respond', { runtime: h.runtime.info.id, sessionId: session.sessionId as never, approvalId: approvalId('during-refusal'), decision: { type: 'option', optionId: 'opt-1' } })
  await approval
  release()
  const refused = await replacement
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'methodFailed')
  assert.equal(refused.error.message, 'There is no flow run missing.')
  const following = live.askApproval(approvalId('after-refusal'))
  await peer.call('goal/list', {})
  assert.ok(peer.messages.some(m => m.method === 'event' && m.params.event.type === 'approval/requested' && m.params.event.approval.id === 'after-refusal'))
  await h.host.call('approval/respond', { runtime: h.runtime.info.id, sessionId: session.sessionId as never, approvalId: approvalId('after-refusal'), decision: { type: 'option', optionId: 'opt-1' } })
  await following
  await peer.call('goal/list', {})
  assert.deepEqual(peer.messages.filter(m => m.method === 'event' && m.params.event.type === 'approval/resolved').map(m => m.params.event.approvalId), [
    'during-refusal', 'after-refusal',
  ])
})

for (const phase of ['before run read', 'during run read'] as const) {
  test(`subscribe reconciles run snapshots received ${phase}`, async t => {
    const { home, directory, h, door, module } = await rig(t)
    await door.close()
    await h.host.call('workspace/open', { path: home })
    const preview = await h.host.call('flow/preview', { root: home, source })
    const run = await h.host.call('flow/start-goal', { root: home, source, sentence: 'Synthetic run', token: preview.token! })
    let current = await h.host.call('flow/execution', { run: run.id })
    const view = await h.host.call('goal/read', { goal: run.goal })
    let broadcast!: (notification: WireNotification) => void
    const add = h.host.addBroadcaster.bind(h.host)
    Object.defineProperty(h.host, 'addBroadcaster', { value: (callback: typeof broadcast) => { broadcast = callback; return add(callback) } })
    const reopened = await module.openClientDoor({ host: h.host, logger: silent, home, directory, hostVersion: 'test' })
    assert.ok(reopened)
    t.after(() => reopened.close())
    const peer = await Peer.open(reopened.socketPath)
    t.after(() => peer.socket.close())
    await peer.hello()
    const call = h.host.call.bind(h.host)
    let reading!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { reading = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    t.after(release)
    let first = true
    Object.defineProperty(h.host, 'call', { value: async (method: string, params: unknown) => {
      const result = method === 'flow/execution' ? current : await call(method as never, params as never)
      if (first && method === (phase === 'before run read' ? 'goal/list' : 'flow/execution')) {
        first = false; reading(); await held
      }
      return result
    } })
    const subscribed = peer.call('client/subscribe', { topics: ['runs', 'cards', 'teams'], scope: { team: run.goal } })
    await entered
    for (const state of ['stalled', phase === 'before run read' ? 'running' : 'settled'] as const) {
      current = { ...current, state }
      broadcast({ method: 'flow/execution-changed', params: { execution: current } })
    }
    for (const title of ['Earlier card', 'Latest card']) {
      broadcast({ method: 'team/changed', params: { state: { ...view.board,
        intents: view.board.intents.map(card => ({ ...card, title })) } } })
    }
    broadcast({ method: 'goal/activity', params: { goal: run.goal, previous: 'needs-you',
      activity: 'working', sentence: 'Earlier Team' } })
    broadcast({ method: 'goal/activity', params: { goal: run.goal, previous: 'working',
      activity: 'needs-you', sentence: 'Latest Team' } })
    release()
    const acknowledged = await subscribed
    assert.equal(acknowledged.ok, true)
    assert.deepEqual(acknowledged.result, { baseline: 3 })
    await peer.call('goal/list', {})
    assert.deepEqual(peer.messages.filter(m => m.method === 'flow/execution-changed').map(m => m.params.execution.state), [current.state])
    assert.deepEqual(peer.messages.filter(m => m.method === 'team/changed').map(m => m.params.state.intents[0].title), ['Latest card'])
    assert.deepEqual(peer.messages.filter(m => m.method === 'goal/changed').map(m => m.params.view.goal.sentence), ['Latest Team'])
    assert.deepEqual(peer.messages.filter(m => m.method === 'goal/changed').map(m => m.params.view.board.intents[0].title), ['Latest card'])
    assert.equal(peer.messages.some(m => m.method === 'goal/activity'), false)
  })
}

for (const accepted of [true, false]) {
  test(`a ${accepted ? 'successful' : 'refused'} replacement queued behind a read preserves snapshot and notice ordering`, async t => {
    const { home, directory, h, door, module } = await rig(t)
    await door.close()
    await h.host.call('workspace/open', { path: home })
    const preview = await h.host.call('flow/preview', { root: home, source })
    const run = await h.host.call('flow/start-goal', { root: home, source, sentence: 'Synthetic run', token: preview.token! })
    let current = await h.host.call('flow/execution', { run: run.id })
    const session = await h.host.call('session/create', { runtime: h.runtime.info.id, options: { cwd: home } })
    let broadcast!: (notification: WireNotification) => void
    const add = h.host.addBroadcaster.bind(h.host)
    Object.defineProperty(h.host, 'addBroadcaster', { value: (callback: typeof broadcast) => { broadcast = callback; return add(callback) } })
    const reopened = await module.openClientDoor({ host: h.host, logger: silent, home, directory, hostVersion: 'test' })
    assert.ok(reopened)
    t.after(() => reopened.close())
    const peer = await Peer.open(reopened.socketPath)
    t.after(() => peer.socket.close())
    const call = h.host.call.bind(h.host)
    Object.defineProperty(h.host, 'call', { configurable: true, value: async (method: string, params: unknown) =>
      method === 'flow/execution' ? current : call(method as never, params as never) })
    await peer.hello()
    assert.equal((await peer.call('client/subscribe', { topics: ['runs', 'notices'] })).ok, true)
    await peer.call('goal/list', {})
    const before = peer.messages.length
    const { entered, release } = holdNextRead(h.host)
    t.after(release)
    const preceding = peer.call('goal/list', {})
    await entered
    if (!accepted) Object.defineProperty(h.host, 'pendingApprovalEvents', { value: () => { throw new Error('Synthetic approval baseline failure') } })
    const replacement = peer.call('client/subscribe', { topics: ['waiting', 'notices'] })
    // A pong follows receipt of the subscription frame, even while the read is held.
    await new Promise<void>(resolve => { peer.socket.once('pong', () => resolve()); peer.socket.ping() })
    for (const state of ['stalled', 'running'] as const) {
      current = { ...current, state }
      broadcast({ method: 'flow/execution-changed', params: { execution: current } })
      await h.host.teamPlane.notify({ where: 'inbox', title: `During ${state}` }, { runtime: h.runtime.info.id, sessionId: session.id })
    }
    release()
    assert.equal((await preceding).ok, true)
    const result = await replacement
    assert.equal(result.ok, accepted)
    await peer.call('goal/list', {})
    const notifications = peer.messages.slice(before).filter(m => 'method' in m)
    assert.deepEqual(notifications.filter(m => m.method === 'flow/execution-changed').map(m => m.params.execution.state),
      accepted ? ['running'] : ['stalled', 'running'])
    assert.deepEqual(notifications.filter(m => m.method === 'person/notice').map(m => m.params.notice.title), ['During stalled', 'During running'])
    current = { ...current, state: 'settled' }
    broadcast({ method: 'flow/execution-changed', params: { execution: current } })
    await peer.call('goal/list', {})
    assert.equal(peer.messages.filter(m => m.method === 'flow/execution-changed').at(-1).params.execution.state, 'settled')
  })
}

for (const kind of ['symlink', 'hardlink'] as const) {
  test(`publishing a pointer replaces a ${kind} without changing its target`, async t => {
    const { home, directory, h, door, module } = await rig(t)
    await door.close()
    const { pointerPath } = module.clientDoorPaths(await realpath(home), directory)
    const target = join(directory, 'target')
    await writeFile(target, 'Synthetic target', { mode: 0o640 })
    await (kind === 'symlink' ? symlink : link)(target, pointerPath)
    const reopened = await module.openClientDoor({ host: h.host, logger: silent, home, directory, hostVersion: 'test' })
    t.after(() => reopened?.close())
    assert.ok(reopened)
    assert.equal(await readFile(target, 'utf8'), 'Synthetic target')
    assert.equal((await lstat(target)).mode & 0o777, 0o640)
    assert.equal((await lstat(pointerPath)).isSymbolicLink(), false)
    assert.equal((await lstat(pointerPath)).mode & 0o777, 0o600)
    assert.equal(JSON.parse(await readFile(pointerPath, 'utf8')).pid, process.pid)
  })
}

test('pointer publication failure closes upgraded peers and detaches their broadcaster before returning', async t => {
  const { home, directory, h, door, module } = await rig(t)
  await door.close()
  const fs = await import('node:fs/promises')
  let peer: Peer | undefined
  let detached = false
  const add = h.host.addBroadcaster.bind(h.host)
  Object.defineProperty(h.host, 'addBroadcaster', { value: (callback: Parameters<typeof add>[0]) => {
    const detach = add(callback)
    return () => { detached = true; detach() }
  } })
  const failed = await module.openClientDoor({ host: h.host, logger: silent, home, directory, hostVersion: 'test' }, {
    ...fs,
    writeFile: async () => {
      peer = await Peer.open(door.socketPath)
      await peer.hello()
      throw Object.assign(new Error('Synthetic publication failure'), { code: 'EACCES' })
    },
  })
  t.after(() => peer?.socket.terminate())
  assert.equal(failed, null)
  assert.ok(peer)
  assert.equal(detached, true)
  await peer.until(() => peer!.socket.readyState === WebSocket.CLOSED)
  await assert.rejects(lstat(door.socketPath), { code: 'ENOENT' })
})

test('a failed pointer rename preserves the previous pointer and removes the temporary file', async t => {
  const { home, directory, h, door, module } = await rig(t)
  await door.close()
  const { pointerPath } = module.clientDoorPaths(await realpath(home), directory)
  await writeFile(pointerPath, 'Previous synthetic pointer', { mode: 0o640 })
  const fs = await import('node:fs/promises')
  const failed = await module.openClientDoor({ host: h.host, logger: silent, home, directory, hostVersion: 'test' }, {
    ...fs, rename: async () => { throw Object.assign(new Error('Synthetic rename failure'), { code: 'EACCES' }) },
  })
  assert.equal(failed, null)
  assert.equal(await readFile(pointerPath, 'utf8'), 'Previous synthetic pointer')
  assert.equal((await lstat(pointerPath)).mode & 0o777, 0o640)
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false)
  await assert.rejects(lstat(door.socketPath), { code: 'ENOENT' })
})

test('a replacement failing after snapshot collection retains the old selection and queued run state', async t => {
  const { home, h, door } = await rig(t)
  await h.host.call('workspace/open', { path: home })
  const preview = await h.host.call('flow/preview', { root: home, source })
  const run = await h.host.call('flow/start-goal', { root: home, source, sentence: 'Synthetic run', token: preview.token! })
  const peer = await Peer.open(door.socketPath)
  t.after(() => peer.socket.close())
  await peer.hello()
  assert.equal((await peer.call('client/subscribe', { topics: ['waiting'], scope: { team: run.goal } })).ok, true)
  const { entered, release } = holdNextRead(h.host, 'flow/executions')
  t.after(release)
  Object.defineProperty(h.host, 'pendingApprovalEvents', { value: () => { throw new Error('Synthetic approval baseline failure') } })
  const replacement = peer.call('client/subscribe', { topics: ['waiting'], scope: { team: run.goal } })
  await entered
  const before = peer.messages.length
  const settled = new Promise<void>(resolve => {
    const detach = h.host.addBroadcaster(notification => {
      if (notification.method === 'flow/execution-changed' && notification.params.execution.id === run.id && notification.params.execution.state === 'settled') {
        detach(); resolve()
      }
    })
    t.after(detach)
  })
  const view = await h.host.call('goal/read', { goal: run.goal })
  await h.host.call('team/intent', { room: view.board.id, id: view.board.intents[0]!.id, action: 'done', outcome: 'done' })
  await settled
  release()
  assert.equal((await replacement).ok, false)
  await peer.call('goal/list', {})
  assert.ok(peer.messages.slice(before).some(m => m.method === 'flow/execution-changed' && m.params.execution.state === 'settled'))
})

const activityRig = async (t: any) => {
  const { home, directory, h, door, module } = await rig(t)
  await door.close()
  await h.host.call('workspace/open', { path: home })
  const preview = await h.host.call('flow/preview', { root: home, source })
  const run = await h.host.call('flow/start-goal', { root: home, source, sentence: 'Synthetic activity', token: preview.token! })
  let broadcast!: (notification: WireNotification) => void
  const add = h.host.addBroadcaster.bind(h.host)
  Object.defineProperty(h.host, 'addBroadcaster', { value: (callback: typeof broadcast) => { broadcast = callback; return add(callback) } })
  let current: SeatActivity = { goal: run.goal, seat: 'demo:seat', role: 'reviewer', card: null, state: 'idle', doing: null }
  Object.defineProperty(h.host, 'seatActivities', { configurable: true, value: () => [current, { ...current, goal: 'other' }] })
  const reopened = await module.openClientDoor({ host: h.host, logger: silent, home, directory, hostVersion: 'test' })
  assert.ok(reopened)
  t.after(() => reopened.close())
  const peer = await Peer.open(reopened.socketPath)
  t.after(() => peer.socket.close())
  await peer.hello()
  return { h, home, run, peer, broadcast, get current() { return current }, change(state: SeatActivity['state']) {
    current = { ...current, state, doing: state === 'working' ? { kind: 'thinking' } : null }
    broadcast({ method: 'seat/activity', params: current })
  } }
}

test('seat baselines and review changes follow Team, run and project scope and topic selection', async t => {
  const r = await activityRig(t)
  const { peer, run, home, broadcast } = r
  const review = await peer.call('finding/run', { goal: run.goal, run: run.id })
  assert.equal(review.ok, true)
  assert.equal(review.result.goal, run.goal)
  assert.deepEqual(review.result.rounds, [])
  for (const scope of [{ team: run.goal }, { run: run.id }, { project: home }, { team: 'other-team' }]) {
    const before = peer.messages.length
    assert.equal((await peer.call('client/subscribe', { topics: ['seats', 'reviews'], scope })).ok, true)
    broadcast({ method: 'finding/changed', params: { goal: run.goal, revision: 1 } })
    broadcast({ method: 'finding/changed', params: { goal: 'other', revision: 2 } })
    r.change('working')
    broadcast({ method: 'seat/activity', params: { ...r.current, goal: 'other' } })
    await peer.call('goal/list', {})
    const notifications = peer.messages.slice(before).filter(m => 'method' in m)
    if ('team' in scope && scope.team === 'other-team') assert.deepEqual(notifications, [])
    else {
      assert.equal(notifications.filter(m => m.method === 'seat/activity').length, 2)
      assert.ok(notifications.every(m => m.params.goal === run.goal))
      assert.deepEqual(notifications.filter(m => m.method === 'finding/changed').map(m => m.params.revision), [1])
    }
  }
  for (const topics of [['seats'], ['reviews'], ['teams']]) {
    assert.equal((await peer.call('client/subscribe', { topics, scope: { team: run.goal } })).ok, true)
    await peer.call('goal/list', {})
    const before = peer.messages.length
    broadcast({ method: 'finding/changed', params: { goal: run.goal, revision: 3 } })
    r.change('idle')
    await peer.call('goal/list', {})
    const methods = peer.messages.slice(before).filter(m => 'method' in m).map(m => m.method)
    assert.deepEqual(methods, topics[0] === 'reviews' ? ['finding/changed'] : topics[0] === 'seats' ? ['seat/activity'] : [])
  }
})

for (const phase of ['before seat read', 'during seat read'] as const) {
  test(`subscribe reconciles seat snapshots received ${phase}`, async t => {
    const r = await activityRig(t)
    const { peer, h, run } = r
    const { entered, release } = holdNextRead(h.host)
    t.after(release)
    if (phase === 'during seat read') Object.defineProperty(h.host, 'seatActivities', { value: () => {
      const sampled = r.current
      r.change('waiting')
      r.change('working')
      return [sampled]
    } })
    const subscribing = peer.call('client/subscribe', { topics: ['seats'], scope: { team: run.goal } })
    await entered
    if (phase === 'before seat read') { r.change('waiting'); r.change('working') }
    release()
    const acknowledged = await subscribing
    assert.equal(acknowledged.ok, true)
    assert.deepEqual(acknowledged.result, { baseline: 1 })
    await peer.call('goal/list', {})
    assert.deepEqual(peer.messages.filter(m => m.method === 'seat/activity').map(m => m.params.state), ['working'])
    r.change('idle')
    await peer.call('goal/list', {})
    assert.deepEqual(peer.messages.filter(m => m.method === 'seat/activity').map(m => m.params.state), ['working', 'idle'])
  })
}

for (const accepted of [true, false]) {
  test(`a ${accepted ? 'successful' : 'refused'} replacement preserves queued seat snapshots and review invalidations`, async t => {
    const r = await activityRig(t)
    const { peer, h, run } = r
    assert.equal((await peer.call('client/subscribe', { topics: ['seats', 'reviews'], scope: { team: run.goal } })).ok, true)
    await peer.call('goal/list', {})
    const before = peer.messages.length
    const { entered, release } = holdNextRead(h.host)
    t.after(release)
    const preceding = peer.call('goal/list', {})
    await entered
    if (!accepted) Object.defineProperty(h.host, 'pendingApprovalEvents', { value: () => { throw new Error('Synthetic approval baseline failure') } })
    const replacing = peer.call('client/subscribe', { topics: ['seats', 'reviews', 'waiting'], scope: { team: run.goal } })
    await new Promise<void>(resolve => { peer.socket.once('pong', () => resolve()); peer.socket.ping() })
    r.change('waiting')
    r.broadcast({ method: 'finding/changed', params: { goal: run.goal, revision: 4 } })
    r.change('working')
    r.broadcast({ method: 'finding/changed', params: { goal: run.goal, revision: 5 } })
    release()
    assert.equal((await preceding).ok, true)
    assert.equal((await replacing).ok, accepted)
    await peer.call('goal/list', {})
    assert.deepEqual(peer.messages.slice(before).filter(m => m.method === 'seat/activity').map(m => m.params.state), accepted ? ['working'] : ['waiting', 'working'])
    assert.deepEqual(peer.messages.slice(before).filter(m => m.method === 'finding/changed').map(m => m.params.revision), [4, 5])
    r.change('idle')
    await peer.call('goal/list', {})
    assert.equal(peer.messages.filter(m => m.method === 'seat/activity').at(-1).params.state, 'idle')
  })
}

test('client hello reports metering and goal insight is admitted only to the read tier', async t => {
  const { h, door, module } = await rig(t)
  const metered = new FakeRuntime({ id: runtimeId('metered'), capabilities: { metered: true } })
  h.host.register(metered)
  const peer = await Peer.open(door.socketPath); t.after(() => peer.socket.close())
  assert.equal((await peer.call('insight/goal', { goal: 'missing' })).error.code, 'helloFirst')
  const hello = await peer.hello()
  assert.equal(hello.result.runtimes.find((one: any) => one.id === h.runtime.info.id).metered, false)
  assert.equal(hello.result.runtimes.find((one: any) => one.id === metered.info.id).metered, true)
  assert.ok(hello.result.methods.includes('insight/goal'))
  assert.equal(module.clientRefusal('insight/goal', true, []), 'tierNotGranted')
  await h.host.call('workspace/open', { path: h.stateDir })
  const goal = await h.host.call('goal/create', { root: h.stateDir, sentence: 'Measure the synthetic Team' }) as any
  const insight = await peer.call('insight/goal', { goal: goal.goal.id })
  assert.equal(insight.ok, true, JSON.stringify(insight))
  assert.equal(insight.result.goal, goal.goal.id)
})


test('the run surface answers and audits its actual tier, without admitting other verbs', async t => {
  const { home, h, door, module } = await rig(t)
  const peer = await Peer.open(door.socketPath); t.after(() => peer.socket.close())
  await peer.hello()
  assert.equal(module.clientRefusal('workspace/open', true, ['read']), 'tierNotGranted')
  assert.equal((await peer.call('workspace/open', { path: home })).ok, true)
  assert.equal((await peer.call('flow/catalog', { root: home })).ok, true)
  assert.equal((await peer.call('flow/source', { root: home, id: '/tmp/outside.yaml' })).ok, false)
  const preview = await peer.call('flow/preview', { root: home, source })
  assert.ok(preview.result.token)
  assert.equal((await peer.call('flow/start-goal', { root: home, source, sentence: 'Demo', token: preview.result.token })).ok, true)
  assert.equal((await peer.call('workspace/open', { path: '' })).error.code, 'badRequest')
  assert.equal((await peer.call('flow/execution/stop', { run: 'missing' })).error.code, 'notOnClientSurface')
  assert.equal((await peer.call('approval/respond', null)).error.code, 'notOnClientSurface')
  await door.close()
  await peer.until(() => peer.socket.readyState === WebSocket.CLOSED)
  await h.host.call('audit/query', {})
  const entries = (await readFile(join(home, 'audit.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(one => one.via === 'client')
  for (const method of ['workspace/open', 'flow/start-goal']) assert.ok(entries.some(one => one.method === method && one.tier === 'run' && one.outcome === 'ok'))
  assert.ok(entries.some(one => one.method === 'flow/source' && one.tier === 'read' && one.outcome === 'failed'))
  assert.ok(entries.some(one => one.method === 'workspace/open' && one.tier === 'run' && one.outcome === 'refused'))
})
