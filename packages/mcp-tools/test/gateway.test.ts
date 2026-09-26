import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const MAIN = fileURLToPath(new URL('../src/main.js', import.meta.url))

test('in-flight gateway calls reject immediately when gateway socket cleanly disconnects', async () => {
  const sockPath = join(tmpdir(), `hdt-${randomUUID().slice(0, 8)}.sock`)
  if (existsSync(sockPath)) unlinkSync(sockPath)

  let serverClientSocket: Socket | null = null
  let onSocketData: ((data: string) => void) | null = null

  const server = createServer((sock) => {
    serverClientSocket = sock
    let buf = ''
    sock.on('data', (chunk) => {
      buf += chunk.toString()
      for (;;) {
        const newline = buf.indexOf('\n')
        if (newline === -1) break
        const line = buf.slice(0, newline)
        buf = buf.slice(newline + 1)
        onSocketData?.(line)
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(sockPath, resolve))

  const proc = spawn(process.execPath, [MAIN], {
    env: {
      ...process.env,
      HD_TOOLS_SOCKET: sockPath,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  })

  const rl = createInterface({ input: proc.stdout })
  const pendingResponses = new Map<number, (res: { id?: number; result?: unknown; error?: { code?: number; message?: string } }) => void>()

  rl.on('line', (line) => {
    if (!line.trim()) return
    try {
      const parsed = JSON.parse(line)
      if (typeof parsed.id === 'number') {
        const handler = pendingResponses.get(parsed.id)
        if (handler) {
          pendingResponses.delete(parsed.id)
          handler(parsed)
        }
      }
    } catch {
      // ignore
    }
  })

  const sendMcp = (req: { id: number; method: string; params?: Record<string, unknown> }) => {
    return new Promise<{ id?: number; result?: unknown; error?: { code?: number; message?: string } }>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingResponses.delete(req.id)
        reject(new Error(`MCP request ${req.id} timed out`))
      }, 5000)
      pendingResponses.set(req.id, (res) => {
        clearTimeout(timer)
        resolve(res)
      })
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...req }) + '\n')
    })
  }

  try {
    // 1. Initialize handshake
    onSocketData = (line) => {
      const msg = JSON.parse(line)
      if (msg.method === 'server/info') {
        serverClientSocket?.write(JSON.stringify({ id: msg.id, result: { instructions: 'ready' } }) + '\n')
      }
    }
    const initRes = await sendMcp({ id: 1, method: 'initialize', params: {} })
    assert.equal((initRes.result as { serverInfo?: { name?: string } })?.serverInfo?.name, 'harnessdesk')

    // 2. Control test: normal tools/list succeeds when gateway answers.
    // `main.js`'s own tools/list now also asks the gateway's mcp/list (a
    // Seat's approved external servers), in parallel — this fake gateway
    // answers both, exactly as the real one always does even when phase 12
    // has nothing to offer (an empty list, never silence).
    onSocketData = (line) => {
      const msg = JSON.parse(line)
      if (msg.method === 'tools/list' || msg.method === 'mcp/list') {
        serverClientSocket?.write(JSON.stringify({ id: msg.id, result: { tools: [] } }) + '\n')
      }
    }
    const controlRes = await sendMcp({ id: 2, method: 'tools/list' })
    assert.deepEqual(controlRes.result, { tools: [] }, 'control: tools/list succeeds when gateway is healthy')

    // 3. Defect test: clean disconnect while tools/list is in flight
    const disconnectPromise = new Promise<void>((resolve) => {
      onSocketData = (_line) => {
        // Clean close without error
        serverClientSocket?.end()
        resolve()
      }
    })

    const inFlightMcp = sendMcp({ id: 3, method: 'tools/list' })
    await disconnectPromise

    // The in-flight MCP call must resolve with an error immediately, NOT hang for 300s or hit our 5s test timeout
    const errorRes = await inFlightMcp
    assert.ok(errorRes.error, 'clean disconnect must reject in-flight request')
    assert.match(
      errorRes.error.message ?? '',
      /disconnected|not reachable/i,
      'error message must indicate disconnect',
    )

    // 4. Recovery: subsequent call re-establishes socket connection
    onSocketData = (line) => {
      const msg = JSON.parse(line)
      if (msg.method === 'tools/list' || msg.method === 'mcp/list') {
        serverClientSocket?.write(JSON.stringify({ id: msg.id, result: { tools: [] } }) + '\n')
      }
    }
    const recoveryRes = await sendMcp({ id: 4, method: 'tools/list' })
    assert.deepEqual(recoveryRes.result, { tools: [] }, 'recovery: subsequent request reconnects and succeeds')
  } finally {
    proc.kill()
    server.close()
    if (existsSync(sockPath)) unlinkSync(sockPath)
  }
})

