import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'

import type { FlowExecution, FlowPreview, GoalView, Lane, SessionOptions } from '@harnessdesk/protocol'
import { Host, StateStore } from '../src/index.js'
import { captureShellProject } from '../src/shell-project.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

const exec = promisify(execFile)

const SOURCE = `
version: 2
name: Two attempts
roles:
  competitor: { kind: agent, uses: writer, seats: [fake, fake], isolate: true, grant: edit, independentOf: [] }
seed: { role: competitor, title: Build the greeting }
rules: []
messaging: board-only
`

async function desk(t: TestContext, runtime = new FakeRuntime(), folder?: string) {
  const repo = await makeRepo('hd-team-project-')
  const root = await realpath(folder ?? repo.dir)
  const home = tempDir('hd-team-project-state-')
  const state = new StateStore(join(home, 'state.json'))
  await mkdir(join(home, 'agents', 'writer'), { recursive: true })
  await writeFile(join(home, 'agents', 'writer', 'AGENT.md'), '---\nname: Writer\nceiling: edit\nanswers: [done]\nprefer: [fake]\n---\nBuild the greeting.\n')
  await writeFile(join(home, 'state.json'), JSON.stringify({ workspaces: [{ path: root, name: 'Greeting', lastOpenedAt: 1, id: 'old-project' }], preferences: {} }))
  const host = new Host({ logger: silent, state, builtinAgents: tempDir('hd-team-project-agents-'), catalogRefreshMs: 0 })
  host.register(runtime)
  await host.start()
  t.after(() => host.dispose())
  return { host, root, repo, home, state, runtime }
}

async function start(d: Awaited<ReturnType<typeof desk>>) {
  const preview = await d.host.call('flow/preview', { root: d.root, source: SOURCE }) as FlowPreview
  assert.ok(preview.token, JSON.stringify(preview.problems))
  return await d.host.call('flow/start-goal', { root: d.root, source: SOURCE, token: preview.token, sentence: 'Build the greeting' }) as FlowExecution
}

async function firstRound(d: Awaited<ReturnType<typeof desk>>, id: string) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const run = await d.host.call('flow/execution', { run: id }) as FlowExecution
    if (run.state !== 'running' || run.rounds[0]?.seats.length === 2) return run
    if (Date.now() > deadline) throw new Error('The attempts did not open')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('the selected old-record project previews without authority and starts both isolated attempts', async t => {
  const d = await desk(t)
  const preview = await d.host.call('flow/preview', { root: d.root, source: SOURCE }) as FlowPreview
  assert.ok(preview.token)
  assert.equal(d.state.state.workspaces[0]?.shellIdentity, undefined, 'preview grants no authority')
  assert.deepEqual(await d.host.call('lane/list', {}), [], 'preview allocates nothing')
  const run = await firstRound(d, (await start(d)).id)
  assert.equal(run.state, 'running', run.reason ?? '')
  assert.equal(run.rounds[0]?.seats.length, 2)
  const lanes = await d.host.call('lane/list', {}) as readonly Lane[]
  assert.equal(lanes.length, 2)
  assert.notEqual(lanes[0]?.cwd, lanes[1]?.cwd)
  assert.deepEqual(d.state.state.workspaces[0]?.shellIdentity, await captureShellProject(d.root))
  assert.equal(d.state.state.workspaces[0]?.id, 'old-project')
  const saved = JSON.parse(await readFile(join(d.home, 'state.json'), 'utf8'))
  assert.equal(saved.workspaces[0].realPath, d.root)
})

test('an isolated first round refuses a non-repository in preview, without allocating a lane', async t => {
  const d = await desk(t, new FakeRuntime(), tempDir('hd-team-folder-'))
  const preview = await d.host.call('flow/preview', { root: d.root, source: SOURCE }) as FlowPreview
  assert.equal(preview.token, null)
  assert.ok(preview.problems.some(problem => /Choose a Git project/.test(problem.text)))
  assert.deepEqual(await d.host.call('lane/list', {}), [])
})

test('starting a flow cannot admit a folder from a card or an agent', async t => {
  const d = await desk(t)
  const other = await makeRepo('hd-team-other-')
  await assert.rejects(d.host.call('flow/preview', { root: other.dir, source: SOURCE }), /outside every/)
  assert.equal(d.state.state.workspaces.some(entry => entry.path === other.dir), false)
})

