import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { SeatCeiling } from '@harnessdesk/protocol'
import type { McpServerSpec } from '@harnessdesk/agent-inventory'

import { CeilingGate, type CeilingGatePort, type Conversation } from '../src/ceilings/gate.js'
import { McpToolGateway, type GatewayCaller, type GatewayServer } from '../src/attachments/gate.js'
import { BoundedTail, callStdioMcpServer, listStdioMcpServerTools, McpTransportError } from '../src/attachments/transport.js'

/**
 * The real transport road, not the in-process fakes Task 3's own gate tests
 * use: an actual child process, spoken to over actual pipes, that only ever
 * runs when the gate — a real `CeilingGate`, not a stand-in for one — has
 * already admitted the call. `FAKE_MCP_MARKER` is the one thing a mocked
 * `invoke` could never prove: that the process itself, not merely the gate's
 * bookkeeping, actually ran.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))

const specFor = (marker: string): McpServerSpec => ({
  name: 'reviewer-tools',
  transport: 'stdio',
  command: process.execPath,
  args: [FIXTURE],
  env: { FAKE_MCP_MARKER: marker },
})

/** A minimal, real `CeilingGatePort` — the same one `attachments-gate.test.ts` uses. */
class FakePort implements CeilingGatePort {
  readonly ceilings = new Map<string, SeatCeiling>()
  rootOf(runtime: string, session: string): Conversation | null {
    return { runtime, sessionId: session }
  }
  ceilingOf(runtime: string, session: string): SeatCeiling | null {
    return this.ceilings.get(`${runtime}:${session}`) ?? null
  }
  causeOf(): ReturnType<CeilingGatePort['causeOf']> {
    return { kind: 'person' }
  }
  nameOf(): string {
    return 'Receiver'
  }
  say(): void {}
  async askPerson(): Promise<'allowed' | 'refused' | 'unanswered'> {
    return 'refused'
  }
}

const server = (overrides: Partial<GatewayServer> = {}): GatewayServer => ({
  seat: 'seat-1',
  identity: { kind: 'mcp', name: 'reviewer-tools', digest: 'digest-a', source: 'library', pathLabel: '~/reviewer-tools' },
  endpoint: 'mcp:reviewer-tools:digest-a',
  ceiling: 'merge',
  ...overrides,
})

