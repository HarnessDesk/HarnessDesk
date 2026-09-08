import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import type { Page, SessionSummary, TeamState } from '@harnessdesk/protocol'

import { Host, Logger, StateStore, serve } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client } from './fixtures/harness.js'

/**
 * A room and a linked worktree, through the real host.
 *
 * The engine test for this stubs `rootOf`, so it can only prove that
 * `createRoom` asks the resolver — never that the resolver answers correctly.
 * It did not: `#boardRootOf` took the longest *open workspace* containing a
 * folder and consulted git only when nothing matched, so a worktree somebody
 * had opened contained its own conversations and resolved to itself. A room
 * made under the main checkout was then unjoinable from the worktree, because
 * every peer in it came back with a root the room did not have.
 *
 * Both halves are needed to see it — a real linked worktree *and* it being
 * open — which is why this test builds a real repository and drives the wire
 * rather than a fake.
 */
const run = promisify(execFile)
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@x',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@x',
}
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-C', cwd, ...args], { env })).stdout

const silent = new Logger('test', { level: 'error', console: false })

/** A repository with one commit, and a linked worktree hanging off it. */
const repoWithWorktree = async (): Promise<{ main: string; tree: string; clean(): Promise<void> }> => {
  // `realpath`, because macOS hands out `/var/…` for `/private/var/…` and git
  // answers with the resolved one — a mismatch that reads exactly like the bug
  // under test and is not it.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hd-room-worktree-')))
  const main = join(dir, 'checkout')
  await run('git', ['init', '-b', 'main', main], { env })
  await writeFile(join(main, 'README.md'), '# checkout\n')
  await git(main, 'add', '.')
  await git(main, 'commit', '-m', 'first')
  const tree = join(dir, 'feature')
  await git(main, 'worktree', 'add', '-b', 'feature', tree)
  return { main, tree, clean: () => rm(dir, { recursive: true, force: true }) }
}

/**
 * A member has to be a conversation that exists.
 *
 * The engine cannot decide this: it sees only *live* peers, and a member whose
 * process has stopped is still a member — deliberately, so one that comes back
 * keeps its name. So a join naming nothing at all was written down, and the
 * room counted a member the tree could not draw and the delete dialog promised
 * would "leave the room and carry on". Found by a recording, whose own caller
 * split a session key on the wrong character.
 */
/**
 * A stopped conversation is still in the project it was working in.
 *
 * The registry check proved only that the host had *heard of* the
 * conversation. A stopped record still exists with `live = null`, and the
 * engine's own project check reads the live peer list — so it found nothing to
 * check and let the join through. A conversation in project B could therefore
 * be made a member of a room in project A, and resuming that stored
 * membership would hand it another project's board: the one thing rooms
 * promise never to do.
 *
 * The cwd is on the stored session whether or not it is running, so the check
 * uses that and holds for both.
 */
test('a stopped conversation cannot join a room in another project', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-room-stopped-'))
  const a = await realpath(await mkdtemp(join(tmpdir(), 'hd-room-project-a-')))
  const b = await realpath(await mkdtemp(join(tmpdir(), 'hd-room-project-b-')))
  const runtime = new FakeRuntime()
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
  })
  host.register(runtime)
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  const client = await Client.connect(server)

  try {
    await client.call('workspace/open', { path: a })
    await client.call('workspace/open', { path: b })
    const room = (await client.call('team/room/create', { root: a, name: 'Project A' })) as TeamState

    // A conversation in the *other* project, then stopped.
    const away = (await client.call('session/create', {
      runtime: 'fake',
      options: { cwd: b },
    })) as { id: string }
    await client.call('session/close', { runtime: 'fake', sessionId: away.id })

    await assert.rejects(
      () => client.call('team/room/join', { room: room.id, runtime: 'fake', sessionId: away.id }),
      /outside/,
    )

    const rooms = (await client.call('team/rooms', { root: a })) as readonly TeamState[]
    assert.deepEqual(rooms.find((one) => one.id === room.id)?.members, [])
  } finally {
    client.close()
    await server.close()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
    await rm(a, { recursive: true, force: true })
    await rm(b, { recursive: true, force: true })
  }
})

