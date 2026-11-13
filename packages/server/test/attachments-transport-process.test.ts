import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { callStdioMcpServer } from '../src/attachments/transport.js'
import { tempDir } from './scratch.js'

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
  process.env['HD_TEST_SECRET_SENTINEL'] = 'host-only'
  t.after(() => { delete process.env['HD_TEST_SECRET_SENTINEL'] })
  await callStdioMcpServer(spec({ FAKE_MCP_ENV_FILE: envFile, FIXTURE_OWN: 'configured' }), 'flag_issue', { line: 1 })
  const seen = JSON.parse(await readFile(envFile, 'utf8')) as Record<string, string>
  assert.equal(seen['HD_TEST_SECRET_SENTINEL'], undefined)
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
