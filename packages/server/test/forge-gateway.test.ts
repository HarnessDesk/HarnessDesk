import { gitSteerContext } from '../src/git-gateway/steer-context.js'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { ExtensionKernel, setForgeEngine, type ForgeScope } from '@harnessdesk/cordis-host'
import { gitPlugin } from '@harnessdesk/plugins'
import type { ForgeReference } from '@harnessdesk/protocol'
import { ForgePlane } from '../src/forge.js'
import { GitGateway } from '../src/git-gateway/index.js'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'
import { sourceDigest } from '../src/flow-execution.js'
import { CeilingGate, GatedRegistry } from '../src/ceilings/gate.js'
import type { HeldQuestion } from '../src/ceilings/gate.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const fixture = async (t: { after(fn: () => void | Promise<void>): void }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hd-forge-gateway-'))), checkout = join(root, 'checkout'), remote = join(root, 'remote.git'), host = join(root, 'host'), bin = join(root, 'bin')
  mkdirSync(bin); mkdirSync(host)
  git(root, 'init', '-q', '-b', 'feature/widgets', checkout)
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  // Fixture commits use the process's existing git identity, as contributor runs do.
  writeFileSync(join(checkout, 'file'), 'widgets'); git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'Widgets')
  git(checkout, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
  const statePath = join(root, 'gh.json'), tracePath = join(root, 'calls.ndjson')
  const state = { repo: 'acme/widgets', view: { nameWithOwner: 'acme/widgets', url: 'https://github.com/acme/widgets', defaultBranchRef: { name: 'main' } }, user: { login: 'jane-doe' }, publicationHead: git(checkout, 'rev-parse', 'HEAD'), pulls: [], issues: [{ number: 42, title: 'Widgets', comments: [] }], protectedBranches: ['release'] }
  writeFileSync(statePath, JSON.stringify(state))
  copyFileSync(fileURLToPath(new URL('../../test/fixtures/fake-gh.mjs', import.meta.url)), join(bin, 'gh')); chmodSync(join(bin, 'gh'), 0o755)
  const prior = { PATH: process.env.PATH, FAKE_GH_STATE: process.env.FAKE_GH_STATE, FAKE_GH_TRACE: process.env.FAKE_GH_TRACE, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN, GIT_ASKPASS: process.env.GIT_ASKPASS, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0 }
  process.env.GH_TOKEN = 'ghp_placeholder_host_credential'; delete process.env.GITHUB_TOKEN
  Object.assign(process.env, { GIT_ASKPASS: '/fixture/host-askpass', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '!false' })
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: statePath, FAKE_GH_TRACE: tracePath })
  t.after(() => { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } rmSync(root, { recursive: true, force: true }) })
  const gateway = new GitGateway({ directory: host, localRemote: () => remote, gh: async (cwd, args, env) => {
    try { return { stdout: execFileSync('gh', [...args], { cwd, env: { ...env, GH_TOKEN: 'host-fixture-token' }, encoding: 'utf8' }), stderr: '', exitCode: 0 } }
    catch (error) { return { stdout: '', stderr: String(error), exitCode: 1 } }
  } })
  const questions: HeldQuestion[] = [], publications: ForgeReference[] = [], admissions: string[] = []
  let onQuestion: (() => void | Promise<void>) | undefined
  let answer: 'allowed' | 'standing' | 'refused' | 'unanswered' = 'allowed', mergeStep = false, ceiling: 'read' | 'publish' | 'merge' = 'merge'
  const plane = new ForgePlane({ gitGateway: gateway, checkoutOf: async () => ({ cwd: checkout, root: checkout }),
    admitWrite: async verb => { admissions.push(verb); if (ceiling === 'read' || verb === 'merge' && ceiling !== 'merge') throw new Error('Ceiling refused') },
    askPerson: async (_scope, question) => { questions.push(question); await onQuestion?.(); return answer }, mergeStep: (_scope, target) => mergeStep && ceiling === 'merge' && target.number === 1 && target.head === git(checkout, 'rev-parse', 'HEAD'),
    agentOf: () => ({ name: 'Test Agent', version: null }), optionsOf: () => [], toolsOffered: () => true,
    record: (_runtime, _session, item) => { publications.push(item.reference); return true },
  }, { gh: async args => ({ stdout: args[0] === 'api' ? 'jane-doe' : '', stderr: '', exitCode: 0 }) })
  setForgeEngine(plane); t.after(() => setForgeEngine(null))
  const kernel = new ExtensionKernel(); t.after(() => kernel.dispose())
  await kernel.load(gitPlugin); await new Promise(resolve => setTimeout(resolve, 60)); kernel.setWorkspace({ root: checkout, branch: 'feature/widgets' })
  const invoke = async (name: string, args: unknown, sessionId = 's1') => {
    const tool = kernel.list('tool').find(one => one.name === name); assert.ok(tool)
    return kernel.invokeTool(tool.id, args, { runtime: 'fixture', sessionId } as never)
  }
  const run = async (name: string, args: unknown, sessionId = 's1') => {
    const result = await invoke(name, args, sessionId)
    if (!result.ok) throw new Error(result.error)
    return JSON.stringify(result)
  }
  const rows = () => gateway.record({ repository: 'acme/widgets', limit: 1000 })
  const trace = () => !existsSync(tracePath) ? [] : readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { argv: string[]; cwd: string; hasCredential: boolean; envKeys: string[] })
  return { gateway, plane, kernel, root, checkout, remote, host, run, invoke, rows, questions, publications, admissions, trace, statePath,
    onQuestion: (hook: () => void | Promise<void>) => { onQuestion = hook },
    answer: (value: typeof answer) => { answer = value }, mergeStep: (value: boolean) => { mergeStep = value }, ceiling: (value: typeof ceiling) => { ceiling = value } }
}

