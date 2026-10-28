import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { packagedPath, preferUnpackedPath } from '../src/node.js'

test('the Node entry owns the shared archive-to-filesystem path rule', () => {
  assert.equal(packagedPath(join('/demo', 'app.asar', 'node_modules', 'lead', 'child.js')),
    join('/demo', 'app.asar.unpacked', 'node_modules', 'lead', 'child.js'))
  for (const path of [join('/demo', 'packages', 'lead', 'child.js'), join('/demo', 'app.asar.unpacked', 'child.js'), join('/demo', 'my-app.asar', 'child.js')]) {
    assert.equal(packagedPath(path), path)
  }
})

test('prefer the physical twin only while it exists, otherwise preserve the original entry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hd-packaged-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const original = join(root, 'app.asar', 'node_modules', 'lead', 'child.js')
  const unpacked = join(root, 'app.asar.unpacked', 'node_modules', 'lead', 'child.js')
  assert.equal(preferUnpackedPath(original), original)
  await mkdir(dirname(unpacked), { recursive: true })
  await writeFile(unpacked, 'fixture')
  assert.equal(preferUnpackedPath(original), unpacked)
  await rm(unpacked)
  assert.equal(preferUnpackedPath(original), original)
  const development = join(root, 'packages', 'lead', 'child.js')
  assert.equal(preferUnpackedPath(development), development)
})
