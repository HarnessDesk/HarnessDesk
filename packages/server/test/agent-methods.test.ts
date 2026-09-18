import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'

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
  assert.equal(one?.definition?.permission, 'read')
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
 * rule every other path the renderer names answers to: inside a folder opened
 * here, or refused before anything is read.
 */

/** One folder open, one not, and a roster that records every project it is asked about. */
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
    workspaces: { openRoots: () => [open] },
  } as never
  return { ctx, asked, open, elsewhere }
}

test('a project outside every open folder is refused, and nothing under it is read', async () => {
  const { ctx, asked, open, elsewhere } = await confinedRig()
  await assert.rejects(agentMethods['agent/list'](ctx, { project: elsewhere }), /outside every open workspace/)
  await assert.rejects(
    agentMethods['agent/read'](ctx, { id: 'secret', project: elsewhere }),
    /outside every open workspace/,
  )
  // `..` is collapsed before the check, so it cannot walk out of an open folder.
  await assert.rejects(
    agentMethods['agent/list'](ctx, { project: join(open, '..', 'elsewhere') }),
    /outside every open workspace/,
  )
  // Nor can a relative path, which would resolve against wherever the host was started.
  await assert.rejects(agentMethods['agent/list'](ctx, { project: 'elsewhere' }), /not an absolute path/)
  assert.deepEqual(asked, [], 'the roster is not asked about a folder the window does not have open')
})

/*
 * The control for the refusal above, which a handler refusing every project
 * would also pass: an open folder's project reaches the roster, and what it
 * holds comes back.
 */
test('a project inside an open folder is read, and its Agents are the ones answered', async () => {
  const { ctx, asked, open } = await confinedRig()
  const listed = await agentMethods['agent/list'](ctx, { project: open })
  assert.deepEqual(
    listed.map((one) => [one.id, one.origin, one.definition?.name]),
    [['reviewer', 'project', 'Open reviewer']],
  )
  const one = await agentMethods['agent/read'](ctx, { id: 'reviewer', project: open })
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
