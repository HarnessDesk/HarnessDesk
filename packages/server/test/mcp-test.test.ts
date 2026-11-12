import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { McpTestResult } from '@harnessdesk/protocol'

import { MCP_TEST_MAX_IN_FLIGHT, McpConnectionTests, mcpSecretMask, mcpTestEnvironment } from '../src/mcp-test.js'
import { libraryMethods } from '../src/methods/library.js'
import type { HostContext } from '../src/methods/context.js'

/**
 * Test connection against scripted fakes only: a stdio fixture
 * (`fixtures/fake-mcp-probe.mjs`) and HTTP servers on loopback. No real MCP
 * server and no configuration from this machine is ever read — `home` and
 * the project are temporary folders.
 */

const PROBE = fileURLToPath(new URL('./fixtures/fake-mcp-probe.mjs', import.meta.url))
const SECRET = 'probe-secret-0123456789abcdef' // hd-secrets-ok: a planted marker the tests look for, not a credential

const fixture = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hd-mcp-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const project = join(root, 'project')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  const user = async (servers: Record<string, unknown>) =>
    writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: servers }))
  const shared = async (servers: Record<string, unknown>) =>
    writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: servers }))
  return { root, home, project, user, shared, userFile: join(home, '.claude.json'), projectFile: join(project, '.mcp.json') }
}

const probe = (env: Record<string, string>) => ({ command: process.execPath, args: [PROBE], env })

const failed = (result: McpTestResult) => {
  assert.equal(result.ok, false)
  return result as Extract<McpTestResult, { ok: false }>
}

test('a user server answers: tools are counted across every page', async (t) => {
  const f = await fixture(t)
  await f.user({ probe: probe({ PROBE_TOOLS: '4', PROBE_PAGES: '3' }) })
  const tests = new McpConnectionTests({ home: f.home })
  const result = await tests.test({ name: 'probe', path: f.userFile })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.ok)
  assert.equal(result.tools, 12)
  assert.equal(result.serverName, 'probe')
  assert.equal(result.serverVersion, '1.2.3')
  assert.ok(result.ms >= 0)
})

test('a project server is shown before it runs, and runs in the project once confirmed', async (t) => {
  const f = await fixture(t)
  const cwdFile = join(f.root, 'cwd.txt')
  await f.shared({ probe: probe({ PROBE_CWD_FILE: cwdFile, PROBE_SECRET: SECRET }) })
  const tests = new McpConnectionTests({ home: f.home })

  const asked = failed(await tests.test({ name: 'probe', path: f.projectFile, cwd: f.project }))
  assert.equal(asked.reason, 'confirm')
  assert.ok(asked.reason === 'confirm')
  assert.deepEqual(asked.target, {
    transport: 'stdio',
    scope: 'project',
    command: process.execPath,
    args: [PROBE],
    cwd: f.project,
    launchEnv: [],
    envNames: ['PROBE_CWD_FILE', 'PROBE_SECRET'],
  })
  assert.ok(!JSON.stringify(asked).includes(SECRET), 'a variable value is never in the answer')
  assert.equal(existsSync(cwdFile), false, 'nothing ran before the confirmation')

  // A digest the person was not shown runs nothing.
  assert.equal(failed(await tests.test({ name: 'probe', path: f.projectFile, cwd: f.project, confirmed: 'stale' })).reason, 'confirm')
  assert.equal(existsSync(cwdFile), false)

  const ran = await tests.test({ name: 'probe', path: f.projectFile, cwd: f.project, confirmed: asked.digest })
  assert.equal(ran.ok, true, JSON.stringify(ran))
  assert.equal(await readFile(cwdFile, 'utf8'), f.project)

  // The file changed after the person looked: it asks again.
  await f.shared({ probe: probe({ PROBE_CWD_FILE: cwdFile, PROBE_SECRET: 'something-else-now' }) })
  assert.equal(failed(await tests.test({ name: 'probe', path: f.projectFile, cwd: f.project, confirmed: asked.digest })).reason, 'confirm')
})

