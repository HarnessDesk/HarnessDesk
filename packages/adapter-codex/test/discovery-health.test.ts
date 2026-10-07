import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { AgentEvent } from '@harnessdesk/protocol'

import { CodexRuntime } from '../src/index.js'

/**
 * What the window is told when Codex cannot be started.
 *
 * "Codex is not installed on this machine" is a sentence about the machine,
 * and it was the only one this runtime had for a failed lookup: a copy that was
 * there and would not answer got it too, with an install hint for a program
 * the person had installed. Found-but-silent now says which copy and what it
 * did, and what it says depends on whether asking again could change it; only a
 * machine with no copy says "not installed".
 */
const skip = process.platform === 'win32'

const folder = async (t: TestContext): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-codex-health-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const program = async (path: string, text: string): Promise<string> => {
  await writeFile(path, text)
  await chmod(path, 0o755)
  return path
}

test('a Codex that is there and will not run is reported as unreadable, with its reason, not as not installed', { skip }, async (t) => {
  const dir = await folder(t)
  const cli = await program(join(dir, 'codex'), '#!/bin/sh\necho "env: node: No such file or directory" >&2\nexit 127\n')
  const runtime = new CodexRuntime({ binaryPath: cli, clientName: 'harnessdesk-test' })
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))

  await assert.rejects(runtime.start())

  const health = runtime.health()
  assert.ok(health.state === 'unavailable', JSON.stringify(health))
  assert.equal(health.reason, 'unreadable', 'not the "install it" state, and one the host asks about again')
  assert.ok(health.message.includes(cli), `it names the copy: ${health.message}`)
  assert.match(health.message, /exited with code 127: env: node: No such file or directory/, 'and what it said')
  assert.doesNotMatch(health.message, /not installed/i)
  assert.match(health.remediation ?? '', /codex --version/, 'and the one thing worth trying meanwhile')
  const told = events.find((event) => event.type === 'error')
  assert.equal(told?.type === 'error' ? told.error.code : null, 'runtimeUnavailable', 'a window that listens for failures hears one')
})

test('a Codex that prints no version says what it printed, and offers nothing that would not help', { skip }, async (t) => {
  const dir = await folder(t)
  const cli = await program(join(dir, 'codex'), '#!/bin/sh\necho "hello"\n')
  const runtime = new CodexRuntime({ binaryPath: cli, clientName: 'harnessdesk-test' })
  t.after(() => runtime.dispose())

  await assert.rejects(runtime.start())

  const health = runtime.health()
  assert.ok(health.state === 'unavailable', JSON.stringify(health))
  assert.equal(health.reason, 'unknown', 'nothing a later ask or a PATH could change')
  assert.match(health.message, /printed no version number \("hello"\)/)
  assert.equal(health.remediation, undefined)
})

test('a Codex that is found and then cannot be started is not sent to `codex --version`', { skip }, async (t) => {
  const dir = await folder(t)
  // Answers the version question and removes itself: the spawn that follows finds nothing there.
  const cli = await program(join(dir, 'codex'), '#!/bin/sh\nif [ "$1" = --version ]; then echo "codex-cli 99.1.0"; rm -- "$0"; fi\n')
  const runtime = new CodexRuntime({ binaryPath: cli, clientName: 'harnessdesk-test' })
  t.after(() => runtime.dispose())

  await assert.rejects(runtime.start())

  const health = runtime.health()
  assert.ok(health.state === 'unavailable', JSON.stringify(health))
  assert.match(health.message, /Failed to spawn|Could not start codex app-server/, 'this is the app-server failing to start, which is not a lookup')
  assert.doesNotMatch(health.remediation ?? '', /codex --version/, 'running `--version` would not test what failed')
})

test('a machine with no Codex still says so, with the install hint', { skip }, async (t) => {
  const dir = await folder(t)
  const runtime = new CodexRuntime({ clientName: 'harnessdesk-test', discovery: { env: { PATH: dir }, locations: [] } })
  t.after(() => runtime.dispose())

  await assert.rejects(runtime.start())

  assert.deepEqual(runtime.health(), {
    state: 'unavailable',
    reason: 'notInstalled',
    message: 'Codex is not installed on this machine.',
    remediation: 'Install it with `brew install codex` or `npm i -g @openai/codex`.',
  })
})
