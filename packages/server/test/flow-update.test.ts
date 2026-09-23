import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, realpath, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
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
  const journal = join(state, 'flow-updates', `${createHash('sha256').update(`${canonical}\0review`).digest('hex')}.json`)
  await mkdir(join(state, 'flow-updates'), { recursive: true })
  await writeFile(journal, '{not json', 'utf8')

  await assert.rejects(updates.preview(project, 'review'), /saved flow update.*unreadable|invalid/i)
})

test('an unreadable conversion journal refuses instead of starting a new update', async () => {
  const { project, state, updates } = await setup()
  const canonical = await realpath(project)
  const journal = join(state, 'flow-updates', `${createHash('sha256').update(`${canonical}\0review`).digest('hex')}.json`)
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

test('an ancestor link planted after preview is refused before the update rereads its flow', async () => {
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

const twoAgents = `
name: Pair review
roles:
  writer: { kind: agent, seat: fixture=writer, permission: publish, order: Write., outcomes: [done] }
  checker: { kind: agent, seat: fixture=checker, permission: read, order: Check., outcomes: [done] }
seed: { role: writer, title: Write }
rules:
  - { id: check, on: writer, when: { every: done }, then: { role: checker, title: Check } }
`

test('the flow and its journal are replaced by rename, never rewritten in place', async () => {
  const { project, path, state, updates } = await setup()
  const preview = await updates.preview(project, 'review')
  const journal = join(state, 'flow-updates', `${createHash('sha256').update(`${await realpath(project)}\0review`).digest('hex')}.json`)
  const journalBefore = await lstat(journal)
  const flowBefore = await lstat(path)

  assert.equal((await updates.apply(project, preview.token)).state, 'applied')
  assert.notEqual((await lstat(path)).ino, flowBefore.ino, 'the flow was truncated and rewritten in place')
  assert.notEqual((await lstat(journal)).ino, journalBefore.ino, 'the journal was truncated and rewritten in place')
  assert.deepEqual(await readdir(join(project, '.harnessdesk', 'flows')), ['review.yml'])
  assert.deepEqual(await readdir(join(project, '.harnessdesk', 'agents')), ['review-writer'])
  assert.deepEqual(await readdir(join(state, 'flow-updates')), [journal.split('/').at(-1)])
})

test('a project folder replaced between preview and apply is refused and nothing is written into either', async () => {
  const { project, path, updates } = await setup()
  const preview = await updates.preview(project, 'review')
  await rename(project, `${project}-previewed`)
  await mkdir(join(project, '.harnessdesk', 'flows'), { recursive: true })
  await writeFile(path, legacy, 'utf8')

  const result = await updates.apply(project, preview.token)
  assert.equal(result.state, 'refused')
  assert.match(result.message, /project folder changed after the preview/i)
  assert.equal(await readFile(path, 'utf8'), legacy)
  assert.deepEqual(await readdir(join(project, '.harnessdesk')), ['flows'])
  assert.deepEqual(await readdir(join(`${project}-previewed`, '.harnessdesk')), ['flows'])
})

test('a planted Agents link is refused before any Agent is written through it', async () => {
  const { project, path, updates } = await setup()
  const outside = join(project, '..', 'outside-agents')
  await mkdir(outside)
  await symlink(outside, join(project, '.harnessdesk', 'agents'))
  const preview = await updates.preview(project, 'review')

  const result = await updates.apply(project, preview.token)
  assert.equal(result.state, 'refused')
  assert.match(result.message, /link/i)
  assert.deepEqual(await readdir(outside), [])
  assert.equal(await readFile(path, 'utf8'), legacy)
})

test('without an any-component no-follow open the update is shown but never applied', async () => {
  const scratch = tempDir('hd-flow-update-')
  const project = join(scratch, 'project')
  const state = join(scratch, 'state')
  await mkdir(join(project, '.harnessdesk', 'flows'), { recursive: true })
  const path = join(project, '.harnessdesk', 'flows', 'review.yml')
  await writeFile(path, legacy, 'utf8')
  const catalogue = new FlowCatalog({ confine: async () => {}, platform: 'linux' })
  const updates = new FlowUpdates({ stateDir: state, catalogue, platform: 'linux' })

  const preview = await updates.preview(project, 'review')
  assert.equal(preview.edits.length, 2)
  assert.ok(preview.problems.some((problem) => problem.level === 'error' && /cannot change project files on this system/.test(problem.text)))
  const result = await updates.apply(project, preview.token)
  assert.equal(result.state, 'refused')
  assert.equal(await readFile(path, 'utf8'), legacy)
  assert.deepEqual(await readdir(join(project, '.harnessdesk')), ['flows'])
  await assert.rejects(readdir(state), { code: 'ENOENT' })
})

test('interrupted conversion leaves the old flow runnable and a restarted desk continues from its journal', async () => {
  const { project, path, state, catalogue, updates } = await setup()
  await writeFile(path, twoAgents, 'utf8')
  const preview = await updates.preview(project, 'review')
  assert.deepEqual(preview.problems.filter((problem) => problem.level === 'error'), [])
  const flows = join(project, '.harnessdesk', 'flows')
  await chmod(flows, 0o500)
  let partial
  try { partial = await updates.apply(project, preview.token) } finally { await chmod(flows, 0o755) }
  assert.equal(partial.state, 'partial')
  assert.equal(partial.message, 'The flow was not replaced. Some Agent files were created; review them, then continue the update.')
  assert.deepEqual([...partial.written].sort(), ['.harnessdesk/agents/review-checker/AGENT.md', '.harnessdesk/agents/review-writer/AGENT.md'])
  assert.equal(await readFile(path, 'utf8'), twoAgents)
  assert.deepEqual(await readdir(flows), ['review.yml'])
  const writer = await lstat(join(project, '.harnessdesk', 'agents', 'review-writer', 'AGENT.md'))

  const restarted = new FlowUpdates({ stateDir: state, catalogue })
  const resumed = await restarted.preview(project, 'review')
  assert.equal(resumed.resuming, true)
  const applied = await restarted.apply(project, resumed.token)
  assert.equal(applied.state, 'applied')
  assert.match(await readFile(path, 'utf8'), /version: 2/)
  assert.equal((await lstat(join(project, '.harnessdesk', 'agents', 'review-writer', 'AGENT.md'))).ino, writer.ino, 'a journaled Agent was written again')
  assert.deepEqual((await readdir(join(project, '.harnessdesk', 'agents'))).sort(), ['review-checker', 'review-writer'])
})

/*
 * Customize copies a shipped or this-Mac flow into a project that may never
 * have had a `.harnessdesk` folder at all: the folder is made through the
 * same confined tree that writes the file. A refusal never names a path on
 * this machine, and a preview's token stops working when it expires.
 */
const customizeSetup = async (options: { readonly now?: () => number } = {}) => {
  const scratch = tempDir('hd-flow-customize-')
  const project = join(scratch, 'project')
  const state = join(scratch, 'state')
  const builtin = join(scratch, 'builtin')
  await Promise.all([mkdir(project), mkdir(state), mkdir(builtin)])
  await writeFile(join(builtin, 'fan-out.yml'), 'version: 2\nname: Fan-out\nroles:\n  a: { kind: person, outcomes: [done] }\nseed: { role: a, title: A }\nrules: []\n', 'utf8')
  const catalogue = new FlowCatalog({ userRoot: join(scratch, 'user'), builtinRoot: builtin, confine: async () => {} })
  return { project, updates: new FlowUpdates({ stateDir: state, catalogue, ...(options.now ? { now: options.now } : {}) }) }
}

test('customize makes the project’s flows folder when there is none yet', async () => {
  const { project, updates } = await customizeSetup()
  const preview = await updates.customizePreview(project, 'fan-out')
  const applied = await updates.customizeApply(project, 'fan-out', preview.token!)
  assert.deepEqual([applied.state, applied.written], ['applied', ['.harnessdesk/flows/fan-out.yml']])
  assert.match(await readFile(join(project, '.harnessdesk', 'flows', 'fan-out.yml'), 'utf8'), /name: Fan-out/)
})

test('a customize refusal never names a path on this machine', async (t) => {
  const { project, updates } = await customizeSetup()
  await mkdir(join(project, '.harnessdesk'))
  await chmod(join(project, '.harnessdesk'), 0o555)
  t.after(() => chmod(join(project, '.harnessdesk'), 0o755))
  const preview = await updates.customizePreview(project, 'fan-out')
  const refused = await updates.customizeApply(project, 'fan-out', preview.token!)
  assert.equal(refused.state, 'refused')
  assert.doesNotMatch(refused.message, /(^|[\s'"(])\/[A-Za-z]/, `no absolute path in: ${refused.message}`)
  assert.ok(!refused.message.includes(await realpath(project)))
})

test('a customize token past its expiry, or for another flow, writes nothing', async () => {
  let now = 1_000
  const { project, updates } = await customizeSetup({ now: () => now })
  const preview = await updates.customizePreview(project, 'fan-out')
  now += 10 * 60_000 + 1
  const late = await updates.customizeApply(project, 'fan-out', preview.token!)
  assert.equal(late.state, 'refused')
  assert.match(late.message, /expired/)
  now = 1_000
  const again = await updates.customizePreview(project, 'fan-out')
  assert.equal((await updates.customizeApply(project, 'another', again.token!)).state, 'refused', 'a token names the flow it previewed')
  await assert.rejects(readdir(join(project, '.harnessdesk')))
})

/*
 * `order:` was optional in the old format: a role without one ran on the old
 * engine's own sentence. Update carries that sentence into the Agent it
 * writes — an Agent is its brief, and one written with none would convert a
 * flow that ran into one that cannot seat anybody.
 */
test('a role with no order of its own becomes an Agent carrying the brief the old engine gave it', async () => {
  const { project, path, updates } = await setup()
  await writeFile(path, legacy.replace('    order: Write the change.\n', '').replace('      order: Write the change.\n', ''), 'utf8')
  assert.doesNotMatch(await readFile(path, 'utf8'), /order:/)
  const preview = await updates.preview(project, 'review')
  assert.equal(preview.problems.filter((problem) => problem.level === 'error').length, 0)
  const agent = preview.edits.find((edit) => edit.path.endsWith('/AGENT.md'))!
  const parsed = parseAgentDefinition(agent.after ?? '', 'review-writer')
  assert.deepEqual(parsed.problems.filter((problem) => problem.level === 'error'), [], 'the written Agent is seatable')
  assert.equal(parsed.agent?.brief.trim(), 'You are the writer. The cards say the rest.')
})

test('a role whose order is only blank space is given the same brief', async () => {
  const { project, path, updates } = await setup()
  await writeFile(path, legacy.replace('    order: Write the change.\n', '    order: "   "\n'), 'utf8')
  const preview = await updates.preview(project, 'review')
  const agent = preview.edits.find((edit) => edit.path.endsWith('/AGENT.md'))!
  assert.equal(parseAgentDefinition(agent.after ?? '', 'review-writer').agent?.brief.trim(), 'You are the writer. The cards say the rest.')
})