test('a project server’s launch variables are shown with their values, every other variable by name', async (t) => {
  const f = await fixture(t)
  await f.shared({
    probe: probe({
      PATH: '/opt/tools/bin:/usr/bin',
      NODE_OPTIONS: '--require ./preload.js',
      LD_PRELOAD: './libhook.so',
      pythonpath: './vendor',
      PIP_INDEX_URL: 'https://jane:index-pass-0123@pypi.example.com/simple',
      PROBE_SECRET: SECRET,
    }),
  })
  const asked = failed(await new McpConnectionTests({ home: f.home }).test({ name: 'probe', path: f.projectFile, cwd: f.project }))
  assert.ok(asked.reason === 'confirm' && asked.target.transport === 'stdio')
  assert.deepEqual(asked.target.launchEnv, [
    { name: 'LD_PRELOAD', value: './libhook.so' },
    { name: 'NODE_OPTIONS', value: '--require ./preload.js' },
    { name: 'PATH', value: '/opt/tools/bin:/usr/bin' },
    { name: 'PIP_INDEX_URL', value: 'https://•••@pypi.example.com/simple' },
    { name: 'pythonpath', value: './vendor' },
  ])
  assert.deepEqual(asked.target.envNames, ['PROBE_SECRET'])
  assert.ok(!JSON.stringify(asked).includes(SECRET))
  assert.ok(!JSON.stringify(asked).includes('index-pass-0123'))
})

test('a server that never answers times out', async (t) => {
  const f = await fixture(t)
  await f.user({ probe: probe({ PROBE_MODE: 'hang' }) })
  const tests = new McpConnectionTests({ home: f.home, timeoutMs: 400 })
  const result = failed(await tests.test({ name: 'probe', path: f.userFile }))
  assert.equal(result.reason, 'timeout')
  assert.match(result.detail, /initialize/)
})

test('an argument is masked in what the server prints; a short one is not', async (t) => {
  const f = await fixture(t)
  await f.user({ probe: { command: process.execPath, args: [PROBE, '-y', '.', '--token=arg-value-0123456789'], env: { PROBE_MODE: 'crash' } } })
  const result = failed(await new McpConnectionTests({ home: f.home }).test({ name: 'probe', path: f.userFile }))
  assert.equal(result.reason, 'spawnFailed')
  assert.match(result.stderr ?? '', /argv: -y \. •••/)
  assert.ok(!JSON.stringify(result).includes('arg-value-0123456789'))
})

test('the mask covers variable and header values, arguments, the URL, its user name, password and query values', () => {
  const mask = mcpSecretMask({
    name: 'web',
    transport: 'http',
    url: 'https://jane:url-pw-1@mcp.example.com/v1?key=query-value-0123&mode=full', // hd-secrets-ok: a placeholder the mask test plants
    headers: { authorization: 'Bearer header-token-0123456789' },
    env: { SHORT: 'abcd' },
  })
  const said = mask('jane url-pw-1 query-value-0123 header-token-0123456789 abcd full https://jane:url-pw-1@mcp.example.com/v1?key=query-value-0123&mode=full') // hd-secrets-ok: a placeholder the mask test plants
  assert.equal(said, '••• ••• ••• ••• ••• full •••')
  // Arguments: from eight characters, and a `--flag=value` by its value too; never `.` or `-y`.
  const args = mcpSecretMask({ name: 'srv', transport: 'stdio', command: 'npx', args: ['-y', '.', 'srv', '--key=arg-value-0123'] })
  assert.equal(args('npx -y . srv --key=arg-value-0123 / arg-value-0123'), 'npx -y . srv ••• / •••')
})

test('a proxy the desk passes on loses its user name and password; the server’s own proxy is passed as written', () => {
  const env = mcpTestEnvironment(
    { name: 'x', transport: 'stdio', command: 'x', env: { ALL_PROXY: 'socks5://own:own-pass@proxy.example.com:1080' } },
    {
      PATH: '/usr/bin',
      HTTP_PROXY: 'http://jane:proxy-pass@proxy.example.com:8080',
      https_proxy: 'jane:proxy-pass@proxy.example.com:3128', // hd-secrets-ok: a placeholder the mask test plants
      HTTPS_PROXY: 'http://proxy.example.com:3128',
      NO_PROXY: 'localhost',
    },
  )
  assert.equal(env['HTTP_PROXY'], 'http://proxy.example.com:8080')
  assert.equal(env['https_proxy'], 'proxy.example.com:3128')
  assert.equal(env['HTTPS_PROXY'], 'http://proxy.example.com:3128')
  assert.equal(env['NO_PROXY'], 'localhost')
  assert.equal(env['ALL_PROXY'], 'socks5://own:own-pass@proxy.example.com:1080')
  assert.ok(!Object.values(env).some((value) => value?.includes('proxy-pass')))
})

