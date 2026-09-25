import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'

import type { AgentEntry } from '@harnessdesk/protocol'

import { Agents } from '../src/agents.js'
import { builtinAgentRoot } from '../src/host.js'
import { agentMethods } from '../src/methods/agents.js'
import { Client, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * The two read verbs, against a real roster on disk and a context stub.
 *
 * Only the wiring is under test here: the precedence rules have their own test
 * and are not re-proved through the wire.
 */

const ctxWith = async () => {
  const root = tempDir('hd-agent-methods-')
  const user = join(root, 'user')
  await mkdir(join(user, 'reviewer'), { recursive: true })
  await writeFile(
    join(user, 'reviewer', 'AGENT.md'),
    '---\nname: Reviewer\npermission: read\n---\nRead the diff.\n',
    'utf8',
  )
  return { agents: new Agents({ user, builtin: join(root, 'builtin') }) } as never
}

test('agent/list answers the roster', async () => {
  const ctx = await ctxWith()
  const listed = await agentMethods['agent/list'](ctx, {})
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.definition?.name, 'Reviewer')
  assert.equal(listed[0]?.origin, 'user')
})

test('agent/read answers one, by id', async () => {
  const ctx = await ctxWith()
  const one = await agentMethods['agent/read'](ctx, { id: 'reviewer' })
  assert.equal(one?.definition?.ceiling, 'edit')
})

test('agent/read answers null for an id nobody defined', async () => {
  const ctx = await ctxWith()
  assert.equal(await agentMethods['agent/read'](ctx, { id: 'nobody' }), null)
})

const writeAgent = async (dir: string, id: string, name: string) => {
  await mkdir(join(dir, id), { recursive: true })
  await writeFile(join(dir, id, 'AGENT.md'), `---\nname: ${name}\n---\n${name} does the work.\n`, 'utf8')
}

/*
 * `project` crosses the socket, and a project's Agents are read from beneath
 * it. Unconfined, a request could have the host list `.harnessdesk/agents`
 * under any directory on the disk and read what is in it — so it answers to the
 * rule the git verbs answer to: an open folder, or the top of the repository an
 * open folder sits in, compared by real path, or refused before anything is
 * read.
 *
 * The rule itself is the host's, and the host is where it is tested, further
 * down. These two pin only what the verbs do with it: ask it, and read what it
 * answered — never the text that arrived, and nothing at all when it refuses.
 */

/**
 * A roster that records every project it is asked about, behind a stand-in for
 * the host's confinement that records what it was handed. It confines one
 * spelling of the open folder, deliberately not the folder's own, so a verb
 * that read the text that arrived would be caught asking about the wrong path.
 */
const confinedRig = async () => {
  const root = tempDir('hd-agent-methods-')
  const user = join(root, 'user')
  const open = join(root, 'open')
  const elsewhere = join(root, 'elsewhere')
  await writeAgent(user, 'reviewer', 'User reviewer')
  await writeAgent(join(open, '.harnessdesk', 'agents'), 'reviewer', 'Open reviewer')
  await writeAgent(join(elsewhere, '.harnessdesk', 'agents'), 'secret', 'Somebody else')
  const roster = new Agents({ user, builtin: join(root, 'builtin') })
  const asked: (string | undefined)[] = []
  const handed: string[] = []
  const spelled = `${open}/x/..`
  const ctx = {
    agents: {
      list: (project?: string) => {
        asked.push(project)
        return roster.list(project)
      },
      read: (id: string, project?: string) => {
        asked.push(project)
        return roster.read(id, project)
      },
    },
    workspaces: {
      confineGitRoot: async (project: string) => {
        handed.push(project)
        if (project === spelled) return open
        throw new Error(`${project} is outside every open workspace. Open its folder first to read from it.`)
      },
      // Nothing here is a real checkout, so the folder that was handed is its own top.
      topLevel: async () => null,
    },
  } as never
  return { ctx, asked, handed, open, spelled, elsewhere }
}

test('a project the host will not confine is refused, and nothing under it is read', async () => {
  const { ctx, asked, handed, elsewhere } = await confinedRig()
  await assert.rejects(agentMethods['agent/list'](ctx, { project: elsewhere }), /outside every open workspace/)
  await assert.rejects(
    agentMethods['agent/read'](ctx, { id: 'secret', project: elsewhere }),
    /outside every open workspace/,
  )
  // Nor a relative path, which the host would resolve against wherever it was started.
  await assert.rejects(agentMethods['agent/list'](ctx, { project: 'elsewhere' }), /not an absolute path/)
  assert.deepEqual(handed, [elsewhere, elsewhere], 'the host is asked about the text that arrived, and only that')
  assert.deepEqual(asked, [], 'the roster is not asked about a folder the window does not have open')
})

