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

test('an ancestor link inside a project never becomes a flow layer', async () => {
  const scratch = tempDir('hd-flow-catalog-')
  const project = join(scratch, 'project')
  const outside = join(scratch, 'outside')
  await Promise.all([mkdir(project), mkdir(join(outside, 'flows'), { recursive: true })])
  await writeFile(join(outside, 'flows', 'escape.yml'), old('Outside'), 'utf8')
  await symlink(outside, join(project, '.harnessdesk'))

  const catalogue = new FlowCatalog({ confine: async () => {} })
  const entries = await catalogue.list(project)

  assert.equal(entries.length, 1)
  assert.notEqual(entries[0]?.id, 'escape')
  assert.match(entries[0]?.problem ?? '', /link|real directory/i)
})

test('a legacy .harnessdesk file still means this project has no flows', async () => {
  const scratch = tempDir('hd-flow-catalog-')
  const project = join(scratch, 'project')
  await mkdir(project)
  await writeFile(join(project, '.harnessdesk'), 'legacy project metadata', 'utf8')

  const catalogue = new FlowCatalog({ confine: async () => {}, legacyStrict: true })
  assert.deepEqual(await catalogue.list(project), [])
})

test('the flow layer refuses after 256 directory entries, including non-flow files', async () => {
  const scratch = tempDir('hd-flow-catalog-')
  const project = join(scratch, 'project')
  const flows = join(project, '.harnessdesk', 'flows')
  await mkdir(flows, { recursive: true })
  await Promise.all(Array.from({ length: 257 }, (_value, index) => writeFile(join(flows, `note-${index}`), '', 'utf8')))
  await writeFile(join(flows, 'review.yml'), old('Must not be partially listed'), 'utf8')

  const catalogue = new FlowCatalog({ confine: async () => {} })
  const entries = await catalogue.list(project)

  assert.deepEqual(entries.map((entry) => entry.id), ['__limit__'])
  assert.match(entries[0]?.problem ?? '', /256 entries/i)
})
