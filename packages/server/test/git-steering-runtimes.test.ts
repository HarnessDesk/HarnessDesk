import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { CodexRuntime } from '@harnessdesk/adapter-codex'
import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { runtimeId, type AgentRuntime, type Session, type WireNotification } from '@harnessdesk/protocol'
import { Host, Logger, StateStore } from '../src/index.js'
import { ExtensionKernel, setForgeEngine, type HarnessContext } from '@harnessdesk/cordis-host'
import { gitPlugin } from '@harnessdesk/plugins'
import { GitGateway } from '../src/git-gateway/index.js'
import { ToolGateway } from '../src/tool-gateway.js'
const codex = fileURLToPath(new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url))
const peer = fileURLToPath(new URL('../../../adapter-acp/test/fixtures/fake-acp-agent.mjs', import.meta.url))
const cursor = fileURLToPath(new URL('../../../cursor-acp/dist/src/main.js', import.meta.url))
const cursorFake = fileURLToPath(new URL('../../../cursor-acp/test/fixtures/fake-cursor-agent.mjs', import.meta.url))
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const until = async (predicate: () => boolean | Promise<boolean>, message: string) => {
  const end = Date.now() + 10_000
  while (!await predicate()) { assert.ok(Date.now() < end, message); await new Promise(resolve => setTimeout(resolve, 10)) }
}
async function fixture(t: { after(fn: () => void | Promise<void>): void }, kind: 'codex' | 'acp' | 'cursor' | 'claude', off: boolean | 'project' = false, approve = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hd-steer-runtime-'))), cwd = join(home, 'checkout'), stateDir = join(home, 'state'), remote = join(home, 'remote.git')
  mkdirSync(stateDir); git(home, 'init', '-q', '-b', 'x', cwd); git(home, 'init', '-q', '--bare', remote)
  writeFileSync(join(cwd, 'file'), 'widgets'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'Widgets'); git(cwd, 'remote', 'add', 'origin', remote)
  const store = new StateStore(join(stateDir, 'state.json')); await store.load()
  const kernel = new ExtensionKernel()
  await kernel.load({ manifest: { id: 'fixture-shadow', name: 'Fixture shadow' }, plugin: { name: 'fixture-shadow', inject: ['tools'], apply(ctx: HarnessContext) { ctx.tools.register({ name: 'git_push', namespace: 'git', description: 'A collision must never receive steering.', inputSchema: {}, execute: () => { throw new Error('Wrong plugin received the push') } }) } } })
  await kernel.load(gitPlugin)
  const engine = new GitGateway({ directory: join(stateDir, 'git-gateway'), stateDirectory: stateDir, localRemote: () => remote, gh: async (_cwd, args) => ({ stdout: args.some(arg => arg.includes('/branches/')) ? '{"protected":false}' : '{"defaultBranchRef":{"name":"main"}}', stderr: '', exitCode: 0 }) })
  const host = new Host({ gitGateway: engine, extensions: kernel, state: store, logger: new Logger('test', { console: false, level: 'error' }), catalogRefreshMs: 0, idleStopMs: 0, retryDelaysMs: [], heldWaitMs: 3000 })
  setForgeEngine(host.forgePlane)
  const callers = new Map<string, string>(), socket = join(home, 'tools.sock')
  const launch = async (root: string, caller: string) => { const env = await host.gitSteering.environment(root, caller); return env ? { ...env, HD_TOOLS_SOCKET: socket } : undefined }
  const claim = (caller: string, session: string) => { callers.set(caller, session) }
  const runtime: AgentRuntime = kind === 'codex' ? new CodexRuntime({ id: runtimeId('fixture'), binaryPath: codex, clientName: 'test', env: { HOME: home, CODEX_HOME: home, FAKE_CODEX_GIT_APPROVAL: '1' }, gitEnvironment: launch, onGitSession: claim }) : new AcpRuntime({ id: 'fixture', name: 'Fixture Agent', command: process.execPath, args: [kind === 'cursor' ? cursor : kind === 'claude' ? fileURLToPath(new URL('../../../claude-acp/dist/src/main.js', import.meta.url)) : peer],
    env: { HOME: home, ...(kind === 'claude' ? { CLAUDE_CODE_EXECUTABLE: fileURLToPath(new URL('../../../claude-acp/test/fixtures/fake-claude.mjs', import.meta.url)), CLAUDE_CONFIG_DIR: join(home, 'claude'), CLAUDE_ACP_STATE_DIR: join(home, 'claude-state'), CLAUDECODE: '' } : {}), ...(kind === 'cursor' ? { CURSOR_ACP_COMMAND: cursorFake, CURSOR_ACP_STATE_DIR: join(home, 'cursor'), CURSOR_CONFIG_DIR: join(home, 'cursor-config') } : {}) }, gitEnvironment: launch, onGitSession: claim })
  host.register(runtime)
  const gateway = new ToolGateway(socket, { listTools: () => [], invokeByName: async () => ({ ok: false, error: 'unused' }), steerGit: (caller, params, signal) => {
    const id = caller && callers.get(caller)
    return id ? host.gitSteering.handle('fixture', id, params, signal) : Promise.resolve({ action: 'done', ok: false, output: 'Unknown caller' })
  } })
  gateway.start()
  const notifications: WireNotification[] = [], replyErrors: unknown[] = []
  host.addBroadcaster(notification => {
    notifications.push(notification)
    if (notification.method === 'event' && notification.params.event.type === 'approval/requested') {
      const approval = notification.params.event.approval
      if (approval.type !== 'command' && approval.type !== 'permission') return
      const option = approval.options.find(entry => approve ? entry.id === 'allow' : entry.intent === 'deny')!
      setImmediate(() => { void host.call('approval/respond', { runtime: runtimeId('fixture'), sessionId: approval.sessionId, approvalId: approval.id, decision: { type: 'option', optionId: option.id } }).catch(error => replyErrors.push(error)) })
    }
  })
  t.after(async () => { await gateway.stop(); await host.dispose(); setForgeEngine(null); await kernel.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await host.start()
  if (off) await host.call('app/state/set', { patch: { gitWrites: { steer: off === 'project' ? 'ask' : 'off', ...(off === 'project' ? { projects: { [cwd]: 'off' } } : {}) } } })
  await host.call('workspace/open', { path: cwd })
  const session = await host.call('session/create', { runtime: runtimeId('fixture'), options: { cwd } }) as Session
  const turn = async (text: string) => {
    const start = notifications.length
    await host.call('turn/send', { runtime: runtimeId('fixture'), sessionId: session.id, input: [{ type: 'text', text }] })
    await until(() => notifications.slice(start).some(message => message.method === 'event' && message.params.event.type === 'turn/completed'), 'turn completed')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(replyErrors, [])
    return notifications.slice(start).flatMap(message => message.method === 'event' ? [message.params.event] : [])
  }
  return { host, engine, runtime, session, notifications, turn, cwd, home, remote, store }
}
for (const kind of ['codex', 'acp', 'cursor'] as const) {
  test(`${kind}: PATH catches an unapproved push; an absolute-path success gets the outside banner`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, kind)
    const events = await f.turn('git-steer-run ' + JSON.stringify({ binary: 'git', args: ['push', 'origin', 'x'] }))
    assert.ok(events.some(event => event.type === 'approval/requested' && event.approval.type === 'permission' && event.approval.summary.includes('wants to run git push itself')), JSON.stringify(events))
    assert.ok(events.some(event => event.type === 'item/completed' && event.item.type === 'command' && event.item.exitCode === 1 && event.item.output?.includes('the person declined')), 'the native model reads the refusal as its command output: ' + JSON.stringify(events))
    const absolute = await f.turn('git-steer-run ' + JSON.stringify({ binary: '/usr/bin/git', args: ['push', 'origin', 'x'] }))
    await until(() => f.notifications.some(message => message.method === 'event' && message.params.event.type === 'notice' && message.params.event.message.includes('A push went around HarnessDesk')), 'outside banner')
    assert.ok(absolute.some(event => event.type === 'item/completed' && event.item.type === 'command' && event.item.exitCode === 0))
    assert.equal(git(f.remote, 'rev-parse', 'refs/heads/x'), git(f.cwd, 'rev-parse', 'HEAD'))
  })
}
for (const kind of ['codex', 'acp'] as const) {
  for (const off of [false, true, 'project'] as const) test(`${kind}: native approval ${off ? `is unchanged with ${off === 'project' ? 'project' : 'global'} off` : 'is declined and replaced by a steering card'}`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, kind, off)
    const text = kind === 'codex' ? 'native approval' : 'ceiling permission ' + JSON.stringify({ toolCallId: 'git-write', title: 'git push origin x', kind: 'execute', rawInput: { command: 'git push origin x' } })
    const events = await f.turn(text)
    await until(() => Boolean(off) || f.notifications.some(message => message.method === 'event' && message.params.event.type === 'approval/requested' && message.params.event.approval.type === 'permission' && message.params.event.approval.summary.includes('wants to run git push itself')), 'steering card')
    const native = events.filter(event => event.type === 'approval/requested' && !String(event.approval.id).startsWith('held-'))
    assert.equal(native.length, off ? 1 : 0)
    assert.equal(events.some(event => event.type === 'item/completed' && event.item.type === 'notice' && event.item.text.includes('Steered ')), !off)
  })
}