/*
 * The control for the refusal above, which a handler refusing every project
 * would also pass: a project the host confines reaches the roster — as the path
 * the host answered, not the one that was sent — and what it holds comes back.
 */
test('a project the host confines is read at the path the host answered', async () => {
  const { ctx, asked, open, spelled } = await confinedRig()
  const listed = await agentMethods['agent/list'](ctx, { project: spelled })
  assert.deepEqual(
    listed.map((one) => [one.id, one.origin, one.definition?.name]),
    [['reviewer', 'project', 'Open reviewer']],
  )
  const one = await agentMethods['agent/read'](ctx, { id: 'reviewer', project: spelled })
  assert.equal(one?.origin, 'project')
  assert.deepEqual(asked, [open, open])
})

/*
 * The roster raises a directory it cannot read, because a person can act on a
 * path and a reason and cannot act on zero rows. This is where that error
 * reaches the person, so the verbs must not catch it into an empty answer.
 */
test('a roster directory that cannot be read fails the call, rather than answering an empty roster', async () => {
  const root = tempDir('hd-agent-methods-')
  /* 300 characters in one component: refused by every filesystem these tests
     run on and by no mode, so unlike a chmod this cannot skip as root. */
  const ctx = {
    agents: new Agents({ user: join(root, 'n'.repeat(300)), builtin: join(root, 'builtin') }),
  } as never
  const refused = (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'ENAMETOOLONG')
    return true
  }
  await assert.rejects(agentMethods['agent/list'](ctx, {}), refused)
  await assert.rejects(agentMethods['agent/read'](ctx, { id: 'reviewer' }), refused)
})

/*
 * The other side of that rule: one file that will not parse is not a failure of
 * the call. It is answered as it is — listed, with no definition and a problem
 * saying why — so the roster can show what is broken and where.
 */
test('an Agent whose file will not parse is answered with its problem, not dropped', async () => {
  const root = tempDir('hd-agent-methods-')
  const user = join(root, 'user')
  await writeAgent(user, 'reviewer', 'Reviewer')
  await mkdir(join(user, 'broken'), { recursive: true })
  await writeFile(join(user, 'broken', 'AGENT.md'), '---\npermission: admin\n---\nx\n', 'utf8')
  const ctx = { agents: new Agents({ user, builtin: join(root, 'builtin') }) } as never

  const listed = await agentMethods['agent/list'](ctx, {})
  assert.deepEqual(
    listed.map((one) => one.id),
    ['broken', 'reviewer'],
  )
  const broken = await agentMethods['agent/read'](ctx, { id: 'broken' })
  assert.equal(broken?.definition, null)
  assert.equal(
    broken?.problems.some((one) => one.level === 'error'),
    true,
  )
})

/*
 * Everything above runs against a hand-built context. This is the context the
 * host really builds, over the real socket: the params checked off the wire,
 * this machine's roster read from the state directory the host was given (so a
 * test rig or a moved HARNESSDESK_HOME moves it too), and a project held to the
 * host's own list of open folders.
 */
test("the host reads this machine's Agents from its own state directory, and a project's once it is open", async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const badRequest = (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'badRequest')
    return true
  }
  await assert.rejects(client.call('agent/read', {}), badRequest)
  await assert.rejects(client.call('agent/list', { project: 5 }), badRequest)

  const mine = join(harness.stateDir, 'agents')
  await writeAgent(mine, 'scout', 'Scout')
  const project = tempDir('hd-agent-methods-project-')
  await writeAgent(join(project, '.harnessdesk', 'agents'), 'scout', 'Project scout')

  const listed = (await client.call('agent/list', {})) as readonly AgentEntry[]
  const scout = listed.find((one) => one.id === 'scout')
  assert.equal(scout?.origin, 'user')
  assert.equal(scout?.path, join(mine, 'scout', 'AGENT.md'))

  await assert.rejects(client.call('agent/read', { id: 'scout', project }), /outside every open workspace/)
  await client.call('workspace/open', { path: project })
  const read = (await client.call('agent/read', { id: 'scout', project })) as AgentEntry | null
  assert.equal(read?.origin, 'project')
  assert.equal(read?.definition?.name, 'Project scout')
  assert.deepEqual(read?.shadows, [{ origin: 'user', path: join(mine, 'scout', 'AGENT.md') }])
})

