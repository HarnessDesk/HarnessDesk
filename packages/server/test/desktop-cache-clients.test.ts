import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { itemId, turnId, type Session } from '@harnessdesk/protocol'
import WebSocket from 'ws'
import { Host, StateStore, serve, type RunningServer } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

// These are two independent authorized desktop WebSocket clients, not Electron windows.
class DesktopPeer {
  readonly messages: any[] = []
  private next = 0
  private pending = new Map<number, (value: any) => void>()
  constructor(readonly socket: WebSocket) {
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString())
      this.messages.push(message)
      if (typeof message.id === 'number') { this.pending.get(message.id)?.(message); this.pending.delete(message.id) }
    })
  }
  static async connect(server: RunningServer, token = server.token): Promise<DesktopPeer> {
    const socket = new WebSocket(`${server.url.replace('http:', 'ws:')}/ws?token=${token}`)
    const peer = new DesktopPeer(socket)
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    return peer
  }
  async call(method: string, params: unknown): Promise<any> {
    const id = ++this.next
    const reply = await new Promise<any>(resolve => { this.pending.set(id, resolve); this.socket.send(JSON.stringify({ id, method, params })) })
    assert.equal(reply.ok, true, JSON.stringify(reply.error))
    return reply.result
  }
  async close(): Promise<void> {
    await new Promise<void>(resolve => { this.socket.once('close', () => resolve()); this.socket.close() })
  }
}

function sessionFrames(peer: DesktopPeer, id: string): any[] {
  return peer.messages.flatMap(message => {
    if (message.method === 'session/cache-invalidated' && message.params.sessionId === id)
      return [{ method: message.method, watermark: message.params.watermark }]
    if (message.method === 'event') {
      const event = message.params.event
      if ((event.type === 'session/started' ? event.session.id : event.type === 'approval/requested' ? event.approval.sessionId : event.sessionId) === id)
        return [{ method: message.method, type: event.type, watermark: message.params.transcriptFence }]
    }
    return []
  })
}

test('two authorized desktop sockets receive independent contiguous session fences and can reconnect', async t => {
  const dir = tempDir('hd-desktop-cache-clients-')
  await writeFile(join(dir, 'index.html'), '<html>test</html>')
  const host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')), builtinAgents: dir, catalogRefreshMs: 0 })
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const server = await serve({ host, logger: silent, uiRoot: dir, port: 0 })
  const peers: DesktopPeer[] = []
  t.after(async () => { for (const peer of peers) peer.socket.terminate(); await server.close(); await host.dispose() })
  await assert.rejects(DesktopPeer.connect(server, 'wrong-token'), /401/)
  const a = await DesktopPeer.connect(server); peers.push(a)
  const b = await DesktopPeer.connect(server); peers.push(b)
  const one = await a.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } }) as Session
  const two = await b.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } }) as Session
  const addr = (session: Session) => ({ runtime: session.runtime, sessionId: session.id })
  const turn = { id: turnId('synthetic-turn'), status: 'inProgress' as const, items: [] }
  runtime.emit({ type: 'turn/started', sessionId: one.id, turn })
  runtime.emit({ type: 'item/completed', sessionId: one.id, turnId: turn.id, item: { id: itemId('synthetic-item'), type: 'assistantMessage', text: 'synthetic saved body' } })
  runtime.emit({ type: 'turn/completed', sessionId: one.id, turn: { ...turn, status: 'completed' } })
  await a.call('session/cache-snapshot', addr(one))
  const oneBeforeOtherChange = sessionFrames(a, one.id).length
  const recordTwo = host.registry.get(two.runtime, two.id)!
  recordTwo.session = { ...recordTwo.session, title: 'independent synthetic change' }
  await a.call('session/cache-snapshot', addr(one))
  await b.call('session/cache-snapshot', addr(one))
  assert.equal(sessionFrames(a, one.id).length, oneBeforeOtherChange, 'the other session does not advance this session')
  for (const session of [one, two]) {
    const left = sessionFrames(a, session.id), right = sessionFrames(b, session.id)
    assert.deepEqual(left, right)
    assert.ok(left.some(frame => frame.method === 'event'))
    assert.ok(left.some(frame => frame.method === 'session/cache-invalidated'))
    for (const [index, frame] of left.entries()) {
      assert.ok(frame.watermark && Number.isSafeInteger(frame.watermark.sequence), `missing fence for ${frame.method}`)
      if (index) assert.equal(frame.watermark.sequence, left[index - 1]!.watermark.sequence + 1)
    }
  }
  assert.notEqual(sessionFrames(a, one.id)[0]!.watermark.generation, sessionFrames(a, two.id)[0]!.watermark.generation)
  await a.call('session/close', addr(one))
  let sourceReads = 0
  runtime.readSession = async () => { sourceReads++; throw new Error('cache read must not reopen the agent') }
  const snapshot = await b.call('session/cache-snapshot', addr(one))
  assert.ok(snapshot)
  assert.equal(snapshot.session.turns[0].items[0].text, 'synthetic saved body')
  const receipt = await b.call('session/prepare-eviction', { ...addr(one), identity: snapshot.identity })
  assert.ok(receipt)
  assert.equal(receipt.sequence, snapshot.watermark.sequence)
  assert.equal(receipt.generation, snapshot.watermark.generation)
  assert.equal(sourceReads, 0)
  await a.close()
  const before = sessionFrames(b, two.id).length
  recordTwo.session = { ...recordTwo.session, title: 'surviving client change' }
  await b.call('session/cache-snapshot', addr(two))
  assert.ok(sessionFrames(b, two.id).length > before)
  const reconnect = await DesktopPeer.connect(server); peers.push(reconnect)
  const reloaded = await reconnect.call('session/cache-snapshot', addr(one))
  const sync = reconnect.messages.find(message => message.method === 'sync')
  assert.ok(sync && sync.params.sessions.some((session: Session) => session.id === one.id))
  assert.deepEqual(reloaded, snapshot)
  assert.equal(sourceReads, 0)
})