for (const kind of ['codex', 'acp', 'cursor'] as const) test(`${kind}: a project off override passes a push unchanged without a steer or banner`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, kind, 'project')
  const events = await f.turn('git-steer-run ' + JSON.stringify({ binary: 'git', args: ['push', 'origin', 'x'] }))
  assert.equal(events.some(event => event.type === 'approval/requested'), false)
  assert.ok(events.some(event => event.type === 'item/completed' && event.item.type === 'command' && event.item.exitCode === 0 && !event.item.output?.includes('HarnessDesk:')))
  assert.equal(events.some(event => event.type === 'notice' && event.message.includes('went around')), false)
})

for (const kind of ['codex', 'acp', 'cursor', 'claude'] as const) test(`${kind}: approved shell push reaches Host, real plugin and pinned local bare remote`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, kind, false, true)
  git(f.cwd, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git')
  await f.engine.pins.pin(f.cwd, 'acme/widgets', { kind: 'person', id: 'person' })
  const events = await f.turn('git-steer-run ' + JSON.stringify({ binary: 'git', args: ['push', 'origin', 'x'] }))
  if (kind !== 'claude') assert.ok(events.some(event => event.type === 'item/completed' && event.item.type === 'command' && event.item.exitCode === 0), JSON.stringify(events))
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/x'), git(f.cwd, 'rev-parse', 'HEAD'))
  assert.ok(events.some(event => event.type === 'item/completed' && (event.item.type === 'command' && event.item.output?.includes('recorded.') || kind === 'claude' && event.item.type === 'notice' && event.item.text.includes('Sent through HarnessDesk'))), JSON.stringify(events))
  assert.ok(events.some(event => event.type === 'approval/requested' && 'options' in event.approval && event.approval.options.some(option => option.label === 'Push through HarnessDesk')))
  assert.equal((await f.engine.record({ repository: 'acme/widgets', limit: 10 }))[0]?.outcome, 'ok')
  const page = await f.host.call('git/record/list', { root: f.cwd })
  assert.equal(page.repository, 'acme/widgets'); assert.equal(page.entries.length, 1); assert.deepEqual(page.counts, { all: 1, outside: 0, refused: 0 })
  assert.notEqual(await f.host.call('git/record/attribute', { root: f.cwd, branch: 'x', sha: git(f.cwd, 'rev-parse', 'HEAD') }), 'outside')
  git(f.cwd, 'commit', '--allow-empty', '-qm', 'Outside update'); git(f.cwd, 'push', f.remote, 'HEAD:x')
  await f.engine.remoteHead('acme/widgets', 'x')
  const outside = await f.host.call('git/record/list', { root: f.cwd, view: 'outside' })
  assert.equal(outside.counts.outside, 1); assert.equal(outside.entries[0]?.requester.kind, 'outside')

})

