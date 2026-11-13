import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { canonicalMcp, digestOf } from '@harnessdesk/agent-inventory'
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

test('short environment values do not mask output', async t => {
  const f = await setup(t)
  await f.write({ command: process.execPath, args: [PROBE], env: { PROBE_MODE: 'error', PROBE_SECRET: '${TOKEN}' } })
  const result = await new McpConnectionTests({ home: f.home, baseEnv: { TOKEN: 'xyz' } }).test({ name: 'probe', path: f.path })
  assert.ok(!result.ok)
  assert.match(result.detail, /bad key xyz/)
  assert.ok(!result.detail.includes('•••'))
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
  assert.deepEqual(expanded.names, ['ARG', 'BASE', 'EMPTY', 'EXEC', 'SET', 'TOKEN', 'UNSET'])
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
  const { spec, secrets } = expandMcpTestSpec({ name: 'probe', transport: 'http', url: '${BASE}/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } }, 'claude', { BASE: 'https://mcp.example.com', TOKEN: 'token-value' })
  const result = await runMcpTest(spec, { cwd: '/work/demo', secrets, fetch: (async (url, init) => {
    assert.equal(String(url), 'https://mcp.example.com/mcp')
    assert.equal((init?.headers as Record<string, string>)['Authorization'], 'Bearer token-value')
    const body = JSON.parse(String(init?.body))
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize'
      ? { protocolVersion: '2025-06-18', serverInfo: { name: 'token-value', version: '1' } }
      : { tools: [] } })
  }) as typeof fetch })
  assert.ok(result.ok, JSON.stringify(result))
  assert.equal(result.serverName, '•••')
  assert.ok(!JSON.stringify(result).includes('token-value'))
})

test('a long expanded secret is redacted before a protocol error is shortened', async t => {
  const f = await setup(t)
  await f.write({ command: process.execPath, args: [PROBE], env: { PROBE_MODE: 'error', PROBE_SECRET: '${TOKEN}' } })
  const result = await new McpConnectionTests({ home: f.home, baseEnv: { TOKEN: 'private'.repeat(100) } }).test({ name: 'probe', path: f.path })
  assert.ok(!result.ok)
  assert.ok(!JSON.stringify(result).includes('private'))
  assert.match(result.detail, /•••/)
})


test('project confirmation discloses all desk variable names, never values, and binds the names', async t => {
  const f = await setup(t)
  const path = join(f.home, '.mcp.json')
  const entry = (token: string) => ({ type: 'http', url: 'https://mcp.acme.dev/mcp', headers: { Authorization: `Bearer \${${token}}` } })
  await writeFile(path, JSON.stringify({ mcpServers: { probe: entry('AWS_SECRET_ACCESS_KEY') } }))
  const tests = new McpConnectionTests({ home: f.home, baseEnv: { AWS_SECRET_ACCESS_KEY: 'synthetic-value', GITHUB_TOKEN: 'synthetic-value' } })
  const first = await tests.test({ name: 'probe', path, cwd: f.home })
  assert.ok(!first.ok && first.reason === 'confirm')
  assert.deepEqual((first.target as typeof first.target & { readEnvNames: string[] }).readEnvNames, ['AWS_SECRET_ACCESS_KEY'])
  assert.ok(!JSON.stringify(first.target).includes('synthetic-value'))
  await writeFile(path, JSON.stringify({ mcpServers: { probe: entry('GITHUB_TOKEN') } }))
  const next = await tests.test({ name: 'probe', path, cwd: f.home, confirmed: first.digest })
  assert.ok(!next.ok && next.reason === 'confirm', 'equal values read under different names need new consent')
  assert.notEqual(next.digest, first.digest)
})

test('expanded defaults are not secrets; only actual desk values of four or more characters are', () => {
  const expanded = expandMcpTestSpec({ name: 'probe', transport: 'stdio', command: 'node', env: {
    DEBUG: '${DEBUG}', MODE: '${MISSING:-fallback-mode}', TOKEN: '${TOKEN}', EMPTY: '${EMPTY:-fallback}',
  } }, 'claude', { DEBUG: '1', TOKEN: 'four', EMPTY: '' })
  assert.deepEqual(expanded.secrets, ['four'])
  assert.equal(expanded.spec.env?.['EMPTY'], '', 'documented empty-but-set suppresses the default')
})