test('an approved call reaches the real process — the marker proves it, not just the gate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-mcp-real-'))
  const marker = join(dir, 'marker.ndjson')
  const spec = specFor(marker)
  try {
    const port = new FakePort()
    port.ceilings.set('claude:one', { level: 'merge', hold: 'held' })
    const gate = new CeilingGate(port)
    const gateway = new McpToolGateway({
      serversFor: () => [server()],
      callerOf: () => ({ seat: 'seat-1', runtime: 'claude', sessionId: 'one' }) satisfies GatewayCaller,
      admit: (call) => gate.admit(call),
    })

    const result = await gateway.call('token', 'reviewer-tools', 'flag_issue', (gatewayServer) =>
      callStdioMcpServer(spec, 'flag_issue', { line: 12, server: gatewayServer.identity.name }),
    )
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.result, { content: [{ type: 'text', text: 'flagged' }], isError: false })

    const written = await readFile(marker, 'utf8')
    assert.deepEqual(JSON.parse(written.trim()), { line: 12, server: 'reviewer-tools' }, 'the real process actually ran, with the real arguments')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a denied call never dials out: no marker, because the process is never even started', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-mcp-real-'))
  const marker = join(dir, 'marker.ndjson')
  const spec = specFor(marker)
  try {
    const port = new FakePort()
    port.ceilings.set('claude:one', { level: 'read', hold: 'held' }) // below merge
    const gate = new CeilingGate(port)
    let dialedOut = false
    const gateway = new McpToolGateway({
      serversFor: () => [server()],
      callerOf: () => ({ seat: 'seat-1', runtime: 'claude', sessionId: 'one' }) satisfies GatewayCaller,
      admit: (call) => gate.admit(call),
    })

    const result = await gateway.call('token', 'reviewer-tools', 'flag_issue', async (gatewayServer) => {
      dialedOut = true // would only run if the gate had admitted the call
      return callStdioMcpServer(spec, 'flag_issue', { line: 1 })
    })
    assert.equal(result.ok, false)
    assert.equal(dialedOut, false, 'a read Seat below merge must never reach the invoke callback at all')

    const existsAfter = await readFile(marker, 'utf8').then(
      () => true,
      () => false,
    )
    assert.equal(existsAfter, false, 'no marker: the real child process was never spawned for a refused call')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unknown tool name is refused by the real process itself, not silently accepted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-mcp-real-'))
  const marker = join(dir, 'marker.ndjson')
  const spec = specFor(marker)
  try {
    await assert.rejects(callStdioMcpServer(spec, 'not_a_real_tool', {}), McpTransportError)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a real tools/list reaches the process and comes back bounded, not invented', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-mcp-real-'))
  const marker = join(dir, 'marker.ndjson')
  const spec = specFor(marker)
  try {
    const tools = await listStdioMcpServerTools(spec)
    assert.deepEqual(tools, [
      { name: 'flag_issue', description: 'Flag a line for review.', inputSchema: { type: 'object', properties: { line: { type: 'number' } }, required: ['line'] } },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a server offering more tools than the bound is refused outright, not truncated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-mcp-real-'))
  const marker = join(dir, 'marker.ndjson')
  const spec: McpServerSpec = { name: 'reviewer-tools', transport: 'stdio', command: process.execPath, args: [FIXTURE], env: { FAKE_MCP_MARKER: marker, FAKE_MCP_TOOL_COUNT: '257' } }
  try {
    await assert.rejects(listStdioMcpServerTools(spec), /more than 256 tools/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('close aborts an in-flight call and leaves no process waiting on an answer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-mcp-real-'))
  const marker = join(dir, 'marker.ndjson')
  // A command that starts, but never speaks MCP at all — stands in for a
  // blocked/hung server. `sleep` accepts no stdio protocol, so the transport's
  // own `initialize` request will sit unanswered until the abort fires.
  const spec: McpServerSpec = { name: 'blocked-server', transport: 'stdio', command: 'sleep', args: ['30'] }
  const controller = new AbortController()
  const call = callStdioMcpServer(spec, 'flag_issue', {}, { signal: controller.signal })
  // Give the process a moment to actually spawn before aborting it.
  await new Promise((resolve) => setTimeout(resolve, 100))
  controller.abort()
  await assert.rejects(call, McpTransportError)
  await rm(dir, { recursive: true, force: true })
})

const fixtureSpec = (env: Record<string, string>): McpServerSpec => ({ name: 'misbehaving', transport: 'stdio', command: process.execPath, args: [FIXTURE], env })

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('pagination is bounded: empty pages that always name another cursor stop at the page bound, fast', async () => {
  const started = Date.now()
  await assert.rejects(listStdioMcpServerTools(fixtureSpec({ FAKE_MCP_EMPTY_PAGES: '1' })), /more than \d+ pages/)
  assert.ok(Date.now() - started < 5000, 'refused within the bound, not after a timeout')
})

test('a listing has one deadline for all its pages, not one per page', async () => {
  await assert.rejects(
    listStdioMcpServerTools(fixtureSpec({ FAKE_MCP_PAGE_DELAY_MS: '150' }), { deadlineMs: 500 }),
    /did not finish listing its tools within/,
  )
})

test('stderr is capped: a server that floods it cannot grow the desk, and the reason stays short', async () => {
  const flood = new BoundedTail(8 * 1024)
  for (let index = 0; index < 100; index += 1) flood.push('x'.repeat(64 * 1024))
  assert.ok(flood.text().length <= 8 * 1024, 'the kept text never exceeds its bound, however much arrives')

  const error = await callStdioMcpServer(fixtureSpec({ FAKE_MCP_STDERR_BYTES: String(4 * 1024 * 1024) }), 'flag_issue', {}).then(
    () => null,
    (caught: unknown) => caught as Error,
  )
  assert.ok(error instanceof McpTransportError)
  assert.ok(error.message.length < 1024, `the reason names the tail of stderr, not all of it (${error.message.length} chars)`)
})

test('an abort escalates to SIGKILL: a server that ignores SIGTERM does not outlive the call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-mcp-kill-'))
  const pidFile = join(dir, 'pid')
  const controller = new AbortController()
  const call = callStdioMcpServer(fixtureSpec({ FAKE_MCP_IGNORE_TERM: '1', FAKE_MCP_HANG_CALL: '1', FAKE_MCP_PID_FILE: pidFile }), 'flag_issue', {}, { signal: controller.signal })
  for (let tries = 0; tries < 50; tries += 1) {
    if (await readFile(pidFile, 'utf8').catch(() => '')) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const pid = Number(await readFile(pidFile, 'utf8'))
  assert.ok(alive(pid))
  await new Promise((resolve) => setTimeout(resolve, 150))
  const aborted = Date.now()
  controller.abort()
  await assert.rejects(call, /aborted/)
  assert.ok(Date.now() - aborted < 1000, 'the call itself ends at once')
  for (let tries = 0; tries < 60 && alive(pid); tries += 1) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(alive(pid), false, 'the server that shrugged off SIGTERM was killed')
  await rm(dir, { recursive: true, force: true })
})

test('an already-aborted signal starts nothing at all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-mcp-preabort-'))
  const pidFile = join(dir, 'pid')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(callStdioMcpServer(fixtureSpec({ FAKE_MCP_PID_FILE: pidFile }), 'flag_issue', {}, { signal: controller.signal }), /aborted/)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(await readFile(pidFile, 'utf8').catch(() => null), null, 'no process was started')
  await rm(dir, { recursive: true, force: true })
})

test('a server runs in the folder it is given, never wherever the desk happened to start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-mcp-cwd-'))
  const spec: McpServerSpec = { name: 'where', transport: 'stdio', command: process.execPath, args: ['-e', "require('fs').writeFileSync('cwd.txt', process.cwd()); process.exit(1)"] }
  await assert.rejects(callStdioMcpServer(spec, 'x', {}, { cwd: dir }))
  assert.equal(await realpath(await readFile(join(dir, 'cwd.txt'), 'utf8')), await realpath(dir))
  await rm(dir, { recursive: true, force: true })
})
