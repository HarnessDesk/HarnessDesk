/**
 * `harnessdesk mcp` against a real host, over its own stdio: the handshake,
 * the tool list, reads, the start gate the host keeps (off, on, the daily
 * number, a refund, an edited Flow), answering a card, a desk that goes away
 * and comes back, a long wait's progress, cancellation and timeout, and the
 * guard that keeps a desk's own Seat from starting work through it.
 *
 * Every desk here is a scripted fake: no vendor, credential or network.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { FlowExecution, GoalView, McpStartsView } from '@harnessdesk/protocol'
import { cleanEnv, initialize, LOADED_MACHINE_MS, mcpServer } from './mcp-server.js'
import { MCP_EXCLUDED, toolsOf } from '../src/mcp-tools.js'
import { MCP_VERSIONS } from '../src/mcp.js'
import { COMMANDS } from '../src/cli.js'
const { openClientDoor } = await import(new URL('../../../server/dist/src/client-door.js', import.meta.url).href) as typeof import('../../server/src/client-door.js')
const { silent, start, stop } = await import(new URL('../../../server/dist/test/fixtures/harness.js', import.meta.url).href) as typeof import('../../server/test/fixtures/harness.js')
const { makeRepo } = await import(new URL('../../../server/dist/test/fixtures/evidence-desk.js', import.meta.url).href) as typeof import('../../server/test/fixtures/evidence-desk.js')
const flowRig = await import(new URL('../../../server/dist/test/fixtures/flow-host-evidence.js', import.meta.url).href) as typeof import('../../server/test/fixtures/flow-host-evidence.js')

const REAL_HOST_TEST_MS = 4 * LOADED_MACHINE_MS
const CLIENT = 'example-client@1.0.0'
/** A Flow saved in the project, so the catalogue holds it: one person step. */
const SAVED = 'version: 2\nname: MCP proof\nroles:\n  ship: { kind: person, outcomes: [shipped] }\nseed: { role: ship, title: Ship it }\n'

/** A desk with its client door, in a private directory, and a project holding one saved Flow. */
const personDesk = async (t: TestContext) => {
  const directory = await mkdtemp('/tmp/hd-mcp-')
  await chmod(directory, 0o700)
  const home = join(directory, 'home'); await mkdir(home)
  const repo = await makeRepo('hd-mcp-project-')
  await mkdir(join(repo.dir, '.harnessdesk', 'flows'), { recursive: true })
  await writeFile(join(repo.dir, '.harnessdesk', 'flows', 'mcp-proof.yml'), SAVED)
  const up = async () => {
    const h = await start({ catalogRefreshMs: 0 }, home)
    const door = await openClientDoor({ host: h.host, logger: silent, home, directory, hostVersion: '9.9.9' })
    assert.ok(door)
    await h.host.call('workspace/open', { path: repo.dir })
    let closed = false
    const down = async () => { if (closed) return; closed = true; await door.close(); await stop(h) }
    t.after(down)
    return { h, down }
  }
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return { directory, home, repo, up }
}

