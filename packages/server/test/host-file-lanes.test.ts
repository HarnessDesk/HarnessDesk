import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'

import { ExtensionKernel, setEditorEngine, type HarnessContext, type HarnessPlugin } from '@harnessdesk/cordis-host'
import { SupervisedExtensionHost } from '@harnessdesk/extension-host'
import type { Session } from '@harnessdesk/protocol'

import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { Worktrees } from '../src/worktree.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/*
 * What a plugin tool sees through the host's own admission: a conversation in the folder the person opened runs in
 * that folder as it was opened, however the host admits it; a Seat with a checkout of its own runs in that checkout.
 */

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, ...args], {
  env: { ...process.env, GIT_AUTHOR_NAME: 'Jane Doe', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Jane Doe', GIT_COMMITTER_EMAIL: 'dev@example.com' },
})).stdout

async function rig(t: TestContext) {
  const base = await realpath(tempDir('hd-file-lanes-'))
  const project = join(base, 'project')
  const stateDir = join(base, 'state')
  await run('git', ['init', '-q', '-b', 'main', project])
  await mkdir(join(project, 'src'))
  await writeFile(join(project, 'file.txt'), 'top\n')
  await writeFile(join(project, 'src', 'file.txt'), 'src\n')
  await git(project, 'add', '.')
  await git(project, 'commit', '-qm', 'Initial fixture')
  const linked = join(base, 'linked')
  await git(project, 'worktree', 'add', '-q', '-b', 'feature', linked)
  await writeFile(join(linked, 'file.txt'), 'linked\n')
  await writeFile(join(linked, 'src', 'file.txt'), 'linked src\n')
  const alias = join(base, 'alias')
  await symlink(project, alias)

  const kernel = new SupervisedExtensionHost(new ExtensionKernel(), { env: { HARNESSDESK_PLUGINS: join(base, 'plugins') } })
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), extensions: kernel, builtinAgents: join(base, 'agents'), libraryHome: join(base, 'library') })
  const agent = new FakeRuntime()
  host.register(agent)
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    setEditorEngine(null)
    await host.dispose()
    await kernel.dispose()
  }
  t.after(async () => {
    await dispose()
  })
  await host.start()
  setEditorEngine(host.editorPlane)
  await kernel.loadBuiltin({
    manifest: { id: 'file-probe', name: 'File probe', permissions: { workspace: { read: true }, editor: true } },
    plugin: {
      name: 'file-probe', inject: ['tools', 'context', 'fs', 'workspace', 'editor'],
      apply(ctx: HarnessContext) {
        ctx.context.register({
          label: 'Where', chip: { description: 'Fixture location' },
          resolve: async () => JSON.stringify({ root: ctx.workspace.root, branch: ctx.workspace.branch, read: (await ctx.fs.read('file.txt')).trim() }),
        })
        ctx.tools.register({
          name: 'where', description: '', inputSchema: { type: 'object' },
          execute: async () => JSON.stringify({
            root: ctx.workspace.root,
            branch: ctx.workspace.branch,
            read: (await ctx.fs.read('file.txt')).trim(),
            names: (await ctx.fs.list('.')).map((entry) => entry.name).filter((name) => name !== '.git').sort(),
            editor: await ctx.editor.open('file.txt').then(() => 'opened', (error: unknown) => String(error)),
          }),
        })
      },
    },
  } as HarnessPlugin)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const tool = kernel.list('tool')[0]!
  const where = async (scope: { runtime: string; sessionId: string }) => {
    const result = await kernel.invokeTool(tool.id, {}, scope as never)
    if (!result.ok) assert.fail(result.error)
    const part = result.content[0]
    if (part?.type !== 'text') assert.fail('the probe answers in text')
    return JSON.parse(part.text)
  }
  const chip = kernel.list('context').find((one) => one.chip)!
  const context = async (scope: { runtime: string; sessionId: string }) => {
    const result = await kernel.resolveOne(chip.id, undefined, scope as never)
    assert.ok(result, 'the location chip resolves')
    return JSON.parse(result.text)
  }
  const agentRoot = join(base, 'agents', 'probe')
  await mkdir(agentRoot, { recursive: true })
  await writeFile(join(agentRoot, 'AGENT.md'), `---\nname: Probe\npermission: read\nprefer: [${agent.info.id}]\n---\nRead the checkout.\n`)
  const seat = async (cwd: string, project?: string) => {
    const seated = await host.call('agent/seat', { id: 'probe', cwd, ...(project ? { project } : {}) })
    return { runtime: String(agent.info.id), sessionId: String(seated.id) }
  }
  /** A conversation started the ordinary way, in the folder that is open. */
  const conversation = async (cwd: string) => {
    const session = (await host.call('session/create', { runtime: agent.info.id, options: { cwd } } as never)) as Session
    return { runtime: String(agent.info.id), sessionId: String(session.id) }
  }
  return { host, agent, base, project, linked, alias, stateDir, where, context, seat, conversation, dispose }
}

