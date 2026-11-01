import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

for (const mode of ['held', 'failed', 'unknown'] as const) test(`account removal protects a nested home with a ${mode} owner`, { timeout: 30_000 }, async () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tempDir('hd-home-lease-home-'),
    HARNESSDESK_NO_UPDATE_CHECK: '1',
    HD_STATE: tempDir('hd-home-lease-state-'),
    HD_LEASE_MODE: mode,
    HD_BOOTSTRAP: new URL('../src/bootstrap.js', import.meta.url).href,
    HD_ADAPTER: new URL('../../../adapter-codex/dist/src/runtime.js', import.meta.url).href,
    HD_FAKE: fileURLToPath(new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url)),
  }
  delete env['SHELL']
  delete env['CODEX_HOME']
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/bootstrap-account-home-lease.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const code = await new Promise<number | null>((resolve) => {
    const deadline = setTimeout(() => child.kill('SIGKILL'), 25_000)
    child.once('exit', value => { clearTimeout(deadline); resolve(value) })
  })
  assert.equal(code, 0, stderr)
})
