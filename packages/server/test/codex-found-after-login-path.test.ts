import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CodexRuntime } from '@harnessdesk/adapter-codex'

import { Host, StateStore, type HostOptions } from '../src/index.js'
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
    if (process.env['PATH'] !== pathAtStart) void host.retryProgramLookup()
  })

  await host.start()
  const first = runtime.health()
  assert.ok(first.state === 'unavailable' && first.reason === 'notInstalled', `before the shell has answered Codex cannot be seen: ${JSON.stringify(first)}`)

  await applied.settled
  await until(() => runtime.health().state === 'ready', `the desk never found the Codex the shell's PATH names: ${JSON.stringify(runtime.health())}`)
  assert.equal(runtime.info.version, 'codex-cli 0.149.0')
})

/**
 * The same order with the shape the bug had.
 *
 * Above, the Codex is on no folder the first PATH names, so it is not found. On
 * the machine that showed the bug it *was* found: npm leaves Codex as a
 * Node-script launcher, `#!/usr/bin/env node`, and the `node` it starts lives in
 * a folder only the login shell's PATH names. The first ask ran the launcher,
 * `env` could not find `node`, and the copy exited 127 — a copy that is there
 * and will not answer, not one that is missing. Nothing above runs that shape.
 *
 * No `env` is handed to discovery and nothing is shortened: the probe reads the
 * live `process.env`, as the desk's does, and the host keeps its own schedule.
 */
const launcherMachine = async (t: TestContext, options: Partial<HostOptions> = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'hd-codex-launcher-path-'))
  const bin = join(root, 'bin')
  const tools = join(root, 'tools')
  await mkdir(bin)
  await mkdir(tools)
  const codex = join(bin, 'codex')
  await writeFile(codex, `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(FAKE).href)})\n`)
  await chmod(codex, 0o755)
  await symlink(process.execPath, join(tools, 'node'))

  const launched = process.env['PATH']
  // What the desk was launched with: the Codex launcher, and no `node` to run it.
  process.env['PATH'] = bin
  const runtime = new CodexRuntime({
    binaryPath: null,
    // The well-known locations are this machine's; the PATH is the only way to this Codex.
    discovery: { locations: [] },
    clientName: 'harnessdesk-test',
    codexHome: join(root, 'codex'),
  })
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')), version: '9.9.9', catalogRefreshMs: 0, ...options })
  host.register(runtime)
  t.after(async () => {
    if (launched === undefined) delete process.env['PATH']
    else process.env['PATH'] = launched
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { host, runtime, codex, bin, tools }
}

const openedWithoutWaiting = async (host: Host, runtime: CodexRuntime, codex: string): Promise<void> => {
  const began = Date.now()
  await host.start()
  assert.ok(Date.now() - began < 5_000, 'the desk opened without waiting for a Codex that would not answer')
  const first = runtime.health()
  assert.ok(first.state === 'unavailable' && first.reason === 'unreadable', `a copy that is there is not "not installed": ${JSON.stringify(first)}`)
  assert.ok(first.message.includes(codex), `it names the copy: ${first.message}`)
  assert.match(first.message, /exited with code 127/, 'and what it did')
}

test('a Codex whose launcher needs the login shell\'s PATH is run once that PATH lands', { skip: process.platform === 'win32', timeout: 30_000 }, async (t) => {
  // No schedule: this is the look the PATH's own arrival makes.
  const { host, runtime, codex, bin, tools } = await launcherMachine(t, { retryDelaysMs: [] })

  const applied = applyLoginShellPath({
    home: join(tools, 'home'),
    env: { SHELL: '/bin/sh', PATH: bin },
    exists: (path) => path === '/bin/sh',
    list: () => [],
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      return `__HARNESSDESK_PATH__${tools}:${bin}__HARNESSDESK_PATH__`
    },
  })
  // What `createDefaultHost` does with it.
  const pathAtStart = process.env['PATH']
  void applied.settled.then(() => {
    if (process.env['PATH'] !== pathAtStart) void host.retryProgramLookup()
  })

  await openedWithoutWaiting(host, runtime, codex)

  await applied.settled
  await until(() => runtime.health().state === 'ready', `the desk never ran the Codex once its PATH had node: ${JSON.stringify(runtime.health())}`)
  assert.equal(runtime.info.version, 'codex-cli 0.149.0')
})

test('and when nothing announces the PATH, the desk asks that Codex again on its own', { skip: process.platform === 'win32', timeout: 30_000 }, async (t) => {
  // The host's own schedule, unchanged; the PATH changes partway through and nothing says so.
  const { host, runtime, codex, bin, tools } = await launcherMachine(t)

  await openedWithoutWaiting(host, runtime, codex)
  process.env['PATH'] = `${tools}:${bin}`

  await until(() => runtime.health().state === 'ready', `the desk never asked again: ${JSON.stringify(runtime.health())}`)
  assert.equal(runtime.info.version, 'codex-cli 0.149.0')
})