test('ACP steering rejects once even when reject always is the first option', async t => {
  const f = await fixture(t, 'acp')
  const events = await f.turn('ceiling permission ' + JSON.stringify({ reportOutcome: true, toolCall: { toolCallId: 'git-write', title: "bash -lc 'git push origin x'", kind: 'execute', rawInput: { command: "bash -lc 'git push origin x'", cwd: f.cwd } }, options: [{ optionId: 'never', name: 'Reject always', kind: 'reject_always' }, { optionId: 'once', name: 'Reject once', kind: 'reject_once' }] }))
  assert.ok(events.some(event => event.type === 'approval/resolved' && event.resolution.outcome === 'decided' && event.resolution.decision.type === 'option' && event.resolution.decision.optionId === 'once'), JSON.stringify(events))
})
test('Claude bridge SDK actually receives the nested-shell steering denial', async t => {
  const f = await fixture(t, 'claude')
  const events = await f.turn('permission ' + JSON.stringify({ tool: 'Bash', input: { command: "bash -c 'git push origin x'" } }))
  assert.ok(JSON.stringify(events).includes('native guard denied.'), JSON.stringify(events))
})

test('unmappable native writes retain the ordinary approval with a steering explanation', async t => {
  const f = await fixture(t, 'acp')
  const command = 'git push origin x | cat'
  const events = await f.turn('ceiling permission ' + JSON.stringify({ toolCallId: 'compound', title: command, kind: 'execute', rawInput: { command, cwd: f.cwd } }))
  const native = events.find(event => event.type === 'approval/requested' && !String(event.approval.id).startsWith('held-'))
  assert.ok(native?.type === 'approval/requested' && native.approval.reason?.includes('Compound shell commands cannot be translated safely.'), JSON.stringify(events))
  assert.equal(events.some(event => event.type === 'approval/requested' && String(event.approval.id).startsWith('held-')), false)
})

test('Never leaves native git unchanged while a pinned outside push is still observed', async t => {
  const f = await fixture(t, 'codex', true)
  await f.engine.pins.pin(f.cwd, 'acme/widgets', { kind: 'person', id: 'person' })
  const events = await f.turn('git-steer-run ' + JSON.stringify({ binary: 'git', args: ['push', 'origin', 'x'] }))
  await until(async () => (await f.engine.record({ repository: 'acme/widgets', limit: 10 })).some(row => row.op === 'observed'), 'outside record with Never')
  assert.equal(events.some(event => event.type === 'approval/requested' || event.type === 'notice' && event.message.includes('went around')), false)
  assert.equal(await f.host.call('git/record/attribute', { root: f.cwd, branch: 'x', sha: git(f.cwd, 'rev-parse', 'HEAD') }), 'outside')
})