/**
 * Phase 12's own live-use gap: a Seat's approved external MCP servers were
 * reachable from the renderer's own `mcp/list`/`mcp/call` wire calls, but
 * never from the one place an actual running agent asks for tools — this
 * bridge's own `tools/list`/`tools/call`. Proven end to end against the real
 * `main.js` binary, exactly as `gateway.on('data', ...)` above did for the
 * desk's own plugin tools.
 */
test('an external MCP server’s tools are merged into tools/list, and a call for one routes to mcp/call, never tools/invoke', async () => {
  const sockPath = join(tmpdir(), `hdt-${randomUUID().slice(0, 8)}.sock`)
  if (existsSync(sockPath)) unlinkSync(sockPath)

  const gatewayCalls: { readonly method: string; readonly params: unknown }[] = []
  let mcpCallCount = 0
  const server = createServer((sock) => {
    let buf = ''
    sock.on('data', (chunk) => {
      buf += chunk.toString()
      for (;;) {
        const newline = buf.indexOf('\n')
        if (newline === -1) break
        const line = buf.slice(0, newline)
        buf = buf.slice(newline + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        gatewayCalls.push({ method: msg.method, params: msg.params })
        const reply = (result: unknown) => sock.write(`${JSON.stringify({ id: msg.id, result })}\n`)
        if (msg.method === 'server/info') reply({ instructions: '' })
        else if (msg.method === 'tools/list') reply({ tools: [] }) // no plugin tools in this test
        else if (msg.method === 'mcp/list') {
          reply({
            tools: [{ name: 'flag_issue', server: 'reviewer-tools', description: 'Flag a line for review.', inputSchema: { type: 'object' } }],
          })
        } else if (msg.method === 'mcp/call') {
          mcpCallCount += 1
          const params = msg.params as { server: string; tool: string; args: unknown }
          // The gate's own refusal is a real possibility on any given call
          // (ceiling, expired caller, hidden name) independent of the tool
          // name itself — the second call stands in for one, so both real
          // outcomes of `mcp/call` get proven against the one approved tool.
          const asKnownTool = params.server === 'reviewer-tools' && params.tool === 'flag_issue'
          if (asKnownTool && mcpCallCount === 1) {
            reply({ ok: true, result: { content: [{ type: 'text', text: 'flagged' }], isError: false } })
          } else {
            reply({ ok: false, reason: 'refused' })
          }
        }
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(sockPath, resolve))

  const proc = spawn(process.execPath, [MAIN], {
    env: { ...process.env, HD_TOOLS_SOCKET: sockPath },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const rl = createInterface({ input: proc.stdout })
  const pendingResponses = new Map<number, (res: { id?: number; result?: unknown; error?: { code?: number; message?: string } }) => void>()
  rl.on('line', (line) => {
    if (!line.trim()) return
    try {
      const parsed = JSON.parse(line)
      if (typeof parsed.id === 'number') {
        const handler = pendingResponses.get(parsed.id)
        if (handler) {
          pendingResponses.delete(parsed.id)
          handler(parsed)
        }
      }
    } catch {
      // ignore
    }
  })
  const sendMcp = (req: { id: number; method: string; params?: Record<string, unknown> }) =>
    new Promise<{ id?: number; result?: unknown; error?: { code?: number; message?: string } }>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingResponses.delete(req.id)
        reject(new Error(`MCP request ${req.id} timed out`))
      }, 5000)
      pendingResponses.set(req.id, (res) => {
        clearTimeout(timer)
        resolve(res)
      })
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...req }) + '\n')
    })

  try {
    await sendMcp({ id: 1, method: 'initialize', params: {} })

    const listed = await sendMcp({ id: 2, method: 'tools/list' })
    assert.deepEqual(
      (listed.result as { tools: unknown[] }).tools,
      [{ name: 'flag_issue', description: 'Flag a line for review.', inputSchema: { type: 'object' } }],
      'the external server’s own tool, with its real schema, reaches the agent’s own tools/list',
    )

    const called = await sendMcp({ id: 3, method: 'tools/call', params: { name: 'flag_issue', arguments: { line: 3 } } })
    assert.deepEqual(called.result, { content: [{ type: 'text', text: 'flagged' }], isError: false })
    const invokeCalls = gatewayCalls.filter((one) => one.method === 'tools/invoke')
    assert.deepEqual(invokeCalls, [], 'an external server’s tool must never be dispatched through the plugin verb')
    const mcpCall = gatewayCalls.find((one) => one.method === 'mcp/call')
    assert.deepEqual(mcpCall?.params, { server: 'reviewer-tools', tool: 'flag_issue', args: { line: 3 } })

    // A refusal at the real gateway (ceiling, expired caller, hidden name) is
    // reported to the agent as an ordinary tool error, not a protocol fault.
    gatewayCalls.length = 0
    const refused = await sendMcp({ id: 4, method: 'tools/call', params: { name: 'flag_issue', arguments: {} } })
    assert.deepEqual(refused.result, { content: [{ type: 'text', text: 'refused' }], isError: true })
  } finally {
    proc.kill()
    server.close()
    if (existsSync(sockPath)) unlinkSync(sockPath)
  }
})