test('kernel pushes pin once, continue without a question, ask for rewrites, and record protected refusals', async t => {
  const f = await fixture(t)
  await f.run('git_push', { set_upstream: true })
  assert.equal(f.publications[0]?.action, 'opened')
  assert.equal(f.publications[0]?.url, 'https://github.com/acme/widgets/tree/feature/widgets')
  const first = git(f.checkout, 'rev-parse', 'HEAD')
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/feature/widgets'), first)
  assert.equal(await f.gateway.pins.pinned(f.checkout), 'acme/widgets')
  assert.equal(f.questions.length, 1)
  assert.equal(f.questions[0]!.summary, 'Push feature/widgets to acme/widgets')
  assert.deepEqual(f.questions[0]!.facts?.map(fact => fact.label), ['Repository', 'Branch', 'Head'])
  assert.deepEqual(f.questions[0]!.options?.map(option => option.label), ['Push', 'Push this branch without asking', "Don't push"])
  git(f.checkout, 'commit', '--allow-empty', '-qm', 'Next')
  await f.run('git_push', {})
  assert.equal(f.questions.length, 1)
  assert.equal((await f.rows())[0]?.approval?.by, 'standing')
  const second = git(f.checkout, 'rev-parse', 'HEAD')
  // A local ref move makes the next push a rewrite without touching the run's own branch.
  git(f.checkout, 'update-ref', 'refs/heads/feature/widgets', first, second)
  await f.run('git_push', {})
  assert.equal(f.questions.length, 2)
  assert.match(f.questions[1]!.reason, /rewrites/)
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/feature/widgets'), first)
  for (const branch of ['main', 'release']) {
    git(f.checkout, 'branch', '-m', branch)
    await assert.rejects(f.run('git_push', {}), /default-branch|protected-branch/)
    assert.equal((await f.rows())[0]?.outcome, 'refused')
  }
  assert.equal(f.publications.filter(one => one.kind === 'branch').length, 3)
  assert.equal(f.questions.length, 2, 'protected pushes never ask')
})

