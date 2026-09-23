import assert from 'node:assert/strict'
import { lstat, mkdir, readdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { ConfinedTree } from '../src/confined-tree.js'
import { tempDir } from './scratch.js'

/*
 * The threat model is a hostile static tree (docs/decisions.md): a cloned
 * repository's contents, planted links included. Every case below plants the
 * tree first and then asks the module to use it; none races a live process.
 */

const planted = async () => {
  const scratch = tempDir('hd-confined-')
  const project = join(scratch, 'project')
  const outside = join(scratch, 'outside')
  await mkdir(join(project, 'real', 'deeper'), { recursive: true })
  await mkdir(join(outside, 'deeper'), { recursive: true })
  await writeFile(join(outside, 'secret.yml'), 'outside bytes', 'utf8')
  await writeFile(join(outside, 'deeper', 'secret.yml'), 'outside bytes', 'utf8')
  await writeFile(join(project, 'real', 'deeper', 'file.yml'), 'inside bytes', 'utf8')
  return { scratch, project, outside }
}

for (const platform of ['darwin', 'linux'] as const) {
  test(`${platform}: a planted link in any ancestor or as the file itself is refused on read`, async () => {
    const { project, outside } = await planted()
    await symlink(outside, join(project, 'top'))
    await symlink(outside, join(project, 'real', 'middle'))
    await symlink(join(outside, 'secret.yml'), join(project, 'real', 'deeper', 'last.yml'))
    const tree = await ConfinedTree.open(project, { platform })

    assert.equal(await tree.read('real/deeper/file.yml', 1024), 'inside bytes')
    for (const rel of ['top/secret.yml', 'top/deeper/secret.yml', 'real/middle/deeper/secret.yml', 'real/deeper/last.yml']) {
      await assert.rejects(tree.read(rel, 1024), /link/i, rel)
    }
    await assert.rejects(tree.list('top', 16), /link/i)
    await assert.rejects(tree.list('real/middle/deeper', 16), /link/i)
  })
}

test('paths are relative, spelled with / and free of dot segments', async () => {
  const { project } = await planted()
  const tree = await ConfinedTree.open(project)
  for (const rel of ['../outside/secret.yml', 'real/../../outside/secret.yml', '/etc/hosts', 'real\\deeper\\file.yml', 'real//file.yml', './real', 'real/\0']) {
    await assert.rejects(tree.read(rel, 1024), /inside this folder/i, JSON.stringify(rel))
  }
})

test('a missing file or folder reads as nothing, a hard link, directory or oversized file refuses', async () => {
  const { project } = await planted()
  const tree = await ConfinedTree.open(project)
  assert.equal(await tree.read('real/missing.yml', 1024), null)
  assert.equal(await tree.list('nowhere', 16), null)
  await assert.rejects(tree.read('real/deeper', 1024), /regular file/i)
  await writeFile(join(project, 'big.yml'), 'x'.repeat(2048), 'utf8')
  await assert.rejects(tree.read('big.yml', 1024), /larger than/i)
  const { link } = await import('node:fs/promises')
  await link(join(project, 'real', 'deeper', 'file.yml'), join(project, 'twin.yml'))
  await assert.rejects(tree.read('twin.yml', 1024), /regular file/i)
})

test('a planted link is never written through, whether an ancestor or the target', async () => {
  const { project, outside } = await planted()
  await symlink(outside, join(project, 'top'))
  await symlink(join(outside, 'secret.yml'), join(project, 'real', 'target.yml'))
  const tree = await ConfinedTree.open(project)

  await assert.rejects(tree.ensureDir('top/new'), /link/i)
  await assert.rejects(tree.createFolder('top/agent', [['AGENT.md', 'planted']], '.tmp-'), /link/i)
  await assert.rejects(tree.replace('real/target.yml', 'outside bytes', 'replaced'), /link/i)
  await assert.rejects(tree.put('top/journal.json', 'planted'), /link/i)
  assert.deepEqual((await readdir(outside)).sort(), ['deeper', 'secret.yml'])
  assert.equal(await readFile(join(outside, 'secret.yml'), 'utf8'), 'outside bytes')
})

test('without an any-component no-follow open, every write refuses and nothing is written', async () => {
  const { project } = await planted()
  const tree = await ConfinedTree.open(project, { platform: 'linux' })
  assert.equal(tree.writable, false)
  await assert.rejects(tree.ensureDir('made'), /cannot change files/i)
  await assert.rejects(tree.createFolder('real/agent', [['AGENT.md', 'text']], '.tmp-'), /cannot change files/i)
  await assert.rejects(tree.replace('real/deeper/file.yml', 'inside bytes', 'after'), /cannot change files/i)
  await assert.rejects(tree.put('real/journal.json', 'text'), /cannot change files/i)
  assert.deepEqual((await readdir(project)).sort(), ['real'])
  assert.deepEqual((await readdir(join(project, 'real'))).sort(), ['deeper'])
  assert.equal(await readFile(join(project, 'real', 'deeper', 'file.yml'), 'utf8'), 'inside bytes')
})

test('replace renames a synced sibling over the target and never rewrites it in place', async () => {
  const { project } = await planted()
  const tree = await ConfinedTree.open(project)
  const path = join(project, 'real', 'deeper', 'file.yml')
  const before = await lstat(path)

  assert.equal(await tree.replace('real/deeper/file.yml', 'inside bytes', 'after'), 'replaced')
  const after = await lstat(path)
  assert.equal(await readFile(path, 'utf8'), 'after')
  assert.notEqual(after.ino, before.ino, 'an in-place write keeps the inode')
  assert.equal(after.mode & 0o777, before.mode & 0o777)
  assert.deepEqual(await readdir(join(project, 'real', 'deeper')), ['file.yml'])

  assert.equal(await tree.replace('real/deeper/file.yml', 'inside bytes', 'after'), 'unchanged')
  assert.equal((await lstat(path)).ino, after.ino)
})

test('replace refuses bytes that are neither the previewed before nor the after, leaving them and no temporary file', async () => {
  const { project } = await planted()
  const tree = await ConfinedTree.open(project)
  const path = join(project, 'real', 'deeper', 'file.yml')
  // Shorter than the previewed bytes, so only the byte comparison — not the size bound — can refuse it.
  await writeFile(path, 'edited', 'utf8')

  assert.equal(await tree.replace('real/deeper/file.yml', 'inside bytes', 'after'), 'changed')
  assert.equal(await readFile(path, 'utf8'), 'edited')
  assert.deepEqual(await readdir(join(project, 'real', 'deeper')), ['file.yml'])
})

test('put replaces host state by rename, so a reader sees the old or the new bytes, never a torn write', async () => {
  const { project } = await planted()
  const tree = await ConfinedTree.open(project)
  await tree.put('real/journal.json', 'first')
  const first = await lstat(join(project, 'real', 'journal.json'))
  await tree.put('real/journal.json', 'second')
  const second = await lstat(join(project, 'real', 'journal.json'))
  assert.equal(await readFile(join(project, 'real', 'journal.json'), 'utf8'), 'second')
  assert.notEqual(second.ino, first.ino)
  assert.deepEqual((await readdir(join(project, 'real'))).sort(), ['deeper', 'journal.json'])
})

test('createFolder is exclusive and leaves no temporary folder behind', async () => {
  const { project } = await planted()
  const tree = await ConfinedTree.open(project)
  await tree.ensureDir('made/agents')
  await tree.createFolder('made/agents/one', [['AGENT.md', 'brief']], '.tmp-')
  assert.equal(await readFile(join(project, 'made', 'agents', 'one', 'AGENT.md'), 'utf8'), 'brief')
  await mkdir(join(project, 'made', 'agents', 'empty'))
  await assert.rejects(tree.createFolder('made/agents/one', [['AGENT.md', 'other']], '.tmp-'), { code: 'EEXIST' })
  await assert.rejects(tree.createFolder('made/agents/empty', [['AGENT.md', 'other']], '.tmp-'), { code: 'EEXIST' })
  assert.equal(await readFile(join(project, 'made', 'agents', 'one', 'AGENT.md'), 'utf8'), 'brief')
  assert.deepEqual((await readdir(join(project, 'made', 'agents'))).sort(), ['empty', 'one'])
})

test('a root replaced after it was pinned is refused rather than used', async () => {
  const { scratch, project } = await planted()
  const pinned = await ConfinedTree.open(project)
  await rename(project, join(scratch, 'moved'))
  await mkdir(join(project, 'real', 'deeper'), { recursive: true })
  await writeFile(join(project, 'real', 'deeper', 'file.yml'), 'inside bytes', 'utf8')

  await assert.rejects(ConfinedTree.open(project, { expect: pinned.identity }), /folder changed/i)
  await assert.rejects(pinned.replace('real/deeper/file.yml', 'inside bytes', 'after'), /folder changed/i)
  assert.equal(await readFile(join(project, 'real', 'deeper', 'file.yml'), 'utf8'), 'inside bytes')
})