test('a project known only from a conversation is admitted by the selected Team start', async t => {
  const d = await desk(t)
  const live = await d.runtime.createSession({ cwd: d.root })
  d.host.registry.upsert(d.runtime.sessions.get(live.id)!.snapshot(), live)
  await d.state.forgetWorkspace(d.root)
  assert.equal(d.state.state.workspaces.length, 0)
  const run = await firstRound(d, (await start(d)).id)
  assert.equal(run.state, 'running', run.reason ?? '')
  assert.equal(run.rounds[0]?.seats.length, 2)
  assert.deepEqual(d.state.state.workspaces[0]?.shellIdentity, await captureShellProject(d.root))
})

test('starting the old main project does not persist an already opened sibling checkout’s identity', async t => {
  const d = await desk(t)
  const sibling = join(d.home, 'sibling')
  await d.repo.git('worktree', 'add', '-b', 'sibling', sibling)
  await d.host.call('workspace/open', { path: sibling })
  const run = await firstRound(d, (await start(d)).id)
  assert.equal(run.state, 'running', run.reason ?? '')
  assert.equal(run.rounds[0]?.seats.length, 2)
  assert.deepEqual(d.state.state.workspaces.find(entry => entry.path === d.root)?.shellIdentity, await captureShellProject(d.root))
})

test('preview refuses changed captured identity and cannot refresh it through Team start', async t => {
  const d = await desk(t)
  await d.host.call('workspace/open', { path: d.root })
  const identity = d.state.state.workspaces[0]?.shellIdentity
  await rename(join(d.root, '.git'), join(d.root, 'old-git'))
  const preview = await d.host.call('flow/preview', { root: d.root, source: SOURCE }) as FlowPreview
  assert.equal(preview.token, null)
  assert.deepEqual(d.state.state.workspaces[0]?.shellIdentity, identity)
  assert.deepEqual(await d.host.call('lane/list', {}), [])
})

test('preview refuses an unusable checkout parent before reserving ports', async t => {
  const d = await desk(t)
  await writeFile(join(d.home, 'worktrees'), 'A file blocks the checkout parent.\n')
  const preview = await d.host.call('flow/preview', { root: d.root, source: SOURCE }) as FlowPreview
  assert.equal(preview.token, null)
  assert.deepEqual(await d.host.call('lane/list', {}), [])
})

for (const changed of ['none', 'untracked', 'ignored', 'committed'] as const) test(`a failed Seat with ${changed} work ${changed === 'none' ? 'releases' : 'retains'} its lane`, async t => {
  const runtime = new FakeRuntime()
  let d: Awaited<ReturnType<typeof desk>>
  runtime.createSession = async (options: SessionOptions): Promise<never> => {
    if (changed !== 'none') await writeFile(join(options.cwd, changed === 'ignored' ? 'attempt.ignored' : 'attempt.txt'), 'Work to keep.\n')
    if (changed === 'committed') {
      await exec('git', ['-C', options.cwd, 'add', 'attempt.txt'])
      await exec('git', ['-C', options.cwd, '-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', 'commit', '-m', 'Keep the attempted work'])
    }
    throw new Error('The test conversation could not open.')
  }
  d = await desk(t, runtime)
  if (changed === 'ignored') {
    await writeFile(join(d.root, '.gitignore'), '*.ignored\n')
    await d.repo.git('add', '.gitignore')
    await d.repo.git('commit', '-m', 'Declare ignored fixture output')
  }
  await d.host.call('workspace/open', { path: d.root })
  const run = await firstRound(d, (await start(d)).id)
  assert.equal(run.state, 'stalled')
  const lanes = await d.host.call('lane/list', {}) as readonly Lane[]
  assert.equal(lanes.length, 1)
  assert.equal(lanes[0]?.state, changed === 'none' ? 'released' : 'retained')
  assert.doesNotMatch(run.reason ?? '', /Lane [0-9a-f-]+/)
  const view = await d.host.call('goal/read', { goal: run.goal }) as GoalView
  assert.deepEqual(view.members.filter(member => member.closed === null), [])
})
