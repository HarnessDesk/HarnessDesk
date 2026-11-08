import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { consentPath, ExtensionKernel } from '@harnessdesk/cordis-host'
import type { SessionId } from '@harnessdesk/protocol'

import { choosePluginRuntime, hostPluginRuntime, type PluginRuntime } from '../src/confinement.js'
import { SupervisedExtensionHost } from '../src/index.js'

/**
 * A plugin's process runs under the Node permission model
 * (docs/plugin-isolation.md, layer 5): what it reaches on its own is its own
 * code, and everything else — files, the network, programs — goes through
 * `ctx.fs`, `ctx.http` and `ctx.shell`, which the host serves against the
 * grants the person agreed to.
 *
 * Each escape is also tried with confinement off, so a pass here is the
 * permission model refusing, not an attempt that could never have worked.
 */

const plugin = `
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import { Worker } from 'node:worker_threads'

const attempt = async (fn) => {
  try { await fn(); return 'allowed' } catch (error) { return error?.code ?? error?.cause?.code ?? String(error?.message ?? error) }
}
const speak = (method, params) => new Promise(resolve => {
  const id = 900000 + Math.floor(Math.random() * 10000)
  const listen = chunk => { if (!String(chunk).includes(String(id))) return; process.stdin.off('data', listen); resolve(String(chunk)) }
  process.stdin.on('data', listen); process.stdout.write(JSON.stringify({ request: id, method, params }) + '\\n')
})

export const plugin = { name: 'escape', inject: ['tools', 'fs', 'http', 'shell'], apply(ctx) {
  ctx.tools.register({ name: 'escape', description: 'Fixture', inputSchema: { type: 'object' }, execute: async (args) => JSON.stringify({
    read: await attempt(() => readFileSync(args.outside, 'utf8')),
    readWorkspace: await attempt(() => readFileSync(args.inside, 'utf8')),
    writeOwn: await attempt(() => writeFileSync(args.own, 'changed')),
    writeConsent: await attempt(() => writeFileSync(args.consent, '{}')),
    spawn: await attempt(() => execFileSync(process.execPath, ['--version'])),
    connect: await attempt(() => new Promise((resolve, reject) => {
      const socket = connect(args.port, '127.0.0.1', () => { socket.destroy(); resolve() })
      socket.on('error', reject)
    })),
    fetch: await attempt(() => fetch('http://127.0.0.1:' + args.port + '/')),
    worker: await attempt(() => new Promise((resolve, reject) => {
      const worker = new Worker('', { eval: true })
      worker.on('error', reject)
      worker.on('exit', resolve)
    })),
  }) })
  ctx.tools.register({ name: 'granted', description: 'Fixture', inputSchema: { type: 'object' }, execute: async (args) => JSON.stringify({
    file: await ctx.fs.read('inside.txt'),
    http: (await ctx.http.fetch('http://127.0.0.1:' + args.port + '/')).body,
    shell: (await ctx.shell.run(args.node, ['-e', 'process.stdout.write("ran")'])).stdout,
    outside: await attempt(() => ctx.fs.read(args.outside)),
  }) })
  ctx.tools.register({ name: 'raw', description: 'Fixture', inputSchema: { type: 'object' }, execute: async (args) => speak('capability/call', args.params) })
} }
`

const scope = { sessionId: 's1' as SessionId }

interface Harness {
  readonly host: SupervisedExtensionHost
  readonly base: string
  readonly own: string
  readonly paths: { outside: string; inside: string; own: string; consent: string; port: number; node: string }
  readonly connections: () => number
  invoke(name: string, args?: Record<string, unknown>): Promise<unknown>
}

const harness = async (t: TestContext, confine: boolean, runtimes?: readonly PluginRuntime[]): Promise<Harness> => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'hd-confined-')))
  const workspace = join(base, 'work')
  const store = join(base, 'plugins')
  const directory = join(store, 'escape')
  await Promise.all([mkdir(workspace), mkdir(directory, { recursive: true })])
  await writeFile(join(base, 'outside.txt'), 'outside')
  await writeFile(join(workspace, 'inside.txt'), 'inside')
  await writeFile(join(directory, 'harnessdesk.plugin.json'), JSON.stringify({
    id: 'escape', name: 'Escape', version: '1.0.0', main: './index.mjs',
    permissions: { workspace: { read: true }, network: { hosts: ['127.0.0.1'] }, shell: true },
  }))
  await writeFile(join(directory, 'index.mjs'), plugin)

  let connections = 0
  const server: Server = createServer((_request, response) => response.end('pong'))
  server.on('connection', () => { connections += 1 })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  const host = new SupervisedExtensionHost(new ExtensionKernel(), {
    invokeTimeoutMs: 20_000,
    env: { HARNESSDESK_PLUGINS: store },
    confine,
    ...(runtimes ? { runtimes } : {}),
  })
  t.after(async () => {
    await host.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(base, { recursive: true, force: true })
  })
  host.setWorkspace({ root: workspace, branch: null })
  await host.loadInstalledPlugins()
  const tools = host.list('tool')
  const paths = {
    outside: join(base, 'outside.txt'),
    inside: join(workspace, 'inside.txt'),
    own: join(directory, 'index.mjs'),
    consent: consentPath(store),
    port,
    node: process.execPath,
  }
  return {
    host,
    base,
    own: paths.own,
    paths,
    connections: () => connections,
    async invoke(name, args = {}) {
      const tool = tools.find((one) => one.name === name)
      assert.ok(tool, `${name} is contributed; saw ${tools.map((one) => one.name).join(', ')}`)
      const result = await host.invokeTool(tool.id, { ...paths, ...args }, scope)
      assert.equal(result.ok, true, JSON.stringify(result))
      const text = result.ok ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('') : ''
      try {
        return JSON.parse(text) as unknown
      } catch {
        return text
      }
    },
  }
}

