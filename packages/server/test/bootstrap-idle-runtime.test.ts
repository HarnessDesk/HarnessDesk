import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { makeRepo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

for (const scenario of ['core', 'reads', 'surfaces'] as const) {
  test(`production host idle scenario: ${scenario}`, { timeout: 30_000 }, async (t) => {
    const started = Date.now()
    const root = tempDir('hd-idle-bootstrap-')
    const repo = await makeRepo('hd-idle-bootstrap-repo-')
    const env: NodeJS.ProcessEnv = { ...process.env,
      HOME: tempDir('hd-idle-bootstrap-home-'), HARNESSDESK_NO_UPDATE_CHECK: '1',
      HD_SCENARIO: scenario, HD_STATE: root, HD_REPO: repo.dir, HD_BOOTSTRAP: new URL('../src/bootstrap.js', import.meta.url).href,
      HD_FAKE: fileURLToPath(new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url)),
      // Codex closes an unsubscribed idle thread after a minute; the scripted one does so at once.
      FAKE_CODEX_MODE: 'hold', FAKE_CODEX_MCP_CHILDREN: join(root, 'children.ndjson'), FAKE_CODEX_UNLOAD_MS: '1',
      FAKE_CODEX_PAGED_HISTORY: '1', FAKE_CODEX_FILE_ROOT: repo.dir,
    }
    delete env['SHELL']
    delete env['CODEX_HOME']
    const childStarted = Date.now()
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/bootstrap-idle-runtime.mjs', import.meta.url))],
      { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stdout.resume()
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    let watchdog = false
    const result = await new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve, reject) => {
      const deadline = setTimeout(() => { watchdog = true; child.kill('SIGKILL') }, 25_000)
      child.once('error', (error) => { clearTimeout(deadline); reject(error) })
      child.once('close', (code, signal) => { clearTimeout(deadline); resolve({ code, signal }) })
    })
    const ledger = await readFile(join(root, 'children.ndjson'), 'utf8').catch(() => '')
    const helperPids: number[] = ledger.trim().split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { pid: number }).pid)
    const live = helperPids.filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } })
    const detail = `${scenario}: elapsed=${Date.now() - started}ms childElapsed=${Date.now() - childStarted}ms code=${result.code} signal=${result.signal} watchdog=${watchdog} helperPids=${helperPids.join(',')} live=${live.join(',')}\n${stderr}`
    t.diagnostic(detail)
    assert.equal(result.code, 0, detail)
    assert.equal(result.signal, null, detail)
    assert.equal(watchdog, false, detail)
    assert.deepEqual(live, [], detail)
  })
}
