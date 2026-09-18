import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import type { AgentEntry } from '@harnessdesk/protocol'

import { Agents } from '../src/agents.js'
import { tempDir } from './scratch.js'

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
  const root = tempDir('hd-agents-')
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
  /* Present, and unreadable: a link to itself, which no open can get to the
     end of. (A directory where the file goes used to stand in here; it is now
     refused before any read is tried, and has a test of its own below.) */
  await mkdir(join(roots.user, 'unreadable'), { recursive: true })
  await symlink('AGENT.md', join(roots.user, 'unreadable', 'AGENT.md'))

  const listed = await agents.list()
  assert.deepEqual(
    listed.map((one) => one.id),
    ['good', 'unreadable'],
  )
  const stuck = listed.find((one) => one.id === 'unreadable')
  /* The same shape a file that does not parse arrives in, so a reader has one
     case to handle: no definition, and a problem that says what happened. */
  assert.equal(stuck?.definition, null)
  // Null, not a sentinel string: two unrelated unreadable entries must not
  // compare equal to a consumer comparing digests.
  assert.equal(stuck?.digest, null)
  assert.equal(stuck?.origin, 'user')
  assert.equal(
    stuck?.problems.some((one) => one.level === 'error' && /ELOOP/.test(one.text)),
    true,
    'the problem names the failure, not just that there was one',
  )
})

/*
 * Links, and what is at the end of them.
 *
 * Where an Agent came from decides how far its links are followed. A project
 * arrives in a clone — somebody else's input — so its files are read only from
 * inside it: an `AGENT.md` whose real path leaves the project is refused, and
 * so is every file under a `.harnessdesk/agents` that is itself a link out. The
 * brief is a model's standing order, and a repository must not be able to put
 * a file from this machine into one.
 *
 * This machine's roster, and the one that ships with the app, were put there
 * by the person or the build: a dotfiles checkout linked into place is a setup,
 * not an attack, so their links are followed.
 *
 * In every root, what is read is a regular file of at most 256 KiB, and what is
 * refused is still listed, saying why and carrying nothing of what is there.
 */

/** The shape every refusal takes: listed, unusable, unhashed, and saying why. */
const assertRefused = (entry: AgentEntry | undefined, why: RegExp) => {
  assert.ok(entry, 'a refused Agent is listed, not dropped')
  // A boolean, so a regression reports the start of what it read, not 256 KiB of it.
  assert.ok(
    entry.definition === null,
    `refused, so no definition — but one was read, its brief beginning ${JSON.stringify(entry.definition?.brief.slice(0, 40))}`,
  )
  assert.equal(entry.digest, null)
  assert.equal(
    entry.problems.some((one) => one.level === 'error' && why.test(one.text)),
    true,
    `a problem saying ${String(why)}, among: ${JSON.stringify(entry.problems)}`,
  )
}

test('a project AGENT.md that links outside the project is refused, and nothing of what it points at comes back', async () => {
  const { root, project, agents } = await rig()
  /* Outside the project, on the same machine: the file a cloned repository
     would like read into a prompt. No front matter, so read, it is a valid
     Agent whose brief is the secret. */
  const secret = join(root, 'secret.env')
  await writeFile(secret, 'TOKEN=hunter2\n', 'utf8')
  await mkdir(join(project, '.harnessdesk', 'agents', 'leak'), { recursive: true })
  await symlink(secret, join(project, '.harnessdesk', 'agents', 'leak', 'AGENT.md'))

  const listed = await agents.list(project)
  const leak = listed.find((one) => one.id === 'leak')
  assertRefused(leak, /links outside the project/)
  assert.equal(leak?.origin, 'project')
  assert.equal(JSON.stringify(listed).includes('hunter2'), false, "the linked file's text is nowhere in the answer")
})

