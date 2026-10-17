import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url))
for (const [args, code] of [[['--help'], 0], [['-h'], 0], [['--unknown'], 2], [['--port'], 2]] as const) {
  test(`host ${args.join(' ')} prints usage and leaves the home untouched`, async t => {
    const home = await mkdtemp('/tmp/bugs-1675-bin-')
    t.after(() => rm(home, { recursive: true, force: true }))
    const result = spawnSync(process.execPath, [bin, ...args], {
      env: { ...process.env, HOME: home, HARNESSDESK_HOME: join(home, 'desk'), HARNESSDESK_CODEX_BINARY: fileURLToPath(new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url)) },
      encoding: 'utf8', timeout: 3000,
    })
    assert.equal(result.status, code, result.stderr || result.error?.message || '')
    assert.match(result.stdout + result.stderr, /Usage:.*harnessdesk-host/)
    assert.match(result.stdout + result.stderr, /--port/)
    assert.deepEqual(await readdir(home), [])
  })
}