test('a conversation in the open folder runs its tool calls in that folder as it was opened', async (t) => {
  const d = await rig(t)
  const cases = [
    { opened: d.project, branch: 'main', read: 'top', names: ['file.txt', 'src'] },
    // Admitted to the repository, which holds the folder that was opened.
    { opened: join(d.project, 'src'), branch: 'main', read: 'src', names: ['file.txt'] },
    // Admitted to the project's main checkout, another branch with other contents.
    { opened: d.linked, branch: 'feature', read: 'linked', names: ['file.txt', 'src'] },
    { opened: join(d.linked, 'src'), branch: 'feature', read: 'linked src', names: ['file.txt'] },
    // Admitted to the real path the link leads to.
    { opened: d.alias, branch: 'main', read: 'top', names: ['file.txt', 'src'] },
  ]
  for (const { opened, ...expected } of cases) {
    await d.host.call('workspace/open', { path: opened })
    const scope = await d.conversation(opened)
    assert.deepEqual(await d.where(scope), { root: opened, ...expected, editor: 'opened' }, opened)
    assert.deepEqual(await d.context(scope), { root: opened, branch: expected.branch, read: expected.read }, opened)
  }
})

test('a Seat in a lane of its own runs its tool calls in the lane', async (t) => {
  const d = await rig(t)
  await d.host.call('workspace/open', { path: d.project })
  const lane = await new Worktrees(d.stateDir).create(d.project, { name: 'isolated' })
  await writeFile(join(lane.path, 'file.txt'), 'lane\n')
  const agentRoot = join(d.base, 'agents', 'probe')
  await mkdir(agentRoot, { recursive: true })
  await writeFile(join(agentRoot, 'AGENT.md'), `---\nname: Probe\npermission: read\nprefer: [${d.agent.info.id}]\n---\nRead the checkout.\n`)
  const seated = await d.host.call('agent/seat', { id: 'probe', cwd: lane.path, project: d.project })
  const scope = { runtime: String(d.agent.info.id), sessionId: String(seated.id) }
  assert.deepEqual(await d.where(scope), { root: lane.path, branch: null, read: 'lane', names: ['file.txt', 'src'], editor: 'opened' })
  // The person's own conversation in the open folder is not moved by the Seat's lane.
  assert.deepEqual(await d.where(await d.conversation(d.project)), { root: d.project, branch: 'main', read: 'top', names: ['file.txt', 'src'], editor: 'opened' })
})


test('a Seat started in the checkout holding an opened subfolder follows that folder for tools and context', async (t) => {
  const d = await rig(t)
  const opened = join(d.linked, 'src')
  await d.host.call('workspace/open', { path: opened })
  const scope = await d.seat(d.linked, opened)
  assert.deepEqual(await d.where(scope), { root: opened, branch: 'feature', read: 'linked src', names: ['file.txt'], editor: 'opened' })
  assert.deepEqual(await d.context(scope), { root: opened, branch: 'feature', read: 'linked src' })
})