test('a project .harnessdesk/agents that links outside the project yields none of the Agents there', async () => {
  const root = tempDir('hd-agents-')
  const outside = join(root, 'elsewhere', 'agents')
  await write(outside, 'secret', brief('Somebody else'))
  const project = join(root, 'project')
  await mkdir(join(project, '.harnessdesk'), { recursive: true })
  await symlink(outside, join(project, '.harnessdesk', 'agents'))
  const agents = new Agents({ user: join(root, 'user'), builtin: join(root, 'builtin') })

  const listed = await agents.list(project)
  assert.equal(
    listed.some((one) => one.definition !== null),
    false,
    'no Agent is read from the folder the link leads to',
  )
  assert.equal(JSON.stringify(listed).includes('Somebody else'), false, 'nor any of its text')
  assertRefused(
    listed.find((one) => one.id === 'secret'),
    /links outside the project/,
  )
})

/*
 * The control for the two refusals above, which a roster refusing every link
 * in a project would also pass: a link that stays inside the repository — a
 * file, a folder, or the whole `.harnessdesk/agents` — is followed.
 */
test('a link that stays inside the project is followed', async () => {
  const { project, agents } = await rig()
  const here = join(project, '.harnessdesk', 'agents')
  await mkdir(join(project, 'docs'), { recursive: true })
  await writeFile(join(project, 'docs', 'reviewer.md'), brief('Linked reviewer'), 'utf8')
  await mkdir(join(here, 'reviewer'), { recursive: true })
  await symlink(join('..', '..', '..', 'docs', 'reviewer.md'), join(here, 'reviewer', 'AGENT.md'))
  await write(join(project, 'shared'), 'scout', brief('Shared scout'))
  await symlink(join('..', '..', 'shared', 'scout'), join(here, 'scout'))

  assert.deepEqual(
    (await agents.list(project)).map((one) => [one.id, one.origin, one.definition?.name]),
    [
      ['reviewer', 'project', 'Linked reviewer'],
      ['scout', 'project', 'Shared scout'],
    ],
  )

  const root = tempDir('hd-agents-')
  const linked = join(root, 'linked')
  await write(join(linked, 'team', 'agents'), 'planner', brief('Team planner'))
  await mkdir(join(linked, '.harnessdesk'), { recursive: true })
  await symlink(join('..', 'team', 'agents'), join(linked, '.harnessdesk', 'agents'))
  const roster = new Agents({ user: join(root, 'user'), builtin: join(root, 'builtin') })
  assert.deepEqual(
    (await roster.list(linked)).map((one) => [one.id, one.origin, one.definition?.name]),
    [['planner', 'project', 'Team planner']],
  )
})

test("this machine's Agents follow their links, and a linked Agent folder is listed", async () => {
  const { root, roots, agents } = await rig()
  // A dotfiles checkout linked into place, one folder at a time.
  const dotfiles = join(root, 'dotfiles')
  await write(dotfiles, 'reviewer', brief('Dotfiles reviewer'))
  await symlink(join(dotfiles, 'reviewer'), join(roots.user, 'reviewer'))
  // …or one file at a time.
  await writeFile(join(dotfiles, 'scout.md'), brief('Dotfiles scout'), 'utf8')
  await mkdir(join(roots.user, 'scout'), { recursive: true })
  await symlink(join(dotfiles, 'scout.md'), join(roots.user, 'scout', 'AGENT.md'))
  // What ships with the app is trusted the same way.
  await write(join(root, 'bundled'), 'planner', brief('Bundled planner'))
  await symlink(join(root, 'bundled', 'planner'), join(roots.builtin, 'planner'))

  const listed = await agents.list()
  assert.deepEqual(
    listed.map((one) => [one.id, one.origin, one.definition?.name]),
    [
      ['planner', 'builtin', 'Bundled planner'],
      ['reviewer', 'user', 'Dotfiles reviewer'],
      ['scout', 'user', 'Dotfiles scout'],
    ],
  )
  assert.equal(
    listed.find((one) => one.id === 'reviewer')?.path,
    join(roots.user, 'reviewer', 'AGENT.md'),
    'the path is the one in the roster, where the person put the link',
  )
})

