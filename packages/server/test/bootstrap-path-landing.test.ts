import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { tempDir } from './scratch.js'

/**
 * The shell's PATH lands after the host is built, and the desk starts its
 * runtimes without waiting for it — nothing awaits `pathReady`. What the desk
 * does when it lands is the part that was missing: runtimes that found their
 * program missing are asked again, but only when the PATH actually changed.
 *
 * Every other test of the production host awaits `pathReady` first, which is
 * the one order the desk never runs in.
 */
const landing = async (answer: (current: string) => string): Promise<{ asked: number; changed: boolean }> => {
  const root = tempDir('hd-path-landing-')
  const shell = join(root, 'shell')
  // The login shell, as the desk asks for it: a moment, then the PATH between its marks.
  writeFileSync(shell, "#!/bin/sh\nsleep 0.3\nprintf '%s%s%s' '__HARNESSDESK_PATH__' \"$STUB_PATH\" '__HARNESSDESK_PATH__'\n")
  chmodSync(shell, 0o755)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tempDir('hd-path-landing-home-'),
    SHELL: shell,
    STUB_PATH: answer(process.env['PATH'] ?? ''),
    HARNESSDESK_NO_UPDATE_CHECK: '1',
    HD_STATE: root,
    HD_BOOTSTRAP: new URL('../src/bootstrap.js', import.meta.url).href,
    HD_FAKE: fileURLToPath(new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url)),
  }
  delete env['CODEX_HOME']
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/bootstrap-path-landing.mjs', import.meta.url))], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const code = await new Promise<number | null>((resolve) => {
    const deadline = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.once('exit', (value) => { clearTimeout(deadline); resolve(value) })
  })
  assert.equal(code, 0, stderr)
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as { asked: number; changed: boolean }
}

test('a PATH that lands with a folder the desk did not have asks the runtimes that found nothing, once', { skip: process.platform === 'win32', timeout: 30_000 }, async () => {
  const result = await landing((current) => `${tempDir('hd-path-landing-bin-')}:${current}`)

  assert.deepEqual(result, { asked: 1, changed: true })
})

test('a PATH that lands with nothing new asks nobody', { skip: process.platform === 'win32', timeout: 30_000 }, async () => {
  const result = await landing((current) => current)

  assert.deepEqual(result, { asked: 0, changed: false })
})