/** A host on the real socket, and a client on it, both gone when the test is. */
const connected = async (t: TestContext) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  return client
}

/** The project's and this machine's Agents: the built-in ones ship with every desk and are not what these tests are about. */
const idsOf = (listed: unknown) =>
  (listed as readonly AgentEntry[])
    .filter((one) => one.origin !== 'builtin')
    .map((one) => [one.id, one.origin, one.definition?.name])

/*
 * The host's rule, through the host. Every path below is sent exactly as
 * written: `..` included, uncollapsed, so nothing on the way to the host has
 * already done its work for it.
 */
test('the host confines a project by its real path: `..` walks nowhere, and a link does not lead out', async (t) => {
  const client = await connected(t)
  const root = tempDir('hd-agent-methods-')
  const open = join(root, 'open')
  const elsewhere = join(root, 'elsewhere')
  await writeAgent(join(open, '.harnessdesk', 'agents'), 'reviewer', 'Open reviewer')
  await writeAgent(join(elsewhere, '.harnessdesk', 'agents'), 'secret', 'Somebody else')
  await mkdir(join(open, 'x'))
  // Inside the open folder by its text, and outside it by where it leads.
  await symlink(elsewhere, join(open, 'door'))
  await client.call('workspace/open', { path: open })

  const refused = /outside every open workspace/
  await assert.rejects(client.call('agent/list', { project: elsewhere }), refused)
  await assert.rejects(client.call('agent/read', { id: 'secret', project: elsewhere }), refused)
  await assert.rejects(client.call('agent/list', { project: `${open}/../elsewhere` }), refused)
  await assert.rejects(client.call('agent/list', { project: join(open, 'door') }), refused)
  await assert.rejects(client.call('agent/read', { id: 'secret', project: join(open, 'door') }), refused)
  await assert.rejects(client.call('agent/list', { project: 'elsewhere' }), /not an absolute path/)

  // The control: `..` that lands back inside the open folder is the open folder.
  assert.deepEqual(idsOf(await client.call('agent/list', { project: `${open}/x/..` })), [
    ['reviewer', 'project', 'Open reviewer'],
  ])
})

const run = promisify(execFile)

/*
 * A workspace is often a folder inside its repository, and a project's Agents
 * live at the repository's top. Confined by text, the top was refused and the
 * subfolder held nothing, so no input reached them; confined the way the git
 * verbs are, the top of a repository an open folder sits in is admitted.
 */
test("a subfolder of an open repository reaches that repository's Agents", async (t) => {
  const client = await connected(t)
  const repo = tempDir('hd-agent-methods-repo-')
  await run('git', ['init', '-q', repo])
  await writeAgent(join(repo, '.harnessdesk', 'agents'), 'reviewer', 'Repository reviewer')
  await mkdir(join(repo, 'pkg'))
  await client.call('workspace/open', { path: join(repo, 'pkg') })

  assert.deepEqual(idsOf(await client.call('agent/list', { project: repo })), [
    ['reviewer', 'project', 'Repository reviewer'],
  ])
  const read = (await client.call('agent/read', { id: 'reviewer', project: repo })) as AgentEntry | null
  assert.equal(read?.definition?.name, 'Repository reviewer')

  // That repository and no other: git names the top of what is open, and a repository nobody opened is still refused.
  const sibling = tempDir('hd-agent-methods-repo-')
  await run('git', ['init', '-q', sibling])
  await assert.rejects(client.call('agent/list', { project: sibling }), /outside every open workspace/)
})

/*
 * The third root cannot be exercised by writing into it — it is part of the
 * package, and a test that crashed halfway would leave an Agent in what ships.
 * So where it points is pinned instead: `agents/` beside this package's own
 * manifest, which is the directory the app carries along with `src` and `dist`.
 */
test('built-in Agents are looked for at the root of the server package', async () => {
  const root = builtinAgentRoot()
  assert.equal(basename(root), 'agents')
  const manifest = JSON.parse(await readFile(join(dirname(root), 'package.json'), 'utf8')) as { name?: unknown }
  assert.equal(manifest.name, '@harnessdesk/server')
})