/** The desk's client audit entry a predicate names, read from its file as soon as the write lands. */
const clientAudit = async (home: string, predicate: (entry: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + LOADED_MACHINE_MS
  for (;;) {
    const lines = await readFile(join(home, 'audit.ndjson'), 'utf8').catch(() => '')
    const found = lines.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      .find(entry => entry['via'] === 'client' && entry['kind'] === 'client/call' && predicate(entry))
    if (found) return found
    assert.ok(Date.now() < deadline, `no such client audit entry: ${lines.split('\n').slice(-5).join('\n')}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const text = (result: any): string => result.content.map((one: { text: string }) => one.text).join('')

const starts = async (host: { call: (method: 'app/mcpStarts/get', params: Record<string, never>) => Promise<unknown> }) =>
  await host.call('app/mcpStarts/get', {}) as McpStartsView

test('initialize, tools, reads, the start gate with its daily number and refund, answers, and the seat guard', { timeout: 2 * REAL_HOST_TEST_MS }, async t => {
  const r = await personDesk(t)
  const { h } = await r.up()
  const env = { HARNESSDESK_CLIENT_DIR: r.directory, HARNESSDESK_HOME: r.home }
  const server = mcpServer(t, env)

  const hello = await initialize(server)
  assert.deepEqual(hello.result, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'harnessdesk', version: '0.1.0' } })
  assert.equal((await server.request('resources/list')).error?.code, -32601)
  assert.deepEqual((await server.request('ping')).result, {})
  const unknown = await server.request('tools/call', { name: 'watch', arguments: {} })
  assert.equal(unknown.error?.code, -32602)
  assert.match(unknown.error!.message, /Unknown tool watch/)

  await t.test('tools/list is the generated table, nothing more', async () => {
    const listed = (await server.request('tools/list')).result.tools as { name: string; inputSchema: { additionalProperties: boolean } }[]
    assert.equal(listed.length, 19)
    assert.deepEqual(listed.map(tool => tool.name), toolsOf(COMMANDS).map(tool => tool.name))
    assert.ok(listed.every(tool => tool.inputSchema.additionalProperties === false))
    assert.ok(!listed.some(tool => Object.hasOwn(MCP_EXCLUDED, tool.name)))
  })

  await t.test('reads answer with their JSON as structured content', async () => {
    const status = await server.tool('status')
    assert.equal(status.isError, undefined, text(status))
    assert.ok(status.structuredContent && typeof status.structuredContent === 'object')
    assert.deepEqual(JSON.parse(text(status)), status.structuredContent)
    const flows = await server.tool('flows', { project: r.repo.dir })
    assert.equal(flows.isError, undefined, text(flows))
    assert.ok(JSON.stringify(flows.structuredContent).includes('mcp-proof'), 'the saved Flow is in the catalogue')
    const runs = await server.tool('runs')
    assert.equal(runs.isError, undefined, text(runs))
    assert.ok(Array.isArray(runs.structuredContent.runs))
  })

  const offAt = Date.now()
  await t.test('starting work is off until the person turns it on, and the audit says the call came from MCP', async () => {
    const off = await server.tool('flow_start', { flow: 'mcp-proof', project: r.repo.dir, title: 'From an agent' })
    assert.equal(off.isError, true)
    assert.match(text(off), /^exit 4: mcpStartsOff: /)
    // Client calls are written to the desk's audit file, not the sessions' audit query; the write lands after the answer.
    const refused = await clientAudit(r.home, entry => entry['code'] === 'mcpStartsOff' && Number(entry['at']) >= offAt)
    assert.equal(refused['surface'], 'mcp')
    assert.equal(refused['client'], CLIENT)
    assert.equal((await starts(h.host)).started, 0)
  })

  let run!: FlowExecution
  await t.test('turned on, a start is counted and the run says who started it', async () => {
    const before = await starts(h.host)
    await h.host.call('app/mcpStarts/set', { revision: before.revision, mayStart: true, dailyStarts: 1 })
    const started = await server.tool('flow_start', { flow: 'mcp-proof', project: r.repo.dir, title: 'From an agent' })
    assert.equal(started.isError, undefined, text(started))
    assert.deepEqual(Object.keys(started.structuredContent).sort(), ['run', 'team'])
    const shown = await server.tool('run_show', { run: started.structuredContent.run })
    assert.equal(shown.isError, undefined, text(shown))
    assert.deepEqual(shown.structuredContent.startedBy, { via: 'mcp', client: CLIENT })
    run = await h.host.call('flow/execution', { run: started.structuredContent.run }) as FlowExecution
    assert.deepEqual(run.startedBy, { via: 'mcp', client: CLIENT })
    assert.equal(run.attended, true, 'a start from MCP is always attended')
    assert.equal((await starts(h.host)).started, 1)
  })

  await t.test('past the daily number, starts are refused', async () => {
    const capped = await server.tool('flow_start', { flow: 'mcp-proof', project: r.repo.dir })
    assert.equal(capped.isError, true)
    assert.match(text(capped), /^exit 4: mcpDailyCap: /)
    assert.equal((await starts(h.host)).started, 1)
  })

  await t.test('an edited copy of a Flow is refused, and the refused start gives its slot back', async () => {
    const before = await starts(h.host)
    await h.host.call('app/mcpStarts/set', { revision: before.revision, dailyStarts: 2 })
    const edited = join(r.directory, 'edited.yml')
    await writeFile(edited, SAVED.replace('name: MCP proof', 'name: Edited proof'))
    const refused = await server.tool('flow_start', { flow: edited, project: r.repo.dir })
    assert.equal(refused.isError, true)
    assert.match(text(refused), /^exit 4: mcpUnsavedFlow: /)
    const after = await starts(h.host)
    assert.equal(after.started, 1, 'the refused start was refunded')
    assert.equal(after.remaining, 1)
  })

  await t.test('answering is its own grant, and the channel names the MCP client', async () => {
    const card = (await h.host.call('goal/read', { goal: run.goal }) as GoalView).board.intents[0]!
    const off = await server.tool('card_answer', { team: run.goal, card: String(card.id), outcome: 'shipped' })
    assert.equal(off.isError, true)
    assert.match(text(off), /^exit 4: tierNotGranted: /)
    await h.host.call('app/state/set', { patch: { clientsMayAnswer: true } })
    const answered = await server.tool('card_answer', { team: run.goal, card: String(card.id), outcome: 'shipped' })
    assert.equal(answered.isError, undefined, text(answered))
    const channel = JSON.stringify(await h.host.call('team/state', { room: run.goal }))
    assert.ok(channel.includes(`answered from an MCP client (${CLIENT})`), channel)
  })

  await t.test('a version this server does not speak is answered with the latest one it does, never echoed', async () => {
    for (const requested of ['2999-01-01', '2025-06-19', 'latest', '']) {
      const other = mcpServer(t, env)
      assert.equal((await initialize(other, requested)).result.protocolVersion, MCP_VERSIONS[0], requested)
      // The results follow the version agreed, not the string the client sent.
      const status = await other.tool('status')
      assert.equal(status.isError, undefined, text(status))
      assert.ok(status.structuredContent, `structured content for ${requested}, answered as ${MCP_VERSIONS[0]}`)
    }
    const latest = mcpServer(t, env)
    assert.equal((await initialize(latest, '2025-11-25')).result.protocolVersion, '2025-11-25')
    // 2025-03-26 is spoken, and predates structured content: a string comparison would get it right too, but 2999 would not.
    const march = mcpServer(t, env)
    assert.equal((await initialize(march, '2025-03-26')).result.protocolVersion, '2025-03-26')
    assert.equal((await march.tool('status')).structuredContent, undefined)
  })

  await t.test('an older protocol gets its text without structured content', async () => {
    const older = mcpServer(t, env)
    assert.equal((await initialize(older, '2024-11-05')).result.protocolVersion, '2024-11-05', 'a version this server speaks is the one agreed')
    const status = await older.tool('status')
    assert.equal(status.isError, undefined, text(status))
    assert.equal(status.structuredContent, undefined)
    assert.ok(JSON.parse(text(status)))
  })

  await t.test("a desk's own Seat may read through it but never start work", async () => {
    const seat = mcpServer(t, { ...env, HARNESSDESK_GOAL_ID: 'x' })
    await initialize(seat)
    const status = await seat.tool('status')
    assert.equal(status.isError, undefined, text(status))
    const refused = await seat.tool('flow_start', { flow: 'mcp-proof', project: r.repo.dir })
    assert.equal(refused.isError, true)
    assert.match(text(refused), /^exit 4: refused: .*Seats/)
    assert.equal((await starts(h.host)).started, 1)
  })

  await t.test('a value that reads as a flag is refused before it reaches the command', async () => {
    const flag = await server.tool('run_show', { run: '--json' })
    assert.equal(flag.isError, true)
    assert.match(text(flag), /^exit 2: Usage: /)
    const long = await server.tool('run_wait', { run: run.id, timeout: 3601 })
    assert.equal(long.isError, true)
    assert.match(text(long), /^exit 2: Usage: timeout is a whole number of seconds from 1 to 3600/)
    // The number a client sends as a string is held to the same cap, not read past it.
    const spelled = await server.tool('run_wait', { run: run.id, timeout: '7200' })
    assert.equal(spelled.isError, true)
    assert.match(text(spelled), /^exit 2: Usage: timeout is a whole number of seconds from 1 to 3600/)
  })
})

test('a desk that goes away is said plainly, and the next call finds the new one without a restart', { timeout: REAL_HOST_TEST_MS }, async t => {
  const r = await personDesk(t)
  const first = await r.up()
  const server = mcpServer(t, { HARNESSDESK_CLIENT_DIR: r.directory, HARNESSDESK_HOME: r.home })
  await initialize(server)
  const up = await server.tool('status')
  assert.equal(up.isError, undefined, text(up))
  await first.down()
  const gone = await server.tool('status')
  assert.equal(gone.isError, true)
  assert.match(text(gone), /^exit 3: noDesk: /)
  await r.up()
  const back = await server.tool('status')
  assert.equal(back.isError, undefined, text(back))
})

test('run_wait reports progress, can be cancelled, and ends on its timeout as an answer', { timeout: REAL_HOST_TEST_MS }, async t => {
  const directory = await mkdtemp('/tmp/hd-mcp-'); await chmod(directory, 0o700)
  const d = await flowRig.desk(t)
  const door = await openClientDoor({ host: d.host, logger: silent, home: d.stateDir, directory, hostVersion: '9.9.9' })
  assert.ok(door)
  t.after(async () => { await door.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  // A researcher holds its card and does nothing: the run stays running, with no person to wait on.
  const run = await flowRig.start(d, await flowRig.shipped(d, 'investigation'), { question: 'Where does the time go?' })
  await flowRig.claimed(d, run.goal, 'research', 1)
  const server = mcpServer(t, { HARNESSDESK_CLIENT_DIR: directory, HARNESSDESK_HOME: d.stateDir })
  await initialize(server)

  const id = server.nextId()
  server.send({ id, method: 'tools/call', params: { name: 'run_wait', arguments: { run: run.id }, _meta: { progressToken: 'wait-1' } } })
  const progress = await server.waitFor(message => message.method === 'notifications/progress' && message.params?.progressToken === 'wait-1', 'progress')
  assert.equal(progress.params.total, 600, 'a wait with no timeout waits the MCP default')
  assert.match(progress.params.message, /running/)
  server.send({ method: 'notifications/cancelled', params: { requestId: id, reason: 'The person moved on' } })
  await new Promise(resolve => setTimeout(resolve, 2_000))
  assert.ok(!server.messages.some(message => message.id === id), 'a cancelled call gets no answer')
  assert.deepEqual((await server.request('ping')).result, {}, 'the server still answers after a cancel')

  const timedOut = await server.tool('run_wait', { run: run.id, timeout: 1 })
  assert.equal(timedOut.isError, undefined, text(timedOut))
  assert.equal(timedOut.structuredContent.exit, 8)
  assert.equal(timedOut.structuredContent.ended, 'timeout')
  assert.equal(timedOut.structuredContent.state, 'running')
  assert.equal((await d.host.call('flow/execution', { run: run.id }) as FlowExecution).state, 'running', 'waiting changes nothing')
})

test('a run_wait outlives a graceful desk restart: it reconnects to the desk found again and keeps waiting to its deadline', { timeout: REAL_HOST_TEST_MS }, async t => {
  const directory = await mkdtemp('/tmp/hd-mcp-'); await chmod(directory, 0o700)
  const d = await flowRig.desk(t)
  const doors: { close(): Promise<void> }[] = []
  const openDoor = async () => {
    const door = await openClientDoor({ host: d.host, logger: silent, home: d.stateDir, directory, hostVersion: '9.9.9' })
    assert.ok(door); doors.push(door)
    return door
  }
  t.after(async () => { for (const door of doors) await door.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const first = await openDoor()
  const run = await flowRig.start(d, await flowRig.shipped(d, 'investigation'), { question: 'Where does the time go?' })
  await flowRig.claimed(d, run.goal, 'research', 1)
  const server = mcpServer(t, { HARNESSDESK_CLIENT_DIR: directory, HARNESSDESK_HOME: d.stateDir })
  await initialize(server)

  const id = server.nextId()
  server.send({ id, method: 'tools/call', params: { name: 'run_wait', arguments: { run: run.id, timeout: 20 }, _meta: { progressToken: 'restart-1' } } })
  await server.waitFor(message => message.method === 'notifications/progress' && message.params?.progressToken === 'restart-1', 'progress before the restart')
  // The desk closes the way a quit does: it tells every client it is closing, then goes.
  await first.close()
  await new Promise(resolve => setTimeout(resolve, 1_500))
  assert.ok(!server.messages.some(message => message.id === id), 'the wait is not answered while the desk is away')
  const reopenedAt = Date.now()
  await openDoor()
  await clientAudit(d.stateDir, entry => entry['method'] === 'client/subscribe' && Number(entry['at']) >= reopenedAt)
  const answer = await server.waitFor(message => message.id === id, 'the wait\'s answer')
  const result = answer.result
  assert.equal(result.isError, undefined, text(result))
  assert.equal(result.structuredContent.exit, 8, text(result))
  assert.equal(result.structuredContent.ended, 'timeout')
  assert.equal(result.structuredContent.state, 'running', 'the wait read the run again from the desk it reconnected to')
})

test('the same handshake and refusal rule as the desk\'s own tools server', async t => {
  // The agents' tools bridge is the framing this server mirrors. It comes up
  // without a desk; only its calls need the gateway socket.
  const main = fileURLToPath(new URL('../../../mcp-tools/dist/src/main.js', import.meta.url))
  const child = spawn(process.execPath, [main], { env: cleanEnv({ HD_TOOLS_SOCKET: join('/tmp', `hd-mcp-absent-${process.pid}.sock`) }), stdio: ['pipe', 'pipe', 'pipe'] })
  const exit = new Promise(resolve => child.once('close', resolve))
  t.after(async () => { child.stdin.end(); const kill = setTimeout(() => child.kill('SIGKILL'), 5_000); await exit; clearTimeout(kill) })
  let out = ''
  const answers = new Promise<any[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mcp-tools did not answer: ${out}`)), LOADED_MACHINE_MS)
    child.stdout.on('data', chunk => {
      out += chunk.toString()
      const lines = out.split('\n').filter(Boolean).map(line => JSON.parse(line))
      if (lines.length >= 2) { clearTimeout(timer); resolve(lines) }
    })
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'example-client', version: '1.0.0' } } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} })}\n`)
  const [hello, refused] = (await answers).sort((a, b) => a.id - b.id)
  const server = mcpServer(t, {})
  const ours = await initialize(server)
  const oursRefused = await server.request('resources/list')
  assert.equal(hello.result.protocolVersion, ours.result.protocolVersion)
  assert.deepEqual(hello.result.capabilities, ours.result.capabilities)
  assert.deepEqual(hello.result.serverInfo, ours.result.serverInfo)
  assert.equal(refused.error.code, oursRefused.error?.code)
  assert.equal(refused.error.message, oursRefused.error?.message)
})
