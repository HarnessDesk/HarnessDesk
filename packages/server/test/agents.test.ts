import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
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

/*
 * What is on disk decides before precedence does.
 *
 * The three below are one rule read three ways: a file is read first, and only
 * then is it a winner or a shadow. Decided the other way round — precedence
 * first — a folder with no file becomes a shadow at a path nobody can open, and
 * a directory that failed to open becomes an empty roster with no reason given.
 */

test('a lower-tier directory with no AGENT.md is not a shadow', async () => {
  const { roots, agents } = await rig()
  await write(roots.user, 'reviewer', brief('User reviewer'))
  /* The folder left behind by a hand-deleted file, or by a write that failed
     halfway. Nothing is there, so there is nothing for the winner to have
     beaten — a shadow is a place to go and look, and this one has no file. */
  await mkdir(join(roots.builtin, 'reviewer'), { recursive: true })

  const [entry] = await agents.list()
  assert.equal(entry?.origin, 'user')
  assert.deepEqual(entry?.shadows, [])
})

test('a root directory that cannot be read is raised, not read as empty', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hd-agents-'))
  const locked = join(root, 'locked')
  await write(locked, 'reviewer', brief('Locked reviewer'))
  await chmod(locked, 0o000)
  try {
    const readable = await readdir(locked).then(
      () => true,
      () => false,
    )
    // Modes do not apply to root, so there is no refusal here to observe.
    if (readable) return t.skip('this user can read a directory with mode 000')

    const agents = new Agents({ user: locked, builtin: join(root, 'absent') })
    await assert.rejects(agents.list(), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'EACCES')
      return true
    })
  } finally {
    await chmod(locked, 0o700)
  }
})

test('a root the filesystem refuses outright is raised as well', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hd-agents-'))
  /* `ENAMETOOLONG` rather than the permission above, so the guarantee is
     covered for a user the mode test skips for: 300 characters in one component
     is refused by every filesystem these tests run on, and by no mode. */
  const absurd = join(root, 'n'.repeat(300))
  const agents = new Agents({ user: absurd, builtin: join(root, 'absent') })
  await assert.rejects(agents.list(), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'ENAMETOOLONG')
    return true
  })
})

test('a root that is a file, or is under one, is simply empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hd-agents-'))
  await writeFile(join(root, 'user'), 'somebody touched this instead of making it\n', 'utf8')
  /* The other half of the rule above, and the reason `ENOTDIR` is not raised:
     a project with a `.harnessdesk` *file* has no Agents in it, and `agent/list`
     refusing for every such project would be a worse answer than an empty one. */
  const agents = new Agents({ user: join(root, 'user'), builtin: join(root, 'user', 'agents') })
  assert.deepEqual(await agents.list(), [])
})

test('an AGENT.md that cannot be read is listed with its failure, and costs only itself', async () => {
  const { roots, agents } = await rig()
  await write(roots.user, 'good', brief('Good'))
  // Present, and unreadable: a directory where the file goes.
  await mkdir(join(roots.user, 'unreadable', 'AGENT.md'), { recursive: true })

  const listed = await agents.list()
  assert.deepEqual(
    listed.map((one) => one.id),
    ['good', 'unreadable'],
  )
  const stuck = listed.find((one) => one.id === 'unreadable')
  /* The same shape a file that does not parse arrives in, so a reader has one
     case to handle: no definition, and a problem that says what happened. */
  assert.equal(stuck?.definition, null)
  assert.equal(stuck?.origin, 'user')
  assert.equal(
    stuck?.problems.some((one) => one.level === 'error' && /EISDIR/.test(one.text)),
    true,
    'the problem names the failure, not just that there was one',
  )
})