test('a join that names no conversation is refused, not written down', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-room-phantom-'))
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hd-room-phantom-work-')))
  const runtime = new FakeRuntime()
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
  })
  host.register(runtime)
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  const client = await Client.connect(server)

  try {
    await client.call('workspace/open', { path: dir })
    const room = (await client.call('team/room/create', {
      root: dir,
      name: 'Refund flow',
    })) as TeamState

    await assert.rejects(
      () =>
        client.call('team/room/join', {
          room: room.id,
          runtime: 'fake',
          sessionId: 'never-existed',
        }),
      /no fake conversation never-existed/,
    )

    const rooms = (await client.call('team/rooms', { root: dir })) as readonly TeamState[]
    assert.deepEqual(rooms.find((one) => one.id === room.id)?.members, [])
  } finally {
    client.close()
    await server.close()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('a conversation in an opened worktree joins its project’s room', async () => {
  const { main, tree, clean } = await repoWithWorktree()
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-room-worktree-state-'))
  const runtime = new FakeRuntime()
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
  })
  host.register(runtime)
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  const client = await Client.connect(server)

  try {
    // Both are open, which is the half a unit test cannot stub: the worktree
    // is now a workspace that contains its own conversations.
    await client.call('workspace/open', { path: main })
    await client.call('workspace/open', { path: tree })

    // A room made from the worktree still belongs to the project.
    const room = (await client.call('team/room/create', {
      root: tree,
      name: 'Checkout rewrite',
    })) as TeamState
    assert.equal(room.root, main, 'the room is keyed by the project, not the worktree')

    // And a conversation working *in the worktree* can join it.
    const started = (await client.call('session/create', {
      runtime: 'fake',
      options: { cwd: tree },
    })) as { id: string }
    await client.call('team/room/join', { room: room.id, runtime: 'fake', sessionId: started.id })

    const rooms = (await client.call('team/rooms', { root: main })) as readonly TeamState[]
    const back = rooms.find((one) => one.id === room.id)
    assert.equal(back?.members.length, 1, `the worktree conversation is in the room: ${JSON.stringify(back?.members)}`)
  } finally {
    client.close()
    await server.close()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
    await clean()
  }
})

/**
 * A submodule is its own project, and the resolver has to say so in the same
 * words the session list does.
 *
 * The room's root used to be `dirname(--git-common-dir)`, and a submodule's
 * common dir is `<super>/.git/modules/<path>` — it does not end in `/.git`, so
 * the suffix test failed and the folder was resolved as though it were in no
 * repository at all, landing on whichever open workspace contained it. With
 * the superproject open, that is the superproject: a room made in the
 * submodule was keyed by its parent, drawn as a folder of its own beside the
 * submodule its conversations are grouped under, and unjoinable from inside
 * it. `repositoryOf` — which is what the tree groups on — answers with the
 * submodule's own working tree, so this asks that.
 */
