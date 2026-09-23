import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { SeatCeiling } from '@harnessdesk/protocol'
import type { McpServerSpec } from '@harnessdesk/agent-inventory'

import { CeilingGate, type CeilingGatePort, type Conversation } from '../src/ceilings/gate.js'
import { McpToolGateway, type GatewayCaller, type GatewayServer } from '../src/attachments/gate.js'
import { callStdioMcpServer, listStdioMcpServerTools, McpTransportError } from '../src/attachments/transport.js'

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
