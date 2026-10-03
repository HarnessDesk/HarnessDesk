import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { findDesks, resolveDesk, localTransport, canonicalProject, type DeskPointer } from '../src/node.js'
import { WireCallError } from '../src/index.js'

const rig = async () => {
  const directory = await fs.mkdtemp('/tmp/hd-door-')
  await fs.chmod(directory, 0o700)
  await fs.mkdir(join(directory, 'home'))
  const home = await fs.realpath(join(directory, 'home'))
  const hash = createHash('sha256').update(await fs.realpath(home)).digest('hex').slice(0, 16)
  const socketPath = join(directory, `${hash}.sock`)
  const pointerPath = join(directory, `${hash}.json`)
  const desk: DeskPointer = { home, pid: process.pid, startedAt: 1, hostVersion: '0.1.0', protocolVersion: 1, socketPath }
  const server = createServer()
  const sockets = new WebSocketServer({ noServer: true })
  const urls: (string | undefined)[] = []
  server.on('upgrade', (request, socket, head) => {
    urls.push(request.url)
    sockets.handleUpgrade(request, socket, head, ws => {
      ws.on('message', raw => {
        const request = JSON.parse(raw.toString())
        ws.send(JSON.stringify({ id: request.id, ok: true, result: [] }))
      })
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  await fs.chmod(socketPath, 0o600)
  const write = async (patch: Record<string, unknown> = {}) => fs.writeFile(pointerPath, JSON.stringify({ ...desk, socketPath: undefined, ...patch }), { mode: 0o600 })
  await write()
  return { directory, home, socketPath, pointerPath, desk, urls, write, env: { HARNESSDESK_CLIENT_DIR: directory },
    cleanup: async () => { for (const ws of sockets.clients) ws.terminate(); await new Promise<void>(resolve => sockets.close(() => server.close(() => resolve()))); await fs.rm(directory, { recursive: true, force: true }) } }
}

test('canonicalProject matches host realpath and resolve fallback for relative aliases', async t => {
  const directory = await fs.mkdtemp('/tmp/hd-door-'); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const { relative, resolve } = await import('node:path')
  const project = join(directory, 'project'); await fs.mkdir(project)
  const alias = join(directory, 'alias'); await fs.symlink(project, alias)
  assert.equal(await canonicalProject(relative(process.cwd(), alias)), await fs.realpath(project))
  const absent = relative(process.cwd(), join(directory, 'missing'))
  assert.equal(await canonicalProject(absent), resolve(absent))
})

test('findDesks reads live pointers without modifying them', async t => {
  const r = await rig(); t.after(r.cleanup)
  assert.deepEqual(await findDesks({ env: r.env }), [r.desk])
  assert.equal(await fs.readFile(r.pointerPath, 'utf8'), JSON.stringify({ ...r.desk, socketPath: undefined }))
})

test('dead pid and refused socket pointers are excluded, never deleted', async t => {
  const r = await rig(); t.after(r.cleanup)
  await r.write({ pid: 2_147_483_647 })
  assert.deepEqual(await findDesks({ env: r.env }), [])
  await r.write()
  await fs.rename(r.socketPath, `${r.socketPath}.moved`)
  assert.deepEqual(await findDesks({ env: r.env }), [])
  assert.ok(await fs.lstat(r.pointerPath))
  assert.ok(await fs.lstat(`${r.socketPath}.moved`))
})

test('resolveDesk respects explicit home, environment home and canonical aliases', async t => {
  const r = await rig(); t.after(r.cleanup)
  const alias = join(r.directory, 'home-alias')
  await fs.symlink(r.home, alias)
  assert.deepEqual(await resolveDesk({ home: alias, env: { ...r.env, HARNESSDESK_HOME: '/tmp/absent-demo-home' } }), r.desk)
  assert.deepEqual(await resolveDesk({ env: { ...r.env, HARNESSDESK_HOME: r.home } }), r.desk)
})

test('authoritative absent home errors name other live desks', async t => {
  const r = await rig(); t.after(r.cleanup)
  await assert.rejects(resolveDesk({ home: join(r.directory, 'absent'), env: r.env }), e => e instanceof WireCallError && e.code === 'noDesk' && e.message.includes(r.home))
})

test('unsafe directory mode and symlink are refused before any connection', async t => {
  const r = await rig(); t.after(r.cleanup)
  await fs.chmod(r.directory, 0o755)
  await assert.rejects(resolveDesk({ home: r.home, env: r.env }), e => e instanceof WireCallError && e.code === 'unsafeDirectory')
  await fs.chmod(r.directory, 0o700)
  const link = `${r.directory}-link`
  await fs.symlink(r.directory, link); t.after(() => fs.unlink(link))
  await assert.rejects(findDesks({ env: { HARNESSDESK_CLIENT_DIR: link } }), e => e instanceof WireCallError && e.code === 'unsafeDirectory')
  assert.equal(r.urls.length, 0)
})

test('unsafe socket mode, socket symlink and pointer modes are refused', async t => {
  const r = await rig(); t.after(r.cleanup)
  await fs.chmod(r.socketPath, 0o666)
  await assert.rejects(localTransport(r.desk), e => e instanceof WireCallError && e.code === 'unsafeSocket')
  await fs.chmod(r.socketPath, 0o600)
  await fs.chmod(r.pointerPath, 0o644)
  await assert.rejects(resolveDesk({ home: r.home, env: r.env }), e => e instanceof WireCallError && e.code === 'unsafePointer')
  await fs.chmod(r.pointerPath, 0o600)
  await fs.rename(r.socketPath, `${r.socketPath}.moved`)
  await fs.symlink(`${r.socketPath}.moved`, r.socketPath)
  await assert.rejects(localTransport(r.desk), e => e instanceof WireCallError && e.code === 'unsafeSocket')
})

test('localTransport uses the client WebSocket path on the unix socket', async t => {
  const r = await rig(); t.after(r.cleanup)
  const transport = await localTransport(r.desk)
  const response = new Promise(resolve => transport.onMessage(resolve))
  transport.send({ id: 1, method: 'goal/list', params: {} })
  assert.deepEqual(await response, { id: 1, ok: true, result: [] })
  assert.deepEqual(r.urls, ['/client'])
  const closed = new Promise<void>(resolve => transport.onClose(resolve))
  transport.close()
  await closed
})


for (const marker of ['HARNESSDESK_GOAL_ID', 'HARNESSDESK_LANE_ID']) {
  test(`the Node transport refuses spending from its own Seat (${marker}) before sending`, async t => {
    const r = await rig(); t.after(r.cleanup)
    // Extra arguments are ignored by the old transport: this regression fails
    // there without requiring a new type to exist before the implementation.
    const transport = await (localTransport as Function)(r.desk, { env: { [marker]: 'demo' } })
    const response = new Promise(resolve => transport.onMessage(resolve))
    transport.send({ id: 1, method: 'flow/catalog', params: { root: '/tmp/demo' } })
    await response
    assert.throws(() => transport.send({ id: 2, method: 'workspace/open', params: { path: '/tmp/demo' } }), e => e instanceof WireCallError && e.code === 'refused')
    transport.close()
  })
}