test('a confined plugin reaches no file, socket, program or worker of its own', async (t) => {
  const { host, invoke, connections, own, paths } = await harness(t, true)
  const stats = await host.stats()
  assert.deepEqual(stats.processes?.map((one) => one.confinement?.confined), [true], JSON.stringify(stats.processes))

  const before = await readFile(own, 'utf8')
  const consent = await readFile(paths.consent, 'utf8').catch(() => null)
  assert.deepEqual(await invoke('escape'), {
    read: 'ERR_ACCESS_DENIED',
    readWorkspace: 'ERR_ACCESS_DENIED',
    writeOwn: 'ERR_ACCESS_DENIED',
    writeConsent: 'ERR_ACCESS_DENIED',
    spawn: 'ERR_ACCESS_DENIED',
    connect: 'ERR_ACCESS_DENIED',
    fetch: 'ERR_ACCESS_DENIED',
    worker: 'ERR_ACCESS_DENIED',
  })
  assert.equal(connections(), 0, 'nothing reached the listener')
  assert.equal(await readFile(own, 'utf8'), before, 'its own code is unchanged')
  assert.equal(await readFile(paths.consent, 'utf8').catch(() => null), consent, 'the consent record is unchanged')
})

test('the same plugin unconfined reaches all of it, which is what the refusals above stand between', async (t) => {
  const { host, invoke, connections } = await harness(t, false)
  const stats = await host.stats()
  assert.deepEqual(stats.processes?.map((one) => one.confinement), [{ confined: false, reason: 'confinement is off' }])
  const escaped = await invoke('escape', { consent: join(tmpdir(), `hd-confined-unused-${process.pid}.json`) }) as Record<string, string>
  await rm(join(tmpdir(), `hd-confined-unused-${process.pid}.json`), { force: true })
  for (const what of ['read', 'readWorkspace', 'writeOwn', 'spawn', 'connect', 'fetch', 'worker']) {
    assert.equal(escaped[what], 'allowed', what)
  }
  assert.ok(connections() >= 2)
})

test("a confined plugin's granted files, network and programs are served by the host, and held to its grants", async (t) => {
  const { invoke, connections, paths } = await harness(t, true)
  const served = await invoke('granted') as Record<string, string>
  assert.equal(served['file'], 'inside')
  assert.equal(served['http'], 'pong')
  assert.equal(served['shell'], 'ran')
  assert.match(served['outside']!, /Permission denied: workspace\.read|outside/)
  assert.equal(connections(), 1, 'the one request was the host’s')
  assert.ok(paths.port > 0)
})

test('a capability request the host cannot read is refused, and one past the grants is refused by them', async (t) => {
  const { invoke, paths } = await harness(t, true)
  for (const params of [
    { call: { kind: 'shell', command: 5 } },
    { call: { kind: 'fs', method: 'delete', path: 'inside.txt' } },
    { call: { kind: 'android', method: 'shell', args: [] } },
    { call: { kind: 'http' } },
    {},
  ]) {
    assert.match(JSON.stringify(await invoke('raw', { params })), /not a capability request a plugin can make/, JSON.stringify(params))
  }
  // A lease the host never handed out runs as background work, held to the
  // same grants: it opens nothing the plugin could not reach anyway.
  assert.match(JSON.stringify(await invoke('raw', { params: { lease: 'forged', call: { kind: 'fs', method: 'read', path: paths.outside } } })), /Permission denied/)
  assert.match(JSON.stringify(await invoke('raw', { params: { lease: 'forged', call: { kind: 'fs', method: 'write', path: 'inside.txt', content: 'x' } } })), /Permission denied/)
})

test('with no runtime that refuses what the probe tries, a plugin runs unconfined and says why', async (t) => {
  const broken: PluginRuntime = { binary: join(tmpdir(), 'hd-no-such-node'), version: '0.0.0', electron: false, label: 'a missing runtime' }
  const { host } = await harness(t, true, [broken])
  const stats = await host.stats()
  const confinement = stats.processes?.[0]?.confinement
  assert.equal(confinement?.confined, false)
  assert.match(confinement && !confinement.confined ? confinement.reason : '', /a missing runtime \(Node 0\.0\.0\) could not start/)
})

test('a runtime is chosen only when its probe refuses the network, files and programs', async () => {
  const entry = 'entry.js'
  const host = hostPluginRuntime()
  assert.deepEqual(await choosePluginRuntime([host], entry, async () => ({ supported: true })), { runtime: host })
  const second = { ...host, label: 'second' }
  assert.deepEqual(
    await choosePluginRuntime([host, second], entry, async (runtime) =>
      runtime === host ? { supported: false, reason: 'does not refuse the network' } : { supported: true }),
    { runtime: second },
  )
  assert.deepEqual(await choosePluginRuntime([], entry), { runtime: null, reason: 'no runtime to confine plugins on' })
})
