import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { FlowCatalog } from '../src/flow-catalog.js'
import { tempDir } from './scratch.js'

const old = (name: string) => `
name: ${name}
roles:
  writer: { kind: agent, seat: fixture=writer, order: Write, outcomes: [done] }
seed: { role: writer, title: Write }
`

test('nearest broken flow shadows farther valid flow', async () => {
  const scratch = tempDir('hd-flow-catalog-')
  const project = join(scratch, 'project')
  const user = join(scratch, 'user')
  const builtin = join(scratch, 'builtin')
  await Promise.all([mkdir(join(project, '.harnessdesk', 'flows'), { recursive: true }), mkdir(user), mkdir(builtin)])
  await writeFile(join(project, '.harnessdesk', 'flows', 'review.yml'), 'name: [broken\n', 'utf8')
  await writeFile(join(user, 'review.yml'), old('Personal review'), 'utf8')
  await writeFile(join(builtin, 'review.yaml'), old('Built in review'), 'utf8')

  const catalogue = new FlowCatalog({ userRoot: user, builtinRoot: builtin, confine: async () => {} })
  const [entry] = await catalogue.list(project)
  assert.equal(entry?.origin, 'project')
  assert.equal(entry?.format, null)
  assert.match(entry?.problem ?? '', /line|flow|map/i)
  assert.deepEqual(entry?.shadows.map((shadow) => shadow.origin), ['user', 'builtin'])
})

test('links traversal duplicate extensions and oversized files refuse without escape', async () => {
  const scratch = tempDir('hd-flow-catalog-')
  const project = join(scratch, 'project')
  const outside = join(scratch, 'outside')
  const user = join(scratch, 'user')
  const builtin = join(scratch, 'builtin')
  await Promise.all([mkdir(project), mkdir(outside), mkdir(user), mkdir(builtin)])
  await writeFile(join(outside, 'escape.yml'), old('Outside'), 'utf8')
  await mkdir(join(project, '.harnessdesk'))
  await symlink(outside, join(project, '.harnessdesk', 'flows'))
  const catalogue = new FlowCatalog({ userRoot: user, builtinRoot: builtin, confine: async () => {} })

  const entries = await catalogue.list(project)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.origin, 'project')
  assert.match(entries[0]?.problem ?? '', /link|real directory/i)
  await assert.rejects(catalogue.read(project, '../escape.yml'), /directly inside|somewhere else/i)
  await assert.rejects(catalogue.read(project, '.harnessdesk\\flows\\escape.yml'), /directly inside|somewhere else/i)
})
