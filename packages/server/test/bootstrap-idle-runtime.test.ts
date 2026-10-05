import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { makeRepo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

test('the production host releases finished-seat MCP processes, protects work, and resumes through one start', { timeout: 30_000 }, async () => {
  const root = tempDir('hd-idle-bootstrap-')
  const repo = await makeRepo('hd-idle-bootstrap-repo-')
  const env: NodeJS.ProcessEnv = { ...process.env,
    HOME: tempDir('hd-idle-bootstrap-home-'), HARNESSDESK_NO_UPDATE_CHECK: '1',
    HD_STATE: root, HD_REPO: repo.dir, HD_BOOTSTRAP: new URL('../src/bootstrap.js', import.meta.url).href,
    HD_FAKE: fileURLToPath(new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url)),
    FAKE_CODEX_MODE: 'hold', FAKE_CODEX_MCP_CHILDREN: join(root, 'children.ndjson'),
    FAKE_CODEX_PAGED_HISTORY: '1', FAKE_CODEX_FILE_ROOT: repo.dir,
  }
  delete env['SHELL']
  delete env['CODEX_HOME']
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/bootstrap-idle-runtime.mjs', import.meta.url))],
    { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const code = await new Promise<number | null>((resolve) => {
    const deadline = setTimeout(() => child.kill('SIGKILL'), 25_000)
    child.once('exit', (value) => { clearTimeout(deadline); resolve(value) })
  })
  assert.equal(code, 0, stderr)
})
