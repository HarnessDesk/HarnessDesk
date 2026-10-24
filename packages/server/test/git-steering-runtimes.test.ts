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
import { ToolGateway } from '../src/tool-gateway.js'
const codex = fileURLToPath(new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url))
const peer = fileURLToPath(new URL('../../../adapter-acp/test/fixtures/fake-acp-agent.mjs', import.meta.url))
const cursor = fileURLToPath(new URL('../../../cursor-acp/dist/src/main.js', import.meta.url))
const cursorFake = fileURLToPath(new URL('../../../cursor-acp/test/fixtures/fake-cursor-agent.mjs', import.meta.url))
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const until = async (predicate: () => boolean, message: string) => {
  const end = Date.now() + 10_000
  while (!predicate()) { assert.ok(Date.now() < end, message); await new Promise(resolve => setTimeout(resolve, 10)) }
}
async function fixture(t: { after(fn: () => void | Promise<void>): void }, kind: 'codex' | 'acp' | 'cursor', off: boolean | 'project' = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hd-steer-runtime-'))), cwd = join(home, 'checkout'), stateDir = join(home, 'state'), remote = join(home, 'remote.git')
  mkdirSync(stateDir); git(home, 'init', '-q', '-b', 'x', cwd); git(home, 'init', '-q', '--bare', remote)
  writeFileSync(join(cwd, 'file'), 'widgets'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'Widgets'); git(cwd, 'remote', 'add', 'origin', remote)
  const store = new StateStore(join(stateDir, 'state.json')); await store.load()
  const host = new Host({ state: store, logger: new Logger('test', { console: false, level: 'error' }), catalogRefreshMs: 0, idleStopMs: 0, retryDelaysMs: [], heldWaitMs: 3000 })
  const callers = new Map<string, string>(), socket = join(home, 'tools.sock')
  const launch = async (root: string, caller: string) => { const env = await host.gitSteering.environment(root, caller); return env ? { ...env, HD_TOOLS_SOCKET: socket } : undefined }
  const claim = (caller: string, session: string) => { callers.set(caller, session) }
  const runtime: AgentRuntime = kind === 'codex' ? new CodexRuntime({ id: runtimeId('fixture'), binaryPath: codex, clientName: 'test', env: { HOME: home, CODEX_HOME: home, FAKE_CODEX_GIT_APPROVAL: '1' }, gitEnvironment: launch, onGitSession: claim }) : new AcpRuntime({ id: 'fixture', name: 'Fixture Agent', command: process.execPath, args: [kind === 'cursor' ? cursor : peer],
    env: { HOME: home, ...(kind === 'cursor' ? { CURSOR_ACP_COMMAND: cursorFake, CURSOR_ACP_STATE_DIR: join(home, 'cursor'), CURSOR_CONFIG_DIR: join(home, 'cursor-config') } : {}) }, gitEnvironment: launch, onGitSession: claim })
  host.register(runtime)
  const gateway = new ToolGateway(socket, { listTools: () => [], invokeByName: async () => ({ ok: false, error: 'unused' }), steerGit: (caller, params) => {
    const id = caller && callers.get(caller)
    return id ? host.gitSteering.handle('fixture', id, params) : Promise.resolve({ action: 'done', ok: false, output: 'Unknown caller' })
  } })
  gateway.start()
  const notifications: WireNotification[] = [], replyErrors: unknown[] = []
  host.addBroadcaster(notification => {
    notifications.push(notification)
    if (notification.method === 'event' && notification.params.event.type === 'approval/requested') {
      const approval = notification.params.event.approval
      if (approval.type !== 'command' && approval.type !== 'permission') return
      const option = approval.options.find(entry => entry.intent === 'deny')!
      setImmediate(() => { void host.call('approval/respond', { runtime: runtimeId('fixture'), sessionId: approval.sessionId, approvalId: approval.id, decision: { type: 'option', optionId: option.id } }).catch(error => replyErrors.push(error)) })
    }
  })
  t.after(async () => { await gateway.stop(); await host.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
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
  return { host, runtime, session, notifications, turn, cwd, home, remote, store }
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
    assert.equal(events.some(event => event.type === 'item/completed' && event.item.type === 'notice' && event.item.text.includes('Steered git push origin x')), !off)
  })
}

for (const kind of ['codex', 'acp', 'cursor'] as const) test(`${kind}: a project off override passes a push unchanged without a steer or banner`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, kind, 'project')
  const events = await f.turn('git-steer-run ' + JSON.stringify({ binary: 'git', args: ['push', 'origin', 'x'] }))
  assert.equal(events.some(event => event.type === 'approval/requested'), false)
  assert.ok(events.some(event => event.type === 'item/completed' && event.item.type === 'command' && event.item.exitCode === 0 && !event.item.output?.includes('HarnessDesk:')))
  assert.equal(events.some(event => event.type === 'notice' && event.message.includes('went around')), false)
})
