import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { CLIENT_METHODS, type FlowExecution, type FlowPreview, type GoalView } from '@harnessdesk/protocol'
const { openClientDoor } = await import(new URL('../../../server/dist/src/client-door.js', import.meta.url).href) as typeof import('../../server/src/client-door.js')
const { silent, start, stop } = await import(new URL('../../../server/dist/test/fixtures/harness.js', import.meta.url).href) as typeof import('../../server/test/fixtures/harness.js')
const { makeRepo } = await import(new URL('../../../server/dist/test/fixtures/evidence-desk.js', import.meta.url).href) as typeof import('../../server/test/fixtures/evidence-desk.js')

const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url))
const launch = (t: TestContext, directory: string, home: string, args: readonly string[], cwd?: string, preload?: string) => {
  const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), bin, ...args], { cwd, env: { ...process.env, HARNESSDESK_CLIENT_DIR: directory, HARNESSDESK_HOME: home }, stdio: preload ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  const changed = new Set<() => void>()
  child.stdout!.on('data', chunk => { stdout += chunk.toString(); for (const wake of changed) wake() })
  child.stderr!.on('data', chunk => { stderr += chunk.toString() })
  const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
  t.after(async () => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit })
  const lines = () => stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)) as any[]
  const until = async (predicate: (lines: any[]) => boolean) => {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { changed.delete(wake); reject(new Error(`no streamed change: ${stdout} ${stderr}`)) }, 8_000)
      const wake = () => { if (predicate(lines())) { clearTimeout(timeout); changed.delete(wake); resolve() } }
      changed.add(wake); wake()
    })
  }
  return { child, exit, lines, until, output: () => ({ stdout, stderr }) }
}

const rig = async (t: TestContext) => {
  const directory = await mkdtemp('/tmp/hd-door-')
  await chmod(directory, 0o700)
  const home = join(directory, 'home'); await mkdir(home)
  const h = await start({ catalogRefreshMs: 0 }, home)
  const door = await openClientDoor({ host: h.host, logger: silent, home, directory, hostVersion: '9.9.9' })
  assert.ok(door)
  t.after(async () => { await door.close(); await stop(h); await rm(directory, { recursive: true, force: true }) })
  const repo = await makeRepo('hd-cli-project-')
  await h.host.call('workspace/open', { path: repo.dir })
  const source = 'version: 2\nname: CLI proof\nroles:\n  ship: { kind: person, outcomes: [shipped] }\nseed: { role: ship, title: Ship it }\n'
  const preview = await h.host.call('flow/preview', { root: repo.dir, source }) as FlowPreview
  assert.ok(preview.token, JSON.stringify(preview.problems))
  const run = await h.host.call('flow/start-goal', { root: repo.dir, source, token: preview.token!, sentence: 'Finish the demo' }) as FlowExecution
  const complete = async () => {
    let detach = () => {}, timer: ReturnType<typeof setTimeout>
    const settled = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => { detach(); reject(new Error('Flow did not settle')) }, 8_000)
      detach = h.host.addBroadcaster(message => {
        if (message.method === 'flow/execution-changed' && message.params.execution.id === run.id && message.params.execution.state === 'settled') {
          clearTimeout(timer); detach(); resolve()
        }
      })
    })
    const view = await h.host.call('goal/read', { goal: run.goal }) as GoalView
    await h.host.call('team/intent', { room: run.goal, id: view.board.intents[0]!.id, action: 'done', outcome: 'shipped' })
    await settled
  }
  return { directory, home, h, door, repo, run, complete }
}

test('built CLI reads the real host and canonical relative/symlink project filters', { timeout: 30_000 }, async t => {
  const r = await rig(t)
  const desks = launch(t, r.directory, r.home, ['desks'])
  assert.equal(await desks.exit, 0, desks.output().stderr)
  assert.match(desks.output().stdout, /9\.9\.9/)
  const status = launch(t, r.directory, r.home, ['status', '--json'])
  assert.equal(await status.exit, 0, status.output().stderr)
  assert.equal(status.lines().length, 1)
  assert.equal(status.lines()[0].hello.hostVersion, '9.9.9')
  assert.equal(status.lines()[0].runs[0].id, r.run.id)
  const projectAlias = join(r.directory, 'project-alias'); await symlink(r.repo.dir, projectAlias)
  for (const [command, field] of [['runs', 'runs'], ['teams', 'teams']] as const) {
    const child = launch(t, r.directory, r.home, [command, '--json', '--project', 'project-alias'], r.directory)
    assert.equal(await child.exit, 0, child.output().stderr)
    assert.equal(child.lines()[0][field].length, 1)
  }
  const wrong = launch(t, r.directory, r.home, ['teams', '--json', '--project', './other'], r.directory)
  assert.equal(await wrong.exit, 0); assert.deepEqual(wrong.lines()[0].teams, [])
  await r.complete()
  const active = launch(t, r.directory, r.home, ['runs', '--json'])
  assert.equal(await active.exit, 0); assert.deepEqual(active.lines()[0].runs, [])
  const all = launch(t, r.directory, r.home, ['runs', '--json', '--all', '--team', r.run.goal])
  assert.equal(await all.exit, 0); assert.equal(all.lines()[0].runs[0].state, 'settled')
})