test('a crash is spawnFailed, with its stderr tail and the secret masked', async (t) => {
  const f = await fixture(t)
  await f.user({ probe: probe({ PROBE_MODE: 'crash', PROBE_SECRET: SECRET }) })
  const result = failed(await new McpConnectionTests({ home: f.home }).test({ name: 'probe', path: f.userFile }))
  assert.equal(result.reason, 'spawnFailed')
  assert.match(result.detail, /exited \(code 3\)/)
  assert.match(result.stderr ?? '', /fatal: token ••• rejected/)
  assert.ok(!JSON.stringify(result).includes(SECRET))
})

test('stdout that is not JSON-RPC is a protocol failure', async (t) => {
  const f = await fixture(t)
  await f.user({ probe: probe({ PROBE_MODE: 'badjson' }) })
  const result = failed(await new McpConnectionTests({ home: f.home }).test({ name: 'probe', path: f.userFile }))
  assert.equal(result.reason, 'protocol')
  assert.match(result.detail, /not JSON-RPC: Server ready/)
})

test('an error answer is a protocol failure that never repeats a variable value', async (t) => {
  const f = await fixture(t)
  await f.user({ probe: probe({ PROBE_MODE: 'error', PROBE_SECRET: SECRET }) })
  const result = failed(await new McpConnectionTests({ home: f.home }).test({ name: 'probe', path: f.userFile }))
  assert.equal(result.reason, 'protocol')
  assert.match(result.detail, /bad key •••/)
  assert.ok(!JSON.stringify(result).includes(SECRET))
})

test('the command gets a minimal environment plus its own variables, never the desk’s', async (t) => {
  const f = await fixture(t)
  const envFile = join(f.root, 'env.txt')
  await f.user({ probe: probe({ PROBE_ENV_FILE: envFile, CONFIGURED: 'yes' }) })
  const tests = new McpConnectionTests({
    home: f.home,
    baseEnv: { PATH: process.env['PATH'] ?? '/usr/bin', HOME: f.home, HD_TOKEN: 'x', HARNESSDESK_HOME: '/x', OPENAI_API_KEY: 'x' },
  })
  assert.equal((await tests.test({ name: 'probe', path: f.userFile })).ok, true)
  const names = (await readFile(envFile, 'utf8')).split('\n')
  for (const name of ['PATH', 'HOME', 'CONFIGURED', 'PROBE_ENV_FILE']) assert.ok(names.includes(name), name)
  for (const name of ['HD_TOKEN', 'HARNESSDESK_HOME', 'OPENAI_API_KEY']) assert.ok(!names.includes(name), name)
})

test('the whole process group is gone after the test, a SIGTERM-proof grandchild included', async (t) => {
  const f = await fixture(t)
  const pidFile = join(f.root, 'pid.txt')
  await f.user({ probe: probe({ PROBE_MODE: 'grandchild', PROBE_PID_FILE: pidFile }) })
  const result = await new McpConnectionTests({ home: f.home }).test({ name: 'probe', path: f.userFile })
  assert.equal(result.ok, true, JSON.stringify(result))
  const pid = Number(await readFile(pidFile, 'utf8'))
  assert.ok(pid > 0)
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (let waited = 0; alive() && waited < 3_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50))
  if (alive()) process.kill(pid, 'SIGKILL')
  assert.equal(alive(), false, 'the grandchild outlived the test')
})

test('a command that does not exist is spawnFailed', async (t) => {
  const f = await fixture(t)
  await f.user({ probe: { command: 'hd-no-such-command-xyz' } })
  const result = failed(await new McpConnectionTests({ home: f.home }).test({ name: 'probe', path: f.userFile }))
  assert.equal(result.reason, 'spawnFailed')
  assert.match(result.detail, /no such command/)
})

test('only declarations in known files are found', async (t) => {
  const f = await fixture(t)
  await f.user({ probe: probe({}) })
  const tests = new McpConnectionTests({ home: f.home })
  const stray = join(f.root, 'elsewhere.json')
  await writeFile(stray, JSON.stringify({ mcpServers: { probe: probe({}) } }))
  assert.equal(failed(await tests.test({ name: 'probe', path: stray })).reason, 'notFound')
  assert.equal(failed(await tests.test({ name: 'absent', path: f.userFile })).reason, 'notFound')
  // A project file is only a project file with its project named.
  await f.shared({ probe: probe({}) })
  assert.equal(failed(await tests.test({ name: 'probe', path: f.projectFile })).reason, 'notFound')
})

test('one test per server at a time', async (t) => {
  const f = await fixture(t)
  await f.user({ probe: probe({ PROBE_MODE: 'hang' }) })
  const tests = new McpConnectionTests({ home: f.home, timeoutMs: 600 })
  const first = tests.test({ name: 'probe', path: f.userFile })
  const second = failed(await tests.test({ name: 'probe', path: f.userFile }))
  assert.equal(second.reason, 'busy')
  assert.equal(failed(await first).reason, 'timeout')
})

