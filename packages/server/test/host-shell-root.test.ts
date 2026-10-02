import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { ExtensionKernel, type HarnessContext, type HarnessPlugin } from '@harnessdesk/cordis-host'
import { sessionId, type AgentRuntime, type Session } from '@harnessdesk/protocol'

import { bridgeCallerFor } from '../src/bootstrap.js'
import { invokeForBridge } from '../src/tool-gateway.js'
import { Host } from '../src/host.js'
import { Worktrees } from '../src/worktree.js'
import { StateStore } from '../src/state.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, ...args], {
  env: { ...process.env, GIT_AUTHOR_NAME: 'Jane Doe', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Jane Doe', GIT_COMMITTER_EMAIL: 'dev@example.com' },
})).stdout

async function rig(t: TestContext, runtime?: AgentRuntime) {
  const base = await realpath(tempDir('hd-shell-authority-'))
  const project = join(base, 'project')
  const other = join(base, 'other')
  const stateDir = join(base, 'state')
  for (const cwd of [project, other]) {
    await run('git', ['init', '-q', '-b', 'main', cwd])
    await writeFile(join(cwd, 'file.txt'), 'original\n')
    await git(cwd, 'add', '.')
    await git(cwd, 'commit', '-qm', 'Initial fixture')
  }
  await writeFile(join(other, 'file.txt'), 'private-other-repository\n')
  const kernel = new ExtensionKernel()
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), extensions: kernel, builtinAgents: join(base, 'agents'), libraryHome: join(base, 'library') })
  const agent = runtime ?? new FakeRuntime()
  host.register(agent)
  t.after(async () => { await host.dispose(); await kernel.dispose() })
  await host.start()
  await host.call('workspace/open', { path: project })
  await kernel.load({
    manifest: { id: 'root-probe', name: 'Root probe', permissions: { shell: true, workspace: { read: true } } },
    plugin: {
      name: 'root-probe', inject: ['tools', 'shell', 'context'],
      apply(ctx: HarnessContext) {
        const where = async () => (await ctx.shell.run(process.execPath, ['-e', 'process.stdout.write(process.cwd())'])).stdout
        ctx.tools.register({ name: 'where', description: '', inputSchema: { type: 'object' }, execute: where })
        ctx.context.register({ label: 'Where', chip: { description: "Fixture context" }, resolve: where })
        ctx.context.register({ label: 'Diff', chip: { description: "Fixture context" }, resolve: async () => (await ctx.shell.run('git', ['diff'])).stdout })
        ctx.context.register({ label: 'Automatic location', resolve: where })
      },
    },
  } as HarnessPlugin)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const contexts = kernel.list('context')
  const tool = kernel.list('tool')[0]!
  const where = contexts.find((entry) => entry.label === 'Where')!
  const diff = contexts.find((entry) => entry.label === 'Diff')!
  const worktrees = new Worktrees(stateDir)
  const lane = await worktrees.create(project, { name: 'isolated' })
  const seat = async (cwd = lane.path) => {
    const agentRoot = join(base, 'agents', 'probe')
    await mkdir(agentRoot, { recursive: true })
    await writeFile(join(agentRoot, 'AGENT.md'), `---\nname: Probe\npermission: read\nprefer: [${agent.info.id}]\n---\nRead the checkout.\n`)
    return host.call('agent/seat', { id: 'probe', cwd, project })
  }
  return { host, kernel, agent, base, project, other, stateDir, lane, seat, tool, where, diff }
}

for (const forged of ['other repository', 'home'] as const) {
  test(`context/resolve ignores a forged workspaceRoot naming ${forged}`, async (t) => {
    const d = await rig(t)
    const workspaceRoot = forged === 'home' ? homedir() : d.other
    const answer = await d.host.call('context/resolve', { id: d.where.id, workspaceRoot })
    assert.equal(answer.text, d.project)
    assert.equal((await d.host.call('context/resolve', { id: d.diff.id, workspaceRoot: d.other })).text, '')
  })
}