test('every plugin forge write runs in the host, records its requester, preserves signing and head-bound checks', async t => {
  const f = await fixture(t)
  await f.run('git_push', { set_upstream: true })
  await f.run('pr_create', { title: 'Widgets', body: 'Add widgets.' })
  await f.run('pr_update', { number: 1, title: 'Better widgets', body: 'Improved.', base: 'main' })
  await f.run('pr_review', { number: 1, event: 'approve', body: 'Checked.' })
  await f.run('pr_comment', { number: 1, body: 'Ready.' })
  await f.run('issue_comment', { number: 42, body: 'Fixed.' })
  const state = JSON.parse(readFileSync(f.statePath, 'utf8'))
  state.pulls[0].checks = [{ name: 'build', id: 1, started_at: '2026-10-24T00:00:00Z', status: 'completed', conclusion: 'success' }]
  writeFileSync(f.statePath, JSON.stringify(state))
  const head = git(f.checkout, 'rev-parse', 'HEAD')
  await f.run('pr_merge', { number: 1, head })
  assert.equal(f.questions.length, 2, 'ordinary merge asks even with a merge ceiling')
  assert.ok((await f.gateway.record({ repository: 'acme/widgets', number: 1, limit: 100 })).some(row => row.op === 'pr.create' && row.outcome === 'ok'))
  const rows = (await f.rows()).filter(one => one.outcome === 'ok')
  for (const op of ['push', 'pr.create', 'pr.update', 'pr.review', 'pr.comment', 'issue.comment', 'pr.merge']) {
    const row = rows.find(one => one.op === op); assert.ok(row, op)
    assert.deepEqual(row.requester, { kind: 'session', id: 'fixture/s1', seat: { label: 'Test Agent', role: null, round: null, team: null }, conversation: { runtime: 'fixture', sessionId: 's1' } })
  }
  const writes = f.trace().filter(call => ['create', 'edit', 'merge', 'review', 'comment'].includes(call.argv[1] ?? ''))
  assert.equal(writes.length, 6)
  assert.ok(writes.every(call => call.cwd === f.host && call.argv.slice(-2).join(' ') === '--repo acme/widgets'))
  const merge = writes.find(call => call.argv[1] === 'merge')!
  assert.equal(merge.argv[merge.argv.indexOf('--match-head-commit') + 1], head)
  assert.equal(f.publications.at(-1)?.action, 'merged')
  const reads = f.trace().filter(call => call.cwd === f.checkout)
  assert.ok(reads.length > 0)
  assert.ok(reads.every(call => !call.hasCredential && !call.envKeys.some(key => /^(GH_TOKEN|GITHUB_TOKEN|GIT_ASKPASS|GIT_CONFIG.*|GIT_CREDENTIAL.*)$/.test(key))), 'the plugin shell receives no host credential configuration')
  assert.ok(writes.every(call => call.hasCredential), 'only the host runner receives its credential')
  f.mergeStep(true)
  await f.run('pr_merge', { number: 1, head })
  assert.equal(f.questions.length, 2, 'the authorized Team merge step does not ask again')
  assert.equal((await f.rows())[0]?.approval?.by, 'ceiling')
  assert.match(JSON.parse(readFileSync(f.statePath, 'utf8')).pulls[0].body, /Test Agent/)
})

