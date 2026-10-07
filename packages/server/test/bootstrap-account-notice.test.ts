import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { tempDir } from './scratch.js'

/*
 * The seat resolved right after the desk starts, on the host the desk really
 * builds. `account-notice-seating.test.ts` holds the failure on a bare `Host`;
 * this holds that nothing the desk wires around it — its account slots, its
 * agent directory, its install service — changes what a signed-in Codex's own
 * `account/updated` does to the first account read.
 */
test('the production host resolves a Codex seat when the account notice lands on its first read', { timeout: 40_000 }, async () => {
  const root = tempDir('hd-notice-bootstrap-')
  const work = tempDir('hd-notice-bootstrap-work-')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // No real home is read, no login shell is asked, no update is checked.
    HOME: tempDir('hd-notice-bootstrap-home-'),
    HARNESSDESK_NO_UPDATE_CHECK: '1',
    HD_STATE: root, HD_WORK: work,
    HD_BOOTSTRAP: new URL('../src/bootstrap.js', import.meta.url).href,
    HD_FAKE: fileURLToPath(new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url)),
    FAKE_CODEX_ACCOUNT_NOTICE: 'first-read', FAKE_CODEX_HOLD_ACCOUNT: join(root, 'hold-account'),
  }
  delete env['SHELL']
  delete env['CODEX_HOME']
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/bootstrap-account-notice.mjs', import.meta.url))],
    { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const code = await new Promise<number | null>((resolve) => {
    const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.once('exit', (value) => { clearTimeout(deadline); resolve(value) })
  })
  assert.equal(code, 0, stderr)
})
