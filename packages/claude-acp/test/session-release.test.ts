import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { scratch } from './scratch.js'

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
test('eight sessions share a Claude bridge and closing them releases each CLI, including the catalogue probe', async (t) => {
  const log = join(scratch('claude-lifetime-'), 'processes.log')
  const runtime = new AcpRuntime({ id: 'claude', name: 'Claude', command: process.execPath,
    args: [fileURLToPath(new URL('../src/main.js', import.meta.url))], env: {
      HOME: scratch('claude-home-'), CLAUDE_CONFIG_DIR: scratch('claude-config-'),
      CLAUDE_ACP_STATE_DIR: scratch('claude-state-'), CLAUDECODE: '', FAKE_CLAUDE_LOG: log,
      CLAUDE_CODE_EXECUTABLE: fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url)),
    } })
  t.after(() => runtime.dispose())
  const count = async () => (await readFile(log, 'utf8')).split('\n')
    .filter(line => line.startsWith('spawn ')).map(line => Number(line.split(' ')[1])).filter(alive).length
  const expectCount = async (expected: number) => {
    const deadline = Date.now() + 5_000
    while (await count() !== expected) {
      assert.ok(Date.now() < deadline, `expected ${expected} live fake CLIs, got ${await count()}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  await runtime.start()
  await runtime.defaultSessionOptions()
  await expectCount(0)
  const sessions = []
  for (let n = 1; n <= 8; n++) {
    sessions.push(await runtime.createSession({ cwd: scratch('claude-work-') }))
    if ([1, 3, 8].includes(n)) await expectCount(n)
  }
  await sessions[0]!.close()
  await expectCount(7)
  assert.equal(await runtime.resumeSession(sessions[1]!.id), sessions[1])
  for (const session of sessions.slice(1)) await session.close()
  await expectCount(0)
})