test('no more than the cap run at once, across servers', async (t) => {
  const f = await fixture(t)
  const names = Array.from({ length: MCP_TEST_MAX_IN_FLIGHT + 1 }, (_, i) => `probe${i}`)
  await f.user(Object.fromEntries(names.map((name) => [name, probe({ PROBE_MODE: 'hang' })])))
  const tests = new McpConnectionTests({ home: f.home, timeoutMs: 800 })
  const started = names.slice(0, MCP_TEST_MAX_IN_FLIGHT).map((name) => tests.test({ name, path: f.userFile }))
  const refused = failed(await tests.test({ name: names.at(-1) ?? '', path: f.userFile }))
  assert.equal(refused.reason, 'busy')
  assert.match(refused.detail, new RegExp(`${MCP_TEST_MAX_IN_FLIGHT} tests are already running`))
  for (const result of await Promise.all(started)) assert.equal(failed(result).reason, 'timeout')
  // One finished, so one more may start.
  assert.equal(failed(await tests.test({ name: names.at(-1) ?? '', path: f.userFile })).reason, 'timeout')
})

test('dispose stops a running server’s group at once, and no test starts after it', async (t) => {
  const f = await fixture(t)
  const pidFile = join(f.root, 'self.txt')
  await f.user({ probe: probe({ PROBE_MODE: 'hang', PROBE_SELF_PID_FILE: pidFile }) })
  const tests = new McpConnectionTests({ home: f.home, timeoutMs: 20_000 })
  const running = tests.test({ name: 'probe', path: f.userFile })
  for (let waited = 0; !existsSync(pidFile) && waited < 5_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20))
  const pid = Number(await readFile(pidFile, 'utf8'))
  assert.ok(pid > 0)
  const before = Date.now()
  tests.dispose()
  const result = failed(await running)
  assert.ok(Date.now() - before < 5_000, 'the test ended with the desk, not at its deadline')
  assert.notEqual(result.reason, 'busy')
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (let waited = 0; alive() && waited < 2_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50))
  if (alive()) process.kill(pid, 'SIGKILL')
  assert.equal(alive(), false, 'the server outlived dispose')
  const after = failed(await tests.test({ name: 'probe', path: f.userFile }))
  assert.equal(after.reason, 'busy')
  assert.match(after.detail, /stopping/)
})

test('the wire method takes an identity, never a command', async (t) => {
  const f = await fixture(t)
  const marker = join(f.root, 'client-command-ran')
  await f.user({ probe: probe({}) })
  const tests = new McpConnectionTests({ home: f.home })
  const ctx = { mcpConnectionTests: () => tests } as unknown as HostContext
  const handler = libraryMethods['library/mcp/test'] as (ctx: HostContext, params: unknown) => Promise<McpTestResult>
  const result = await handler(ctx, {
    name: 'probe',
    path: f.userFile,
    command: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
    url: 'http://127.0.0.1:1/',
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.ok && result.serverName === 'probe', 'the declared server ran')
  assert.equal(existsSync(marker), false, 'the client-supplied command never ran')
  await assert.rejects(async () => handler(ctx, { name: 'probe', path: f.userFile, cwd: 'relative/folder' }))
})

// -- HTTP ---------------------------------------------------------------------

interface Seen {
  readonly method: string
  readonly headers: IncomingMessage['headers']
  readonly body: Record<string, unknown> | null
}

const listen = async (t: { after: (fn: () => Promise<void>) => void }, handle: (req: IncomingMessage, body: string, res: ServerResponse) => void) => {
  const seen: Seen[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', headers: req.headers, body: body ? (JSON.parse(body) as Record<string, unknown>) : null })
      handle(req, body, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen }
}

/** A streamable HTTP server: JSON replies, or one SSE event per reply when `sse` is set. */
const streamable = (options: { sse?: boolean; status?: number; pages?: number } = {}) =>
  (req: IncomingMessage, raw: string, res: ServerResponse) => {
    if (options.status !== undefined) {
      res.writeHead(options.status, { 'content-type': 'text/plain' })
      res.end(`denied for ${String(req.headers['authorization'] ?? '')}`)
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end()
      return
    }
    const message = JSON.parse(raw) as { id?: number; method: string; params?: { cursor?: string } }
    if (message.id === undefined) {
      res.writeHead(202).end()
      return
    }
    let result: unknown
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'web-probe', version: '9' } }
    } else {
      const page = Number(message.params?.cursor ?? '0')
      result = { tools: [{ name: `a${page}` }, { name: `b${page}` }], ...(page + 1 < (options.pages ?? 1) ? { nextCursor: String(page + 1) } : {}) }
    }
    const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result })
    const headers: Record<string, string> = message.method === 'initialize' ? { 'mcp-session-id': 'session-1' } : {}
    if (options.sse) {
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' })
      res.end(`event: message\ndata: ${reply}\n\n`)
    } else {
      res.writeHead(200, { ...headers, 'content-type': 'application/json' })
      res.end(reply)
    }
  }

