import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import WebSocket from 'ws'
import { approvalId, type WireNotification } from '@harnessdesk/protocol'
import * as doorModule from '../src/client-door.js'
import { Client, silent, start, stop } from './fixtures/harness.js'

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
  assert.equal((await peer.hello()).result.tiers.join(), 'read')
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
  await peer.call('client/subscribe', { topics: ['waiting', 'teams', 'notices'], scope: { team: run.goal } })
  await peer.until(() => peer.messages.some(m => m.method === 'goal/changed'))
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
  await peer.call('client/subscribe', { topics: ['waiting'], scope: { team: goal.goal.id } })
  await peer.until(() => peer.messages.some(m => m.method === 'event' && m.params.event.type === 'approval/requested'))
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

const holdNextGoalList = (host: Awaited<ReturnType<typeof start>>['host']) => {
  const call = host.call.bind(host)
  let release!: () => void
  let reading!: () => void
  const entered = new Promise<void>(resolve => { reading = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let first = true
  Object.defineProperty(host, 'call', { value: async (method: string, params: unknown) => {
    if (method === 'goal/list' && first) { first = false; reading(); await held }
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
  const before = peer.messages.length
  const { entered, release } = holdNextGoalList(h.host)
  t.after(release)
  const replacement = peer.call('client/subscribe', { topics: ['notices'], scope: { team: goal.goal.id } })
  await entered
  await h.host.call('goal/create', { root: home, sentence: 'Other synthetic Team' })
  await h.host.teamPlane.notify({ where: 'inbox', title: 'Candidate in scope' }, { runtime: h.runtime.info.id, sessionId: member.sessionId as never })
  await h.host.teamPlane.notify({ where: 'inbox', title: 'Candidate outside scope' }, { runtime: h.runtime.info.id, sessionId: loose.id })
  release()
  assert.equal((await replacement).ok, true)
  await peer.call('goal/list', {})
  const notifications = peer.messages.slice(before).filter(m => 'method' in m)
  assert.deepEqual(notifications.map(m => [m.method, m.params.notice?.title]), [['person/notice', 'Candidate in scope']])
})

test('a refused replacement retains notices raised during and after its baseline read', async t => {
  const { home, h, door } = await rig(t)
  const session = await h.host.call('session/create', { runtime: h.runtime.info.id, options: { cwd: home } })
  const peer = await Peer.open(door.socketPath)
  t.after(() => peer.socket.close())
  await peer.hello()
  assert.equal((await peer.call('client/subscribe', { topics: ['notices'] })).ok, true)
  const { entered, release } = holdNextGoalList(h.host)
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
  const { entered, release } = holdNextGoalList(h.host)
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
