import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Agents } from '../src/agents.js'

/**
 * Three directories, one winner, and the losers still visible.
 *
 * Hiding a shadowed Agent is how somebody spends an afternoon wondering why
 * their edit does nothing, so the rule the plugin roster already follows
 * applies here: listed and marked, never hidden.
 */

const write = async (dir: string, id: string, body: string) => {
  await mkdir(join(dir, id), { recursive: true })
  await writeFile(join(dir, id, 'AGENT.md'), body, 'utf8')
}

const brief = (name: string) => `---\nname: ${name}\n---\n${name} does the work.\n`

const rig = async () => {
  const root = await mkdtemp(join(tmpdir(), 'hd-agents-'))
  const project = join(root, 'project')
  const roots = { user: join(root, 'user'), builtin: join(root, 'builtin') }
  await mkdir(join(project, '.harnessdesk', 'agents'), { recursive: true })
  await mkdir(roots.user, { recursive: true })
  await mkdir(roots.builtin, { recursive: true })
  return { root, project, roots, agents: new Agents(roots) }
}

test('a project Agent beats a user one, which beats a built-in', async () => {
  const { project, roots, agents } = await rig()
  await write(join(project, '.harnessdesk', 'agents'), 'reviewer', brief('Project reviewer'))
  await write(roots.user, 'reviewer', brief('User reviewer'))
  await write(roots.builtin, 'reviewer', brief('Built-in reviewer'))

  const listed = await agents.list(project)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.definition?.name, 'Project reviewer')
  assert.equal(listed[0]?.origin, 'project')
})

/*
 * The three-root case above passes whichever direction a half-written
 * comparison runs, because project and built-in are the ends of the order and
 * user sits between them. These two take one root away each, so a rule that
 * only got one of the two comparisons right has nothing left to hide behind.
 */

test('project beats built-in with no user copy in between', async () => {
  const { project, roots, agents } = await rig()
  await write(join(project, '.harnessdesk', 'agents'), 'reviewer', brief('Project reviewer'))
  await write(roots.builtin, 'reviewer', brief('Built-in reviewer'))

  const listed = await agents.list(project)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.origin, 'project')
  assert.equal(listed[0]?.definition?.name, 'Project reviewer')
  assert.deepEqual(
    listed[0]?.shadows.map((one) => one.origin),
    ['builtin'],
  )
})

test('user beats built-in when the project has no copy', async () => {
  const { project, roots, agents } = await rig()
  await write(roots.user, 'reviewer', brief('User reviewer'))
  await write(roots.builtin, 'reviewer', brief('Built-in reviewer'))

  const listed = await agents.list(project)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.origin, 'user')
  assert.equal(listed[0]?.definition?.name, 'User reviewer')
  assert.deepEqual(
    listed[0]?.shadows.map((one) => one.origin),
    ['builtin'],
  )
})

test('what it beat is listed on it, in precedence order', async () => {
  const { project, roots, agents } = await rig()
  await write(join(project, '.harnessdesk', 'agents'), 'reviewer', brief('Project reviewer'))
  await write(roots.user, 'reviewer', brief('User reviewer'))
  await write(roots.builtin, 'reviewer', brief('Built-in reviewer'))

  const [entry] = await agents.list(project)
  assert.deepEqual(
    entry?.shadows.map((one) => one.origin),
    ['user', 'builtin'],
  )
})

test('without a project, the user roster is what there is', async () => {
  const { roots, agents } = await rig()
  await write(roots.user, 'scout', brief('Scout'))
  const listed = await agents.list()
  assert.deepEqual(
    listed.map((one) => one.id),
    ['scout'],
  )
  assert.equal(listed[0]?.origin, 'user')
})

test('the digest is stable for the same text and differs for different text', async () => {
  const { roots, agents } = await rig()
  await write(roots.user, 'a', brief('Same'))
  await write(roots.user, 'b', brief('Same'))
  await write(roots.user, 'c', brief('Different'))
  const listed = await agents.list()
  const by = new Map(listed.map((one) => [one.id, one.digest]))
  assert.equal(by.get('a'), by.get('b'))
  assert.notEqual(by.get('a'), by.get('c'))
})

test('one broken Agent costs itself, not the roster', async () => {
  const { roots, agents } = await rig()
  await write(roots.user, 'good', brief('Good'))
  await write(roots.user, 'broken', '---\npermission: admin\n---\nx\n')
  const listed = await agents.list()
  assert.equal(
    listed.map((one) => one.id).includes('good'),
    true,
  )
  const bad = listed.find((one) => one.id === 'broken')
  // A broken Agent is listed, carries its problems, and has no definition —
  // rather than a hollow one a caller could mistake for a working Agent.
  assert.equal(bad?.definition, null)
  assert.equal(
    bad?.problems.some((one) => one.level === 'error'),
    true,
  )
})

test('a missing directory is an empty roster, not a crash', async () => {
  const agents = new Agents({
    user: join(tmpdir(), 'hd-absent-user'),
    builtin: join(tmpdir(), 'hd-absent-builtin'),
  })
  assert.deepEqual(await agents.list(), [])
})