test('real Flow running → settled is streamed without polling, SIGINT writes end last and exits 130', { timeout: 30_000 }, async t => {
  const r = await rig(t)
  const child = launch(t, r.directory, r.home, ['watch', '--json', '--run', r.run.id, '--trace-wire'])
  await child.until(lines => lines.some(e => e.type === 'run.changed' && e.state === 'running'))
  await r.complete()
  await child.until(lines => lines.some(e => e.type === 'run.changed' && e.state === 'settled'))
  child.child.kill('SIGINT')
  assert.equal(await child.exit, 130, child.output().stderr)
  assert.equal(child.lines()[0].type, 'hello')
  assert.equal(child.lines().at(-1).type, 'end')
  assert.equal(child.lines().at(-1).reason, 'interrupted')
  assert.equal(child.lines().filter(e => e.type === 'end').length, 1)
  const calls = child.output().stderr.trim().split('\n').map(line => JSON.parse(line)).filter(e => e.direction === 'send').map(e => e.message.method)
  assert.deepEqual(calls, ['client/hello', 'client/subscribe', 'flow/execution'], 'watch makes no periodic calls')
  t.diagnostic(`Flow proof: ${child.lines().filter(e => ['hello', 'run.changed', 'end'].includes(e.type)).map(e => e.type === 'run.changed' ? e.state : e.type).join(' → ')}; exit 130`)
})

test('human output sanitizes actual agent text while JSON retains escaped data and raw relays notifications', { timeout: 30_000 }, async t => {
  const r = await rig(t)
  await r.h.host.call('goal/create', { root: r.repo.dir, sentence: 'a\x1b]52;c;secret\x07b\n\x1b[31mc\x1b[0m\x9d52;c;c1secret\x9c' })
  const human = launch(t, r.directory, r.home, ['teams'])
  assert.equal(await human.exit, 0)
  assert.ok(human.output().stdout.includes('abc'))
  assert.doesNotMatch(human.output().stdout, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/)
  assert.doesNotMatch(human.output().stdout, /secret/)
  const json = launch(t, r.directory, r.home, ['teams', '--json'])
  assert.equal(await json.exit, 0)
  assert.doesNotMatch(json.output().stdout, /[\x7f-\x9f]/, 'JSON also escapes C1 controls')
  assert.ok(json.lines()[0].teams.some((team: GoalView) => team.goal.sentence.includes('\x1b]52;c;secret')))
  const raw = launch(t, r.directory, r.home, ['watch', '--raw', '--run', r.run.id])
  await raw.until(lines => lines.some(e => e.method === 'flow/execution-changed' && e.params.execution.id === r.run.id))
  raw.child.kill('SIGINT'); assert.equal(await raw.exit, 130)
  assert.equal(raw.lines()[0].type, 'hello'); assert.equal(raw.lines().at(-1).type, 'end')
  assert.ok(raw.lines().some(e => e.method === 'flow/execution-changed' && e.params.execution.document.flow.name === 'CLI proof'))
})

test('human status strips escape payloads from runtime health messages as well as titles', { timeout: 30_000 }, async t => {
  const r = await rig(t)
  r.h.runtime.setHealth({ state: 'unavailable', reason: 'unknown', message: 'a\x1b]52;c;secret\x07b\x1b[31mc\x1b[0m' })
  const child = launch(t, r.directory, r.home, ['status'])
  assert.equal(await child.exit, 0)
  assert.doesNotMatch(child.output().stdout, /secret/)
  assert.ok(child.output().stdout.includes('abc'))
})

