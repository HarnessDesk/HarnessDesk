import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { internals } from '../src/index.js'

for (const body of ['', ' \n\t']) test(`empty skill definitions stay hollow (${JSON.stringify(body)})`, async t => {
  const root = await mkdtemp('/tmp/bugs-1675-skills-')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'empty'))
  await writeFile(join(root, 'empty', 'SKILL.md'), body)
  await writeFile(join(root, 'flat.md'), body)
  const copies = internals.readSkillRoot(root, { path: root, scope: 'user', scanned: true })
  assert.equal(copies.length, 2)
  for (const copy of copies) {
    assert.equal(copy.hollow, true)
    assert.equal(copy.digest, null)
  }
})