test('a directory where AGENT.md goes is refused as not a regular file', async () => {
  const { project, roots, agents } = await rig()
  await mkdir(join(project, '.harnessdesk', 'agents', 'hollow', 'AGENT.md'), { recursive: true })
  await mkdir(join(roots.user, 'folder', 'AGENT.md'), { recursive: true })

  const listed = await agents.list(project)
  assertRefused(
    listed.find((one) => one.id === 'hollow'),
    /is not a regular file/,
  )
  assertRefused(
    listed.find((one) => one.id === 'folder'),
    /is not a regular file/,
  )
})

const run = promisify(execFile)

/** A named pipe where an Agent's AGENT.md goes. */
const pipeAt = async (dir: string, id: string): Promise<void> => {
  await mkdir(join(dir, id), { recursive: true })
  await run('mkfifo', [join(dir, id, 'AGENT.md')])
}

/** The roster this file was compiled beside, for a process of its own to import. */
const ROSTER = new URL('../src/agents.js', import.meta.url).href

test('a named pipe where AGENT.md goes is refused without waiting on it', async () => {
  const { project, roots } = await rig()
  await pipeAt(join(project, '.harnessdesk', 'agents'), 'piped')
  await pipeAt(roots.user, 'queue')

  /* Listed in a process of its own, because what this guards against is not an
     error but a wait. Opening a pipe to read waits for a writer, and nothing
     here ever writes one: a roster that asks not to wait answers at once, and
     one that forgot would wait forever, holding a thread of the host's I/O
     pool for each listing. So the process is killed at a deadline instead —
     which bounds how long a regression takes to fail, and is not a head start
     the roster races, since a roster that does not wait never needs it. */
  const script = [
    `const { Agents } = await import(${JSON.stringify(ROSTER)})`,
    `const roster = new Agents(${JSON.stringify(roots)})`,
    `process.stdout.write(JSON.stringify(await roster.list(${JSON.stringify(project)})))`,
  ].join('\n')
  const answered = await run(process.execPath, ['--input-type=module', '--eval', script], {
    timeout: 20_000,
    killSignal: 'SIGKILL',
  }).catch((error: { killed?: boolean }) => {
    if (error.killed) assert.fail('the listing waited on a pipe nobody writes to, and never answered')
    throw error
  })

  const listed = JSON.parse(answered.stdout) as AgentEntry[]
  assertRefused(
    listed.find((one) => one.id === 'piped'),
    /is not a regular file/,
  )
  assertRefused(
    listed.find((one) => one.id === 'queue'),
    /is not a regular file/,
  )
})

/** An Agent file of exactly `bytes` bytes, with a word at each end of its brief. */
const ofSize = (bytes: number): string => {
  const head = '---\nname: Long\n---\nFIRST '
  const tail = ' LAST\n'
  return head + 'x'.repeat(bytes - head.length - tail.length) + tail
}

test('an AGENT.md larger than 256 KiB is refused whole, and one of exactly 256 KiB is read whole', async () => {
  const { project, roots, agents } = await rig()
  const limit = 256 * 1024
  await write(roots.user, 'exact', ofSize(limit))
  await write(roots.user, 'over', ofSize(limit + 1))
  await write(join(project, '.harnessdesk', 'agents'), 'bloated', ofSize(limit + 1))

  const listed = await agents.list(project)
  // The control: the cap is not lower than it says, and what is under it is not cut.
  const exact = listed.find((one) => one.id === 'exact')
  assert.equal(exact?.definition?.brief.startsWith('FIRST'), true)
  assert.equal(exact?.definition?.brief.endsWith('LAST'), true)

  for (const id of ['over', 'bloated']) {
    const refused = listed.find((one) => one.id === id)
    assertRefused(refused, /is larger than 256 KiB/)
    // Refused, not truncated: no part of the brief was parsed into anything.
    assert.equal(JSON.stringify(refused).includes('FIRST'), false)
  }
})