test('a Seat on the main checkout stays there while a linked worktree is open', async (t) => {
  const d = await rig(t)
  await d.host.call('workspace/open', { path: d.linked })
  const scope = await d.seat(d.project)
  assert.deepEqual(await d.where(scope), { root: d.project, branch: null, read: 'top', names: ['file.txt', 'src'], editor: 'opened' })
  assert.deepEqual(await d.context(scope), { root: d.project, branch: null, read: 'top' })
  // Cached admission must remember that this is the Seat's checkout, not a project fallback.
  assert.deepEqual(await d.context(scope), { root: d.project, branch: null, read: 'top' })
})

test('a Seat whose lane disappears follows the opened linked worktree for tools and chips', async (t) => {
  const d = await rig(t)
  await d.host.call('workspace/open', { path: d.project })
  const lane = await new Worktrees(d.stateDir).create(d.project, { name: 'vanishing' })
  const scope = await d.seat(lane.path)
  await d.host.call('workspace/open', { path: d.linked })
  await rm(lane.path, { recursive: true, force: true })

  assert.deepEqual(await d.where(scope), { root: d.linked, branch: 'feature', read: 'linked', names: ['file.txt', 'src'], editor: 'opened' })
  assert.deepEqual(await d.context(scope), { root: d.linked, branch: 'feature', read: 'linked' })
})

test('a restarted host re-admits a kept Seat and falls back when another Seat lane is missing', async (t) => {
  const d = await rig(t)
  await d.host.call('workspace/open', { path: d.linked })
  const scope = await d.seat(d.project)
  const session = d.host.registry.get(d.agent.info.id, scope.sessionId as Session['id'])!.session
  const lane = await new Worktrees(d.stateDir).create(d.project, { name: 'missing-on-restart' })
  const missingScope = await d.seat(lane.path, d.project)
  const missingSession = d.host.registry.get(d.agent.info.id, missingScope.sessionId as Session['id'])!.session
  await rm(lane.path, { recursive: true, force: true })
  await d.dispose()

  const kernel = new SupervisedExtensionHost(new ExtensionKernel(), { env: { HARNESSDESK_PLUGINS: join(d.base, 'plugins') } })
  const restarted = new Host({ logger: silent, state: new StateStore(join(d.stateDir, 'state.json')), extensions: kernel, builtinAgents: join(d.base, 'agents'), libraryHome: join(d.base, 'library') })
  const agent = new FakeRuntime()
  restarted.register(agent)
  t.after(async () => {
    setEditorEngine(null)
    await restarted.dispose()
    await kernel.dispose()
  })
  await restarted.start()
  setEditorEngine(restarted.editorPlane)
  await restarted.call('workspace/open', { path: d.linked })
  restarted.registry.upsert({ ...session, runtime: agent.info.id }, null)
  restarted.registry.upsert({ ...missingSession, runtime: agent.info.id }, null)
  await kernel.loadBuiltin({
    manifest: { id: 'restart-file-probe', name: 'Restart file probe', permissions: { workspace: { read: true } } },
    plugin: {
      name: 'restart-file-probe', inject: ['context', 'fs', 'workspace'],
      apply(ctx: HarnessContext) {
        ctx.context.register({
          label: 'Restart location', chip: { description: 'Fixture location' },
          resolve: async () => JSON.stringify({ root: ctx.workspace.root, branch: ctx.workspace.branch, read: (await ctx.fs.read('file.txt')).trim() }),
        })
      },
    },
  } as HarnessPlugin)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const chip = kernel.list('context').find((entry) => entry.label === 'Restart location')!
  const resolveFor = async (sessionId: Session['id']) => {
    const resolved = await kernel.resolveOne(chip.id, undefined, { runtime: agent.info.id, sessionId })
    assert.ok(resolved, 'the location chip resolves')
    return JSON.parse(resolved.text)
  }
  assert.deepEqual(await resolveFor(session.id), { root: d.project, branch: null, read: 'top' })
  assert.deepEqual(await resolveFor(missingSession.id), { root: d.linked, branch: 'feature', read: 'linked' })
})