for (const kind of ['relative', 'empty', 'unregistered', 'symlink elsewhere', 'home', 'filesystem root'] as const) {
  test(`shell admission falls back to the project for a ${kind} root`, async (t) => {
    const d = await rig(t)
    const unregistered = join(d.base, 'unregistered')
    await git(d.project, 'worktree', 'add', '-b', 'unregistered', unregistered)
    const link = kind === 'symlink elsewhere' ? d.lane.path : join(d.base, 'link')
    if (kind === 'symlink elsewhere') await rm(d.lane.path, { recursive: true })
    await symlink(d.other, link)
    const candidate = { relative: '.', empty: '', unregistered, 'symlink elsewhere': link, home: homedir(), 'filesystem root': '/' }[kind]
    const id = sessionId('unconfirmed')
    const record = d.host.registry.upsert({ id, runtime: d.agent.info.id, cwd: candidate, status: { type: 'idle' }, createdAt: 0, updatedAt: 0, turns: [], itemsLoaded: true }, null)
    // Admission also defends a stale host record whose path was replaced on disk.
    Object.assign(record, { shellCheckout: { project: d.project, cwd: candidate } })
    const scope = { runtime: d.agent.info.id, sessionId: id, workspaceRoot: candidate }
    const result = await d.kernel.invokeTool(d.tool.id, {}, scope)
    assert.deepEqual(result, { ok: true, content: [{ type: 'text', text: d.project }] })
    assert.deepEqual(await d.kernel.resolveContext(scope), [{ label: 'Automatic location', text: d.project }])
  })
}

test('an ACP resume listing cannot replace a Seat’s host-authorized shell checkout', async (t) => {
  const store = join(await realpath(tempDir('hd-shell-acp-')), 'sessions.json')
  const acp = new AcpRuntime({ id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath,
    args: [fileURLToPath(new URL('../../../adapter-acp/test/fixtures/fake-acp-agent.mjs', import.meta.url))], env: { FAKE_ACP_STORE: store } })
  const d = await rig(t, acp)
  const opened = await d.seat()
  const id = opened.id
  // Finish the scripted turn before replacing the peer's stored listing.
  const deadline = Date.now() + 5000
  while (d.host.registry.get(acp.info.id, id)?.running.size) {
    if (Date.now() > deadline) throw new Error('the scripted Seat turn did not finish')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await d.host.unregister(acp.info.id)
  const stored = JSON.parse(await readFile(store, 'utf8'))
  stored[String(id)].cwd = homedir()
  await writeFile(store, JSON.stringify(stored))
  const resumed = new AcpRuntime({ id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath,
    args: [fileURLToPath(new URL('../../../adapter-acp/test/fixtures/fake-acp-agent.mjs', import.meta.url))], env: { FAKE_ACP_STORE: store } })
  d.host.register(resumed)
  await resumed.start()
  await d.host.call('session/resume', { runtime: acp.info.id, sessionId: id })
  const record = d.host.registry.get(acp.info.id, id)!
  assert.equal(record.session.cwd, homedir(), 'the real ACP peer listing and replay substituted home')
  const caller = bridgeCallerFor(d.host, String(acp.info.id), String(id))
  assert.equal(caller.workspaceRoot, d.lane.path, 'the actual bootstrap getter retains host placement after ACP replay')
  const result = await invokeForBridge(d.kernel, new Map([['seat-token', caller]]), { namespace: d.tool.namespace, name: d.tool.name, args: {}, caller: 'seat-token' })
  assert.deepEqual(result, { ok: true, content: [{ type: 'text', text: d.lane.path }] })
  // A fresh read/snapshot must not change that authority either.
  d.host.registry.upsert({ ...record.session, cwd: d.other } as Session, null)
  const answer = await d.host.call('context/resolve', { id: d.where.id, runtime: acp.info.id, sessionId: id, workspaceRoot: d.other })
  assert.equal(answer.text, d.lane.path)
  assert.equal(caller.workspaceRoot, d.lane.path)
})


test('a replaced project root cannot widen the shell’s project fallback', async (t) => {
  const d = await rig(t)
  await rename(d.project, join(d.base, 'original-project'))
  await symlink(d.other, d.project)
  await assert.rejects(d.host.call('context/resolve', { id: d.where.id, workspaceRoot: d.other }), /project checkout changed/i)
})
