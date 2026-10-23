import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { errnoOf } from '../src/errno.js'
import { canonicalTarget, isWithinPath } from '../src/path-confinement.js'

/**
 * Where a path really leads, the way the kernel would walk it.
 *
 * The tests build the layouts a cloned repository can carry: folders that are
 * links, links that lead nowhere yet, and links whose target goes `..` after
 * a link. Every expectation is a real path, so none of them is a spelling.
 */

const scratch = async (t: TestContext): Promise<string> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hd-path-confinement-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('an existing path is its real path, and names that are not there yet are kept', async (t) => {
  const dir = await scratch(t)
  await mkdir(join(dir, 'real'))
  await writeFile(join(dir, 'real', 'file.txt'), 'x')
  await symlink(join(dir, 'real'), join(dir, 'alias'))
  assert.equal(canonicalTarget(join(dir, 'alias', 'file.txt')), join(dir, 'real', 'file.txt'))
  assert.equal(canonicalTarget(join(dir, 'alias', 'missing', 'deeper.txt')), join(dir, 'real', 'missing', 'deeper.txt'))
})

test('a path below a file keeps its tail', async (t) => {
  const dir = await scratch(t)
  await writeFile(join(dir, 'file.txt'), 'x')
  assert.equal(canonicalTarget(join(dir, 'file.txt', 'child')), join(dir, 'file.txt', 'child'))
})

test('a dangling link names where it leads, read from the link\'s own real parent', async (t) => {
  const dir = await scratch(t)
  await mkdir(join(dir, 'a'))
  await mkdir(join(dir, 'b'))
  await symlink('../b/file.txt', join(dir, 'a', 'link'))
  await symlink(join(dir, 'b', 'later.txt'), join(dir, 'absolute'))
  assert.equal(canonicalTarget(join(dir, 'a', 'link')), join(dir, 'b', 'file.txt'))
  assert.equal(canonicalTarget(join(dir, 'absolute')), join(dir, 'b', 'later.txt'))
  // Names after a dangling link ride along: nothing can be made below it yet, but this is where they would be.
  assert.equal(canonicalTarget(join(dir, 'a', 'link', 'deeper', 'file.txt')), join(dir, 'b', 'file.txt', 'deeper', 'file.txt'))
})

test('a chain of dangling links is followed to its end', async (t) => {
  const dir = await scratch(t)
  await mkdir(join(dir, 'a'))
  await mkdir(join(dir, 'b'))
  await symlink('second', join(dir, 'a', 'first'))
  await symlink('../b/third', join(dir, 'a', 'second'))
  await symlink(join(dir, 'b', 'end.txt'), join(dir, 'b', 'third'))
  assert.equal(canonicalTarget(join(dir, 'a', 'first')), join(dir, 'b', 'end.txt'))
})

/**
 * The folder `..` applies to is the one a link led to, not the one the text
 * before it names. Read as text, `sub/../x` is a sibling of `sub`; the kernel
 * goes up from wherever `sub` leads. A cloned repository can carry both links.
 */
test('".." in a dangling link\'s target goes up from the folder a link reached', async (t) => {
  const dir = await scratch(t)
  const root = join(dir, 'project')
  await mkdir(root)
  await mkdir(join(dir, 'elsewhere', 'dir'), { recursive: true })
  await symlink(join(dir, 'elsewhere', 'dir'), join(root, 'sub'))
  await symlink('sub/../x', join(root, 'new'))
  await symlink('./sub/./../x', join(root, 'dotted'))
  await symlink('sub/../../y', join(root, 'two-up'))
  await mkdir(join(root, 'nested'))
  await symlink('../sub/../z', join(root, 'nested', 'from-nested'))
  assert.equal(canonicalTarget(join(root, 'new')), join(dir, 'elsewhere', 'x'))
  assert.equal(canonicalTarget(join(root, 'dotted')), join(dir, 'elsewhere', 'x'))
  assert.equal(canonicalTarget(join(root, 'two-up')), join(dir, 'y'))
  assert.equal(canonicalTarget(join(root, 'nested', 'from-nested')), join(dir, 'elsewhere', 'z'))
  // The same spelling reached through the link in the middle of a longer path.
  assert.equal(canonicalTarget(join(root, 'sub', 'new-file.txt')), join(dir, 'elsewhere', 'dir', 'new-file.txt'))
})