test('a room in a submodule is keyed by the submodule, not the superproject', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hd-room-submodule-')))
  const lib = join(dir, 'lib')
  await run('git', ['init', '-q', '-b', 'main', lib], { env })
  await writeFile(join(lib, 'README.md'), '# lib\n')
  await git(lib, 'add', '.')
  await git(lib, 'commit', '-m', 'first')
  const superproject = join(dir, 'super')
  await run('git', ['init', '-q', '-b', 'main', superproject], { env })
  await writeFile(join(superproject, 'README.md'), '# super\n')
  await git(superproject, 'add', '.')
  await git(superproject, 'commit', '-m', 'first')
  await run('git', ['-C', superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'sub'], { env })
  await git(superproject, 'commit', '-m', 'sub')
  const sub = join(superproject, 'sub')

  const stateDir = await mkdtemp(join(tmpdir(), 'hd-room-submodule-state-'))
  const runtime = new FakeRuntime()
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
  })
  host.register(runtime)
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  const client = await Client.connect(server)

  try {
    // The superproject is the folder somebody opened — the half that made the
    // old fallback answer with it.
    await client.call('workspace/open', { path: superproject })
    const room = (await client.call('team/room/create', {
      root: sub,
      name: 'Library work',
    })) as TeamState
    assert.equal(room.root, sub, 'the room is keyed by the submodule it was made in')

    // And it is the same string the session list groups that folder under.
    // `session/list` fills `repo` from `repositoryOf`, which is what the tree
    // groups on, so comparing the two here is what pins the computations
    // together rather than merely asserting today's output twice.
    const started = (await client.call('session/create', {
      runtime: 'fake',
      options: { cwd: sub },
    })) as { id: string }
    runtime.history.push({
      id: started.id,
      runtime: 'fake',
      title: 'Library work',
      cwd: sub,
      status: { type: 'idle' },
      createdAt: 0,
      updatedAt: 0,
    } as unknown as SessionSummary)
    const page = (await client.call('session/list', { runtime: 'fake' })) as Page<SessionSummary>
    assert.equal(
      page.data.find((one) => String(one.id) === started.id)?.repo?.root,
      room.root,
      'the room and its own conversation name the project the same way',
    )
    await client.call('team/room/join', { room: room.id, runtime: 'fake', sessionId: started.id })
    const rooms = (await client.call('team/rooms', { root: sub })) as readonly TeamState[]
    assert.equal(rooms.find((one) => one.id === room.id)?.members.length, 1)
  } finally {
    client.close()
    await server.close()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * An open parent folder does not get to stand in for the repository under it.
 *
 * `containing` returned the longest open workspace containing the project, so
 * a person with `~/code` open and a repository at `~/code/api` made rooms
 * keyed by `~/code` while every conversation in them was grouped under
 * `~/code/api`: the project drawn twice, and the second conversation refused
 * at the door of the room the first one is in.
 */
test('a room in a repository under an open parent folder is keyed by the repository', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hd-room-parent-')))
  const repo = join(dir, 'api')
  await run('git', ['init', '-q', '-b', 'main', repo], { env })
  await writeFile(join(repo, 'README.md'), '# api\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-m', 'first')

  const stateDir = await mkdtemp(join(tmpdir(), 'hd-room-parent-state-'))
  const runtime = new FakeRuntime()
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
  })
  host.register(runtime)
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  const client = await Client.connect(server)

  try {
    // The parent is open; the repository itself is not.
    await client.call('workspace/open', { path: dir })
    const room = (await client.call('team/room/create', {
      root: repo,
      name: 'API',
    })) as TeamState
    assert.equal(room.root, repo, 'the repository is the project, not the folder above it')

    const started = (await client.call('session/create', {
      runtime: 'fake',
      options: { cwd: repo },
    })) as { id: string }
    await client.call('team/room/join', { room: room.id, runtime: 'fake', sessionId: started.id })
    const rooms = (await client.call('team/rooms', { root: repo })) as readonly TeamState[]
    assert.equal(rooms.find((one) => one.id === room.id)?.members.length, 1)
  } finally {
    client.close()
    await server.close()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})


/**
 * A repository reached through a symlink is the same project as the
 * repository, in the same spelling.
 *
 * Raised in review and left unresolved there, so it is settled here rather
 * than reasoned about: `repositoryOf` puts every answer through `realpath`
 * while `describeWorkspace` resolves a workspace path only lexically, so a
 * folder opened at `/tmp/x` stays `/tmp/x` while its repository resolves to
 * `/private/tmp/x`. The question is whether a room made in the folder as
 * opened is keyed the same way the session list keys the conversations in it.
 *
 * An explicit symlink rather than macOS's `/tmp`, so the test is not vacuous
 * on a platform where `/tmp` is a real directory.
 */