test('until settled handles already terminal runs, live completion, and SIGTERM 143', { timeout: 30_000 }, async t => {
  const r = await rig(t)
  const alias = join(r.directory, 'project-alias'); await symlink(r.repo.dir, alias)
  const project = launch(t, r.directory, r.home, ['watch', '--json', '--project', 'project-alias'], r.directory)
  await project.until(lines => lines.some(e => e.type === 'run.changed' && e.run === r.run.id))
  project.child.kill('SIGTERM'); assert.equal(await project.exit, 143)
  assert.equal(project.lines().at(-1).type, 'end')
  const child = launch(t, r.directory, r.home, ['watch', '--json', '--run', r.run.id, '--until', 'settled'])
  await child.until(lines => lines.some(e => e.type === 'run.changed' && e.state === 'running'))
  await r.complete()
  assert.equal(await child.exit, 0, child.output().stderr)
  assert.equal(child.lines().at(-1).reason, 'until')
  const terminal = launch(t, r.directory, r.home, ['watch', '--json', '--run', r.run.id, '--until', 'settled'])
  assert.equal(await terminal.exit, 0)
  assert.ok(terminal.lines().some(e => e.type === 'run.changed' && e.state === 'settled'))
  assert.equal(terminal.lines().at(-1).reason, 'until')
})

test('until settled ends a real stopped Flow, and host shutdown ends observation cleanly', { timeout: 30_000 }, async t => {
  const r = await rig(t)
  const child = launch(t, r.directory, r.home, ['watch', '--json', '--run', r.run.id, '--until', 'settled'])
  await child.until(lines => lines.some(e => e.type === 'run.changed' && e.state === 'running'))
  await r.h.host.flowsPlane.stopRun(r.run.id, 'Synthetic test stop')
  assert.equal(await child.exit, 0, child.output().stderr)
  assert.ok(child.lines().some(e => e.type === 'run.changed' && e.state === 'stopped'))
  assert.equal(child.lines().at(-1).reason, 'until')
  const shutdown = launch(t, r.directory, r.home, ['watch', '--json'])
  await shutdown.until(lines => lines[0]?.type === 'hello')
  await r.door.close()
  assert.equal(await shutdown.exit, 0); assert.equal(shutdown.lines().at(-1).reason, 'desk-closed')
})

test('no desk exits 3, unsafe boundary exits 4, invalid usage exits 2', async t => {
  const directory = await mkdtemp('/tmp/hd-door-'); t.after(() => rm(directory, { recursive: true, force: true }))
  const missing = launch(t, directory, join(directory, 'missing'), ['status', '--json'])
  assert.equal(await missing.exit, 3); assert.equal(missing.output().stdout, ''); assert.match(missing.output().stderr, /noDesk/)
  await chmod(directory, 0o755)
  const unsafe = launch(t, directory, directory, ['status']); assert.equal(await unsafe.exit, 4)
  const usage = launch(t, directory, directory, ['open']); assert.equal(await usage.exit, 2)
})

const stub = async (t: TestContext, reconnectCode?: string, terminalState?: 'stalled', delayHello = false) => {
  const directory = await mkdtemp('/tmp/hd-door-'); await chmod(directory, 0o700)
  const home = await realpath(directory)
  const socket = join(directory, `${createHash('sha256').update(home).digest('hex').slice(0, 16)}.sock`)
  const server = createServer(), sockets = new WebSocketServer({ noServer: true })
  let first: WebSocket | undefined, connections = 0
  let sawHello = () => {}
  const helloSeen = new Promise<void>(resolve => { sawHello = resolve })
  server.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head, ws => {
    const n = ++connections; first ??= ws
    ws.on('message', raw => {
      const request = JSON.parse(raw.toString())
      if (request.method === 'client/hello') { sawHello(); if (delayHello) return }
      const code = terminalState || reconnectCode && n === 1 ? null : reconnectCode ?? 'incompatible'
      const result = request.method === 'client/hello' ? { protocolVersion: 1, hostVersion: 'demo', desk: { home, pid: process.pid, startedAt: 1 }, tiers: ['read'], methods: Object.keys(CLIENT_METHODS), runtimes: [] } : request.method === 'flow/execution' ? { id: request.params.run, goal: 'demo-team', document: { flow: { name: 'Demo', roles: [] } }, state: terminalState, rounds: [], reason: 'Synthetic stall' } : null
      ws.send(JSON.stringify(code ? { id: request.id, ok: false, error: { code, message: 'Demo refusal' } } : { id: request.id, ok: true, result }))
    })
  }))
  await new Promise<void>(resolve => server.listen(socket, resolve)); await chmod(socket, 0o600)
  await writeFile(socket.replace('.sock', '.json'), JSON.stringify({ home, pid: process.pid, startedAt: 1, hostVersion: 'demo', protocolVersion: 1 }), { mode: 0o600 })
  t.after(async () => { for (const ws of sockets.clients) ws.terminate(); await new Promise<void>(resolve => sockets.close(() => server.close(() => resolve()))); await rm(directory, { recursive: true, force: true }) })
  return { directory, home, helloSeen, drop: () => first!.terminate(), send: (notification: object) => first!.send(JSON.stringify(notification)) }
}

