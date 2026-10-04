import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { childrenGone, childrenUp, Hosts } from './hosts.js'

/**
 * The accounting a test file does for the plugin hosts it starts
 * (`hosts.ts`), exercised for real: a child process nobody disposed has to
 * end up named in a failure, and a process that cannot exit has to be ended
 * with a message rather than left for a person to find later (#1306).
 */

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
const HOSTS = pathToFileURL(fileURLToPath(new URL('./hosts.js', import.meta.url))).href

/** Runs a module script in a process of its own, and answers how it ended. */
const run = (script: string): Promise<{ code: number | null; stderr: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 20_000 }, (error, _stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stderr })
    })
  })

test('settling disposes a host no test did, and names only that one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-hosts-'))
  const hosts = new Hosts()
  try {
    await cp(join(FIXTURES, 'plugin-good'), join(dir, 'plugins', 'good'), { recursive: true })
    const forgotten = hosts.make('forgotten', { invokeTimeoutMs: 5_000, env: { HARNESSDESK_PLUGINS: join(dir, 'plugins') } })
    await forgotten.loadInstalledPlugins()
    // Never started, so the child that is up below is the forgotten host's alone.
    await hosts.make('tidy').dispose()
    assert.equal(childrenUp(), 1, 'the forgotten host has a child running')

    await assert.rejects(hosts.settle(), (error: Error) => {
      assert.match(error.message, /forgotten/)
      assert.doesNotMatch(error.message, /tidy/)
      return true
    })
    assert.equal(forgotten.disposed, true)
    await childrenGone()
  } finally {
    await hosts.settle().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

test('settling is quiet when every host was disposed by its test', async () => {
  const hosts = new Hosts()
  await hosts.make('one').dispose()
  await hosts.make('two').dispose()
  await hosts.settle()
})

test('a process that cannot exit is ended with a message naming what holds it open', async () => {
  const { code, stderr } = await run(`
    import { spawn } from 'node:child_process'
    import { failIfStillOpen } from ${JSON.stringify(HOSTS)}
    // This child waits on its stdin, so it ends with this process and outlives nothing.
    spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] })
    failIfStillOpen(300)
  `)
  assert.equal(code, 1, stderr)
  assert.match(stderr, /still running 300ms after its last test/)
  assert.match(stderr, /held open by: .*ProcessWrap/)
})

test('a process that does exit is not kept waiting for the deadline', async () => {
  const { code, stderr } = await run(`
    import { failIfStillOpen } from ${JSON.stringify(HOSTS)}
    failIfStillOpen(600_000)
  `)
  assert.equal(code, 0, stderr)
})
