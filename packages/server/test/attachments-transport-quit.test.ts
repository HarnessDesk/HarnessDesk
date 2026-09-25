import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

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

/*
 * #895. SIGKILL follows SIGTERM only after a two-second timer, and a quit that
 * ends the process sooner never runs it: a server that shrugs off SIGTERM
 * outlived the desk. Here a process stands in for the desk: it starts an
 * exchange with such a server, aborts it (SIGTERM, ignored), and exits at once.
 */
test('a server that ignores SIGTERM does not outlive a desk that quits before the grace period', async (t) => {
  const dir = tempDir('hd-mcp-quick-quit-')
  const pidFile = join(dir, 'pid')
  const heldFile = join(dir, 'held')
  const script = `
    import { callStdioMcpServer } from ${JSON.stringify(TRANSPORT)}
    import { readFileSync } from 'node:fs'
    const written = () => {
      try { return Number(readFileSync(${JSON.stringify(pidFile)}, 'utf8')) > 1 && readFileSync(${JSON.stringify(heldFile)}, 'utf8').includes('held') } catch { return false }
    }
    const abort = new AbortController()
    const call = callStdioMcpServer({
      name: 'stubborn', transport: 'stdio', command: process.execPath, args: [${JSON.stringify(FIXTURE)}],
      env: { FAKE_MCP_HANG_CALL: '1', FAKE_MCP_IGNORE_TERM: '1', FAKE_MCP_PID_FILE: ${JSON.stringify(pidFile)}, FAKE_MCP_MARKER: ${JSON.stringify(heldFile)} },
    }, 'flag_issue', {}, { signal: abort.signal }).catch(() => {})
    // The server ignores SIGTERM before it writes its pid, and holds the call with nothing more to write.
    while (!written()) await new Promise((resolve) => setTimeout(resolve, 10))
    abort.abort()
    await call
    process.exit(0)
  `
  const desk = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'inherit', 'inherit'] })
  const code = await new Promise<number | null>((resolve) => desk.once('exit', resolve))
  assert.equal(code, 0)
  const pid = Number(await readFile(pidFile, 'utf8'))
  // Never 0 or negative: those would signal this process's own group.
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `a real pid, got ${pid}`)
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL') })
  // SIGKILL is delivered on the way out; the kernel reaps it a moment later.
  for (let tries = 0; tries < 100 && alive(pid); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(alive(pid), false, 'the server was killed when the desk exited, not left running')
})