test('stable watch consumes the independent raw queue while emitting only stable events', async t => {
  const r = await stub(t, 'incompatible')
  const core = new URL('../../../client/dist/src/index.js', import.meta.url).href
  const wrapper = join(r.directory, 'observed-client.mjs')
  const preload = join(r.directory, 'observe-notifications.mjs')
  // Observe reads of the real client's queue without replacing its transport or projections.
  await writeFile(wrapper, `
export * from ${JSON.stringify(core)}
import { connect as actualConnect } from ${JSON.stringify(core)}
export async function connect(options) {
  const client = await actualConnect(options)
  return {
    ...client,
    get hello() { return client.hello },
    async *notifications() {
      for await (const notification of client.notifications()) {
        process.send({ type: 'raw-consumed' })
        yield notification
      }
    },
  }
}
`)
  await writeFile(preload, `
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@harnessdesk/client' && context.parentURL.endsWith('/cli/dist/src/cli.js')) {
    return { url: new URL('./observed-client.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
} })
`)
  const child = launch(t, r.directory, r.home, ['watch', '--json'], undefined, preload)
  let consumed = 0
  const drained = new Promise<boolean>(resolve => {
    child.child.on('message', message => {
      if ((message as { type?: string }).type === 'raw-consumed' && ++consumed === 3) resolve(true)
    })
  })
  await child.until(lines => lines[0]?.type === 'hello')
  for (const state of ['open', 'claimed', 'done']) r.send({ method: 'team/changed', params: { state: {
    id: 'demo-team', intents: [{ id: 1, state, title: 'Synthetic snapshot', outcome: null }], members: [], channel: [],
  } } })
  await child.until(lines => lines.some(event => event.type === 'card.changed' && event.state === 'done'))
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2_000) })
  t.after(() => clearTimeout(timer!))
  assert.equal(await Promise.race([drained, deadline]), true, 'stable watch must consume all three delivered raw snapshots')
  assert.equal(consumed, 3)
  child.child.kill('SIGINT')
  assert.equal(await child.exit, 130, child.output().stderr)
  assert.equal(child.lines()[0].type, 'hello')
  assert.equal(child.lines().at(-1).type, 'end')
  assert.equal(child.lines().filter(event => event.type === 'card.changed').length, 3)
  assert.ok(child.lines().every(event => event.type && !event.method), 'normal watch must not print raw envelopes')
})

test('incompatible hello exits 6', async t => {
  const r = await stub(t)
  const child = launch(t, r.directory, r.home, ['status', '--json'])
  assert.equal(await child.exit, 6); assert.match(child.output().stderr, /incompatible/)
})

test('until settled also ends on a scripted stalled baseline', async t => {
  const r = await stub(t, undefined, 'stalled')
  const child = launch(t, r.directory, r.home, ['watch', '--json', '--run', 'demo-run', '--until', 'settled'])
  assert.equal(await child.exit, 0, child.output().stderr)
  assert.equal(child.lines()[0].type, 'hello')
  assert.ok(child.lines().some(e => e.type === 'run.changed' && e.state === 'stalled'))
  assert.equal(child.lines().at(-1).reason, 'until')
})

for (const [code, exit] of [['incompatible', 6], ['tierNotGranted', 4]] as const) test(`fatal reconnect ${code} retains error code after end`, async t => {
  const r = await stub(t, code)
  const child = launch(t, r.directory, r.home, ['watch', '--json'])
  await child.until(lines => lines[0]?.type === 'hello'); r.drop()
  assert.equal(await child.exit, exit, child.output().stderr)
  assert.equal(child.lines().at(-1).type, 'end'); assert.equal(child.lines().at(-1).reason, 'error')
})

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) test(`${signal} cancels a pending hello and writes only truthful end`, async t => {
  const r = await stub(t, undefined, undefined, true)
  const child = launch(t, r.directory, r.home, ['watch', '--json'])
  await r.helloSeen
  child.child.kill(signal)
  let timer: ReturnType<typeof setTimeout>
  const exit = await Promise.race([child.exit, new Promise<string>(resolve => { timer = setTimeout(() => resolve('still waiting on hello'), 1_000) })])
  clearTimeout(timer!)
  assert.equal(exit, code)
  assert.equal(child.lines().length, 1)
  assert.equal(child.lines()[0].type, 'end'); assert.equal(child.lines()[0].reason, 'interrupted')
  assert.equal(child.output().stderr, '')
})
