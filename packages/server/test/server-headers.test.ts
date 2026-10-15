import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import WebSocket from 'ws'

import { Host, StateStore, serve, type RunningServer } from '../src/index.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

const start = async (t: TestContext, allowedOrigins?: readonly string[]) => {
  const dir = tempDir('hd-server-headers-')
  await writeFile(join(dir, 'index.html'), '<html>app shell</html>')
  await writeFile(join(dir, 'bundle.js'), 'export {}')
  const host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')) })
  await host.start()
  const server = await serve({ host, logger: silent, uiRoot: dir, port: 0, allowedOrigins })
  t.after(async () => {
    await server.close()
    await host.dispose()
  })
  return { server, host, dir }
}

const httpRequest = (
  server: RunningServer,
  path: string,
  headers: Record<string, string | string[]> = {},
  method = 'GET',
): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
  const rawHeaders = Object.entries({ Host: `127.0.0.1:${server.port}`, ...headers }).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).flatMap((entry) => [name, entry]))
  const req = request(`${server.url}${path}`, { method, headers: rawHeaders }, (res) => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => { body += chunk })
    res.on('end', () => resolve({ status: res.statusCode!, body }))
    res.on('error', reject)
  })
  req.on('upgrade', (res, socket) => {
    socket.destroy()
    resolve({ status: res.statusCode!, body: '' })
  })
  req.on('error', reject)
  req.end()
})

const connect = (server: RunningServer, headers: Record<string, string | string[]> = {}, token = server.token): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`${server.url.replace('http:', 'ws:')}/ws?token=${token}`, {
      headers,
      handshakeTimeout: 2000,
    })
    socket.on('error', reject)
    socket.once('open', () => socket.close())
    socket.once('close', () => resolve())
  })

test('HTTP checks Host before serving any route, even with the launch token', async (t) => {
  const { server } = await start(t)
  for (const host of ['acme.dev', `acme.dev:${server.port}`, '127.0.0.1', 'localhost', '127.0.0.1:0', `127.0.0.1:${server.port}.acme.dev`]) {
    for (const path of ['/healthz', `/?token=${server.token}`, '/bundle.js', '/preview-frame?ticket=unused']) {
      const res = await httpRequest(server, path, { Host: host })
      assert.equal(res.status, 403, `${host} on ${path}`)
      assert.equal(res.body, 'Forbidden')
    }
  }
})

test('HTTP accepts both names with the bound port and keeps the token gate', async (t) => {
  const { server } = await start(t)
  for (const name of ['127.0.0.1', 'localhost']) {
    const headers = { Host: `${name}:${server.port}` }
    assert.equal((await httpRequest(server, '/healthz', headers)).status, 200)
    assert.equal((await httpRequest(server, '/', headers)).status, 401)
    assert.equal((await httpRequest(server, `/?token=${server.token}`, headers)).body, '<html>app shell</html>')
    assert.equal((await httpRequest(server, '/bundle.js', headers)).status, 200)
  }
})

test('the upgrade checks Host even with the launch token', async (t) => {
  const { server } = await start(t)
  for (const host of ['acme.dev', `acme.dev:${server.port}`, '127.0.0.1', '127.0.0.1:0']) {
    await assert.rejects(connect(server, { Host: host }), /socket hang up/)
  }
})

test('the upgrade refuses foreign and non-origin values', async (t) => {
  const { server } = await start(t)
  for (const origin of ['http://acme.dev', 'null', '', `${server.url}/`, `${server.url}/page`, `${server.url} http://acme.dev`, 'http://127.0.0.1:0', server.url.replace('http:', 'https:')]) {
    await assert.rejects(connect(server, { Origin: origin }), /socket hang up/)
  }
})

test('the upgrade accepts either own origin or no Origin with a valid token', async (t) => {
  const { server } = await start(t)
  for (const name of ['127.0.0.1', 'localhost']) {
    const Host = `${name}:${server.port}`
    await connect(server, { Host, Origin: `http://${Host}` })
    await connect(server, { Host })
    await assert.rejects(connect(server, { Host, Origin: `http://${Host}` }, 'wrong-token'), /401/)
    await assert.rejects(connect(server, { Host }, ''), /401/)
  }
})

test('a dev origin is accepted only when explicitly configured', async (t) => {
  const origin = 'http://127.0.0.1:5273'
  const { server } = await start(t)
  await assert.rejects(connect(server, { Origin: origin }), /socket hang up/)
  const { server: configured } = await start(t, [origin])
  await connect(configured, { Origin: origin })
  await assert.rejects(connect(configured, { Origin: 'http://localhost:5273' }), /socket hang up/)
  await assert.rejects(connect(configured, { Origin: origin, Host: `acme.dev:${configured.port}` }), /socket hang up/)
  await assert.rejects(connect(configured, { Origin: origin }, 'wrong-token'), /401/)
})

test('HTTP checks Origin on state-changing methods', async (t) => {
  const { server } = await start(t)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await httpRequest(server, `/?token=${server.token}`, { Origin: 'http://acme.dev' }, method)).status, 403, method)
    assert.equal((await httpRequest(server, `/?token=${server.token}`, { Origin: server.url }, method)).status, 200, method)
    assert.equal((await httpRequest(server, `/?token=${server.token}`, {}, method)).status, 200, method)
    assert.equal((await httpRequest(server, '/', {}, method)).status, 401, method)
  }
  assert.equal((await httpRequest(server, '/bundle.js', { Origin: 'http://acme.dev' })).status, 200)
  const origin = 'http://127.0.0.1:5273'
  const { server: configured } = await start(t, [origin])
  assert.equal((await httpRequest(configured, `/?token=${configured.token}`, { Origin: origin }, 'POST')).status, 200)
})

test('a refused HTTP request leaves the preview ticket available', async (t) => {
  const { server, host, dir } = await start(t)
  await host.call('workspace/open', { path: dir })
  const { ticket } = await host.call('preview/ticket', { path: join(dir, 'index.html') })
  const path = `/preview-frame?ticket=${encodeURIComponent(ticket)}`
  assert.equal((await httpRequest(server, path, { Host: `acme.dev:${server.port}` })).status, 403)
  assert.equal((await httpRequest(server, path, { Origin: 'http://acme.dev' }, 'POST')).status, 403)
  assert.equal((await httpRequest(server, path)).body, '<html>app shell</html>')
})

test('HTTP and the upgrade refuse repeated Host or Origin headers', async (t) => {
  const { server } = await start(t)
  const repeatedHost = { Host: [`127.0.0.1:${server.port}`, 'acme.dev'] }
  assert.equal((await httpRequest(server, '/healthz', repeatedHost)).status, 403)
  await assert.rejects(httpRequest(server, `/ws?token=${server.token}`, {
    ...repeatedHost,
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
  }), /socket hang up/)
  const repeatedOrigin = { Origin: [server.url, 'http://acme.dev'] }
  assert.equal((await httpRequest(server, '/healthz', repeatedOrigin, 'POST')).status, 403)
  await assert.rejects(connect(server, repeatedOrigin), /socket hang up/)
})