/*
 * The renderer names the folder it has open; a project keeps its Agents at the
 * top of its checkout. So a folder is read as the checkout it is in: a
 * subfolder as its repository's top, a linked worktree as its own top — the
 * branch's Agents, which is what a branch is for.
 */
test('a folder inside a repository reads the Agents at the top of its checkout, and a worktree its own', async (t) => {
  const client = await connected(t)
  const repo = tempDir('hd-agent-methods-top-')
  const git = (...args: string[]) => run('git', ['-C', repo, '-c', 'user.email=dev@example.com', '-c', 'user.name=Jane Doe', ...args])
  await run('git', ['init', '-q', repo])
  await git('commit', '-q', '--allow-empty', '-m', 'root')
  await writeAgent(join(repo, '.harnessdesk', 'agents'), 'reviewer', 'Repository reviewer')
  await mkdir(join(repo, 'pkg'))
  await client.call('workspace/open', { path: join(repo, 'pkg') })
  assert.deepEqual(idsOf(await client.call('agent/list', { project: join(repo, 'pkg') })), [
    ['reviewer', 'project', 'Repository reviewer'],
  ])

  const tree = join(tempDir('hd-agent-methods-tree-'), 'tree')
  await git('worktree', 'add', '-q', '-b', 'side', tree)
  await writeAgent(join(tree, '.harnessdesk', 'agents'), 'scout', 'Branch scout')
  await client.call('workspace/open', { path: tree })
  // The worktree's checkout, not the main one: the reviewer is untracked there and so is not in this branch.
  assert.deepEqual(idsOf(await client.call('agent/list', { project: tree })), [['scout', 'project', 'Branch scout']])
})

/*
 * `repo.root` on a `workspace/open` result names the *main* checkout on
 * purpose (`#openWorkspace`'s own comment: so the session list can group a
 * worktree under the project it is a checkout of) — but that is exactly the
 * wrong value for anything that wants the checkout this folder is actually
 * *in*, which for a linked worktree is the worktree's own top. `checkoutRoot`
 * is the value `projectOf` resolves an Agent read to, and what the roster's
 * watch names in an `agent/changed` notice for this same folder, so a
 * renderer surface reads it instead of `repo.root` whenever it needs "the
 * checkout this folder is a part of" rather than "the project this checkout
 * belongs to".
 */
test("workspace/open carries this checkout's own top, a linked worktree's included — never the main checkout `repo.root` deliberately names instead", async (t) => {
  const client = await connected(t)
  const repo = tempDir('hd-workspace-checkout-top-repo-')
  const realRepo = await realpath(repo)
  const git = (...args: string[]) =>
    run('git', ['-C', repo, '-c', 'user.email=dev@example.com', '-c', 'user.name=Jane Doe', ...args])
  await run('git', ['init', '-q', repo])
  await git('commit', '-q', '--allow-empty', '-m', 'root')
  await mkdir(join(repo, 'pkg'))

  type Opened = { checkoutRoot: string | null; repo: { root: string; worktree: boolean } | null }

  // A plain subfolder: its own checkout top is the repository's, same as `repo.root` here.
  const subfolder = (await client.call('workspace/open', { path: join(repo, 'pkg') })) as Opened
  assert.equal(subfolder.checkoutRoot, realRepo)
  assert.equal(subfolder.repo?.root, realRepo)
  assert.equal(subfolder.repo?.worktree, false)

  const tree = join(tempDir('hd-workspace-checkout-top-tree-'), 'tree')
  await git('worktree', 'add', '-q', '-b', 'checkout-top-branch', tree)
  const realTree = await realpath(tree)
  await mkdir(join(tree, 'pkg'))

  // The worktree's own subfolder: its checkout top is the worktree's own —
  // never the main repository `repo.root` names, and never this subfolder itself.
  const worktreeSubfolder = (await client.call('workspace/open', { path: join(tree, 'pkg') })) as Opened
  assert.equal(worktreeSubfolder.checkoutRoot, realTree)
  assert.equal(worktreeSubfolder.repo?.root, realRepo)
  assert.equal(worktreeSubfolder.repo?.worktree, true)
  assert.notEqual(
    worktreeSubfolder.checkoutRoot,
    worktreeSubfolder.repo?.root,
    "a worktree's own top and the main checkout `repo.root` names are two different folders here",
  )
})

test('the host says where this machine keeps its state, so the roster can name the folder it reads', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const hello = (await client.call('host/hello', { clientVersion: 'test' })) as { stateDir: string }
  assert.equal(hello.stateDir, harness.stateDir)
})
