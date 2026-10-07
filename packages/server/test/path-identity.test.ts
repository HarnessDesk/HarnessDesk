import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'

import { canonicalPath, sameCanonicalPath, withCanonicalPaths } from '../src/path-identity.js'
import { samePath } from '../src/worktree.js'
import { tempDir } from './scratch.js'

const fixture = () => {
  const base = realpathSync.native(tempDir('hd-path-identity-'))
  const folder = join(base, 'folder')
  const alias = join(base, 'alias')
  mkdirSync(folder)
  symlinkSync(folder, alias, 'dir')
  return { base, folder, alias }
}

const countCalls = (t: TestContext) => {
  let calls = 0
  const native = realpathSync.native
  t.mock.method(realpathSync, 'native', new Proxy(native, {
    apply(target, receiver, args) { calls++; return Reflect.apply(target, receiver, args) },
  }))
  return () => calls
}

test('a computation shares canonical endpoints across nested reads and awaits', async (t) => {
  const { folder, alias } = fixture()
  const calls = countCalls(t)
  await withCanonicalPaths(async () => {
    for (let n = 0; n < 300; n++) assert.equal(sameCanonicalPath(alias, folder), true)
    assert.equal(calls(), 1, 'the native endpoint is not resolved again')
    await Promise.resolve()
    withCanonicalPaths(() => assert.equal(canonicalPath(alias), folder))
    assert.equal(samePath(folder, folder), true)
    assert.equal(calls(), 1, 'comparisons and nested reads need no extra filesystem calls')
  })
  withCanonicalPaths(() => assert.equal(canonicalPath(alias), folder))
  assert.equal(calls(), 2, 'the next computation reads the filesystem again')
})

test('retarget, rename, deletion and recreation are visible to the next computation', () => {
  const { base, folder, alias } = fixture()
  const other = join(base, 'other')
  mkdirSync(other)
  const read = () => withCanonicalPaths(() => canonicalPath(alias))
  assert.equal(read(), folder)
  rmSync(alias)
  symlinkSync(other, alias, 'dir')
  assert.equal(read(), other)
  const renamed = join(base, 'renamed')
  renameSync(other, renamed)
  assert.equal(read(), resolve(alias), 'a dangling alias keeps lexical historical identity')
  withCanonicalPaths(() => assert.equal(canonicalPath(other), resolve(other)))
  assert.equal(withCanonicalPaths(() => canonicalPath(renamed)), renamed)
  rmSync(alias)
  assert.equal(read(), resolve(alias), 'a missing folder is not a stale alias')
  symlinkSync(renamed, alias, 'dir')
  assert.equal(read(), renamed, 'a failed lookup is not retained for a recreated folder')
})

test('symlink followed by dotdot keeps native filesystem semantics', () => {
  const { base, alias, folder } = fixture()
  const nested = join(folder, 'nested')
  mkdirSync(nested)
  const link = join(base, 'nested-link')
  symlinkSync(nested, link, 'dir')
  withCanonicalPaths(() => {
    assert.equal(canonicalPath(`${link}/..`), folder)
    assert.equal(sameCanonicalPath(`${link}/..`, alias), true)
    assert.equal(sameCanonicalPath(`${link}/..`, base), false)
  })
})

test('concurrent computations have independent snapshots', async () => {
  const { base, folder, alias } = fixture()
  const other = join(base, 'other')
  mkdirSync(other)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const first = withCanonicalPaths(async () => {
    assert.equal(canonicalPath(alias), folder)
    await held
    assert.equal(canonicalPath(alias), folder, 'the in-progress read keeps its snapshot')
  })
  rmSync(alias)
  symlinkSync(other, alias, 'dir')
  await withCanonicalPaths(async () => {
    await Promise.resolve()
    assert.equal(canonicalPath(alias), other, 'a separate read sees the changed alias')
  })
  release()
  await first
})

test('finished, thrown and rejected computations release inherited caches', async () => {
  const { base, folder, alias } = fixture()
  const other = join(base, 'other')
  mkdirSync(other)
  for (const ending of ['return', 'throw', 'reject'] as const) {
    rmSync(alias)
    symlinkSync(folder, alias, 'dir')
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let detached!: Promise<string>
    const read = () => {
      assert.equal(canonicalPath(alias), folder)
      detached = held.then(() => canonicalPath(alias))
      if (ending === 'throw') throw new Error('read failed')
      if (ending === 'reject') return Promise.reject(new Error('read failed'))
      return undefined
    }
    if (ending === 'throw') assert.throws(() => withCanonicalPaths(read), /read failed/)
    else if (ending === 'reject') await assert.rejects(withCanonicalPaths(read)!, /read failed/)
    else withCanonicalPaths(read)
    rmSync(alias)
    symlinkSync(other, alias, 'dir')
    release()
    assert.equal(await detached, other, `${ending} must not retain a cache in detached work`)
  }
})
