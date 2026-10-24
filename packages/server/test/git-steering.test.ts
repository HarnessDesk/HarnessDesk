import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { GitGateway } from '../src/git-gateway/index.js'
import { GitSteering, type SteerScope } from '../src/git-gateway/steering.js'
import { ToolGateway } from '../src/tool-gateway.js'
import { ForgePlane } from '../src/forge.js'
import { StateStore } from '../src/state.js'
import type { HeldQuestion } from '../src/ceilings/gate.js'
const run = promisify(execFile)
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
async function rig(t: { after(fn: () => void | Promise<void>): void }) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hd-git-steer-'))), cwd = join(home, 'checkout'), remote = join(home, 'remote.git'), state = join(home, 'state')
  mkdirSync(state)
  git(home, 'init', '-q', '-b', 'x', cwd); git(home, 'init', '-q', '--bare', remote)
  writeFileSync(join(cwd, 'file'), 'widgets'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'Widgets')
  git(cwd, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
  const prefs: Record<string, unknown> = {}
  const gateway = new GitGateway({ directory: join(state, 'gateway'), stateDirectory: state, localRemote: () => remote, recordOutside: () => (prefs['gitWrites'] as { recordOutside?: boolean })?.recordOutside !== false,
    gh: async (_cwd, args) => ({ stdout: args.some(arg => arg.includes('/branches/')) ? '{"protected":false}' : '{"defaultBranchRef":{"name":"main"}}', stderr: '', exitCode: 0 }) })
  const scope: SteerScope = { runtime: 'fixture', sessionId: 's1', cwd, root: cwd, turn: 't1', name: 'Test Agent' }
  const questions: HeldQuestion[] = [], rows: string[] = [], tools: { name: string; args: unknown }[] = []
  let admitted = true
  let choice: 'allowed' | 'standing' | 'refused' | 'unanswered' = 'allowed'
  const plane = new ForgePlane({ gitGateway: gateway, checkoutOf: async () => ({ cwd, root: cwd }), admitWrite: async () => {}, askPerson: async (_scope, question) => { questions.push(question); return 'allowed' }, agentOf: () => ({ name: 'Test Agent', version: null }), optionsOf: () => [], toolsOffered: () => true, record: () => true })
  const steer = new GitSteering(state, gateway, { preferences: () => prefs, projectOf: async () => cwd, scope: async () => scope,
    admit: async () => { if (!admitted) throw new Error('Read ceiling refused') },
    ask: async (_scope, question) => { questions.push(question); return choice }, say: (_scope, text) => { rows.push(text) },
    invoke: async (_scope, name, input) => {
      tools.push({ name, args: input })
      if (name !== 'git_push') return { ok: true, content: [{ type: 'text', text: 'Forge write' }] }
      try {
        const args = input as { branch: string }
        const sha = git(cwd, 'rev-parse', 'HEAD')
        const output = await plane.push({ branch: args.branch, sha, expect: 'create' }, { plugin: 'git', runtime: 'fixture', sessionId: 's1', signal: new AbortController().signal })
        return { ok: true, content: [{ type: 'text', text: output.output }] }
      } catch (error) { return { ok: false, error: String(error) } }
    } })
  const socket = join(home, 'tools.sock'), server = new ToolGateway(socket, { listTools: () => [], invokeByName: async () => ({ ok: false, error: 'unused' }), steerGit: (caller, params, signal) => caller === 'token' ? steer.handle('fixture', 's1', params, signal) : Promise.resolve({ action: 'done', ok: false, output: 'Unknown caller' }) })
  server.start()
  const env = { ...process.env, ...await steer.environment(cwd, 'token'), HD_TOOLS_SOCKET: socket }
  t.after(async () => { await server.stop(); rmSync(home, { recursive: true, force: true }) })
  const command = async (binary: string, args: string[], override: NodeJS.ProcessEnv = {}) => {
    try { const out = await run(join(steer.directory, binary), args, { cwd, env: { ...env, ...override } }); return { code: 0, ...out } }
    catch (error) { const failure = error as { code: number; stdout: string; stderr: string }; return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr } }
  }
  return { home, cwd, state, remote, gateway, plane, prefs, scope, steer, env, command, rows, questions, tools, admit: (value: boolean) => { admitted = value }, choose: (value: typeof choice) => { choice = value } }
}