test('decoy origin cannot change a pin, refused pinning has no effect, and ceilings precede approvals', async t => {
  const f = await fixture(t)
  f.answer('refused')
  await assert.rejects(f.run('git_push', {}), /person did not approve/)
  assert.equal(await f.gateway.pins.pinned(f.checkout), null)
  assert.equal((await f.rows()).length, 0, 'an unapproved proposal has no record')
  f.answer('allowed'); await f.run('git_push', {})
  git(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/acme/decoy.git')
  await assert.rejects(f.run('git_push', {}), /differs from the pinned repository/)
  assert.equal(await f.gateway.pins.pinned(f.checkout), 'acme/widgets')
  assert.equal(f.questions.length, 2)
  f.ceiling('read')
  await assert.rejects(f.run('git_push', {}), /Ceiling refused/)
  assert.equal(f.questions.length, 2)
  await assert.rejects(f.plane.push({ branch: 'feature/widgets', sha: 'a'.repeat(40), expect: 'create' }, {}), /live invocation/)
})

test('standing branch choice permits another live conversation invocation, but rewrites still ask', async t => {
  const f = await fixture(t)
  f.answer('standing'); await f.run('git_push', {})
  const first = git(f.checkout, 'rev-parse', 'HEAD')
  git(f.checkout, 'commit', '--allow-empty', '-qm', 'Next')
  await f.run('git_push', {})
  assert.equal(f.questions.length, 1)
  git(f.checkout, 'update-ref', 'refs/heads/feature/widgets', first)
  await f.run('git_push', {})
  assert.equal(f.questions.length, 2)
  f.answer('refused')
  git(f.checkout, 'branch', '-m', 'another')
  await assert.rejects(f.run('git_push', {}), /person did not approve/)
  assert.equal(f.questions.length, 3)
})

test('approval cannot outlive its invocation or approve a checkout head that moved while it waited', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  f.onQuestion(() => controller.abort())
  await assert.rejects(f.plane.push({ branch: 'feature/widgets', sha: git(f.checkout, 'rev-parse', 'HEAD'), expect: 'create' }, {
    runtime: 'fixture', sessionId: 's1', plugin: 'git#1', signal: controller.signal,
  }), /live invocation/)
  assert.equal(await f.gateway.pins.pinned(f.checkout), null, 'an expired invocation cannot even establish the pin')
  assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname)'), '')
  f.onQuestion(() => { git(f.checkout, 'commit', '--allow-empty', '-qm', 'Moved during approval') })
  await assert.rejects(f.run('git_push', {}), /reviewed-sha-mismatch/)
  assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname)'), '')
  assert.equal((await f.rows())[0]?.outcome, 'refused')
})


test('first pin approval uses only local facts and unapproved repositories have no record', async t => {
  const f = await fixture(t)
  f.onQuestion(() => {
    assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname)'), '')
    assert.equal(readFileSync(f.statePath, 'utf8').includes('publicationHead'), true)
    assert.equal(f.trace().length, 0, 'no gh request before approval')
  })
  f.answer('refused')
  await assert.rejects(f.run('git_push', {}), /person did not approve/)
  assert.equal((await f.rows()).length, 0)
})

test('pinned reads ignore upstream and gh default selection and reject effective-origin rewrites', async t => {
  const f = await fixture(t)
  await f.run('git_push', { set_upstream: true })
  git(f.checkout, 'remote', 'add', 'upstream', 'https://github.com/acme/other.git')
  await f.run('pr_create', { title: 'Widgets', body: 'Body' })
  git(f.checkout, 'config', 'remote.upstream.gh-resolved', 'base')
  await f.run('issue_comment', { number: 42, body: 'Fixed' })
  const reads = f.trace().filter(call => call.cwd === f.checkout && ['pr', 'issue'].includes(call.argv[0]!))
  assert.ok(reads.length > 0)
  assert.ok(reads.every(call => call.argv[call.argv.indexOf('--repo') + 1] === 'acme/widgets'), JSON.stringify(reads))
  git(f.checkout, 'config', 'url.https://github.com/acme/decoy.insteadOf', 'https://github.com/acme/widgets')
  await assert.rejects(f.run('pr_comment', { number: 1, body: 'No' }), /origin|pinned/)
  const refusal = (await f.rows())[0]!
  assert.equal(refusal.op, 'pr.comment'); assert.equal(refusal.number, 1); assert.equal(refusal.outcome, 'refused')
})

