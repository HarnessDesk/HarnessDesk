import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { LocalFiles } from '../src/workspace.js'

/**
 * #77: `stat` follows links, so `isSymlink` was false for every link, and a
 * link whose target was gone could not be described at all.
 */
test("a link says it is one, and its kind is its target's", { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-local-files-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'folder'))
  await writeFile(join(dir, 'file.txt'), 'x')
  await symlink(join(dir, 'folder'), join(dir, 'to-folder'))
  await symlink(join(dir, 'file.txt'), join(dir, 'to-file'))
  await symlink(join(dir, 'nowhere'), join(dir, 'dangling'))

  const files = new LocalFiles()
  const described = async (name: string) => {
    const { kind, isSymlink } = await files.stat(join(dir, name))
    return { kind, isSymlink }
  }
  assert.deepEqual(await described('folder'), { kind: 'directory', isSymlink: false })
  assert.deepEqual(await described('file.txt'), { kind: 'file', isSymlink: false })
  assert.deepEqual(await described('to-folder'), { kind: 'directory', isSymlink: true })
  assert.deepEqual(await described('to-file'), { kind: 'file', isSymlink: true })
  assert.deepEqual(await described('dangling'), { kind: 'other', isSymlink: true })
})
