import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { itemId, sessionId, CLIENT_METHODS, type FlowExecution, type FlowPreview, type GoalView } from '@harnessdesk/protocol'
const { openClientDoor } = await import(new URL('../../../server/dist/src/client-door.js', import.meta.url).href) as typeof import('../../server/src/client-door.js')
const { silent, start, stop } = await import(new URL('../../../server/dist/test/fixtures/harness.js', import.meta.url).href) as typeof import('../../server/test/fixtures/harness.js')
const { makeRepo } = await import(new URL('../../../server/dist/test/fixtures/evidence-desk.js', import.meta.url).href) as typeof import('../../server/test/fixtures/evidence-desk.js')

const flowRig = await import(new URL('../../../server/dist/test/fixtures/flow-host-evidence.js', import.meta.url).href) as typeof import('../../server/test/fixtures/flow-host-evidence.js')

const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url))
const launch = (t: TestContext, directory: string, home: string, args: readonly string[], cwd?: string, preload?: string, lifetimeMs = 15_000, pipeInput = false) => {
  const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), bin, ...args], { cwd, env: { ...process.env, HARNESSDESK_CLIENT_DIR: directory, HARNESSDESK_HOME: home }, stdio: preload ? [pipeInput ? 'pipe' : 'ignore', 'pipe', 'pipe', 'ipc'] : [pipeInput ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  const changed = new Set<() => void>()
  child.stdout!.on('data', chunk => { stdout += chunk.toString(); for (const wake of changed) wake() })
  child.stderr!.on('data', chunk => { stderr += chunk.toString() })
  const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  const timer = setTimeout(() => child.kill('SIGKILL'), lifetimeMs)
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
  const finished = launch(t, r.directory, r.home, ['status', '--json', '--team', r.run.goal])
  assert.equal(await finished.exit, 0, finished.output().stderr)
  assert.deepEqual(finished.lines()[0].runs, [], 'runs still lists only active Runs')
  assert.equal(finished.lines()[0].overviews[0].overview.run.run, r.run.id, "a settled Team keeps its newest Run's strip")
  assert.equal(finished.lines()[0].overviews[0].overview.run.state, 'settled')
  const finishedText = launch(t, r.directory, r.home, ['status', '--team', r.run.goal])
  assert.equal(await finishedText.exit, 0, finishedText.output().stderr)
  assert.match(finishedText.output().stdout, new RegExp(`${r.run.id}\\s+settled`))
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
  assert.deepEqual(calls.slice(0, 3), ['client/hello', 'client/subscribe', 'flow/execution'])
  assert.ok(calls.slice(3).every(method => method === 'finding/run'), 'watch adds only event-driven review reads')
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
  const stopped = launch(t, r.directory, r.home, ['status', '--json', '--team', r.run.goal])
  assert.equal(await stopped.exit, 0, stopped.output().stderr)
  assert.equal(stopped.lines()[0].overviews[0].overview.run.run, r.run.id, "a stopped Team keeps its newest Run's strip")
  assert.equal(stopped.lines()[0].overviews[0].overview.run.state, 'stopped')
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
      const result = request.method === 'client/hello' ? { protocolVersion: 1, hostVersion: 'demo', desk: { home, pid: process.pid, startedAt: 1 }, tiers: ['read'], methods: Object.keys(CLIENT_METHODS), runtimes: [] } : request.method === 'client/subscribe' ? { baseline: 0 } : request.method === 'flow/execution' ? { id: request.params.run, goal: 'demo-team', document: { flow: { name: 'Demo', roles: [] } }, state: terminalState, rounds: [], reason: 'Synthetic stall' } : null
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


test('built watch streams real synthetic Seat activity and review publication without polling', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp('/tmp/hd-door-'); await chmod(directory, 0o700)
  const d = await flowRig.desk(t)
  const door = await openClientDoor({ host: d.host, logger: silent, home: d.stateDir, directory, hostVersion: '9.9.9' })
  assert.ok(door)
  t.after(async () => { await door.close(); await rm(directory, { recursive: true, force: true }) })
  const run = await flowRig.start(d, await flowRig.shipped(d, 'independent-review'), flowRig.TASK)
  const build = (await flowRig.claimed(d, run.goal, 'build', 1))[0]!
  let producedInvalidations = 0
  const detach = d.host.addBroadcaster(notification => {
    if (notification.method === 'finding/changed' && notification.params.goal === run.goal) producedInvalidations++
  })
  t.after(detach)
  const child = launch(t, directory, d.stateDir, ['watch', '--json', '--run', run.id, '--trace-wire'], undefined, undefined, 45_000)
  await child.until(lines => lines.some(e => e.type === 'seat.changed' && e.card === build.id && e.state === 'working'))
  await flowRig.write(d, build, 'Synthetic CLI proof')
  const reviewers = await flowRig.claimed(d, run.goal, 'specialists', 3)
  for (const card of reviewers) await flowRig.review(d, card, 'approve')
  await child.until(lines => lines.some(e => e.type === 'review.changed' && e.state === 'local' && e.cards.includes(reviewers[0]!.id)))
  const calls = () => child.output().stderr.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(e => e.direction === 'send').map(e => e.message.method)
  await flowRig.person(d, run.goal, 'ship', 'shipped')
  await flowRig.settled(d, run.id)
  await child.until(lines => lines.some(e => e.type === 'run.changed' && e.state === 'settled'))
  // Wait for durable round-close processing before measuring the quiet desk.
  await d.host.flowsPlane.flush()
  const trace = () => child.output().stderr.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const drainedDeadline = Date.now() + 15_000
  for (;;) {
    const frames = trace(), requests = frames.filter(f => f.direction === 'send')
    const answered = new Set(frames.filter(f => f.direction === 'receive' && f.message.id !== undefined).map(f => f.message.id))
    const delivered = frames.filter(f => f.direction === 'receive' && f.message.method === 'finding/changed').length
    if (delivered === producedInvalidations && requests.every(f => answered.has(f.message.id))) break
    assert.ok(Date.now() < drainedDeadline, 'event-triggered reads must finish before quiet measurement')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  let invalidated = true, invalidations = 0, reviewReads = 0
  for (const frame of trace()) {
    if (frame.direction === 'receive' && frame.message.method === 'finding/changed') { invalidated = true; invalidations++ }
    if (frame.direction === 'send' && frame.message.method === 'finding/run') {
      assert.ok(invalidated, 'each review read needs the initial baseline or a discrete finding invalidation')
      invalidated = false; reviewReads++
    }
  }
  assert.ok(reviewReads <= invalidations + 1)
  const before = calls()
  await new Promise(resolve => setTimeout(resolve, 2_700))
  assert.deepEqual(calls(), before, 'a quiet desk makes no periodic reads')
  assert.deepEqual(before.slice(0, 3), ['client/hello', 'client/subscribe', 'flow/execution'])
  assert.ok(before.includes('finding/run'))
  assert.ok(before.every(method => ['client/hello', 'client/subscribe', 'flow/execution', 'finding/run'].includes(method)), JSON.stringify(before))
  child.child.kill('SIGINT'); assert.equal(await child.exit, 130, child.output().stderr)
  const events = child.lines()
  assert.equal(events[0].type, 'hello'); assert.equal(events.at(-1).type, 'end')
  const seat = events.find(e => e.type === 'seat.changed' && e.card === build.id)
  const review = events.find(e => e.type === 'review.changed' && e.state === 'local' && e.cards.includes(reviewers[0]!.id))
  assert.equal(seat.team, run.goal); assert.ok(seat.since !== undefined); assert.deepEqual(seat.doing, { kind: 'thinking' })
  assert.equal(review.run, run.id); assert.deepEqual(review.cards, reviewers.map(c => c.id)); assert.equal(review.pr, null)
  const human = launch(t, directory, d.stateDir, ['watch', '--run', run.id])
  // Human output is intentionally text, so await bytes rather than the launcher's JSON parser.
  const humanDeadline = Date.now() + 8_000
  while (!human.output().stdout.includes('review.changed') || !human.output().stdout.includes('seat.changed')) {
    assert.ok(Date.now() < humanDeadline, human.output().stdout + human.output().stderr)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  human.child.kill('SIGINT'); assert.equal(await human.exit, 130)
  if (process.env['HD_TASK5_PROOF_DIR']) {
    const proof = process.env['HD_TASK5_PROOF_DIR']
    await mkdir(proof, { recursive: true })
    await writeFile(join(proof, 'watch-events.ndjson'), child.output().stdout)
    await writeFile(join(proof, 'watch-wire.ndjson'), child.output().stderr)
    await writeFile(join(proof, 'watch-human.txt'), human.output().stdout)
    await writeFile(join(proof, 'examples.json'), JSON.stringify({ seat, review, calls: before, producedInvalidations, invalidations, reviewReads, quietMs: 2700 }, null, 2) + '\n')
    t.diagnostic(`CLI proof artifacts: ${proof}`)
  }
  t.diagnostic(`Real desk proof: ${JSON.stringify({ seat, review, calls: before, producedInvalidations, invalidations, reviewReads, quietMs: 2700 })}`)
})

test('status uses the shared overview on an isolated desk with a working tool and no polling', { timeout: 60_000 }, async t => {
  const d = await flowRig.desk(t)
  const turns = new Map<string, import('@harnessdesk/protocol').TurnId>()
  for (const runtime of d.runtimes) t.after(runtime.subscribe(event => {
    if (event.type === 'turn/started') turns.set(`${runtime.info.id}:${event.sessionId}`, event.turn.id)
  }))
  const run = await flowRig.start(d, await flowRig.shipped(d, 'independent-review'), flowRig.TASK)
  const cards = await flowRig.claimed(d, run.goal, 'build', 1)
  const view = await d.host.call('goal/read', { goal: run.goal }) as GoalView
  const seat = view.members.find(one => one.session.runtime === cards[0]!.claim!.runtime && one.session.sessionId === cards[0]!.claim!.sessionId)!
  assert.ok(seat)
  const turnId = turns.get(`${seat.session.runtime}:${seat.session.sessionId}`)!
  assert.ok(turnId)
  d.runtimes.find(one => one.info.id === seat.session.runtime)!.emit({
    type: 'item/started', sessionId: sessionId(seat.session.sessionId), turnId,
    item: { id: itemId('status-read'), type: 'toolCall', tool: 'Read', args: { path: 'src/demo.ts' }, status: 'inProgress', source: { kind: 'builtin' } },
  })
  const idle = await d.host.call('goal/create', { root: d.root, sentence: 'An idle Team' }) as GoalView
  const directory = await mkdtemp('/tmp/hd-door-')
  const door = await openClientDoor({ host: d.host, logger: silent, home: d.stateDir, directory, hostVersion: '9.9.9' })
  assert.ok(door)
  t.after(async () => { await door.close(); await rm(directory, { recursive: true, force: true }) })
  const json = launch(t, directory, d.stateDir, ['status', '--json', '--trace-wire'])
  assert.equal(await json.exit, 0, json.output().stderr)
  const value = json.lines()[0]
  assert.equal(value.hello.hostVersion, '9.9.9')
  assert.equal(value.runs[0].id, run.id)
  assert.equal(value.runs[0].team, run.goal)
  assert.equal(value.runs[0].flow, run.document.flow.name)
  assert.equal(value.runs[0].document, undefined, 'runs keep their summary shape')
  assert.equal(value.overviews.length, 1, 'only Teams with active runs are shown by default')
  assert.equal(value.overviews[0].team, run.goal)
  const overview = value.overviews[0].overview
  assert.equal(overview.run.run, run.id)
  assert.equal(overview.run.state, 'running')
  assert.equal(overview.run.role, 'build')
  assert.equal(overview.run.round, 1)
  assert.ok(overview.run.reviewRounds)
  assert.ok(overview.run.total)
  const row = overview.seats.find((one: any) => one.seat === seat.id)
  assert.equal(row.state, 'working')
  assert.equal(row.role, 'build')
  assert.equal(row.card.id, cards[0]!.id)
  assert.match(row.doing, /src\/demo\.ts/)
  assert.equal(typeof row.since, 'number')
  const sent = json.output().stderr.trim().split('\n').map(line => JSON.parse(line)).filter(e => e.direction === 'send')
  assert.deepEqual(sent.map(e => e.message.method), ['client/hello', 'client/subscribe', 'insight/goal'])
  assert.deepEqual(sent[1].message.params.topics, ['runs', 'cards', 'teams', 'seats', 'waiting'])
  const human = launch(t, directory, d.stateDir, ['status'])
  assert.equal(await human.exit, 0, human.output().stderr)
  assert.match(human.output().stdout, /9\.9\.9/)
  assert.ok(human.output().stdout.includes(run.id))
  assert.match(human.output().stdout, /round 1.*build/)
  assert.match(human.output().stdout, /reviews \d+ of \d+.*cost/)
  assert.match(human.output().stdout, /src\/demo\.ts.*since (now|\d+[smhd] ago)/)
  const scoped = launch(t, directory, d.stateDir, ['status', '--team', idle.goal.id, '--json'])
  assert.equal(await scoped.exit, 0, scoped.output().stderr)
  assert.deepEqual(scoped.lines()[0].runs, [])
  assert.deepEqual(scoped.lines()[0].overviews, [{ team: idle.goal.id, overview: { run: null, needsYou: [], seats: [] } }])
  const proof = process.env['HD_STATUS_PROOF_DIR']
  if (proof) {
    await mkdir(proof, { recursive: true })
    await writeFile(join(proof, 'status.txt'), human.output().stdout)
    await writeFile(join(proof, 'status.json'), json.output().stdout)
    await writeFile(join(proof, 'status-wire.jsonl'), json.output().stderr)
  }
  t.diagnostic(`status proof: run strip + working Read seat; wire hello → subscribe → insight/goal; idle --team included`)
})


test('built flow CLI opens and previews caller files without spending, and starts from a bound token', { timeout: 30_000 }, async t => {
  const r = await rig(t)
  const path = join(r.directory, 'demo.yaml'), brief = join(r.directory, 'brief.md')
  await writeFile(path, 'version: 2\nname: CLI start\ninputs: { brief: { default: "" }, title: { default: "" } }\nroles:\n  ship: { kind: person, outcomes: [shipped] }\nseed: { role: ship, title: Ship it }\n')
  await writeFile(brief, 'Read the synthetic brief.\n')
  const opened = launch(t, r.directory, r.home, ['open', '.', '--json'], r.repo.dir)
  assert.equal(await opened.exit, 0, opened.output().stderr)
  assert.equal(opened.lines()[0].path, await realpath(r.repo.dir))
  const flows = launch(t, r.directory, r.home, ['flows', '--project', r.repo.dir, '--json'])
  assert.equal(await flows.exit, 0, flows.output().stderr)
  assert.ok(Array.isArray(flows.lines()[0].flows))
  const before = await r.h.host.call('goal/list', {})
  const preview = launch(t, r.directory, r.home, ['flow', 'preview', path, '--brief-file', brief, '--title', 'Demo', '--json'], r.repo.dir)
  assert.equal(await preview.exit, 0, preview.output().stderr)
  assert.ok(preview.lines()[0].token)
  assert.equal((await r.h.host.call('goal/list', {})).length, before.length)
  const noConsent = launch(t, r.directory, r.home, ['flow', 'start', path], r.repo.dir)
  assert.equal(await noConsent.exit, 2, noConsent.output().stderr)
  const started = launch(t, r.directory, r.home, ['flow', 'start', path, '--brief-file', brief, '--title', 'Demo', '--yes', '--json'], r.repo.dir)
  assert.equal(await started.exit, 0, started.output().stderr)
  assert.equal(started.lines().length, 1)
  assert.deepEqual(Object.keys(started.lines()[0]).sort(), ['run', 'team'])
  const run = await r.h.host.call('flow/execution', { run: started.lines()[0].run })
  assert.equal(run.attended, true)
  assert.equal(run.brief, 'Read the synthetic brief.\n')
  assert.equal((await r.h.host.call('goal/read', { goal: run.goal })).goal.sentence, 'Demo')
  await writeFile(join(r.repo.dir, 'no-brief.yaml'), 'version: 2\nname: No brief\nroles:\n  ship: { kind: person, outcomes: [shipped] }\nseed: { role: ship, title: Ship }\n')
  const badBrief = launch(t, r.directory, r.home, ['flow', 'preview', 'no-brief.yaml', '--brief-file', brief], r.repo.dir)
  assert.equal(await badBrief.exit, 2, badBrief.output().stderr)
  assert.match(badBrief.output().stderr, /declares/)
})


test('warning-only previews can be displayed and started while errors and missing tokens are refused', { timeout: 30_000 }, async t => {
  const r = await rig(t)
  await r.repo.git('remote', 'add', 'origin', r.repo.dir)
  const path = join(r.directory, 'remote-base.yaml')
  const source = 'version: 2\nname: Remote base\nbase: { remote: origin, branch: main }\nroles:\n  ship: { kind: person, outcomes: [shipped] }\nseed: { role: ship, title: Ship }\n'
  await writeFile(path, source)
  const frozen = await r.h.host.call('flow/preview', { root: r.repo.dir, source })
  assert.ok(frozen.token)
  assert.ok(frozen.problems.some(problem => problem.level === 'warning'))
  assert.ok(frozen.problems.every(problem => problem.level === 'warning'))
  await t.test('preview exits successfully and retains the warning', async () => {
    const preview = launch(t, r.directory, r.home, ['flow', 'preview', path, '--json'], r.repo.dir)
    assert.equal(await preview.exit, 0, preview.output().stderr)
    assert.ok(preview.lines()[0].problems.some((problem: { level: string }) => problem.level === 'warning'))
  })
  await t.test('start redeems the token and keeps warnings on stderr in JSON mode', async () => {
    const started = launch(t, r.directory, r.home, ['flow', 'start', path, '--yes', '--json'], r.repo.dir)
    assert.equal(await started.exit, 0, started.output().stderr)
    assert.equal(started.lines().length, 1)
    assert.deepEqual(Object.keys(started.lines()[0]).sort(), ['run', 'team'])
    assert.match(started.output().stderr, /At Start, fetch remote/)
  })
  for (const command of ['preview', 'start']) {
    const invalid = launch(t, r.directory, r.home, ['flow', command, path, '--seat', 'missing=fake', ...(command === 'start' ? ['--yes'] : [])], r.repo.dir)
    assert.equal(await invalid.exit, 4, invalid.output().stderr)
    assert.match(invalid.output().stdout, /There is no role/)
  }
  await writeFile(path, 'name: Legacy\nroles:\n  ship: { seats: [fake], prompt: Ship }\nseed: { role: ship, title: Ship }\n')
  const missing = launch(t, r.directory, r.home, ['flow', 'start', path, '--yes'], r.repo.dir)
  assert.equal(await missing.exit, 4, missing.output().stderr)
})

test('run show preserves the execution and wait distinguishes person, settled, stopped and timeout without polling', { timeout: 30_000 }, async t => {
  const r = await rig(t)
  const show = launch(t, r.directory, r.home, ['run', 'show', r.run.id, '--json'])
  assert.equal(await show.exit, 0, show.output().stderr)
  assert.deepEqual(show.lines()[0], await r.h.host.call('flow/execution', { run: r.run.id }))
  const person = launch(t, r.directory, r.home, ['run', 'wait', r.run.id, '--json', '--trace-wire'])
  assert.equal(await person.exit, 5, person.output().stderr)
  assert.equal(person.lines()[0].state, 'running')
  await r.complete()
  const settled = launch(t, r.directory, r.home, ['run', 'wait', r.run.id, '--json', '--trace-wire'])
  assert.equal(await settled.exit, 0, settled.output().stderr)
  assert.equal(settled.lines()[0].state, 'settled')
  const calls = settled.output().stderr.trim().split('\n').map(line => JSON.parse(line)).filter(e => e.direction === 'send')
  assert.deepEqual(calls.map(e => e.message.method), ['client/hello', 'client/subscribe', 'flow/execution'])
  assert.deepEqual(calls[1].message.params.scope, { run: r.run.id })
  const timeout = launch(t, r.directory, r.home, ['run', 'wait', r.run.id, '--timeout', '0', '--json'])
  assert.equal(await timeout.exit, 8, timeout.output().stderr)
  const r2 = await rig(t)
  await r2.h.host.flowsPlane.stopRun(r2.run.id, 'Synthetic stop')
  const stopped = launch(t, r2.directory, r2.home, ['run', 'wait', r2.run.id, '--json'])
  assert.equal(await stopped.exit, 7, stopped.output().stderr)
  assert.equal(stopped.lines()[0].reason, 'Synthetic stop')
})

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  test(`run wait cancels a pending hello on ${signal}`, async t => {
    const r = await stub(t, undefined, undefined, true)
    const child = launch(t, r.directory, r.home, ['run', 'wait', 'demo', '--json'])
    await Promise.race([r.helloSeen, child.exit.then(code => assert.fail(child.output().stderr + String(code)))])
    child.child.kill(signal)
    assert.equal(await child.exit, code, child.output().stderr)
  })
}

test('CLI preview → overridden cards → settled, and unattended question → stalled on an isolated fake desk', { timeout: 60_000 }, async t => {
  const live = new Map<number, { fire: () => void; ms: number }>()
  let next = 0
  const d = await flowRig.desk(t, undefined, { questionTimers: {
    setTimer: (fire, ms) => { live.set(++next, { fire, ms }); return next },
    clearTimer: timer => { live.delete(timer as number) },
  } })
  const { HoldFake } = await import(new URL('../../../server/dist/test/fixtures/hold-runtime.js', import.meta.url).href) as typeof import('../../server/test/fixtures/hold-runtime.js')
  const holding = new HoldFake('held'); d.host.register(holding); await holding.start()
  const directory = await mkdtemp('/tmp/hd-door-')
  const door = await openClientDoor({ host: d.host, logger: silent, home: d.stateDir, directory, hostVersion: '9.9.9' })
  assert.ok(door)
  t.after(async () => { await door.close(); await rm(directory, { recursive: true, force: true }) })
  const path = join(directory, 'work.yaml'), brief = join(directory, 'brief.md')
  const source = `version: 2
name: CLI run proof
inputs: { brief: { default: "" }, title: { default: "" } }
roles:
  writer: { kind: agent, uses: implementer }
  gate: { kind: check, run: "true", exits: { "0": pass }, otherwise: fail }
seed: { role: writer, title: "{{title}}" }
rules:
  - { id: check, on: writer, then: { role: gate, title: Check } }
`
  await writeFile(path, source); await writeFile(brief, 'Read the synthetic brief.\n')
  const flags = ['--project', d.root, '--seat', 'writer=held', '--title', 'CLI proof', '--brief-file', brief]
  const opened = launch(t, directory, d.stateDir, ['open', d.root]); assert.equal(await opened.exit, 0, opened.output().stderr)
  const catalogue = launch(t, directory, d.stateDir, ['flows', '--project', d.root]); assert.equal(await catalogue.exit, 0, catalogue.output().stderr)
  const count = holding.sessions.size
  const preview = launch(t, directory, d.stateDir, ['flow', 'preview', path, ...flags])
  assert.equal(await preview.exit, 0, preview.output().stderr)
  assert.match(preview.output().stdout, /writer.*override.*held.*file:/)
  assert.match(preview.output().stdout, /held/); assert.match(preview.output().stdout, /check.*gate.*true/)
  assert.equal(holding.sessions.size, count, 'preview opens no session')
  const unknownRole = launch(t, directory, d.stateDir, ['flow', 'preview', path, '--project', d.root, '--seat', '__proto__=held'])
  assert.equal(await unknownRole.exit, 4, unknownRole.output().stderr)
  assert.match(unknownRole.output().stdout, /There is no role/)
  const start = launch(t, directory, d.stateDir, ['flow', 'start', path, ...flags, '--yes', '--json'])
  assert.equal(await start.exit, 0, start.output().stderr)
  assert.equal(start.lines().length, 1)
  const run = start.lines()[0]; d.runs.push(run.run)
  const [card] = await flowRig.claimed(d, run.team, 'writer', 1)
  assert.equal(card!.claim!.runtime, 'held')
  const shown = launch(t, directory, d.stateDir, ['run', 'show', run.run, '--json'])
  assert.equal(await shown.exit, 0, shown.output().stderr)
  assert.deepEqual(shown.lines()[0].overrides, { writer: [{ runtime: 'held' }] })
  // The run scope includes every Seat on this Team. An extra Seat's question
  // must not decide the target Run's outcome, even in the starting baseline.
  const extra = await d.host.call('goal/seat', { goal: run.team, agent: 'implementer', seats: [{ runtime: 'held' }], grant: { kind: 'ceiling', level: 'edit' } })
  assert.ok(!(await d.host.call('flow/execution', { run: run.run })).rounds.some(round => round.seats.includes(extra.id)))
  void holding.sessions.get(extra.session.sessionId)!.askQuestion('extra-question' as never, 'A separate task?', [{ id: 'yes', label: 'Yes' }])
  await flowRig.whenChanged(d, () => d.host.pendingApprovalEvents().some(one => one.method === 'event' && one.params.event.type === 'approval/requested' && one.params.event.approval.id === 'extra-question') ? true : null, 'the unrelated question')
  const waiting = launch(t, directory, d.stateDir, ['run', 'wait', run.run, '--json', '--trace-wire'])
  // Let the handshake's baseline land before completing the real card.
  const baselineDeadline = Date.now() + 8_000
  while (!waiting.output().stderr.includes('flow/execution-changed')) {
    assert.ok(Date.now() < baselineDeadline, waiting.output().stderr)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  void holding.sessions.get(extra.session.sessionId)!.askQuestion('extra-live-question' as never, 'Another separate task?', [{ id: 'yes', label: 'Yes' }])
  while (!waiting.output().stderr.includes('extra-live-question')) {
    assert.ok(Date.now() < baselineDeadline, waiting.output().stderr)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await flowRig.write(d, card!, 'CLI proof')
  assert.equal(await waiting.exit, 0, waiting.output().stderr)
  assert.equal(waiting.lines()[0].state, 'settled')
  const calls = waiting.output().stderr.trim().split('\n').map(line => JSON.parse(line)).filter(one => one.direction === 'send')
  assert.deepEqual(calls.map(one => one.message.method), ['client/hello', 'client/subscribe', 'flow/execution'])
  const unattended = launch(t, directory, d.stateDir, ['flow', 'start', path, ...flags, '--unattended', '--yes', '--json'])
  assert.equal(await unattended.exit, 0, unattended.output().stderr)
  const second = unattended.lines()[0]; d.runs.push(second.run)
  const [questionCard] = await flowRig.claimed(d, second.team, 'writer', 1)
  const session = holding.sessions.get(questionCard!.claim!.sessionId)!
  void session.askQuestion('cli-question' as never, 'Which base?', [{ id: 'main', label: 'main' }])
  await flowRig.whenChanged(d, () => live.size === 1 ? true : null, 'the unattended deadline')
  assert.equal([...live.values()][0]!.ms, 300_000)
  const question = launch(t, directory, d.stateDir, ['run', 'wait', second.run, '--json'])
  assert.equal(await question.exit, 5, question.output().stderr)
  assert.equal(question.lines()[0].reason, 'waiting for an answer')
  const due = [...live.values()]; live.clear(); due.forEach(one => one.fire())
  await flowRig.whenChanged(d, () => d.host.flowsPlane.executionOf(second.run)?.state === 'stalled' ? true : null, 'the question stall')
  const stopped = launch(t, directory, d.stateDir, ['run', 'wait', second.run, '--json'])
  assert.equal(await stopped.exit, 7, stopped.output().stderr)
  assert.match(stopped.lines()[0].reason, /asked a question/)
  const marker = join(directory, 'seat-marker.mjs')
  await writeFile(marker, "process.env.HARNESSDESK_GOAL_ID = 'demo-team'\n")
  const ownSeat = launch(t, directory, d.stateDir, ['flow', 'start', path, ...flags, '--yes', '--json'], undefined, marker)
  assert.equal(await ownSeat.exit, 4, ownSeat.output().stderr)
  assert.match(ownSeat.output().stderr, /refused:.*own Seats/)
  const noConsent = launch(t, directory, d.stateDir, ['flow', 'start', path, ...flags])
  assert.equal(await noConsent.exit, 2, noConsent.output().stderr)
  const bound = await d.host.call('flow/preview', { root: d.root, source, seats: { writer: [{ runtime: 'held' }] } })
  assert.ok(bound.token)
  await assert.rejects(d.host.call('flow/start-goal', { root: d.root, source, seats: { writer: [{ runtime: 'fake' }] }, token: bound.token!, sentence: 'Mismatch' }), /changed/)
  const proof = process.env['HD_FLOW_START_PROOF_DIR']
  if (proof) {
    await mkdir(proof, { recursive: true })
    await writeFile(join(proof, 'preview.txt'), preview.output().stdout)
    await writeFile(join(proof, 'show.json'), shown.output().stdout)
    await writeFile(join(proof, 'wait-wire.jsonl'), waiting.output().stderr)
    await writeFile(join(proof, 'outcomes.json'), JSON.stringify({ start: run, settled: waiting.lines()[0], unattended: stopped.lines()[0], noConsent: 2, mismatch: 'refused' }, null, 2) + '\n')
  }
  t.diagnostic('Built CLI: opened → catalogue → no-spend override preview → started → overridden card → ignored unrelated baseline/live questions → settled (0); own question (5) → unattended stall (7); no consent (2); mismatched token refused. Wait trace: hello, subscribe, execution only.')
})


test('stdin briefs preserve UTF-8 characters split across pipe reads', { timeout: 30_000 }, async t => {
  const r = await rig(t)
  const path = join(r.directory, 'stdin.yaml'), preload = join(r.directory, 'observe-stdin.mjs')
  await writeFile(path, 'version: 2\nname: Stdin\ninputs: { brief: { default: "" } }\nroles:\n  ship: { kind: person, outcomes: [shipped] }\nseed: { role: ship, title: Ship }\n')
  await writeFile(preload, `
const original = process.stdin[Symbol.asyncIterator].bind(process.stdin)
process.stdin[Symbol.asyncIterator] = async function* () {
  process.send({ type: 'ready' })
  for await (const chunk of original()) { yield chunk; process.send({ type: 'consumed' }) }
}
`)
  const text = 'Brief:\n東京 — synthetic text.\n', bytes = Buffer.from(text)
  const split = Buffer.byteLength('Brief:\n') + 1
  const child = launch(t, r.directory, r.home, ['flow', 'start', path, '--brief-file', '-', '--yes', '--json'], r.repo.dir, preload, 15_000, true)
  child.child.on('message', message => {
    const type = (message as { type: string }).type
    if (type === 'ready') child.child.stdin!.write(bytes.subarray(0, split))
    if (type === 'consumed' && !child.child.stdin!.writableEnded) child.child.stdin!.end(bytes.subarray(split))
  })
  assert.equal(await child.exit, 0, child.output().stderr)
  const run = await r.h.host.call('flow/execution', { run: child.lines()[0].run })
  assert.equal(run.brief, text)
})


test('a terminal whose brief consumed stdin to EOF requires explicit consent', { timeout: 30_000 }, async t => {
  const r = await rig(t)
  const path = join(r.directory, 'eof.yaml'), preload = join(r.directory, 'terminal-stdin.mjs')
  await writeFile(path, 'version: 2\nname: EOF\ninputs: { brief: { default: "" } }\nroles:\n  ship: { kind: person, outcomes: [shipped] }\nseed: { role: ship, title: Ship }\n')
  await writeFile(preload, "Object.defineProperty(process.stdin, 'isTTY', { value: true })\n")
  const child = launch(t, r.directory, r.home, ['flow', 'start', path, '--brief-file', '-', '--json'], r.repo.dir, preload, 15_000, true)
  child.child.stdin!.end('Synthetic brief.\n')
  assert.equal(await child.exit, 2, child.output().stderr)
  assert.match(child.output().stderr, /requires --yes/)
})
