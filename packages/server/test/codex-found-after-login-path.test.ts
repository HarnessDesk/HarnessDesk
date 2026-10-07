import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexRuntime } from '@harnessdesk/adapter-codex'

import { Host, StateStore } from '../src/index.js'
import { applyLoginShellPath } from '../src/installs/shell-path.js'
import { silent } from './fixtures/harness.js'

/**
 * The desk's real order, with a Codex that only the login shell's PATH can see.
 *
 * `createDefaultHost` asks the person's shell for its PATH in the background
 * and the desk starts every runtime without waiting for the answer. A Codex
 * installed where only that PATH looks — a folder in `.zshrc`, a version
 * manager — is therefore not on the PATH the first start reads, and the start
 * said "Codex is not installed". Nothing looked again: the verdict stood until
 * the app was restarted. Every other test of this path awaits the PATH before
 * it starts anything, or names the binary outright, which is the one order and
 * the one lookup the desk does not use.
 *
 * Production pieces throughout: the real PATH step with its shell scripted, the
 * real host, the real runtime finding its Codex by discovery. The scripted
 * Codex is the only stand-in, and it is reachable by nothing but the PATH.
 */
const FAKE = fileURLToPath(new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url))

const until = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    assert.ok(Date.now() < deadline, what)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('a Codex only the login shell knows about is found when its PATH lands', { skip: process.platform === 'win32', timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hd-codex-login-path-'))
  const empty = join(root, 'empty')
  const tools = join(root, 'tools')
  await mkdir(empty)
  await mkdir(tools)
  const codex = join(tools, 'codex')
  await writeFile(codex, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`)
  await chmod(codex, 0o755)

  const launched = process.env['PATH']
  process.env['PATH'] = empty
  const runtime = new CodexRuntime({
    binaryPath: null,
    // The well-known locations are this machine's; the PATH is the only way to this Codex.
    discovery: { locations: [] },
    clientName: 'harnessdesk-test',
    codexHome: join(root, 'codex'),
  })
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), version: '9.9.9', catalogRefreshMs: 0 })
  host.register(runtime)
  t.after(async () => {
    if (launched === undefined) delete process.env['PATH']
    else process.env['PATH'] = launched
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  })

  // The shell answers a moment after the desk is up, as a profile that does real work does.
  const applied = applyLoginShellPath({
    home: join(root, 'home'),
    env: { SHELL: '/bin/sh', PATH: empty },
    exists: (path) => path === '/bin/sh',
    list: () => [],
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      return `__HARNESSDESK_PATH__${tools}:${empty}__HARNESSDESK_PATH__`
    },
  })
  // What `createDefaultHost` does with it.
  const pathAtStart = process.env['PATH']
  void applied.settled.then(() => {
    if (process.env['PATH'] !== pathAtStart) void host.retryNotInstalled()
  })

  await host.start()
  const first = runtime.health()
  assert.ok(first.state === 'unavailable' && first.reason === 'notInstalled', `before the shell has answered Codex cannot be seen: ${JSON.stringify(first)}`)

  await applied.settled
  await until(() => runtime.health().state === 'ready', `the desk never found the Codex the shell's PATH names: ${JSON.stringify(runtime.health())}`)
  assert.equal(runtime.info.version, 'codex-cli 0.149.0')
})
