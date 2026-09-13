import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { isDirectory as acpIsDirectory } from '@harnessdesk/adapter-acp'

import { isDirectory as hostIsDirectory } from '../src/host.js'

/**
 * Lockstep test for folder-existence predicates (#322).
 *
 * `isDirectory` exists in two places on purpose:
 * - `packages/server/src/host.ts` (async, used by the host on session listing to mark `folderGone`)
 * - `packages/adapter-acp/src/runtime.ts` (sync, used by ACP on session resume to refuse deleted folders)
 *
 * `@harnessdesk/protocol` is shared with the renderer where `node:fs` breaks
 * the browser bundle, and the host importing an adapter for a generic fs helper
 * is inverted layering.
 *
 * This table-driven test pins the two implementations to identical semantics
 * over all edge cases: directory, plain file, non-existent path, symlink to
 * directory, broken symlink, and denied parent traversal.
 */
test('host and adapter isDirectory predicates agree across all edge inputs (#322)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hd-is-dir-'))
  const lockedDir = join(root, 'locked')
  t.after(async () => {
    try {
      await chmod(lockedDir, 0o755)
    } catch {}
    await rm(root, { recursive: true, force: true })
  })

  const realDir = join(root, 'real-dir')
  await mkdir(realDir)

  const plainFile = join(root, 'plain-file.txt')
  await writeFile(plainFile, 'hello')

  const missingPath = join(root, 'does-not-exist')

  const dirSymlink = join(root, 'symlink-to-dir')
  await symlink(realDir, dirSymlink)

  const brokenSymlink = join(root, 'broken-symlink')
  await symlink(join(root, 'no-such-target'), brokenSymlink)

  await mkdir(lockedDir)
  const lockedChild = join(lockedDir, 'child')
  await mkdir(lockedChild)
  await chmod(lockedDir, 0o000)

  const cases = [
    { label: 'a directory', path: realDir, expected: true },
    { label: 'a plain file', path: plainFile, expected: false },
    { label: 'a path that does not exist', path: missingPath, expected: false },
    { label: 'a symlink to a directory', path: dirSymlink, expected: true },
    { label: 'a broken symlink', path: brokenSymlink, expected: false },
    { label: 'a path whose parent denies traversal', path: lockedChild, expected: false },
  ] as const

  for (const entry of cases) {
    const hostResult = await hostIsDirectory(entry.path)
    const acpResult = acpIsDirectory(entry.path)

    assert.equal(
      hostResult,
      entry.expected,
      `host isDirectory returned unexpected result for ${entry.label} (${entry.path})`,
    )
    assert.equal(
      acpResult,
      entry.expected,
      `acp isDirectory returned unexpected result for ${entry.label} (${entry.path})`,
    )
    assert.equal(
      hostResult,
      acpResult,
      `host and acp isDirectory disagreed for ${entry.label} (${entry.path}): host=${hostResult}, acp=${acpResult}`,
    )
  }
})
