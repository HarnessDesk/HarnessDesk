import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { expandMcpTestSpec, McpConnectionTests, mcpTestEnvironment, runMcpTest } from '../src/mcp-test.js'

const PROBE = fileURLToPath(new URL('./fixtures/fake-mcp-probe.mjs', import.meta.url))
const setup = async (t: { after: (fn: () => Promise<void>) => void }, dialect = 'claude') => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'hd-mcp-expand-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  const path = dialect === 'codex' ? join(home, '.codex/config.toml') : dialect === 'cursor' ? join(home, '.cursor/mcp.json') : join(home, '.claude.json')
  await mkdir(join(home, dialect === 'codex' ? '.codex' : '.cursor'), { recursive: true })
  const write = async (entry: Record<string, unknown>) => writeFile(path, JSON.stringify({ mcpServers: { probe: entry } }))
  return { home, path, write }
}

test('expands command, args and env from the desk environment before starting', async t => {
  const f = await setup(t)
  await f.write({ command: '${EXEC}', args: ['${PROBE}'], env: { PROBE_TOOLS: '${COUNT}' } })
  const result = await new McpConnectionTests({ home: f.home, baseEnv: { EXEC: process.execPath, PROBE, COUNT: '7' } }).test({ name: 'probe', path: f.path })
  assert.ok(result.ok, JSON.stringify(result))
  assert.equal(result.tools, 7)
})

test('unset references fail by variable name before starting or asking for confirmation', async t => {
  const f = await setup(t)
  const path = join(f.home, '.mcp.json')
  await writeFile(path, JSON.stringify({ mcpServers: { probe: { command: '${MISSING}' } } }))
  const result = await new McpConnectionTests({ home: f.home, baseEnv: {} }).test({ name: 'probe', path, cwd: f.home })
  assert.ok(!result.ok)
  assert.equal(result.reason, 'notFound')
  assert.match(result.detail, /MISSING.*not set/)
})

test('uses defaults only when unset, including an empty default', async t => {
  const f = await setup(t)
  await f.write({ command: process.execPath, args: [PROBE], env: { PROBE_TOOLS: '${COUNT:-5}', PROBE_SECRET: '${EMPTY:-fallback}', OTHER: '${UNSET:-}' } })
  const result = await new McpConnectionTests({ home: f.home, baseEnv: { EMPTY: '' } }).test({ name: 'probe', path: f.path })
  assert.ok(result.ok, JSON.stringify(result))
  assert.equal(result.tools, 5)
})

test('nested braces stay literal, without resolving the inner reference', async t => {
  const f = await setup(t)
  await f.write({ command: process.execPath, args: [PROBE, '${OUTER:-${MISSING}}'], env: { PROBE_TOOLS: '2' } })
  const result = await new McpConnectionTests({ home: f.home, baseEnv: {} }).test({ name: 'probe', path: f.path })
  assert.ok(result.ok, JSON.stringify(result))
  assert.equal(result.tools, 2)
})

test('Cursor leaves bare VAR references literal; it uses env:NAME instead', async t => {
  const f = await setup(t, 'cursor')
  await f.write({ command: process.execPath, args: [PROBE, '${MISSING}'], env: { PROBE_TOOLS: '${env:COUNT}' } })
  const result = await new McpConnectionTests({ home: f.home, baseEnv: { COUNT: '6' } }).test({ name: 'probe', path: f.path })
  assert.ok(result.ok, JSON.stringify(result))
  assert.equal(result.tools, 6)
})

test('Codex passes env_vars names through, overriding inherited values with explicit env', async t => {
  const f = await setup(t, 'codex')
  await writeFile(f.path, `[mcp_servers.probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(PROBE)}, "\u0024{MISSING}"]\nenv_vars = ["PROBE_TOOLS", "PROBE_SECRET"]\nenv = { PROBE_SECRET = "literal" }\n`)
  const result = await new McpConnectionTests({ home: f.home, baseEnv: { PROBE_TOOLS: '8', PROBE_SECRET: 'inherited' } }).test({ name: 'probe', path: f.path })
  assert.ok(result.ok, JSON.stringify(result))
  assert.equal(result.tools, 8)
})

test('confirmation hides resolved values and changes its digest when the environment changes', async t => {
  const f = await setup(t)
  const path = join(f.home, '.mcp.json')
  await writeFile(path, JSON.stringify({ mcpServers: { probe: { command: '${EXEC}', args: ['${PROBE}'], env: { PROBE_TOOLS: '${COUNT}', NODE_OPTIONS: '${OPTIONS}' } } } }))
  const baseEnv = { EXEC: process.execPath, PROBE, COUNT: '4', OPTIONS: '--no-warnings' }
  const tests = new McpConnectionTests({ home: f.home, baseEnv })
  const first = await tests.test({ name: 'probe', path, cwd: f.home })
  assert.ok(!first.ok && first.reason === 'confirm')
  assert.ok(!JSON.stringify(first.target).includes(PROBE))
  assert.ok(!JSON.stringify(first.target).includes('--no-warnings'))
  baseEnv.COUNT = '9'
  const changed = await tests.test({ name: 'probe', path, cwd: f.home, confirmed: first.digest })
  assert.ok(!changed.ok && changed.reason === 'confirm')
  assert.notEqual(changed.digest, first.digest)
  const ran = await tests.test({ name: 'probe', path, cwd: f.home, confirmed: changed.digest })
  assert.ok(ran.ok, JSON.stringify(ran))
  assert.equal(ran.tools, 9)
})

