import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { FlowCatalog } from '../src/flow-catalog.js'
import { FlowUpdates, applyMigration, type MigrationPort } from '../src/flow-update.js'
import { parseAgentDefinition } from '../src/agent-def.js'
import { parseFlowPolicy } from '../src/flow-policy.js'
import { tempDir } from './scratch.js'

const legacy = `
name: Old review
description: Keep this exact meaning.
roles:
  writer:
    kind: agent
    seat: [fixture=writer, fixture=reviewer]
    count: 2
    permission: read
    isolate: true
    order: Write the change.
    outcomes: [done, blocked]
  person:
    kind: person
    outcomes: [approved]
seed: { role: writer, title: Write }
rules:
  - { id: handoff, on: writer, when: { every: done }, then: { role: person, title: Decide } }
`

const setup = async () => {
  const scratch = tempDir('hd-flow-update-')
  const project = join(scratch, 'project')
  const state = join(scratch, 'state')
  const user = join(scratch, 'user')
  const builtin = join(scratch, 'builtin')
  await Promise.all([mkdir(join(project, '.harnessdesk', 'flows'), { recursive: true }), mkdir(state), mkdir(user), mkdir(builtin)])
  const path = join(project, '.harnessdesk', 'flows', 'review.yml')
  await writeFile(path, legacy, 'utf8')
  const catalogue = new FlowCatalog({ userRoot: user, builtinRoot: builtin, confine: async () => {} })
  return { project, path, state, catalogue, updates: new FlowUpdates({ stateDir: state, catalogue }) }
}

test('read permission converts to edit in both places', async () => {
  const { project, updates } = await setup()
  const preview = await updates.preview(project, 'review')
  assert.equal(preview.problems.filter((problem) => problem.level === 'error').length, 0)
  assert.equal(preview.edits.length, 2)
  const agent = preview.edits.find((edit) => edit.path.endsWith('/AGENT.md'))
  const flow = preview.edits.at(-1)
  assert.match(agent?.after ?? '', /ceiling: edit/)
  assert.deepEqual(parseAgentDefinition(agent?.after ?? '', 'review-writer').agent?.answers, ['done', 'blocked'])
  const parsed = parseFlowPolicy(flow?.after ?? '')
  assert.equal(parsed.document?.format, 'agents')
  const writer = parsed.document?.format === 'agents' ? parsed.document.flow.roles.find((role) => role.id === 'writer') : null
  assert.equal(writer?.kind === 'agent' ? writer.grant : null, 'edit')
  assert.deepEqual(writer?.kind === 'agent' ? writer.seats : [], [{ runtime: 'fixture', model: 'writer' }, { runtime: 'fixture', model: 'reviewer' }])
})

test('migration writes Agents before flow and replays idempotently', async () => {
  const writes: string[] = []
  const files = new Map<string, string>([['flow', 'before']])
  const recorded = new Set<string>()
  const port: MigrationPort = {
    read: async (path) => files.get(path) ?? null,
    record: async (path) => { writes.push(`record:${path}`); recorded.add(path) },
    recorded: async (path) => recorded.has(path),
    create: async (path, after) => { writes.push(`create:${path}`); files.set(path, after) },
    replace: async (path, before, after) => { writes.push(`replace:${path}`); assert.equal(files.get(path), before); files.set(path, after) },
  }
  const edits = [{ path: 'agent-a', before: null, after: 'a' }, { path: 'agent-b', before: null, after: 'b' }, { path: 'flow', before: 'before', after: 'after' }]
  await applyMigration(edits, port)
  assert.deepEqual(writes, ['record:agent-a', 'create:agent-a', 'record:agent-b', 'create:agent-b', 'replace:flow'])
  writes.length = 0
  await applyMigration(edits, port)
  assert.deepEqual(writes, [])
})

test('migration refuses colliding Agent and changed flow without writes', async () => {
  const { project, path, updates } = await setup()
  const preview = await updates.preview(project, 'review')
  await mkdir(join(project, '.harnessdesk', 'agents', 'review-writer'), { recursive: true })
  await writeFile(join(project, '.harnessdesk', 'agents', 'review-writer', 'AGENT.md'), 'unrelated', 'utf8')
  const collision = await updates.apply(project, preview.token)
  assert.equal(collision.state, 'refused')
  assert.match(collision.message, /already exists/i)
  assert.equal(await readFile(path, 'utf8'), legacy)
})

test('a changed flow after preview is refused before any Agent is created', async () => {
  const { project, path, updates } = await setup()
  const preview = await updates.preview(project, 'review')
  await writeFile(path, legacy.replace('Old review', 'Edited after preview'), 'utf8')
  const changed = await updates.apply(project, preview.token)
  assert.equal(changed.state, 'refused')
  assert.match(changed.message, /changed after the preview/i)
  await assert.rejects(readFile(join(project, '.harnessdesk', 'agents'), 'utf8'))
})

