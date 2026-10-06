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
import { EvidenceStore } from '../src/evidence/store.js'
import { captureShellProject, shellProjectUnchanged } from '../src/shell-project.js'
import { LaneStore } from '../src/goals/lanes.js'
import { StateStore } from '../src/state.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, ...args], {
  env: { ...process.env, GIT_AUTHOR_NAME: 'Jane Doe', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Jane Doe', GIT_COMMITTER_EMAIL: 'dev@example.com' },
})).stdout

async function rig(t: TestContext, runtime?: AgentRuntime, collision = false) {
  const base = await realpath(tempDir('hd-shell-authority-'))
  const project = join(base, collision ? 'a/b' : 'project')
  const other = join(base, collision ? 'a\\b' : 'other')
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
  let disposed = false
  const dispose = async () => { if (!disposed) { disposed = true; await host.dispose(); await kernel.dispose() } }
  t.after(dispose)
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
  return { host, kernel, agent, base, project, other, stateDir, lane, seat, tool, where, diff, dispose }
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
    Object.assign(record, { shellCheckout: { project: d.project, cwd: candidate, source: 'own' } })
    const scope = { runtime: d.agent.info.id, sessionId: id, workspaceRoot: candidate }
    const result = await d.kernel.invokeTool(d.tool.id, {}, scope)
    assert.deepEqual(result, { ok: true, content: [{ type: 'text', text: d.project }] })
    assert.deepEqual(await d.kernel.resolveContext(scope), [{ label: 'Automatic location', text: d.project }])
    assert.equal(record.shellCheckout?.source, 'fallback')
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

for (const kind of ['home', 'other repository', 'symlink into another repository', 'unopened linked checkout'] as const) {
  test(`agent/seat refuses cwd naming ${kind} before opening a runtime session`, async (t) => {
    const d = await rig(t)
    const link = join(d.base, 'foreign-link')
    await symlink(d.other, link)
    const unopened = join(d.base, 'unopened')
    await git(d.project, 'worktree', 'add', '-b', 'unopened', unopened)
    const candidate = kind === 'home' ? homedir() : kind === 'other repository' ? d.other : kind === 'unopened linked checkout' ? unopened : link
    const create = t.mock.method(d.agent, 'createSession')
    await assert.rejects(d.seat(candidate), /Seat checkout.*not admitted/i)
    assert.equal(create.mock.callCount(), 0)
  })
}

for (const replacement of ['foreign repository', 'deleted lane'] as const) {
  test(`a ${replacement} at a placed lane falls back before the next shell invocation`, async (t) => {
    const d = await rig(t)
    const opened = await d.seat()
    await rm(d.lane.path, { recursive: true, force: true })
    if (replacement === 'foreign repository') {
      await run('git', ['init', '-q', '-b', 'main', d.lane.path])
      await writeFile(join(d.lane.path, 'file.txt'), 'foreign fixture')
      await git(d.lane.path, 'add', '.')
      await git(d.lane.path, 'commit', '-qm', 'Foreign fixture')
    }
    assert.equal((await d.host.call('context/resolve', { id: d.where.id, runtime: d.agent.info.id, sessionId: opened.id })).text, d.project)
    assert.equal(d.host.registry.get(d.agent.info.id, opened.id)?.shellCheckout?.source, 'fallback')
  })
}

test('case-insensitive project and lane spellings keep the canonical placement', async (t) => {
  const d = await rig(t)
  const spelling = d.project.toUpperCase()
  try { await realpath(spelling) } catch { t.skip('the filesystem is case-sensitive'); return }
  await d.seat()
  const opened = await d.host.call('agent/seat', { id: 'probe', cwd: d.lane.path.toUpperCase(), project: spelling })
  assert.deepEqual(d.host.registry.get(d.agent.info.id, opened.id)!.shellCheckout, { project: d.project, cwd: d.lane.path, source: 'own' })
})

test('restart re-admits forged durable placement against opened projects', async (t) => {
  const d = await rig(t)
  const opened = await d.seat()
  await d.dispose()
  const folder = new EvidenceStore(join(d.stateDir, 'evidence')).folderOf(d.project)
  const path = join(folder, 'seats.ndjson')
  const lines = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  for (const line of lines) if (line.type === 'seat') line.record.checkout = { ...line.record.checkout, project: d.other, cwd: d.other }
  await rm(path)
  await new EvidenceStore(join(d.stateDir, 'evidence')).append(d.other, 'seats', lines)
  const kernel = new ExtensionKernel()
  const restarted = new Host({ logger: silent, state: new StateStore(join(d.stateDir, 'state.json')), extensions: kernel, builtinAgents: join(d.base, 'agents'), libraryHome: join(d.base, 'library') })
  const agent = new FakeRuntime()
  restarted.register(agent)
  t.after(async () => { await restarted.dispose(); await kernel.dispose() })
  await restarted.start()
  restarted.registry.upsert({ ...opened, runtime: agent.info.id }, null)
  assert.equal((await restarted.call('evidence/seat', { runtime: agent.info.id, sessionId: opened.id }))?.checkout.project, d.other, 'the forged local placement really loaded')
  // Use the host's real admission resolver, with a shell command in the new kernel.
  await kernel.load({ manifest: { id: 'restored-probe', name: 'Restored probe', permissions: { shell: true, workspace: { read: true } } }, plugin: {
    name: 'restored-probe', inject: ['context', 'shell'], apply(ctx: HarnessContext) {
      ctx.context.register({ label: 'Restored location', chip: { description: 'Fixture context' }, resolve: async () => (await ctx.shell.run(process.execPath, ['-e', 'process.stdout.write(process.cwd())'])).stdout })
    },
  } } as HarnessPlugin)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal((await restarted.call('context/resolve', { id: kernel.list('context')[0]!.id, runtime: agent.info.id, sessionId: opened.id })).text, d.project)
})

test('omitting project cannot relocate a new Seat from a foreign cwd to the opened project', async (t) => {
  const d = await rig(t)
  await d.seat()
  await assert.rejects(d.host.call('agent/seat', { id: 'probe', cwd: d.other }), /Seat checkout.*not admitted/i)
})

test('a runtime-listed repository cannot admit a Seat project the person never opened', async (t) => {
  const d = await rig(t)
  await d.seat()
  d.host.registry.upsert({ id: sessionId('foreign-listed'), runtime: d.agent.info.id, cwd: d.other, status: { type: 'idle' }, createdAt: 0, updatedAt: 0, turns: [], itemsLoaded: true }, null)
  await assert.rejects(d.host.call('agent/seat', { id: 'probe', project: d.other, cwd: d.other }), /outside every project opened here/)
})

test('opening a project subfolder keeps the repository as the default shell anchor', async (t) => {
  const d = await rig(t)
  await d.seat()
  const subfolder = join(d.project, 'src')
  await mkdir(subfolder)
  await d.host.call('workspace/open', { path: subfolder })
  const opened = await d.host.call('agent/seat', { id: 'probe', cwd: d.lane.path })
  assert.deepEqual(d.host.registry.get(d.agent.info.id, opened.id)!.shellCheckout, { project: d.project, cwd: d.lane.path, source: 'own' })
})

for (const kind of ['main', 'opened linked'] as const) {
  test(`the ordinary UI Agent start from the ${kind} checkout subfolder reaches the admitted checkout`, async (t) => {
    const d = await rig(t)
    await d.seat(d.project)
    const checkout = kind === 'main' ? d.project : join(d.base, 'opened-linked')
    if (kind === 'opened linked') await git(d.project, 'worktree', 'add', '-b', 'opened-linked', checkout)
    const subfolder = join(checkout, 'src')
    await mkdir(subfolder)
    await d.host.call('workspace/open', { path: subfolder })
    await d.host.call('workspace/forget', { path: d.project })
    const create = t.mock.method(d.agent, 'createSession')
    // startAsAgent uses the opened folder for both the dry run and the real start.
    const [plan] = await d.host.call('agent/seat/dry', { ids: ['probe'], project: subfolder })
    assert.ok(plan)
    assert.notEqual(plan?.winner, null)
    assert.equal(create.mock.callCount(), 0)
    const opened = await d.host.call('agent/seat', { id: 'probe', cwd: subfolder, project: subfolder })
    assert.equal(create.mock.calls[0]!.arguments[0]!.cwd, checkout)
    assert.equal(opened.cwd, checkout)
    assert.deepEqual(d.host.registry.get(d.agent.info.id, opened.id)!.shellCheckout, { project: d.project, cwd: checkout, source: 'own' })
    const scope = { runtime: d.agent.info.id, sessionId: opened.id, workspaceRoot: d.other }
    assert.deepEqual(await d.kernel.invokeTool(d.tool.id, {}, scope), { ok: true, content: [{ type: 'text', text: checkout }] })
    assert.equal((await d.host.call('context/resolve', { id: d.where.id, ...scope })).text, checkout)
    if (kind === 'opened linked') {
      const sibling = join(d.base, 'unopened-linked')
      await git(d.project, 'worktree', 'add', '-b', 'unopened-linked', sibling)
      await mkdir(join(sibling, 'src'))
      await assert.rejects(d.host.call('agent/seat', { id: 'probe', cwd: join(sibling, 'src'), project: subfolder }), /Seat checkout.*not admitted/i)
      assert.equal(create.mock.callCount(), 1)
    }
  })
}

for (const redirect of ['core.worktree', 'gitdir file'] as const) {
  test(`a foreign folder redirected to the admitted checkout by ${redirect} cannot start a Seat`, async (t) => {
    const d = await rig(t)
    await d.seat(d.project)
    if (redirect === 'core.worktree') await git(d.other, 'config', 'core.worktree', d.project)
    else {
      await rm(join(d.other, '.git'), { recursive: true })
      await writeFile(join(d.other, '.git'), `gitdir: ${join(d.project, '.git')}\n`)
    }
    const create = t.mock.method(d.agent, 'createSession')
    await assert.rejects(d.seat(d.other), /Seat checkout.*not admitted/i)
    assert.equal(create.mock.callCount(), 0)
  })
}

test('an opened linked checkout admits its canonical repository project independently of cwd', async (t) => {
  const d = await rig(t)
  await d.seat()
  await d.host.call('workspace/open', { path: d.lane.path })
  const opened = await d.host.call('agent/seat', { id: 'probe', project: d.lane.path, cwd: d.lane.path })
  assert.deepEqual(d.host.registry.get(d.agent.info.id, opened.id)!.shellCheckout, { project: d.project, cwd: d.lane.path, source: 'own' })
  assert.equal((await d.host.call('evidence/seat', { runtime: d.agent.info.id, sessionId: opened.id }))?.checkout.project, d.project)
})

test('an explicitly opened unmanaged linked checkout starts its Agent and shell in that checkout', async (t) => {
  const d = await rig(t)
  await d.seat()
  const checkout = join(d.base, 'person-opened')
  const sibling = join(d.base, 'unopened-sibling')
  await git(d.project, 'worktree', 'add', '-b', 'person-opened', checkout)
  await git(d.project, 'worktree', 'add', '-b', 'unopened-sibling', sibling)
  assert.equal((await new Worktrees(d.stateDir).list(d.project)).find((entry) => entry.path === checkout)?.managed, false)
  await d.host.call('workspace/open', { path: checkout })
  const saved = JSON.parse(await readFile(join(d.stateDir, 'state.json'), 'utf8')).workspaces[0]
  assert.equal(saved.shellIdentity.checkoutRoot, checkout)
  assert.equal(await shellProjectUnchanged(checkout, saved.shellIdentity), true)
  const create = t.mock.method(d.agent, 'createSession')
  const opened = await d.host.call('agent/seat', { id: 'probe', project: checkout, cwd: checkout })
  assert.equal(create.mock.calls[0]!.arguments[0]!.cwd, checkout)
  assert.equal(opened.cwd, checkout)
  assert.deepEqual(d.host.registry.get(d.agent.info.id, opened.id)!.shellCheckout, { project: d.project, cwd: checkout, source: 'own' })
  const scope = { runtime: d.agent.info.id, sessionId: opened.id, workspaceRoot: d.other }
  assert.deepEqual(await d.kernel.invokeTool(d.tool.id, {}, scope), { ok: true, content: [{ type: 'text', text: checkout }] })
  assert.equal((await d.host.call('context/resolve', { id: d.where.id, ...scope })).text, checkout)
  assert.deepEqual(await d.kernel.resolveContext(scope), [{ label: 'Automatic location', text: checkout }])
  await assert.rejects(d.host.call('agent/seat', { id: 'probe', project: checkout, cwd: sibling }), /Seat checkout.*not admitted/i)
  assert.equal(create.mock.callCount(), 1, 'opening one linked checkout never admits an unopened sibling')
  await d.host.call('workspace/open', { path: d.project })
  assert.deepEqual(await d.kernel.invokeTool(d.tool.id, {}, scope), { ok: true, content: [{ type: 'text', text: checkout }] },
    'opening the main checkout again does not revoke the still-open linked checkout')
  const another = await d.host.call('agent/seat', { id: 'probe', project: d.project, cwd: checkout })
  assert.equal(another.cwd, checkout)
})

for (const change of ['core.worktree=/', 'core.worktree=another repository', '.git replaced by a gitdir file'] as const) {
  test(`shell admission refuses ${change} after workspace open`, async (t) => {
    const d = await rig(t)
    const opened = await d.seat()
    if (change === '.git replaced by a gitdir file') {
      await rename(join(d.project, '.git'), join(d.base, 'original-git'))
      await writeFile(join(d.project, '.git'), `gitdir: ${join(d.other, '.git')}\n`)
    } else {
      await git(d.project, 'config', 'core.worktree', change === 'core.worktree=/' ? '/' : d.other)
    }
    const scope = { runtime: d.agent.info.id, sessionId: opened.id }
    await assert.rejects(d.host.call('context/resolve', { id: d.where.id, ...scope }), /project checkout changed/i)
    await assert.rejects(d.host.call('context/resolve', { id: d.where.id }), /project checkout changed/i)
    const create = t.mock.method(d.agent, 'createSession')
    if (change === '.git replaced by a gitdir file') {
      await assert.rejects(d.seat(), /project checkout changed|outside every project opened here/i)
    } else {
      const top = change === 'core.worktree=/' ? '/' : d.other
      await assert.rejects(d.seat(), {
        message: `${top} is the top level of an open checkout, but git there resolves to a different repository. ` +
          'Open its folder first to work in it.',
      })
    }
    assert.equal(create.mock.callCount(), 0, 'the refusal never starts another Agent')
    await assert.rejects(d.kernel.invokeTool(d.tool.id, {}, scope), /project checkout changed/i)
    await assert.rejects(d.kernel.resolveContext(scope), /project checkout changed/i)
  })
}

test('workspace open records a linked checkout identity and still executes in its lane', async (t) => {
  const d = await rig(t)
  await d.seat()
  await d.host.call('workspace/open', { path: d.lane.path })
  const saved = JSON.parse(await readFile(join(d.stateDir, 'state.json'), 'utf8')).workspaces[0]
  assert.deepEqual(saved.shellIdentity, {
    project: d.project,
    checkoutRoot: d.lane.path,
    gitCommonDir: await realpath(join(d.project, '.git')),
  }, 'the host must keep the opened Git identity instead of deriving authority again')
  const opened = await d.host.call('agent/seat', { id: 'probe', project: d.lane.path, cwd: d.lane.path })
  const scope = { runtime: d.agent.info.id, sessionId: opened.id }
  assert.deepEqual(await d.kernel.invokeTool(d.tool.id, {}, scope), { ok: true, content: [{ type: 'text', text: d.lane.path }] })
  assert.equal((await d.host.call('context/resolve', { id: d.where.id, ...scope })).text, d.lane.path)
})

test('restart retains the opened project identity after core.worktree changes', async (t) => {
  const d = await rig(t)
  await d.dispose()
  await git(d.project, 'config', 'core.worktree', d.other)
  const kernel = new ExtensionKernel()
  const restarted = new Host({ logger: silent, state: new StateStore(join(d.stateDir, 'state.json')), extensions: kernel, builtinAgents: join(d.base, 'agents'), libraryHome: join(d.base, 'library') })
  t.after(async () => { await restarted.dispose(); await kernel.dispose() })
  await restarted.start()
  await kernel.load({ manifest: { id: 'restart-probe', name: 'Restart probe', permissions: { shell: true, workspace: { read: true } } }, plugin: {
    name: 'restart-probe', inject: ['context', 'shell'], apply(ctx: HarnessContext) {
      ctx.context.register({ label: 'Restart location', chip: { description: 'Fixture context' }, resolve: async () => (await ctx.shell.run(process.execPath, ['-e', 'process.stdout.write(process.cwd())'])).stdout })
    },
  } } as HarnessPlugin)
  await new Promise((resolve) => setTimeout(resolve, 60))
  await assert.rejects(restarted.call('context/resolve', { id: kernel.list('context')[0]!.id }), /project checkout changed/i)
})

for (const kind of ['filesystem root', 'home directory'] as const) {
  test(`shell boundaries refuse ${kind} even as the project fallback`, async (t) => {
    const d = await rig(t)
    const worktrees = new Worktrees(d.stateDir)
    await assert.rejects(worktrees.shellRoot(kind === 'filesystem root' ? '/' : await realpath(homedir())), /home directory|filesystem root/i)
  })
}


test('POSIX core.worktree slash/backslash collision invalidates identity and refuses shell', { skip: process.platform === 'win32' }, async (t) => {
  const d = await rig(t, undefined, true)
  const identity = await captureShellProject(d.project)
  const opened = await d.seat()
  await git(d.project, 'config', 'core.worktree', d.other)
  assert.equal(await shellProjectUnchanged(d.project, identity), false)
  const scope = { runtime: d.agent.info.id, sessionId: opened.id }
  await assert.rejects(d.host.call('context/resolve', { id: d.diff.id, ...scope }), /project checkout changed/i)
  await assert.rejects(d.kernel.invokeTool(d.tool.id, {}, scope), /project checkout changed/i)
  await assert.rejects(d.kernel.resolveContext(scope), /project checkout changed/i)
  const create = t.mock.method(d.agent, 'createSession')
  await assert.rejects(d.seat(), {
    message: `${d.other} is the top level of an open checkout, but git there resolves to a different repository. ` +
      'Open its folder first to work in it.',
  })
  assert.equal(create.mock.callCount(), 0, 'the refusal never starts another Agent')
})

test('POSIX browser lane membership keeps slash/backslash checkouts distinct', { skip: process.platform === 'win32' }, async (t) => {
  const base = await realpath(tempDir('hd-browser-membership-'))
  const cwd = join(base, 'a/b')
  const foreign = join(base, 'a\\b')
  await mkdir(cwd, { recursive: true })
  await mkdir(foreign)
  const stateDir = join(base, 'state')
  const lanes = new LaneStore(stateDir)
  await lanes.load()
  await lanes.save({ id: 'collision', goal: 'fixture-goal', seat: null, cwd, branch: '',
    ports: { start: 30000, end: 30019 }, browserProfile: 'lane-11111111-1111-1111-1111-111111111111', state: 'released', createdAt: 1 })
  const kernel = new ExtensionKernel()
  let resolveBrowser!: Parameters<ExtensionKernel['setBrowserResolver']>[0]
  const original = kernel.setBrowserResolver.bind(kernel)
  t.mock.method(kernel, 'setBrowserResolver', (resolve: typeof resolveBrowser) => {
    resolveBrowser = resolve
    original(resolve)
  })
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), extensions: kernel,
    builtinAgents: join(base, 'agents'), libraryHome: join(base, 'library') })
  t.after(async () => { await host.dispose(); await kernel.dispose() })
  await host.start()
  const agent = new FakeRuntime()
  const id = sessionId('browser-membership')
  const session = { id, runtime: agent.info.id, cwd, status: { type: 'idle' } as const,
    createdAt: 0, updatedAt: 0, turns: [], itemsLoaded: true }
  host.registry.upsert(session, null)
  const scope = { runtime: agent.info.id, sessionId: id }
  assert.throws(() => resolveBrowser(scope), /lane was released/, 'control: the actual lane is found')
  host.registry.upsert({ ...session, cwd: foreign }, null)
  assert.equal(resolveBrowser(scope), 'default', 'a distinct POSIX folder cannot select the released browser lane')
})