test('masking server output leaves host-authored exit-code text and defaults readable', async t => {
  const f = await setup(t)
  await f.write({ command: process.execPath, args: [PROBE], env: { PROBE_MODE: 'crash', PROBE_SECRET: '${UNSET:-fallback-mode}', WORD: '${WORD}', DEBUG: '${DEBUG}' } })
  const result = await new McpConnectionTests({ home: f.home, baseEnv: { WORD: 'code', DEBUG: '3' } }).test({ name: 'probe', path: f.path })
  assert.ok(!result.ok)
  assert.match(result.detail, /exited \(code 3\)/)
  assert.ok(result.reason !== 'confirm')
  assert.match(result.stderr ?? '', /fallback-mode/)
})

test('Claude empty-but-set variables remain empty for plain references and defaults', () => {
  const { spec } = expandMcpTestSpec({ name: 'probe', transport: 'stdio', command: 'node', args: ['${EMPTY}', '${EMPTY:-fallback}', '${MISSING:-fallback}'] }, 'claude', { EMPTY: '' })
  assert.deepEqual(spec.args, ['', '', 'fallback'])
})

test('Cursor expands its contextual placeholders and leaves unknown or invalid names literal', () => {
  const project = '/work/demo-project'
  // Context is supplied by the trusted copy lookup, never interpolated from the file.
  const resolve = expandMcpTestSpec
  const { spec, names } = resolve({ name: 'probe', transport: 'stdio', command: '${userHome}/bin/node', args: [
    '${workspaceFolder}', '${workspaceFolderBasename}', '${pathSeparator}', '${/}', '${env:VALID}', '${env:not valid}', '${env:bad-name}', '${UNKNOWN}', '${OUTER:-${INNER}}',
  ] }, 'cursor', { VALID: 'value' }, { home: '/home/jane', cwd: project })
  assert.equal(spec.command, '/home/jane/bin/node')
  assert.deepEqual(spec.args, [project, basename(project), sep, sep, 'value', '${env:not valid}', '${env:bad-name}', '${UNKNOWN}', '${OUTER:-${INNER}}'])
  assert.deepEqual(names, ['VALID'])
})

test('an unset Codex pass-through name stays absent instead of refusing the test', () => {
  const { spec, names } = expandMcpTestSpec({ name: 'probe', transport: 'stdio', command: 'node', envVars: ['SET', 'MISSING'] }, 'codex', { SET: 'value' })
  assert.deepEqual(spec.env, { SET: 'value' })
  assert.deepEqual(names, ['MISSING', 'SET'])
})

test('confirmation digests are keyed per process, stable within one, and remain sixteen hex characters', async t => {
  const f = await setup(t)
  const path = join(f.home, '.mcp.json')
  const spec = { name: 'probe', transport: 'stdio' as const, command: 'node', args: ['demo.js'] }
  await writeFile(path, JSON.stringify({ mcpServers: { probe: spec } }))
  const tests = new McpConnectionTests({ home: f.home })
  const first = await tests.test({ name: 'probe', path, cwd: f.home })
  const second = await tests.test({ name: 'probe', path, cwd: f.home })
  assert.ok(!first.ok && first.reason === 'confirm' && !second.ok && second.reason === 'confirm')
  assert.equal(first.digest, second.digest)
  assert.match(first.digest, /^[a-f0-9]{16}$/)
  assert.notEqual(first.digest, digestOf(`${canonicalMcp(spec)}\n${f.home}`))
  const moduleUrl = new URL('../src/mcp-test.js', import.meta.url).href
  const code = `import { McpConnectionTests } from ${JSON.stringify(moduleUrl)}; const result = await new McpConnectionTests({home:process.argv[1]}).test({name:'probe',path:process.argv[2],cwd:process.argv[1]}); process.stdout.write(result.digest)`
  const other = spawnSync(process.execPath, ['--input-type=module', '-e', code, f.home, path], { encoding: 'utf8' })
  assert.equal(other.status, 0, other.stderr)
  assert.match(other.stdout, /^[a-f0-9]{16}$/)
  assert.notEqual(first.digest, other.stdout)
})

test('a protocol error with no message keeps the host-authored fallback text', async () => {
  const spec = { name: 'probe', transport: 'http' as const, url: 'https://mcp.acme.dev/mcp' }
  const result = await runMcpTest(spec, { cwd: '/work/demo', secrets: ['error'], fetch: (async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32000 } })
  }) as typeof fetch })
  assert.ok(!result.ok)
  assert.equal(result.detail, 'It answered initialize with an error: an error')
})