test('PATH reads preserve stdout and exit code without a socket round trip', async t => {
  const f = await rig(t)
  const expected = await run('git', ['status', '--short'], { cwd: f.cwd })
  assert.equal((await f.command('git', ['status', '--short'], { HD_TOOLS_SOCKET: '/missing/socket' })).stdout, expected.stdout)
  const fake = join(f.home, 'fake-gh'); writeFileSync(fake, '#!/bin/sh\necho "fixture view"\nexit 17\n', { mode: 0o700 })
  const result = await f.command('gh', ['pr', 'view'], { HD_GIT_REAL_GH: fake, HD_TOOLS_SOCKET: '/missing/socket' })
  assert.equal(result.code, 17); assert.equal(result.stdout, 'fixture view\n')
})
test('ask sends a push through R2, pins with the same approval, and records the original command', async t => {
  const f = await rig(t), result = await f.command('git', ['push', '-u', 'origin', 'x'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /HarnessDesk: pushed x to acme\/widgets \([a-f0-9]{7}\), recorded\./)
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/x'), git(f.cwd, 'rev-parse', 'HEAD'))
  assert.equal(f.questions.length, 1)
  assert.deepEqual(f.questions[0]?.options?.map(option => option.label), ['Push through HarnessDesk', 'Let it use its own git', "Don't push"])
  const entries = await f.gateway.record({ repository: 'acme/widgets', limit: 10 })
  assert.equal(entries[0]?.steeredFrom, 'git push -u origin x')
})
test('decline and unreachable socket refuse with visible output and exit 1', async t => {
  const f = await rig(t); f.choose('refused')
  const declined = await f.command('git', ['push', 'origin', 'x'])
  assert.equal(declined.code, 1); assert.match(declined.stdout, /not pushed — the person declined/)
  const unreachable = await f.command('git', ['push'], { HD_TOOLS_SOCKET: join(f.home, 'absent.sock') })
  assert.equal(unreachable.code, 1); assert.match(unreachable.stderr, /go through the git_push tool; use it instead/)
  const unsupported = await f.command('git', ['push', '--tags'])
  assert.equal(unsupported.code, 1); assert.match(unsupported.stdout, /Unsupported push option/)
})
test('own git executes the real binary and is recorded as outside with no attribution', async t => {
  const f = await rig(t); f.choose('standing')
  await f.gateway.pins.pin(f.cwd, 'acme/widgets', { kind: 'person', id: 'person' })
  // Own git deliberately follows the checkout; the local bare remote is the fixture destination.
  git(f.cwd, 'remote', 'set-url', 'origin', f.remote)
  const result = await f.command('git', ['push', 'origin', 'x'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const row = (await f.gateway.record({ repository: 'acme/widgets', limit: 10 }))[0]!
  assert.equal(row.reason, 'own-git-allowed'); assert.equal(row.requester.kind, 'outside'); assert.equal(row.approval?.by, 'person'); assert.equal(row.steeredFrom, 'git push origin x')
  assert.equal(await f.gateway.attribute('acme/widgets', 'x', git(f.cwd, 'rev-parse', 'HEAD')), 'outside')
})
test('redirect skips the steer question but still asks R2; successful bypass gets one banner per turn', async t => {
  const f = await rig(t); f.prefs['gitWrites'] = { steer: 'redirect' }
  const pushed = await f.command('git', ['push', 'origin', 'x'])
  assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr); assert.equal(f.questions.length, 1)
  assert.ok(f.rows.some(row => row.includes('your choice for this project')))
  await f.steer.completed(f.scope, 'git push origin x', 0)
  assert.equal(f.rows.filter(row => row.startsWith('A push went around')).length, 0)
  await f.steer.completed(f.scope, '/usr/bin/git push origin x', 0)
  // An absolute binary bypass is outside even when a PATH call used the same argv.
  await f.steer.completed({ ...f.scope, turn: 't2' }, '/usr/bin/git push origin x', 0)
  assert.equal(f.rows.filter(row => row.startsWith('A push went around')).length, 2)
})
test('global and project off install nothing; recordOutside independently controls observed heads', async t => {
  const f = await rig(t)
  const state = new StateStore(join(f.state, 'settings.json')); await state.load()
  await state.setPreferences({ gitWrites: { steer: 'ask', recordOutside: false, projects: { [f.cwd]: 'off' } } })
  f.prefs['gitWrites'] = state.state.preferences['gitWrites']
  assert.equal(f.steer.steerFor(f.cwd), 'off'); assert.equal(await f.steer.environment(f.cwd, 'another'), undefined)
  assert.equal(f.steer.recordOutside, false)
  git(f.cwd, 'push', f.remote, 'HEAD:x')
  await f.gateway.remoteHead('acme/widgets', 'x')
  assert.deepEqual(await f.gateway.record({ repository: 'acme/widgets', limit: 10 }), [])
  f.prefs['gitWrites'] = { steer: 'off', recordOutside: true }
  const disabled = new GitSteering(join(f.home, 'disabled'), f.gateway, { preferences: () => f.prefs, projectOf: async () => f.cwd,
    scope: async () => null, admit: async () => {}, ask: async () => 'refused', invoke: async () => ({ ok: false, error: 'unused' }), say: () => {} })
  assert.equal(await disabled.environment(f.cwd, 'disabled'), undefined)
  assert.equal(existsSync(disabled.directory), false)
  assert.equal(await f.steer.environment(f.cwd, 'another'), undefined)
  await f.gateway.remoteHead('acme/widgets', 'x')
  assert.equal((await f.gateway.record({ repository: 'acme/widgets', limit: 10 }))[0]?.requester.kind, 'outside')
})
test('forge translation reads body files, fill text and head-bound merge arguments', async t => {
  const f = await rig(t); f.prefs['gitWrites'] = { steer: 'redirect' }
  writeFileSync(join(f.cwd, 'body.txt'), 'A body from a file.')
  assert.equal((await f.command('gh', ['issue', 'comment', '42', '--body-file', 'body.txt'])).code, 0)
  assert.deepEqual(f.tools[0], { name: 'issue_comment', args: { number: 42, body: 'A body from a file.' } })
  git(f.cwd, 'branch', 'main'); git(f.cwd, 'commit', '--allow-empty', '-qm', 'First feature\n\nFeature body')
  assert.equal((await f.command('gh', ['pr', 'create', '--fill'])).code, 0)
  assert.deepEqual(f.tools[1], { name: 'pr_create', args: { title: 'First feature', body: 'Feature body' } })
  const head = git(f.cwd, 'rev-parse', 'HEAD')
  assert.equal((await f.command('gh', ['pr', 'merge', '42', '--rebase', '--match-head-commit', head])).code, 0)
  assert.deepEqual(f.tools[2], { name: 'pr_merge', args: { number: 42, method: 'rebase', head } })
})

test('the ceiling refuses own git before a steering choice is offered', async t => {
  const f = await rig(t); f.admit(false); f.choose('standing')
  const result = await f.command('git', ['push', 'origin', 'x'])
  assert.equal(result.code, 1); assert.match(result.stdout, /Read ceiling refused/)
  assert.equal(f.questions.length, 0)
})

test('a pinned declined steer is recorded; off still records HarnessDesk writes', async t => {
  const f = await rig(t); await f.gateway.pins.pin(f.cwd, 'acme/widgets', { kind: 'person', id: 'person' }); f.choose('refused')
  await f.command('git', ['push', 'origin', 'x'])
  const refusal = (await f.gateway.record({ repository: 'acme/widgets', limit: 10 }))[0]!
  assert.equal(refusal.outcome, 'refused'); assert.equal(refusal.steeredFrom, 'git push origin x')
  f.prefs['gitWrites'] = { steer: 'off', recordOutside: false }
  await f.plane.push({ branch: 'x', sha: git(f.cwd, 'rev-parse', 'HEAD'), expect: 'create' }, { plugin: 'git', runtime: 'fixture', sessionId: 's1', signal: new AbortController().signal })
  assert.equal((await f.gateway.record({ repository: 'acme/widgets', limit: 10 }))[0]?.outcome, 'ok')
})

test('HEAD:branch keeps the reviewed checkout head while writing the requested remote branch', async t => {
  const f = await rig(t), result = await f.command('git', ['push', 'origin', 'HEAD:feature/widgets'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/feature/widgets'), git(f.cwd, 'rev-parse', 'HEAD'))
  assert.equal(git(f.cwd, 'branch', '--show-current'), 'x')
  assert.deepEqual(f.tools[0], { name: 'git_push', args: { branch: 'feature/widgets', set_upstream: false } })
})

test('an unsupported forge command is refused under its own operation', async t => {
  const f = await rig(t); await f.gateway.pins.pin(f.cwd, 'acme/widgets', { kind: 'person', id: 'person' })
  const result = await f.command('gh', ['pr', 'create', '--web'])
  assert.equal(result.code, 1)
  assert.equal((await f.gateway.record({ repository: 'acme/widgets', limit: 10 }))[0]?.op, 'pr.create')
})

test('R3 mode changes apply to installed stand-ins and environment cannot opt out', async t => {
  const f = await rig(t); f.choose('refused')
  assert.equal((await f.command('git', ['push'], { HD_GIT_STEER: 'off' })).code, 1)
  f.prefs['gitWrites'] = { steer: 'off' }
  git(f.cwd, 'remote', 'set-url', 'origin', f.remote)
  assert.equal((await f.command('git', ['push', 'origin', 'x'])).code, 0)
})
test('R3 body files are confined regular bounded files and admission precedes reads', async t => {
  const f = await rig(t); f.prefs['gitWrites'] = { steer: 'redirect' }
  const outside = join(f.home, 'secret'); writeFileSync(outside, 'must not post')
  execFileSync('mkfifo', [join(f.cwd, 'fifo')]); writeFileSync(join(f.cwd, 'large'), 'x'.repeat(65537))
  for (const file of [outside, '../secret', '/dev/zero', 'fifo', 'large']) {
    const reply = await f.steer.handle('fixture', 's1', { binary: 'gh', argv: ['pr', 'comment', '5', '-F', file], cwd: f.cwd })
    assert.equal(reply.ok, false, file)
  }
  assert.equal(f.tools.length, 0)
  f.admit(false)
  const reply = await f.steer.handle('fixture', 's1', { binary: 'gh', argv: ['pr', 'comment', '5', '-F', 'missing'], cwd: f.cwd })
  assert.match(reply.output!, /Read ceiling refused/)
})
test('R3 fill validates base before git log can treat it as an option', async t => {
  const f = await rig(t); f.prefs['gitWrites'] = { steer: 'redirect' }
  assert.equal((await f.command('gh', ['pr', 'create', '--base=--output=../pwned', '--fill'])).code, 1)
  assert.equal(existsSync(join(f.home, 'pwned..HEAD')), false)
})
test('R3 nested hosts skip stand-ins when resolving real executables', async t => {
  const f = await rig(t)
  const nested = new GitSteering(join(f.home, 'nested'), f.gateway, { preferences: () => ({}), projectOf: async () => f.cwd, scope: async () => null, admit: async () => {}, ask: async () => 'refused', invoke: async () => ({ ok: false, error: 'unused' }), say: () => {} }, `${f.steer.directory}:${process.env['PATH']}`)
  const env = await nested.environment(f.cwd, 'nested')
  assert.notEqual(env?.['HD_GIT_REAL_GIT'], join(f.steer.directory, 'git'))
  const result = await f.command('git', ['--version'], { HD_GIT_REAL_GIT: join(f.steer.directory, 'git') })
  assert.equal(result.code, 1)
})
test('R3 completed commands ignore prose and match the embedded steered write', async t => {
  const f = await rig(t); f.choose('refused'); await f.command('git', ['push', 'origin', 'x'])
  for (const command of ['echo git push', 'man git push', '/usr/bin/git push --help', "zsh -lc 'cd /repo && git push origin x'", "/bin/zsh -lc 'git push origin x'"]) await f.steer.completed(f.scope, command, 0)
  assert.equal(f.rows.filter(row => row.includes('went around')).length, 0)
})
test('R3 cwd accepts subdirectories and rejects observation of other checkouts', async t => {
  const f = await rig(t); f.prefs['gitWrites'] = { steer: 'redirect' }; mkdirSync(join(f.cwd, 'sub'))
  const reply = await f.steer.handle('fixture', 's1', { binary: 'git', argv: ['push', 'origin', 'x'], cwd: join(f.cwd, 'sub') })
  assert.equal(reply.ok, true, reply.output ?? '')
  await f.steer.completed(f.scope, '/usr/bin/git push origin x', 0, f.home)
  assert.equal(f.rows.filter(row => row.includes('went around')).length, 1)
})
test('R3 partial preferences retain outside setting and project overrides', async t => {
  const f = await rig(t), state = new StateStore(join(f.state, 'partial.json')); await state.load()
  await state.setPreferences({ gitWrites: { recordOutside: false, projects: { [f.cwd]: 'off' } } })
  await state.setPreferences({ gitWrites: { steer: 'redirect' } })
  assert.deepEqual(state.state.preferences['gitWrites'], { steer: 'redirect', recordOutside: false, projects: { [f.cwd]: 'off' } })
})
test('R3 commands redact URL credentials and multiline bodies in durable output', async t => {
  const f = await rig(t); await f.gateway.pins.pin(f.cwd, 'acme/widgets', { kind: 'person', id: 'person' })
  await f.command('git', ['push', 'https://x-access-token:secret@github.com/acme/widgets.git', 'HEAD'])
  assert.ok(!JSON.stringify(await f.gateway.record({ repository: 'acme/widgets', limit: 100 })).includes('secret'))
  assert.ok(!f.rows.join('').includes('secret'))
})

test('R3 caller disconnect cancels a held steer before invoking the gateway', async t => {
  const f = await rig(t), controller = new AbortController()
  const steering = new GitSteering(join(f.home, 'cancel'), f.gateway, { preferences: () => ({}), projectOf: async () => f.cwd, scope: async () => f.scope, admit: async () => {},
    ask: async (_scope, _question, signal) => { controller.abort(); assert.equal(signal?.aborted, true); return 'allowed' },
    invoke: async () => { assert.fail('A disconnected caller must not invoke'); }, say: () => {} })
  const result = await steering.handle('fixture', 's1', { binary: 'git', argv: ['push'], cwd: f.cwd }, controller.signal)
  assert.equal(result.ok, false)
})
test('R3 own-git recording obeys recordOutside and never trusts a receipt for the pushed SHA', async t => {
  const f = await rig(t); f.choose('standing'); await f.gateway.pins.pin(f.cwd, 'acme/widgets', { kind: 'person', id: 'person' })
  const result = await f.steer.handle('fixture', 's1', { binary: 'git', argv: ['push'], cwd: f.cwd })
  assert.equal(result.action, 'own')
  await f.steer.handle('fixture', 's1', { ticket: result.ticket, exitCode: 0 })
  assert.equal((await f.gateway.record({ repository: 'acme/widgets', limit: 10 })).length, 0, 'exit 0 alone proves no remote head')
  f.prefs['gitWrites'] = { recordOutside: false }
  git(f.cwd, 'remote', 'set-url', 'origin', f.remote)
  await f.command('git', ['push', 'origin', 'x'])
  assert.equal((await f.gateway.record({ repository: 'acme/widgets', limit: 10 })).length, 0)
})
test('R3 pass-through git children receive no desk tool or steering credential', async t => {
  const f = await rig(t), executable = join(f.home, 'show-env')
  writeFileSync(executable, '#!/bin/sh\nenv\n', { mode: 0o700 })
  const result = await f.command('git', ['status'], { HD_GIT_REAL_GIT: executable, HD_TOOLS_CALLER: 'general-secret' })
  assert.equal(result.code, 0)
  assert.ok(!result.stdout.includes('HD_TOOLS_'))
  assert.ok(!result.stdout.includes('HD_GIT_CALLER='))
})

test('R3 read fast path does not start Node', async t => {
  const f = await rig(t)
  const result = await f.command('git', ['status', '--short'], { NODE_OPTIONS: '--this-option-must-not-be-read' })
  assert.equal(result.code, 0, result.stderr)
})