test('legacy workspace record without identity refuses shell until workspace open', async (t) => {
  const d = await rig(t)
  await d.dispose()
  const path = join(d.stateDir, 'state.json')
  const state = JSON.parse(await readFile(path, 'utf8'))
  for (const entry of state.workspaces) delete entry.shellIdentity
  await writeFile(path, JSON.stringify(state))
  const kernel = new ExtensionKernel()
  const host = new Host({ logger: silent, state: new StateStore(path), extensions: kernel,
    builtinAgents: join(d.base, 'agents'), libraryHome: join(d.base, 'library') })
  t.after(async () => { await host.dispose(); await kernel.dispose() })
  await host.start()
  await kernel.load({ manifest: { id: 'legacy-probe', name: 'Legacy probe', permissions: { shell: true, workspace: { read: true } } },
    plugin: { name: 'legacy-probe', inject: ['context', 'shell'], apply(ctx: HarnessContext) {
      ctx.context.register({ label: 'Legacy location', chip: { description: 'Fixture context' },
        resolve: async () => (await ctx.shell.run(process.execPath, ['-e', 'process.stdout.write(process.cwd())'])).stdout })
    } } } as HarnessPlugin)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const id = kernel.list('context')[0]!.id
  await assert.rejects(host.call('context/resolve', { id }), /project checkout changed/i)
  await host.call('workspace/open', { path: d.project })
  assert.equal((await host.call('context/resolve', { id })).text, d.project)
})

test('ambient GIT_DIR and GIT_WORK_TREE cannot redirect captured or validated identity', async (t) => {
  const d = await rig(t)
  const expected = await captureShellProject(d.project)
  const keys = ['GIT_DIR', 'GIT_WORK_TREE'] as const
  const saved = keys.map((key) => process.env[key])
  try {
    process.env.GIT_DIR = join(d.other, '.git')
    process.env.GIT_WORK_TREE = d.other
    assert.deepEqual(await captureShellProject(d.project), expected)
    assert.equal(await shellProjectUnchanged(d.project, expected), true)
    assert.equal((await d.host.call('context/resolve', { id: d.where.id })).text, d.project)
  } finally {
    keys.forEach((key, index) => { const value = saved[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value })
  }
})
