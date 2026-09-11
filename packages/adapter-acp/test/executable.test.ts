import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveExecutable, versionIn } from '../src/executable.js'

/**
 * Finding the agent CLI a bridge should drive. The lookups are injected: the
 * test is about what the adapter does with an answer, not about PATH.
 */

test('versionIn pulls the release triple out of whatever --version printed', () => {
  assert.equal(versionIn('2.1.240 (Claude Code)'), '2.1.240')
  assert.equal(versionIn('codex-cli 0.149.0-alpha.4.1'), '0.149.0-alpha.4.1')
  assert.equal(versionIn('2026.08.11-e8db854'), '2026.08.11-e8db854')
  assert.equal(versionIn('nightly'), 'nightly')
  assert.equal(versionIn(''), null)
  assert.equal(versionIn(null), null)
})

test('a CLI on PATH resolves to its path and version', async () => {
  const found = await resolveExecutable(
    { command: 'claude', env: 'CLAUDE_CODE_EXECUTABLE' },
    {
      which: async (command) => (command === 'claude' ? '/opt/bin/claude' : null),
      versionOf: async (path, args) => {
        assert.equal(path, '/opt/bin/claude')
        assert.deepEqual(args, ['--version'])
        return '2.1.240 (Claude Code)'
      },
    },
  )
  assert.deepEqual(found, { path: '/opt/bin/claude', version: '2.1.240' })
})

test('an absolute command skips the PATH lookup, and custom version arguments are passed', async () => {
  const found = await resolveExecutable(
    { command: '/usr/local/bin/agent', env: 'AGENT_BIN', versionArgs: ['version', '--short'] },
    {
      which: async () => {
        throw new Error('must not be consulted for an absolute path')
      },
      versionOf: async (_path, args) => (args.join(' ') === 'version --short' ? '3.0.0' : null),
    },
  )
  assert.deepEqual(found, { path: '/usr/local/bin/agent', version: '3.0.0' })
})

test('a CLI that is not installed is null, never a throw', async () => {
  const found = await resolveExecutable(
    { command: 'claude', env: 'CLAUDE_CODE_EXECUTABLE' },
    { which: async () => null, versionOf: async () => 'never' },
  )
  assert.equal(found, null)
})

test('a CLI that cannot print a version is still driven', async () => {
  const found = await resolveExecutable(
    { command: 'agent', env: 'AGENT_BIN' },
    { which: async () => '/x/agent', versionOf: async () => null },
  )
  assert.deepEqual(found, { path: '/x/agent', version: null })
})

test('with no lookup given, a CLI on PATH is found by walking PATH (#129)', async (t) => {
  const { chmodSync, mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'hd-which-'))
  const cli = join(dir, 'hd-fake-cli')
  writeFileSync(cli, '#!/bin/sh\necho 1.2.3\n')
  chmodSync(cli, 0o755)
  const path = process.env['PATH']
  process.env['PATH'] = dir
  t.after(() => {
    process.env['PATH'] = path
  })
  const found = await resolveExecutable({ command: 'hd-fake-cli', env: 'HD_FAKE_CLI_EXECUTABLE' }, { versionOf: async () => '1.2.3' })
  assert.deepEqual(found, { path: cli, version: '1.2.3' })
})
