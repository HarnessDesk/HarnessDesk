import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { ExtensionKernel, setForgeEngine } from '@harnessdesk/cordis-host'
import { gitPlugin } from '@harnessdesk/plugins'
import type { FlowExecution, FrontDoorPreview } from '@harnessdesk/protocol'
import { GitGateway } from '../src/git-gateway/index.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { projectOf } from '../src/evidence/revision.js'
import { HoldFake, HOLD_CEILINGS } from './fixtures/hold-runtime.js'
import { answer, claimed, desk, E2E, git, scopeOf } from './fixtures/flow-host-evidence.js'

const execute = promisify(execFile)
const source = `version: 2
name: Review and merge the selected PR
roles:
  reviewer: { kind: agent, uses: code-reviewer, grant: read }
  merger: { kind: agent, uses: merger, grant: merge }
seed: { role: reviewer, title: Review the selected pull request }
rules:
  - { id: merge, on: reviewer, when: { evidence: [{ review: approve }] }, then: { role: merger, title: Merge the reviewed pull request } }
layout: { frontDoor: { contexts: [pull-request] } }
`

for (const mode of ['bound', 'unpinned', 'released', 'closed', 'pr-observation'] as const) test(`public Host ${mode === 'bound' ? 'authorizes its exact target' : mode === 'unpinned' ? 'does not promote an unpinned review after pinning' : mode === 'closed' ? 'refuses a PR closed before review' : mode === 'pr-observation' ? 'records the explicit PR observation' : 'does not fall back after release'} through the Git plugin and gateway`, E2E, async t => {
  const pinned = mode !== 'unpinned'
  const temp = await mkdtemp(join(tmpdir(), 'hd-601-host-')), bin = join(temp, 'bin'), state = join(temp, 'forge.json'), trace = join(temp, 'trace.ndjson')
  await mkdir(bin)
  const ghPath = join(bin, 'gh')
  await copyFile(fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url)), ghPath)
  await chmod(ghPath, 0o755)
  const prior = { PATH: process.env.PATH, FAKE_GH_STATE: process.env.FAKE_GH_STATE, FAKE_GH_TRACE: process.env.FAKE_GH_TRACE }
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state, FAKE_GH_TRACE: trace })
  t.after(async () => {
    setForgeEngine(null)
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    await rm(temp, { recursive: true, force: true })
  })
  const fakeGh = async (args: readonly string[], cwd: string) => {
    try { const result = await execute(process.execPath, [ghPath, ...args], { cwd, env: process.env }); return { ...result, exitCode: 0 } }
    catch (error) { const e = error as { stdout?: string; stderr?: string }; return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: 1 } }
  }
  let gateway!: GitGateway
  const d = await desk(t, undefined, { evidenceGh: fakeGh, gatewayFactory: (stateDir) => gateway = new GitGateway({ directory: join(stateDir, 'gateway'), stateDirectory: stateDir, gh: (cwd, args) => fakeGh(args, cwd) }) })
  await git(d.root, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
  const mergeBase = await git(d.root, 'rev-parse', 'HEAD')
  await git(d.root, 'checkout', '-q', 'main')
  await writeFile(join(d.root, 'base-only.txt'), 'Destination-only change.\n')
  await git(d.root, 'add', 'base-only.txt')
  await git(d.root, 'commit', '-q', '-m', 'Advance destination')
  const baseTip = await git(d.root, 'rev-parse', 'HEAD')
  await git(d.root, 'checkout', '-q', 'work')
  await writeFile(join(d.root, 'head-only.txt'), 'Head-only change.\n')
  await git(d.root, 'add', 'head-only.txt')
  await git(d.root, 'commit', '-q', '-m', 'Advance head')
  const head = await git(d.root, 'rev-parse', 'HEAD')
  assert.equal(await git(d.root, 'merge-base', head, baseTip), mergeBase)
  assert.notEqual(baseTip, mergeBase)
  await writeFile(state, JSON.stringify({ repo: 'acme/widgets', publicationHead: head, baseTips: { main: baseTip }, user: { login: 'jane-doe' }, view: { nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } }, protectedBranches: [], pulls: [{ number: 7, branch: 'work', base: 'main', head, state: 'open', checks: [{ name: 'build', id: 1, status: 'completed', conclusion: 'success' }] }], issues: [] }))
  if (pinned) await gateway.pins.pin(d.root, 'acme/widgets', { kind: 'person', id: 'fixture-person' })
  const held = new HoldFake()
  ;(held as { info: typeof held.info }).info = { ...held.info, ceilings: { ...HOLD_CEILINGS, merge: { settings: [{ option: 'sandbox', value: 'full' }], how: 'Full access' } } }
  d.host.register(held)
  for (const [id, body] of [['code-reviewer', 'ceiling: read\nanswers: [approve]\nproduces: [review]'], ['merger', 'ceiling: merge\nanswers: [merged]']] as const) {
    await mkdir(join(d.stateDir, 'agents', id), { recursive: true })
    await writeFile(join(d.stateDir, 'agents', id, 'AGENT.md'), `---\nname: ${id}\n${body}\nprefer: [holdfake]\n---\nDo the task.\n`)
  }
  const runSource = mode === 'pr-observation' ? source.replace('[{ review: approve }]', '[{ review: approve }, { pr: open }]') : source
  const preview = await d.host.call('authoring/start/preview', { context: { kind: 'pull-request', root: d.root, number: 7 }, source: runSource, vars: {} }) as FrontDoorPreview
  assert.ok(preview.flow.token, JSON.stringify(preview.flow.problems))
  const run = await d.host.call('flow/start-goal', { root: d.root, source: runSource, token: preview.flow.token!, sentence: preview.sentence, vars: preview.vars }) as FlowExecution
  d.runs.push(run.id)
  const [reviewer] = await claimed(d, run.goal, 'reviewer', 1)
  if (mode === 'closed') {
    const [offered] = await d.host.teamPlane.reviewCandidates(reviewer!.id, scopeOf(reviewer!))
    assert.ok(offered)
    const closed = JSON.parse(await readFile(state, 'utf8'))
    closed.pulls[0].state = 'closed'
    await writeFile(state, JSON.stringify(closed))
    await assert.rejects(d.host.teamPlane.reviewCandidates(reviewer!.id, scopeOf(reviewer!)), /closed|open review candidate/i)
    await assert.rejects(d.host.teamPlane.recordReview({ intent: reviewer!.id, candidate: offered.id, verdict: 'approve' }, scopeOf(reviewer!)), /closed|moved on|open review candidate/i)
    return
  }
  const [candidate] = await d.host.teamPlane.reviewCandidates(reviewer!.id, scopeOf(reviewer!))
  assert.equal(candidate?.reviewTarget?.baseTip, pinned ? baseTip : undefined)
  if (mode === 'pr-observation') {
    const journal = await new EvidenceStore(join(d.stateDir, 'evidence')).read(await projectOf(d.root), 'evidence')
    assert.ok(journal.lines.some(line => line.type === 'evidence' && line.record.card?.id === reviewer!.id && line.record.fact.kind === 'pr' && line.record.fact.number === 7 && line.record.fact.state === 'open'))
    await d.host.teamPlane.recordReview({ intent: reviewer!.id, candidate: candidate!.id, verdict: 'approve' }, scopeOf(reviewer!))
    await answer(d, reviewer!, 'approve')
    assert.ok((await claimed(d, run.goal, 'merger', 1))[0], 'the real PR-open evidence guard advances')
    return
  }
  if (pinned) {
    const comparison = await d.host.call('git/diffRange', { root: d.root, from: baseTip, to: head })
    assert.match(comparison.diff, /Destination-only change/)
    assert.match(comparison.diff, /Head-only change/)
  }
  await d.host.teamPlane.recordReview({ intent: reviewer!.id, candidate: candidate!.id, verdict: 'approve' }, scopeOf(reviewer!))
  await answer(d, reviewer!, 'approve')
  const [merger] = await claimed(d, run.goal, 'merger', 1)
  if (!pinned) await gateway.pins.pin(d.root, 'acme/widgets', { kind: 'person', id: 'fixture-person' })
  setForgeEngine(d.host.forgePlane)
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(gitPlugin)
  await new Promise(resolve => setTimeout(resolve, 60))
  kernel.setWorkspace({ root: d.root, branch: 'work' })
  const tool = kernel.list('tool').find(one => one.name === 'pr_merge')!
  if (mode === 'released') {
    assert.match(await d.host.teamPlane.release(merger!.id, {}, scopeOf(merger!)), /^Released/)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('unexpected manual approval wait')), 5000)
    const refused = await kernel.invokeTool(tool.id, { number: 7, head }, { ...scopeOf(merger!), signal: controller.signal } as never)
    clearTimeout(timeout)
    assert.equal(refused.ok, false)
    assert.match(JSON.stringify(refused), /fresh review/i)
    const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(calls.filter(call => call.argv[0] === 'pr' && call.argv[1] === 'merge').length, 0)
    return
  }
  if (!pinned) {
    const refused = await kernel.invokeTool(tool.id, { number: 7, head }, scopeOf(merger!) as never)
    assert.equal(refused.ok, false)
    assert.match(JSON.stringify(refused), /fresh review/i)
    const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(calls.filter(call => call.argv[0] === 'pr' && call.argv[1] === 'merge').length, 0)
    return
  }
  const moved = JSON.parse(await readFile(state, 'utf8'))
  moved.baseTips = { main: 'b'.repeat(40) }
  await writeFile(state, JSON.stringify(moved))
  const stale = await kernel.invokeTool(tool.id, { number: 7, head }, scopeOf(merger!) as never)
  assert.equal(stale.ok, false)
  assert.match(JSON.stringify(stale), /target changed|fresh review/i)
  const before = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(before.filter(call => call.argv[0] === 'pr' && call.argv[1] === 'merge').length, 0)
  moved.baseTips = { main: baseTip }
  await writeFile(state, JSON.stringify(moved))
  const result = await kernel.invokeTool(tool.id, { number: 7, head }, scopeOf(merger!) as never)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(JSON.parse(await readFile(state, 'utf8')).pulls[0].merged, true)
  const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls.filter(call => call.argv[0] === 'pr' && call.argv[1] === 'merge').length, 1)
})
