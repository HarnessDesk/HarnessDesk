import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mock } from 'node:test'

const { createDefaultHost } = await import(process.env.HD_BOOTSTRAP)
const root = process.env.HD_STATE
const ledger = process.env.FAKE_CODEX_MCP_CHILDREN
const realNow = Date.now.bind(Date)
const realTimeout = globalThis.setTimeout
let now = realNow()
Date.now = () => now
mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
const pause = () => new Promise((resolve) => realTimeout(resolve, 20))
const until = async (condition, what) => {
  const deadline = realNow() + 5_000
  while (!await condition()) {
    assert.ok(realNow() < deadline, what)
    await pause()
  }
}
const tick = async (ms = 1_000) => {
  now += ms
  mock.timers.tick(1_000)
  await pause()
}
const running = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const children = async () => (await readFile(ledger, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
await writeFile(ledger, '')
const { host, extensions, pathReady } = createDefaultHost({
  stateDir: root, codexHome: join(root, 'codex'), codexBinaryPath: process.env.HD_FAKE,
  console: false, logLevel: 'error',
})
const runtime = 'codex'
const health = async () => (await host.call('runtime/health', { runtime })).state
try {
  await pathReady
  await host.start()
  const repo = process.env.HD_REPO
  await host.call('workspace/open', { path: repo })
  const goal = await host.call('goal/create', { root: repo, sentence: 'Inspect resources' })
  const seats = []
  for (let n = 0; n < 4; n++) {
    const card = await host.call('team/add', { room: goal.goal.id, title: `Inspect ${n + 1}` })
    const session = await host.call('session/create', { runtime, options: { cwd: repo } })
    await host.call('goal/assign', { goal: goal.goal.id, card: card.id, session: { runtime, sessionId: session.id } })
    seats.push({ card, session, record: host.registry.get(runtime, session.id) })
  }
  const active = seats[3]
  await host.call('turn/send', { runtime, sessionId: active.session.id, input: [{ type: 'text', text: 'Keep working' }] })
  await until(() => active.record.running.size > 0, 'turn accepted')
  // Even a completed card cannot release a still-running turn.
  for (const seat of seats) await host.call('team/intent', { room: goal.goal.id, id: seat.card.id, action: 'done' })
  await tick()
  await tick(11 * 60_000)
  await until(() => seats.slice(0, 3).every((seat) => seat.record.live === null), 'finished seats release their handles')
  const firstChildren = await children()
  assert.equal(firstChildren.length, 4)
  assert.ok(firstChildren.every((child) => running(child.pid)), 'working seat keeps the shared runtime and its MCP child')
  assert.ok(active.record.live)
  assert.equal(await health(), 'ready')
  await host.call('turn/interrupt', { runtime, sessionId: active.session.id })
  await until(() => active.record.running.size === 0, 'working turn ended')
  await tick()
  await tick(11 * 60_000)
  await until(() => active.record.live === null, 'last finished seat released')
  await tick(11 * 60_000)
  await until(async () => await health() === 'idle' && firstChildren.every((child) => !running(child.pid)), 'all finished-seat children exit')
  const history = await host.call('session/list', { runtime, archived: 'exclude' })
  assert.ok(seats.every((seat) => history.data.some((row) => row.id === seat.session.id)))
  const models = await host.call('runtime/models', { runtime })
  assert.ok(models.length > 0)
  const account = await host.call('runtime/account', { runtime })
  assert.ok(account.accounts.length > 0, 'idle is still signed in')
  assert.equal(await health(), 'idle', 'history and catalogue reads do not start a runtime')
  assert.ok(history.nextCursor, 'the cached history has an unread page')
  const older = await host.call('session/list', { runtime, cursor: history.nextCursor })
  assert.ok(older.data.some((row) => row.id === 'thread-older'), 'an unread page is fetched instead of ending history')
  const rest = async () => { await tick(); await tick(11 * 60_000); await until(async () => await health() === 'idle', 'runtime rests after a fresh read') }
  await rest()
  const secondary = await host.call('session/list', { runtime, pageSize: 20 })
  assert.ok(secondary.data.some((row) => row.id === 'thread-2'), 'a new page size fetches real history')
  await rest()
  const defaults = await host.call('runtime/sessionDefaults', { runtime, cwd: join(repo, 'another-project') })
  assert.ok(defaults.some((option) => option.id === 'model'), 'an unseen project keeps its draft controls')
  await rest()
  const skills = await host.call('runtime/skills', { runtime, cwd: repo })
  assert.ok(skills.length > 0, 'unobserved skills are read instead of reported absent')
  await rest()
  await Promise.all(seats.slice(0, 2).map((seat) => host.call('session/resume', { runtime, sessionId: seat.session.id })))
  const reopened = await children()
  assert.equal(new Set(reopened.slice(4).map((child) => child.parent)).size, 1, 'concurrent resumes share one start')
  for (const seat of seats.slice(0, 2)) assert.equal(seat.record.live.id, seat.session.id)
  for (const seat of seats.slice(0, 2)) await host.call('session/close', { runtime, sessionId: seat.session.id })
  // The Flow door seats into the same production adapter and rests its Seat.
  await mkdir(join(root, 'agents', 'scout'), { recursive: true })
  await writeFile(join(root, 'agents', 'scout', 'AGENT.md'), '---\nname: Scout\nceiling: read\nprefer: [codex]\n---\nInspect.\n')
  const source = 'version: 2\nname: Inspect\nroles:\n  inspect: { kind: agent, uses: [scout], grant: read, independentOf: [] }\nseed: { role: inspect, title: Inspect }\nrules: []\n'
  const preview = await host.call('flow/preview', { root: repo, source })
  const run = await host.call('flow/start-goal', { root: repo, source, token: preview.token, sentence: 'Inspect once' })
  let flowView
  try {
    await until(async () => { flowView = await host.call('goal/read', { goal: run.goal }); return flowView.board.intents[0]?.state === 'claimed' }, 'Flow seat claimed')
  } catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify(await host.call('flow/execution', { run: run.id }))}`)
  }
  const card = flowView.board.intents[0]
  const record = host.registry.get(runtime, card.claim.sessionId)
  await until(() => record.running.size > 0, 'Flow turn accepted')
  const finishing = host.call('team/intent', { room: run.goal, id: card.id, action: 'done' })
  await until(() => host.teamPlane.stateFor(run.goal).intents[0]?.state === 'done', 'Flow card finished')
  await host.call('turn/interrupt', { runtime, sessionId: record.session.id })
  await finishing
  await until(() => record.running.size === 0, 'Flow turn ended')
  await tick()
  await tick(11 * 60_000)
  await until(() => record.live === null, 'Flow seat released')
  await tick(11 * 60_000)
  const allChildren = await children()
  await until(async () => await health() === 'idle' && allChildren.every((child) => !running(child.pid)), 'Flow resources released')
  assert.ok((await host.call('goal/read', { goal: run.goal })).members.some((seat) => seat.closed === null), 'rest preserves membership')
  // Each runtime-backed surface can be the first operation after idle stop.
  const hooks = await host.call('runtime/hooks', { runtime, cwd: repo })
  assert.ok(hooks.some((hook) => hook.id === 'guard-1'), 'hooks remain available after idle restart')
  await rest()
  const catalog = await host.call('runtime/catalog', { runtime, cwd: repo })
  assert.ok(catalog.plugins.length > 0, 'extensions restart before reading the catalogue')
  await rest()
  const mcp = await host.call('runtime/mcp/list', { runtime, cwd: repo })
  assert.ok(mcp.length > 0, 'configured tool servers can be read after idle stop')
  await rest()
  const file = await host.call('workspace/readFile', { runtime, path: join(repo, 'README.md') })
  assert.equal(file.kind, 'text', 'file reads restart before entering the runtime filesystem')
  await rest()
  const terminal = await host.call('terminal/open', { runtime, cwd: repo, size: { rows: 24, cols: 80 },
    command: [process.execPath, '-e', 'process.stdin.resume()'] })
  await tick()
  await tick(11 * 60_000)
  assert.equal(await health(), 'ready', 'the restarted terminal keeps the process alive')
  await host.call('terminal/close', { terminalId: terminal.terminalId })
  await rest()
} finally {
  mock.timers.reset()
  Date.now = realNow
  await host.dispose()
  await extensions.dispose()
}