test('interrupted creation leaves the flow untouched and a journaled replay creates only what remains', async () => {
  const files = new Map<string, string>([['flow', 'before']])
  const recorded = new Set<string>()
  let fail = true
  const port: MigrationPort = {
    read: async (path) => files.get(path) ?? null,
    record: async (path) => { recorded.add(path) },
    recorded: async (path) => recorded.has(path),
    create: async (path, after) => {
      if (path === 'agent-b' && fail) throw new Error('interrupted')
      files.set(path, after)
    },
    replace: async (path, before, after) => { assert.equal(files.get(path), before); files.set(path, after) },
  }
  const edits = [{ path: 'agent-a', before: null, after: 'a' }, { path: 'agent-b', before: null, after: 'b' }, { path: 'flow', before: 'before', after: 'after' }]
  await assert.rejects(applyMigration(edits, port), /interrupted/)
  assert.equal(files.get('flow'), 'before')
  assert.equal(files.get('agent-a'), 'a')
  fail = false
  await applyMigration(edits, port)
  assert.deepEqual(Object.fromEntries(files), { flow: 'after', 'agent-a': 'a', 'agent-b': 'b' })
})

test('unapproved or expired update token writes nothing', async () => {
  const { project, updates } = await setup()
  const refused = await updates.apply(project, 'not-a-token')
  assert.equal(refused.state, 'refused')
  await assert.rejects(readFile(join(project, '.harnessdesk', 'agents'), 'utf8'))
})

test('an interrupted yaml conversion resumes the journaled source path', async () => {
  const { project, path, state, catalogue, updates } = await setup()
  const yaml = path.replace(/\.yml$/, '.yaml')
  await rename(path, yaml)
  const preview = await updates.preview(project, 'review')
  assert.equal(preview.problems.filter((problem) => problem.level === 'error').length, 0)

  const resumed = await new FlowUpdates({ stateDir: state, catalogue }).preview(project, 'review')
  assert.equal(resumed.resuming, true)
  assert.equal(resumed.edits.at(-1)?.path, '.harnessdesk/flows/review.yaml')
})

test('an invalid conversion preview is not persisted or resumed', async () => {
  const { project, state, catalogue, updates } = await setup()
  await writeFile(join(project, '.harnessdesk', 'flows', 'Review!.yml'), legacy, 'utf8')
  const invalid = await updates.preview(project, 'Review!')
  assert.ok(invalid.problems.some((problem) => problem.level === 'error'))
  await assert.rejects(readdir(join(state, 'flow-updates')), { code: 'ENOENT' })

  const retried = await new FlowUpdates({ stateDir: state, catalogue }).preview(project, 'Review!')
  assert.equal(retried.resuming, false)
  assert.ok(retried.problems.some((problem) => problem.level === 'error'))
})

test('a corrupt conversion journal refuses instead of starting a new update', async () => {
  const { project, state, updates } = await setup()
  const canonical = await realpath(project)
  const journal = join(state, 'flow-updates', `${Buffer.from(`${canonical}\0review`).toString('base64url')}.json`)
  await mkdir(join(state, 'flow-updates'), { recursive: true })
  await writeFile(journal, '{not json', 'utf8')

  await assert.rejects(updates.preview(project, 'review'), /saved flow update.*unreadable|invalid/i)
})

test('an unreadable conversion journal refuses instead of starting a new update', async () => {
  const { project, state, updates } = await setup()
  const canonical = await realpath(project)
  const journal = join(state, 'flow-updates', `${Buffer.from(`${canonical}\0review`).toString('base64url')}.json`)
  await mkdir(journal, { recursive: true })

  await assert.rejects(updates.preview(project, 'review'), /saved flow update.*unreadable/i)
})

test('a valid preview replaces its confined source only after Agent files exist', async () => {
  const { project, path, updates } = await setup()
  const preview = await updates.preview(project, 'review')

  const applied = await updates.apply(project, preview.token)
  assert.equal(applied.state, 'applied')
  assert.deepEqual(applied.written, ['.harnessdesk/agents/review-writer/AGENT.md'])
  assert.match(await readFile(path, 'utf8'), /version: 2/)
})

test('an ancestor link swapped in after preview is refused before the update rereads its flow', async () => {
  const { project, path, updates } = await setup()
  const preview = await updates.preview(project, 'review')
  const outside = join(project, '..', 'outside')
  await mkdir(join(outside, 'flows'), { recursive: true })
  await writeFile(join(outside, 'flows', 'review.yml'), await readFile(path, 'utf8'), 'utf8')
  await rm(join(project, '.harnessdesk'), { recursive: true, force: true })
  await symlink(outside, join(project, '.harnessdesk'))

  const result = await updates.apply(project, preview.token)
  assert.equal(result.state, 'refused')
  assert.match(result.message, /flow folder.*link|real directory/i)
  assert.equal(await readFile(join(outside, 'flows', 'review.yml'), 'utf8'), legacy)
})