test('".." in a dangling link\'s target stays inside the project when the link it passes through does', async (t) => {
  const dir = await scratch(t)
  const root = join(dir, 'project')
  await mkdir(join(root, 'real', 'deep'), { recursive: true })
  await symlink(join(root, 'real', 'deep'), join(root, 'sub'))
  await symlink('sub/../x', join(root, 'new'))
  // The text reads as project/x. The file the link names is project/real/x.
  assert.equal(canonicalTarget(join(root, 'new')), join(root, 'real', 'x'))
})

test('a link followed on the way to a dangling target is followed too', async (t) => {
  const dir = await scratch(t)
  const root = join(dir, 'project')
  await mkdir(join(dir, 'elsewhere', 'dir'), { recursive: true })
  await mkdir(root)
  await symlink(join(dir, 'elsewhere', 'dir'), join(root, 'sub'))
  // `via` resolves to the folder above `sub`'s target, so `via/x` is elsewhere/x.
  await symlink('sub/..', join(root, 'via'))
  await symlink('via/x', join(root, 'new'))
  // An absolute target starts over from the root of the filesystem. Spelled by hand: `join` would collapse the `..`.
  await symlink(`${join(root, 'sub')}/../y`, join(root, 'absolute'))
  assert.equal(canonicalTarget(join(root, 'new')), join(dir, 'elsewhere', 'x'))
  assert.equal(canonicalTarget(join(root, 'absolute')), join(dir, 'elsewhere', 'y'))
})

test('".." after a name that does not exist has no destination to name', async (t) => {
  const dir = await scratch(t)
  const root = join(dir, 'project')
  await mkdir(root)
  await symlink('nothing/../x', join(root, 'new'))
  await symlink('nowhere', join(root, 'dangling'))
  await symlink('dangling/../y', join(root, 'through-dangling'))
  for (const name of ['new', 'through-dangling']) {
    assert.throws(() => canonicalTarget(join(root, name)), (error: unknown) => errnoOf(error) === 'ENOENT', name)
  }
})

test('a link loop is raised, and so is a chain longer than the system follows', async (t) => {
  const dir = await scratch(t)
  await symlink('loop', join(dir, 'loop'))
  await symlink('b', join(dir, 'a'))
  await symlink('a', join(dir, 'b'))
  for (let index = 0; index < 60; index += 1) await symlink(`chain-${index + 1}`, join(dir, `chain-${index}`))
  for (const name of ['loop', 'a', 'chain-0', join('loop', 'file.txt')]) {
    assert.throws(() => canonicalTarget(join(dir, name)), (error: unknown) => errnoOf(error) === 'ELOOP', name)
  }
})

test('a folder that cannot be searched is raised, never skipped', async (t) => {
  const dir = await scratch(t)
  const locked = join(dir, 'locked')
  await mkdir(locked)
  await writeFile(join(locked, 'file.txt'), 'x')
  await chmod(locked, 0o000)
  try {
    // Modes do not apply to root, so there is no refusal here to observe.
    if (await readdir(locked).then(() => true, () => false)) return t.skip('this user can read a directory with mode 000')
    assert.throws(() => canonicalTarget(join(locked, 'file.txt')), (error: unknown) => errnoOf(error) === 'EACCES')
  } finally {
    await chmod(locked, 0o700)
  }
})

test('a path is within a root when it is the root or below it, and not when it only shares a prefix', () => {
  assert.equal(isWithinPath('/a/b', '/a/b'), true)
  assert.equal(isWithinPath('/a/b', '/a/b/c/d'), true)
  assert.equal(isWithinPath('/a/b', '/a/b/..c'), true, 'a name that starts with dots is still a name')
  assert.equal(isWithinPath('/a/b', '/a/bc'), false)
  assert.equal(isWithinPath('/a/b', '/a'), false)
  assert.equal(isWithinPath('/a/b', '/a/b/../c'), false)
})
