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

    // 2. Control test: normal tools/list succeeds when gateway answers
    onSocketData = (line) => {
      const msg = JSON.parse(line)
      if (msg.method === 'tools/list') {
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

    // The in-flight MCP call must resolve with an error immediately, NOT hang for 120s or hit our 5s test timeout
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
      if (msg.method === 'tools/list') {
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