test('streamable HTTP: headers sent, session carried, pages followed, session ended', async (t) => {
  const f = await fixture(t)
  const web = await listen(t, streamable({ pages: 3 }))
  await f.user({ web: { type: 'http', url: web.url, headers: { Authorization: `Bearer ${SECRET}` } } })
  const result = await new McpConnectionTests({ home: f.home }).test({ name: 'web', path: f.userFile })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.ok && result.tools === 6 && result.serverName === 'web-probe')
  const posts = web.seen.filter((one) => one.method === 'POST')
  assert.deepEqual(posts.map((one) => one.body?.['method']), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'tools/list'])
  assert.equal(posts[0]?.headers['authorization'], `Bearer ${SECRET}`)
  assert.equal(posts[0]?.headers['mcp-session-id'], undefined)
  for (const later of posts.slice(1)) {
    assert.equal(later.headers['mcp-session-id'], 'session-1')
    assert.equal(later.headers['mcp-protocol-version'], '2025-06-18')
  }
  assert.equal(web.seen.at(-1)?.method, 'DELETE')
  assert.ok(!JSON.stringify(result).includes(SECRET))
})

test('streamable HTTP answered as an event stream', async (t) => {
  const f = await fixture(t)
  const web = await listen(t, streamable({ sse: true }))
  await f.user({ web: { type: 'http', url: web.url } })
  const result = await new McpConnectionTests({ home: f.home }).test({ name: 'web', path: f.userFile })
  assert.ok(result.ok && result.tools === 2, JSON.stringify(result))
})

test('a 401 is needsSignIn, and a test never signs in', async (t) => {
  const f = await fixture(t)
  const web = await listen(t, streamable({ status: 401 }))
  await f.user({ web: { type: 'http', url: web.url, headers: { Authorization: `Bearer ${SECRET}` } } })
  const result = failed(await new McpConnectionTests({ home: f.home }).test({ name: 'web', path: f.userFile }))
  assert.equal(result.reason, 'needsSignIn')
  assert.equal(web.seen.length, 1)
  assert.ok(!JSON.stringify(result).includes(SECRET))
})

test('another error status is httpError, its body never echoed', async (t) => {
  const f = await fixture(t)
  const web = await listen(t, streamable({ status: 500 }))
  await f.user({ web: { type: 'http', url: web.url, headers: { 'X-Api-Key': SECRET } } })
  const result = failed(await new McpConnectionTests({ home: f.home }).test({ name: 'web', path: f.userFile }))
  assert.equal(result.reason, 'httpError')
  assert.match(result.detail, /HTTP 500/)
  assert.ok(!JSON.stringify(result).includes(SECRET))
})

test('nothing listening is httpError, and the URL is not repeated', async (t) => {
  const f = await fixture(t)
  await f.user({ web: { type: 'http', url: `http://127.0.0.1:9/mcp?key=${SECRET}` } })
  const result = failed(await new McpConnectionTests({ home: f.home }).test({ name: 'web', path: f.userFile }))
  assert.equal(result.reason, 'httpError')
  assert.ok(!JSON.stringify(result).includes(SECRET))
})

test('the older SSE transport: endpoint event, replies on the stream', async (t) => {
  const f = await fixture(t)
  let stream: ServerResponse | null = null
  const web = await listen(t, (req, raw, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: endpoint\ndata: /messages?session=abc\n\n')
      stream = res
      return
    }
    res.writeHead(202).end()
    const message = JSON.parse(raw) as { id?: number; method: string }
    if (message.id === undefined) return
    const result =
      message.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'old-probe' } }
        : { tools: [{ name: 'x' }] }
    stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`)
  })
  await f.user({ old: { type: 'sse', url: web.url } })
  const result = await new McpConnectionTests({ home: f.home }).test({ name: 'old', path: f.userFile })
  assert.ok(result.ok && result.tools === 1 && result.serverName === 'old-probe', JSON.stringify(result))
})
