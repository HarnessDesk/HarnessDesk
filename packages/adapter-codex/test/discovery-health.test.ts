import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { CodexRuntime } from '../src/index.js'

/**
 * What the window is told when Codex cannot be started.
 *
 * "Codex is not installed on this machine" is a sentence about the machine,
 * and it was the only one this runtime had for a failed lookup: a copy that was
 * there and would not answer got it too, with an install hint for a program
 * the person had installed. Found-but-silent now says which copy and what it
 * did; only a machine with no copy says "not installed".
 */
const skip = process.platform === 'win32'

const folder = async (t: TestContext): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-codex-health-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('a Codex that is there and will not run is reported with its reason, not as not installed', { skip }, async (t) => {
  const dir = await folder(t)
  const cli = join(dir, 'codex')
  await writeFile(cli, '#!/bin/sh\necho "env: node: No such file or directory" >&2\nexit 127\n')
  await chmod(cli, 0o755)
  const runtime = new CodexRuntime({ binaryPath: cli, clientName: 'harnessdesk-test', discovery: { retryDelaysMs: [] } })
  t.after(() => runtime.dispose())

  await assert.rejects(runtime.start())

  const health = runtime.health()
  assert.ok(health.state === 'unavailable', JSON.stringify(health))
  assert.equal(health.reason, 'unknown', 'not the "install it" state')
  assert.ok(health.message.includes(cli), `it names the copy: ${health.message}`)
  assert.match(health.message, /exited with code 127: env: node: No such file or directory/, 'and what it said')
  assert.doesNotMatch(health.message, /not installed/i)
  assert.match(health.remediation ?? '', /codex --version/, 'and the one thing worth trying')
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