test('outside observations supply the next push lease and require approval', async t => {
  const f = await fixture(t)
  await f.run('git_push', {})
  git(f.checkout, 'commit', '--allow-empty', '-qm', 'Outside')
  const outside = git(f.checkout, 'rev-parse', 'HEAD')
  git(f.checkout, 'push', f.remote, 'HEAD:refs/heads/feature/widgets')
  await f.gateway.observe('acme/widgets', 'feature/widgets', outside, null)
  git(f.checkout, 'commit', '--allow-empty', '-qm', 'Next')
  await f.run('git_push', {})
  assert.equal(f.questions.length, 2)
})

test('common GitHub origin spellings are proposals, other hosts are refused', async t => {
  const f = await fixture(t)
  for (const origin of ['ssh://git@github.com/acme/widgets.git', 'ssh://github.com/acme/widgets', 'git@github.com-work:acme/widgets.git', 'https://github.com/acme/widgets.git/', 'ssh://github.com/acme/widgets/']) {
    git(f.checkout, 'remote', 'set-url', 'origin', origin)
    assert.equal(await f.gateway.proposedRepository(f.checkout), 'acme/widgets', origin)
  }
  git(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com.evil/acme/widgets')
  assert.equal(await f.gateway.proposedRepository(f.checkout), null)
})


test('a merge step for another PR asks and uses merge-specific facts and labels', async t => {
  const f = await fixture(t)
  await f.run('git_push', { set_upstream: true })
  await f.run('pr_create', { title: 'Widgets', body: 'Body' })
  const state = JSON.parse(readFileSync(f.statePath, 'utf8'))
  state.pulls[0].checks = [{ name: 'build', id: 1, status: 'completed', conclusion: 'success' }]
  state.pulls.push({ ...state.pulls[0], number: 9, checks: [{ name: 'build', id: 1, status: 'completed', conclusion: 'success' }] })
  writeFileSync(f.statePath, JSON.stringify(state))
  f.mergeStep(true)
  await f.run('pr_merge', { number: 9, head: git(f.checkout, 'rev-parse', 'HEAD') })
  assert.equal(f.questions.length, 2)
  assert.deepEqual(f.questions[1]!.facts?.map(fact => fact.label), ['Repository', 'Branch', 'Head'])
  assert.equal(f.questions[1]!.facts?.[1]?.value, 'feature/widgets')
  assert.deepEqual(f.questions[1]!.options?.map(option => option.label), ['Merge', "Don't merge"])
})

test('timed-out questions explain the outcome and do not pin', async t => {
  const f = await fixture(t)
  f.answer('unanswered')
  await assert.rejects(f.run('git_push', {}), /question timed out/)
  assert.equal(await f.gateway.pins.pinned(f.checkout), null)
  assert.equal((await f.rows()).length, 0)
})

test('person commands are recorded as the person and context writes are refused', async t => {
  const f = await fixture(t)
  const scope = { runtime: 'fixture', sessionId: 's1', plugin: 'fixture', signal: new AbortController().signal, actor: 'human' as const }
  await f.plane.push({ branch: 'feature/widgets', sha: git(f.checkout, 'rev-parse', 'HEAD'), expect: 'create' }, scope)
  assert.deepEqual((await f.rows())[0]?.requester, { kind: 'person', id: 'person' })
  await assert.rejects(f.plane.comment({ subject: 'issue', number: 42, body: 'Body' }, { ...scope, actor: 'context' }), /Context resolution/)
  assert.equal((await f.rows())[0]?.op, 'issue.comment')
  assert.equal((await f.rows())[0]?.outcome, 'refused')
})


test('outer and inner ceiling admission hold one question for the same turn and invocation', async t => {
  const kernel = new ExtensionKernel(); t.after(() => kernel.dispose())
  let questions = 0
  const turns: (string | undefined)[] = []
  const gate = new CeilingGate({
    rootOf: (runtime, sessionId) => ({ runtime, sessionId }), ceilingOf: () => ({ level: 'publish', hold: 'held' }),
    causeOf: (_runtime, _session, turn) => { turns.push(turn); return { kind: 'message', from: { name: 'Reader', runtime: 'fixture', sessionId: 'reader' }, ceiling: { level: 'read', hold: 'held' } } as never },
    nameOf: () => 'Writer', say: () => {}, askPerson: async () => { questions++; return 'allowed' },
  })
  await kernel.load({ manifest: { id: 'git', name: 'Git' }, plugin: { name: 'git', inject: ['tools'], apply(ctx: any) {
    ctx.tools.register({ name: 'git_push', description: 'Fixture', inputSchema: { type: 'object' }, execute: async (_args: unknown, scope: any) => {
      const result = await gate.admit({ tool: 'git_push', needs: 'publish', scope, publishes: true })
      assert.equal(result.admitted, true)
      return 'ok'
    } })
  } } })
  await new Promise(resolve => setTimeout(resolve, 60))
  const registry = new GatedRegistry(kernel, () => gate)
  const tool = registry.list('tool').find(one => one.name === 'git_push')!
  const result = await registry.invokeTool(tool.id, {}, { runtime: 'fixture', sessionId: 's1', turnId: 't1' } as never)
  assert.equal(result.ok, true)
  assert.equal(questions, 1)
  assert.deepEqual(turns, ['t1'])
})


test('the flow merge exemption binds the card grant, PR number and reviewed head', async t => {
  const rig = await goalRig(t)
  const head = 'a'.repeat(40)
  rig.heads.set('/repo', { at: head, dirty: false })
  const entry = agent('merger', ['merged'])
  const merger = { ...entry, definition: { ...entry.definition!, ceiling: 'merge' as const } }
  const source = `version: 2
name: Merge reviewed PR
roles:
  gate: { kind: person, outcomes: [ready] }
  merger: { kind: agent, uses: merger, grant: merge }
seed: { role: gate, title: Review pull request 5 }
rules:
  - { id: merge, on: gate, when: { evidence: [{ pr: open }] }, then: { role: merger, title: Merge pull request 5 } }
`
  const run = await rig.flows.startGoal({ root: '/repo', sentence: 'Merge reviewed PR', source, sourcePath: null, compiled: rig.compile(source, [merger]),
    target: { kind: 'pull-request', label: 'PR 5', base: null, head, pr: 5, dirty: false },
    requireHeld: true, authorization: { sourceDigest: sourceDigest(source), commandDigest: sourceDigest(''), approvedAt: 1, start: 'front-door' },
  })
  assert.equal(run.state, 'running', run.reason ?? '')
  const round = await rig.flows.openRound(run.id, { role: 'merger', title: 'Merge pull request 5' }, { key: 'reviewed-pr', evidence: ['reviewed-head'] })
  const card = round.cards[0]!
  assert.equal(rig.flows.isMergeStep(run.goal, 1, { number: 5, head }), false, 'a person review card is not a merge grant')
  assert.equal(rig.flows.isMergeStep(run.goal, card, { number: 5, head }), true)
  assert.equal(rig.flows.isMergeStep(run.goal, card, { number: 9, head }), false)
  assert.equal(rig.flows.isMergeStep(run.goal, card, { number: 5, head: 'b'.repeat(40) }), false)
  assert.equal(rig.flows.isMergeStep(run.goal, 99, { number: 5, head }), false)
})

test('non-push refusals keep operation and number for a known pin', async t => {
  const f = await fixture(t)
  await f.run('git_push', {})
  const scope = { runtime: 'fixture', sessionId: 's1', plugin: 'fixture', signal: new AbortController().signal }
  f.ceiling('read')
  await assert.rejects(f.plane.comment({ subject: 'issue', number: 42, body: 'Body' }, scope), /Ceiling/)
  assert.equal((await f.rows())[0]?.op, 'issue.comment')
  assert.equal((await f.rows())[0]?.number, 42)
  f.ceiling('merge')
  git(f.checkout, 'commit', '--allow-empty', '-qm', 'Unpushed')
  await assert.rejects(f.plane.pullRequest.create({ head: 'feature/widgets', title: 'Widgets', body: 'Body' }, scope), /Push this branch/)
  assert.equal((await f.rows())[0]?.op, 'pr.create')
  const since = Date.now()
  await f.plane.refuseTool('pr_review', { number: 5 }, scope, 'Blind round', since)
  assert.equal((await f.rows())[0]?.op, 'pr.review')
  assert.equal((await f.rows())[0]?.number, 5)
  assert.equal((await f.rows())[0]?.outcome, 'refused')
})

test('standing answers survive an expired invocation on an already pinned project', async t => {
  const f = await fixture(t)
  await f.run('git_push', {})
  git(f.checkout, 'branch', '-m', 'second')
  const controller = new AbortController()
  f.answer('standing'); f.onQuestion(() => controller.abort())
  await assert.rejects(f.plane.push({ branch: 'second', sha: git(f.checkout, 'rev-parse', 'HEAD'), expect: 'create' }, {
    runtime: 'fixture', sessionId: 's1', plugin: 'fixture', signal: controller.signal,
  }), /live invocation/)
  f.onQuestion(() => {}); f.answer('refused')
  await f.run('git_push', {})
  assert.equal(f.questions.length, 2, 'the next live invocation remembers the standing answer')
})


test('write-deciding forge reads refuse without a pin before running gh', async t => {
  const f = await fixture(t)
  for (const [name, args] of [
    ['pr_create', { title: 'Widgets', body: 'Body' }], ['pr_update', { number: 1, body: 'Body' }],
    ['pr_review', { number: 1, event: 'approve', body: '' }], ['pr_comment', { number: 1, body: 'Body' }],
    ['issue_comment', { number: 42, body: 'Body' }], ['pr_merge', { number: 1, head: 'a'.repeat(40) }],
  ] as const) await assert.rejects(f.run(name, args), /no pinned repository.*git_push/)
  assert.deepEqual(f.trace(), [])
  assert.deepEqual(await f.rows(), [])
})


test('a changed origin while a merge approval waits is recorded as refused', async t => {
  const f = await fixture(t)
  await f.run('git_push', { set_upstream: true })
  await f.run('pr_create', { title: 'Widgets', body: 'Body' })
  const state = JSON.parse(readFileSync(f.statePath, 'utf8'))
  state.pulls[0].checks = [{ name: 'build', id: 1, status: 'completed', conclusion: 'success' }]
  writeFileSync(f.statePath, JSON.stringify(state))
  f.onQuestion(() => { git(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/acme/decoy.git') })
  await assert.rejects(f.run('pr_merge', { number: 1, head: git(f.checkout, 'rev-parse', 'HEAD') }), /repository-changed/)
  const row = (await f.rows())[0]!
  assert.equal(row.op, 'pr.merge'); assert.equal(row.number, 1); assert.equal(row.outcome, 'refused')
})

test('a host-bound steered refspec keeps the source branch upstream and ordinary calls keep the current-branch check', async t => {
  const f = await fixture(t), branch = 'feature/remote', sha = git(f.checkout, 'rev-parse', 'HEAD')
  await gitSteerContext.run({ command: 'git push -u origin HEAD:feature/remote', push: { branch, sourceBranch: 'feature/widgets', sha } }, () => f.run('git_push', { branch, set_upstream: true }))
  assert.equal(git(f.remote, 'rev-parse', `refs/heads/${branch}`), sha)
  assert.equal(git(f.checkout, 'config', 'branch.feature/widgets.merge'), `refs/heads/${branch}`)
  assert.equal(git(f.checkout, 'config', 'branch.feature/widgets.remote'), 'origin')
  await assert.rejects(f.run('git_push', { branch }), /reviewed-sha-mismatch/)
})