test('a room made through a symlinked path is keyed the same way its sessions are', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hd-room-symlink-')))
  const repo = join(dir, 'checkout')
  await run('git', ['init', '-q', '-b', 'main', repo], { env })
  await writeFile(join(repo, 'README.md'), '# checkout\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-m', 'first')
  const alias = join(dir, 'alias')
  await symlink(repo, alias)

  const stateDir = await mkdtemp(join(tmpdir(), 'hd-room-symlink-state-'))
  const runtime = new FakeRuntime()
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
  })
  host.register(runtime)
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  const client = await Client.connect(server)

  try {
    // Opened, and the room made, through the link — the path a person's
    // shortcut or scratch directory actually hands over.
    await client.call('workspace/open', { path: alias })
    const room = (await client.call('team/room/create', {
      root: alias,
      name: 'Through the link',
    })) as TeamState
    const started = (await client.call('session/create', {
      runtime: 'fake',
      options: { cwd: alias },
    })) as { id: string }
    runtime.history.push({
      id: started.id,
      runtime: 'fake',
      title: 'Through the link',
      cwd: alias,
      status: { type: 'idle' },
      createdAt: 0,
      updatedAt: 0,
    } as unknown as SessionSummary)
    const page = (await client.call('session/list', { runtime: 'fake' })) as Page<SessionSummary>
    const seen = page.data.find((one) => String(one.id) === started.id)?.repo?.root
    assert.equal(room.root, seen, 'the room and its conversation name the project the same way')
    assert.equal(room.root, repo, 'and both name the folder git names')
    await client.call('team/room/join', { room: room.id, runtime: 'fake', sessionId: started.id })
    const rooms = (await client.call('team/rooms', { root: repo })) as readonly TeamState[]
    assert.equal(rooms.find((one) => one.id === room.id)?.members.length, 1)
  } finally {
    client.close()
    await server.close()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * A subfolder of a repository opened as a workspace is still that repository.
 *
 * Also raised in review: with `packages/ui` open and a conversation in it, is
 * a room keyed by the subfolder or by the checkout? Both sides of the *host's*
 * answer are pinned here — the room's root and the `repo.root` the session
 * list stamps on that folder's conversations — because the resolver no longer
 * consults the open workspaces at all when git can answer, and that is the
 * half a person can be surprised by.
 *
 * The renderer keeps a third spelling of its own: `homeOf` lets the folder you
 * have open claim its project's home, deliberately and with its own test, so a
 * group's `root` can be the subfolder while its sessions' repository is the
 * checkout. That is not this resolver's to decide and is unchanged by it.
 */
test('a room made in an opened subfolder is keyed by the checkout, as its sessions are', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hd-room-subfolder-')))
  const repo = join(dir, 'checkout')
  await run('git', ['init', '-q', '-b', 'main', repo], { env })
  await mkdir(join(repo, 'packages', 'ui'), { recursive: true })
  await writeFile(join(repo, 'packages', 'ui', 'index.ts'), 'export {}\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-m', 'first')
  const inner = join(repo, 'packages', 'ui')

  const stateDir = await mkdtemp(join(tmpdir(), 'hd-room-subfolder-state-'))
  const runtime = new FakeRuntime()
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
  })
  host.register(runtime)
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  const client = await Client.connect(server)

  try {
    // Only the subfolder is open — the checkout above it is not.
    await client.call('workspace/open', { path: inner })
    const room = (await client.call('team/room/create', {
      root: inner,
      name: 'Renderer',
    })) as TeamState
    const started = (await client.call('session/create', {
      runtime: 'fake',
      options: { cwd: inner },
    })) as { id: string }
    runtime.history.push({
      id: started.id,
      runtime: 'fake',
      title: 'Renderer',
      cwd: inner,
      status: { type: 'idle' },
      createdAt: 0,
      updatedAt: 0,
    } as unknown as SessionSummary)
    const page = (await client.call('session/list', { runtime: 'fake' })) as Page<SessionSummary>
    const seen = page.data.find((one) => String(one.id) === started.id)?.repo?.root
    assert.equal(room.root, seen, 'the room and its conversation name the project the same way')
    assert.equal(room.root, repo, 'and both name the checkout, not the folder that was opened')
    await client.call('team/room/join', { room: room.id, runtime: 'fake', sessionId: started.id })
    const rooms = (await client.call('team/rooms', { root: repo })) as readonly TeamState[]
    assert.equal(rooms.find((one) => one.id === room.id)?.members.length, 1)
  } finally {
    client.close()
    await server.close()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})