test('even short expanded values are masked from server output', async t => {
  const f = await setup(t)
  await f.write({ command: process.execPath, args: [PROBE], env: { PROBE_MODE: 'error', PROBE_SECRET: '${TOKEN}' } })
  const result = await new McpConnectionTests({ home: f.home, baseEnv: { TOKEN: 'xyz' } }).test({ name: 'probe', path: f.path })
  assert.ok(!result.ok)
  assert.ok(!JSON.stringify(result).includes('xyz'))
  assert.match(result.detail, /•••/)
})

test('all expanding fields resolve once; nested braces and replacement text are left alone', () => {
  const declaration = { name: 'probe', transport: 'http' as const, command: '${EXEC}', args: ['${ARG}', '${OUTER:-${INNER}}', '${OUTER:-{INNER}}', '${OPEN'],
    url: '${BASE:-https://mcp.example.com}/mcp', headers: { Authorization: 'Bearer ${TOKEN}' }, env: { VALUE: '${SET}', EMPTY: '${EMPTY:-fallback}', DEFAULT: '${UNSET:-}', INNER: '${ARG}' } }
  const expanded = expandMcpTestSpec(declaration, 'claude', { EXEC: 'node', ARG: '${LITERAL}', TOKEN: 'xyz', SET: 'yes', EMPTY: '' })
  assert.equal(expanded.spec.command, 'node')
  assert.deepEqual(expanded.spec.args, ['${LITERAL}', '${OUTER:-${INNER}}', '${OUTER:-{INNER}}', '${OPEN'])
  assert.equal(expanded.spec.url, 'https://mcp.example.com/mcp')
  assert.deepEqual(expanded.spec.headers, { Authorization: 'Bearer xyz' })
  assert.deepEqual(expanded.spec.env, { VALUE: 'yes', EMPTY: '', DEFAULT: '', INNER: '${LITERAL}' })
  assert.deepEqual(declaration.args[0], '${ARG}', 'the scanned declaration is not mutated')
  const literal = expandMcpTestSpec(declaration, 'codex', {})
  assert.deepEqual(literal.spec, declaration)
  assert.deepEqual(literal.names, [])
})

test('Gemini expands bare and braced variables throughout settings, including defaults', () => {
  const expanded = expandMcpTestSpec({ name: 'probe', transport: 'stdio', command: '$EXEC', args: ['${ARG:-demo.js}'], env: { VALUE: '$TOKEN' } }, 'gemini', { EXEC: 'node', TOKEN: 'yes' })
  assert.equal(expanded.spec.command, 'node')
  assert.deepEqual(expanded.spec.args, ['demo.js'])
  assert.deepEqual(expanded.spec.env, { VALUE: 'yes' })
})

test('only named pass-through variables reach the child; explicit values take precedence', () => {
  const { spec } = expandMcpTestSpec({ name: 'probe', transport: 'stdio', command: 'node', envVars: ['PROBE_TOOLS', 'PROBE_SECRET'], env: { PROBE_SECRET: 'explicit' } }, 'codex', { PROBE_TOOLS: '8', PROBE_SECRET: 'inherited', UNRELATED: 'private' })
  const environment = mcpTestEnvironment(spec, {})
  assert.equal(environment['PROBE_TOOLS'], '8')
  assert.equal(environment['PROBE_SECRET'], 'explicit')
  assert.equal(environment['UNRELATED'], undefined)
})

test('expanded HTTP address and headers reach only the fake transport, never its answer', async () => {
  const { spec, secrets } = expandMcpTestSpec({ name: 'probe', transport: 'http', url: '${BASE}/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } }, 'claude', { BASE: 'https://mcp.example.com', TOKEN: 'xyz' })
  const result = await runMcpTest(spec, { cwd: '/work/demo', secrets, fetch: (async (url, init) => {
    assert.equal(String(url), 'https://mcp.example.com/mcp')
    assert.equal((init?.headers as Record<string, string>)['Authorization'], 'Bearer xyz')
    const body = JSON.parse(String(init?.body))
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize'
      ? { protocolVersion: '2025-06-18', serverInfo: { name: 'xyz', version: '1' } }
      : { tools: [] } })
  }) as typeof fetch })
  assert.ok(result.ok, JSON.stringify(result))
  assert.equal(result.serverName, '•••')
  assert.ok(!JSON.stringify(result).includes('xyz'))
})

test('a long expanded secret is redacted before a protocol error is shortened', async t => {
  const f = await setup(t)
  await f.write({ command: process.execPath, args: [PROBE], env: { PROBE_MODE: 'error', PROBE_SECRET: '${TOKEN}' } })
  const result = await new McpConnectionTests({ home: f.home, baseEnv: { TOKEN: 'private'.repeat(100) } }).test({ name: 'probe', path: f.path })
  assert.ok(!result.ok)
  assert.ok(!JSON.stringify(result).includes('private'))
  assert.match(result.detail, /•••/)
})
