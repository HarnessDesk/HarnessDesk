import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { ExtensionKernel, setForgeEngine, type ForgeScope } from '@harnessdesk/cordis-host'
import { gitPlugin } from '@harnessdesk/plugins'
import type { ForgeReference } from '@harnessdesk/protocol'
import { ForgePlane } from '../src/forge.js'
import { GitGateway } from '../src/git-gateway/index.js'
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
  const prior = { PATH: process.env.PATH, FAKE_GH_STATE: process.env.FAKE_GH_STATE, FAKE_GH_TRACE: process.env.FAKE_GH_TRACE, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN }
  delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: statePath, FAKE_GH_TRACE: tracePath })
  t.after(() => { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } rmSync(root, { recursive: true, force: true }) })
  const gateway = new GitGateway({ directory: host, localRemote: () => remote, gh: async (cwd, args, env) => {
    try { return { stdout: execFileSync('gh', [...args], { cwd, env: { ...env, GH_TOKEN: 'host-fixture-token' }, encoding: 'utf8' }), stderr: '', exitCode: 0 } }
    catch (error) { return { stdout: '', stderr: String(error), exitCode: 1 } }
  } })
  const questions: HeldQuestion[] = [], publications: ForgeReference[] = [], admissions: string[] = []
  let onQuestion: (() => void | Promise<void>) | undefined
  let answer: 'allowed' | 'standing' | 'refused' = 'allowed', mergeStep = false, ceiling: 'read' | 'publish' | 'merge' = 'merge'
  const plane = new ForgePlane({ gitGateway: gateway, checkoutOf: async () => ({ cwd: checkout, root: checkout }),
    admitWrite: async verb => { admissions.push(verb); if (ceiling === 'read' || verb === 'merge' && ceiling !== 'merge') throw new Error('Ceiling refused') },
    askPerson: async (_scope, question) => { questions.push(question); await onQuestion?.(); return answer }, mergeStep: () => mergeStep && ceiling === 'merge',
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
  const trace = () => readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { argv: string[]; cwd: string; hasCredential: boolean })
  return { gateway, plane, kernel, root, checkout, remote, host, run, invoke, rows, questions, publications, admissions, trace, statePath,
    onQuestion: (hook: () => void | Promise<void>) => { onQuestion = hook },
    answer: (value: typeof answer) => { answer = value }, mergeStep: (value: boolean) => { mergeStep = value }, ceiling: (value: typeof ceiling) => { ceiling = value } }
}

test('kernel pushes pin once, continue without a question, ask for rewrites, and record protected refusals', async t => {
  const f = await fixture(t)
  await f.run('git_push', { set_upstream: true })
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
  assert.ok(f.trace().filter(call => call.cwd === f.checkout).every(call => !call.hasCredential), 'the plugin shell receives no host credential')
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
  assert.equal((await f.rows())[0]?.outcome, 'refused')
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
