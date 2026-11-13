import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { mcpTestEnvironment } from '../src/mcp-test.js'
import { callStdioMcpServer } from '../src/attachments/transport.js'
import { tempDir } from './scratch.js'

const TRANSPORT = fileURLToPath(new URL('../src/attachments/transport.js', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))

const alive = (pid: number): boolean => {
  if (!(pid > 1)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const spec = (env: Record<string, string>) => ({
  name: 'fixture',
  transport: 'stdio' as const,
  command: process.execPath,
  args: [FIXTURE],
  env,
})

test('a server starts with the small environment and its own variables, not the desk\'s', async (t) => {
  const dir = tempDir('hd-mcp-env-')
  const envFile = join(dir, 'env.json')
  process.env['HD_TEST_UNLISTED_VARIABLE'] = 'not-listed'
  t.after(() => { delete process.env['HD_TEST_UNLISTED_VARIABLE'] })
  await callStdioMcpServer(spec({ FAKE_MCP_ENV_FILE: envFile, FIXTURE_OWN: 'configured' }), 'flag_issue', { line: 1 })
  const seen = JSON.parse(await readFile(envFile, 'utf8')) as Record<string, string>
  assert.equal(seen['HD_TEST_UNLISTED_VARIABLE'], undefined)
  assert.equal(seen['FIXTURE_OWN'], 'configured')
  assert.ok(seen['PATH'], 'the names a server needs to run still arrive')
})

test('closing a server ends what it started', async (t) => {
  const dir = tempDir('hd-mcp-group-')
  const pidFile = join(dir, 'grandchild')
  const abort = new AbortController()
  const marker = join(dir, 'marker')
  const call = callStdioMcpServer(
    spec({ FAKE_MCP_GRANDCHILD_PID_FILE: pidFile, FAKE_MCP_HANG_CALL: '1', FAKE_MCP_MARKER: marker }),
    'flag_issue',
    {},
    { signal: abort.signal },
  ).catch(() => {})
  let pid = 0
  for (let tries = 0; tries < 200 && !(pid > 1); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    try {
      pid = Number(await readFile(pidFile, 'utf8'))
      if (!(await readFile(marker, 'utf8')).includes('held')) pid = 0
    } catch {
      pid = 0
    }
  }
  assert.ok(pid > 1, `a real pid, got ${pid}`)
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL') })
  assert.equal(alive(pid), true, 'the grandchild runs while the server does')
  abort.abort()
  await call
  for (let tries = 0; tries < 150 && alive(pid); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(alive(pid), false, 'the grandchild ended with the server')
})

const waitForPid = async (pidFile: string, marker?: string): Promise<number> => {
  for (let tries = 0; tries < 200; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    try {
      const pid = Number(await readFile(pidFile, 'utf8'))
      if (pid > 1 && (marker === undefined || (await readFile(marker, 'utf8')).includes('held'))) return pid
    } catch {
      // Not written yet.
    }
  }
  return 0
}

test('a process that ignores SIGTERM is killed after the grace period', async (t) => {
  const dir = tempDir('hd-mcp-stubborn-')
  const pidFile = join(dir, 'grandchild')
  const marker = join(dir, 'marker')
  const abort = new AbortController()
  const call = callStdioMcpServer(
    spec({ FAKE_MCP_GRANDCHILD_PID_FILE: pidFile, FAKE_MCP_GRANDCHILD_IGNORE_TERM: '1', FAKE_MCP_HANG_CALL: '1', FAKE_MCP_MARKER: marker }),
    'flag_issue',
    {},
    { signal: abort.signal },
  ).catch(() => {})
  const pid = await waitForPid(pidFile, marker)
  assert.ok(pid > 1, `a real pid, got ${pid}`)
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL') })
  // Let the grandchild install its SIGTERM handler.
  await new Promise((resolve) => setTimeout(resolve, 300))
  abort.abort()
  await call
  await new Promise((resolve) => setTimeout(resolve, 2_500))
  assert.equal(alive(pid), false, 'killed outright once the grace period ran out')
})

test('a process left behind by a server that already exited is ended', async (t) => {
  const dir = tempDir('hd-mcp-orphan-')
  const pidFile = join(dir, 'grandchild')
  await callStdioMcpServer(
    spec({ FAKE_MCP_GRANDCHILD_PID_FILE: pidFile, FAKE_MCP_LEADER_EXITS: '1', FAKE_MCP_HANG_CALL: '1' }),
    'flag_issue',
    {},
  ).catch(() => {})
  const pid = await waitForPid(pidFile)
  assert.ok(pid > 1, `a real pid, got ${pid}`)
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL') })
  for (let tries = 0; tries < 150 && alive(pid); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(alive(pid), false, 'the helper the server left behind ended with it')
})

test('the environment lets infrastructure names through and no credential', () => {
  const from: NodeJS.ProcessEnv = {
    PATH: '/bin', NODE_EXTRA_CA_CERTS: '/ca.pem', SSL_CERT_FILE: '/c', SSL_CERT_DIR: '/d', REQUESTS_CA_BUNDLE: '/r',
    CURL_CA_BUNDLE: '/u', NO_PROXY: 'local', no_proxy: 'local', LC_NUMERIC: 'C', XDG_CONFIG_HOME: '/x',
    SystemRoot: 'C:\\Windows', ComSpec: 'cmd', PATHEXT: '.EXE', APPDATA: 'a', TEMP: 't', TMP: 't',
    SSH_AUTH_SOCK: '/agent', GITHUB_TOKEN: 'ghp_placeholder', HARNESSDESK_TOKEN: 'placeholder', HD_TEST_UNLISTED_VARIABLE: 'not-listed',
  }
  const env = mcpTestEnvironment({ name: 'f', transport: 'stdio', command: 'x', env: { OWN: '1' } }, from)
  for (const name of ['PATH', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NO_PROXY', 'no_proxy', 'LC_NUMERIC', 'XDG_CONFIG_HOME', 'SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'TEMP', 'TMP', 'OWN']) {
    assert.ok(env[name] !== undefined, `${name} passes`)
  }
  for (const name of ['SSH_AUTH_SOCK', 'GITHUB_TOKEN', 'HARNESSDESK_TOKEN', 'HD_TEST_UNLISTED_VARIABLE']) {
    assert.equal(env[name], undefined, `${name} does not`)
  }
})

test('a desk that quits inside the grace period leaves no stubborn helper behind', async (t) => {
  const dir = tempDir('hd-mcp-quit-orphan-')
  const pidFile = join(dir, 'grandchild')
  const script = `
    import { callStdioMcpServer } from ${JSON.stringify(TRANSPORT)}
    await callStdioMcpServer({
      name: 'orphan', transport: 'stdio', command: process.execPath, args: [${JSON.stringify(FIXTURE)}],
      env: { FAKE_MCP_GRANDCHILD_PID_FILE: ${JSON.stringify(pidFile)}, FAKE_MCP_GRANDCHILD_IGNORE_TERM: '1', FAKE_MCP_LEADER_EXITS: '1', FAKE_MCP_HANG_CALL: '1' },
    }, 'flag_issue', {}).catch(() => {})
    process.exit(0)
  `
  const desk = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'inherit', 'inherit'] })
  const code = await new Promise<number | null>((resolve) => desk.once('exit', resolve))
  assert.equal(code, 0)
  const pid = Number(await readFile(pidFile, 'utf8'))
  assert.ok(pid > 1, `a real pid, got ${pid}`)
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL') })
  for (let tries = 0; tries < 100 && alive(pid); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(alive(pid), false, 'killed on the way out, not left for a timer that never ran')
})
