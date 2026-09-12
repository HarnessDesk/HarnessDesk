import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CodexError,
  compareVersions,
  discoverCodex,
  MINIMUM_CODEX_VERSION,
  newestOf,
  parseVersion,
  requireCodex,
} from '../src/index.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

test('parseVersion reads the numeric triple out of CLI output', () => {
  assert.deepEqual(parseVersion('codex-cli 0.135.0'), [0, 135, 0])
  assert.deepEqual(parseVersion('1.2.3-alpha.4'), [1, 2, 3])
  assert.equal(parseVersion('no numbers here'), null)
})

test('compareVersions orders by major, then minor, then patch', () => {
  assert.ok(compareVersions([0, 135, 0], [0, 100, 0]) > 0)
  assert.ok(compareVersions([0, 99, 9], [0, 100, 0]) < 0)
  assert.equal(compareVersions([1, 0, 0], [1, 0, 0]), 0)
  assert.ok(compareVersions([1, 0, 0], [0, 999, 999]) > 0)
})

test('an explicit override is probed and returned', async () => {
  const found = await discoverCodex(FAKE)
  assert.equal(found?.path, FAKE)
  assert.deepEqual(found?.semver, [0, 149, 0])
})

test('a missing override fails with actionable text', async () => {
  await assert.rejects(
    () => discoverCodex('/definitely/not/a/real/codex'),
    (error: unknown) => error instanceof CodexError && error.code === 'notInstalled',
  )
})

test('requireCodex refuses a version below the minimum', async () => {
  process.env['FAKE_CODEX_VERSION'] = '0.42.0'
  try {
    await assert.rejects(
      () => requireCodex(FAKE),
      (error: unknown) => error instanceof CodexError && error.code === 'versionTooOld',
    )
  } finally {
    delete process.env['FAKE_CODEX_VERSION']
  }
})

test('requireCodex accepts a supported version', async () => {
  const found = await requireCodex(FAKE)
  assert.equal(found.path, FAKE)
})

test('newestOf picks the highest version and folds symlinked duplicates', () => {
  const at = (path: string, version: string) => ({
    path,
    version,
    semver: parseVersion(version) as [number, number, number],
  })
  // The fixture is real, so its realpath resolves; the other paths do not
  // exist and fall back to themselves.
  assert.equal(newestOf([at('/a/codex', '0.135.0'), null, at('/b/codex', '0.149.0')])?.path, '/b/codex')
  // First wins among equals: PATH's entry comes first, so it is kept.
  assert.equal(newestOf([at('/path/codex', '0.140.0'), at('/brew/codex', '0.140.0')])?.path, '/path/codex')
  assert.equal(newestOf([at(FAKE, '0.135.0'), at(FAKE, '0.135.0')])?.path, FAKE)
  assert.equal(newestOf([null, null]), null)
})

test('discovery without an override runs the newest Codex it can find', async () => {
  // The fixture reports 0.149.0; whatever else is installed on this machine
  // is only chosen if it is newer, so the result is never older than that.
  const found = await discoverCodex(null)
  if (found) assert.ok(compareVersions(found.semver, MINIMUM_CODEX_VERSION) >= 0)
})

/**
 * The PATH walk, which is what discovery does now instead of running
 * `/usr/bin/which` (#129) — absent on Windows and on minimal images, where the
 * spawn threw `ENOENT`, the `catch` answered null, and Codex read as *not
 * installed* beside an installed Codex.
 *
 * The one test that reached this line asked `if (found)` before asserting
 * anything, so it passed identically whether the walk worked or answered null
 * on every machine; the adapter-acp half of this change got a real test and
 * this half did not (review of #228, round 2). The fake reports a version
 * above anything a real machine can have, so `newestOf` picks it over whatever
 * is installed here and the assertion is about the walk rather than about the
 * desk it runs on. Skipped on Windows, where an extensionless file marked
 * executable is neither: there the walk rightly looks only for PATHEXT names,
 * as the server's own test of it says.
 */
test('with no override, Codex is found by walking PATH (#129)', { skip: process.platform === 'win32' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hd-codex-path-'))
  const cli = join(dir, 'codex')
  writeFileSync(cli, '#!/bin/sh\necho codex-cli 99.0.0\n')
  chmodSync(cli, 0o755)
  const path = process.env['PATH']
  process.env['PATH'] = dir
  t.after(() => {
    process.env['PATH'] = path
  })
  const found = await discoverCodex(null)
  assert.equal(found?.path, cli)
  assert.deepEqual(found?.semver, [99, 0, 0])
})
