import { spawn } from 'node:child_process'

import type { McpServerSpec } from '@harnessdesk/agent-inventory'

/**
 * The one real road out of the gateway: a single bounded MCP tool call over
 * stdio, spawned fresh and torn down after — never a standing process shared
 * across calls, and never a shell.
 *
 * This is deliberately the smallest thing that can be called a real
 * transport rather than a fake standing in for one: `initialize`, the
 * `notifications/initialized` MCP requires after it, one `tools/call`, and a
 * teardown that never leaves a child running. No resource discovery, no
 * sampling, no elicitation — those are a named remaining gap, not something
 * silently half-done here. HTTP/SSE servers are refused with their own
 * reason (`connectAttachmentServer` below), never attempted through this
 * function, which speaks stdio only.
 *
 * Called only from behind `McpToolGateway.call`'s own `invoke` callback,
 * which means every bound this function skips — approval, ceiling, caller
 * identity — was already checked before it was ever reached. This function
 * has no opinion about any of that; it is the dial-out, not the gate.
 */

const CONNECT_TIMEOUT_MS = 30_000
const CALL_TIMEOUT_MS = 45_000
const MAX_FRAME_BYTES = 64 * 1024

export class McpTransportError extends Error {}

interface PendingReply {
  readonly resolve: (value: { readonly result?: unknown; readonly error?: { readonly message?: string } }) => void
  readonly reject: (error: Error) => void
}

export async function callStdioMcpServer(
  spec: McpServerSpec,
  toolName: string,
  args: unknown,
  options: { readonly signal?: AbortSignal } = {},
): Promise<unknown> {
  if (spec.transport !== 'stdio' || !spec.command) {
    throw new McpTransportError(`${spec.name} is not a stdio server this gateway can reach yet.`)
  }
  const child = spawn(spec.command, [...(spec.args ?? [])], {
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    // No shell: argument arrays reach the executable exactly as given, the
    // same rule every other process this desk starts already follows.
  })

  const pending = new Map<number, PendingReply>()
  let nextId = 1
  let buffer = ''
  let closed = false
  let stderr = ''

  const cleanup = (): void => {
    if (closed) return
    closed = true
    child.stdout.removeAllListeners('data')
    child.stderr.removeAllListeners('data')
    if (!child.killed) child.kill('SIGTERM')
  }

  const failAll = (error: Error): void => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }

  child.on('error', (error) => failAll(new McpTransportError(`${spec.name} could not be started: ${error.message}`)))
  child.on('exit', (code) => {
    if (pending.size > 0) {
      failAll(new McpTransportError(`${spec.name} exited (code ${code ?? 'null'}) before answering.`))
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8').slice(0, MAX_FRAME_BYTES)
  })
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
      failAll(new McpTransportError(`${spec.name} sent a frame larger than ${MAX_FRAME_BYTES / 1024} KiB.`))
      cleanup()
      return
    }
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof message.id !== 'number') continue // a notification, or malformed: never matched to a waiter
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      waiter.resolve(message)
    }
  })

  const abortListener = (): void => {
    failAll(new McpTransportError(`${spec.name} was aborted.`))
    cleanup()
  }
  options.signal?.addEventListener('abort', abortListener, { once: true })

  const send = (method: string, params: unknown, id?: number): void => {
    const frame = `${JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params })}\n`
    if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) {
      throw new McpTransportError(`This call to ${spec.name} is larger than ${MAX_FRAME_BYTES / 1024} KiB.`)
    }
    child.stdin.write(frame)
  }

  const request = (method: string, params: unknown, timeoutMs: number): Promise<unknown> => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new McpTransportError(`${spec.name} did not answer ${method} within ${timeoutMs}ms.`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer)
          if (message.error) reject(new McpTransportError(message.error.message ?? `${spec.name} refused ${method}.`))
          else resolve(message.result)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      send(method, params, id)
    })
  }

  try {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'harnessdesk', version: '0' } }, CONNECT_TIMEOUT_MS)
    send('notifications/initialized', {})
    const result = await request('tools/call', { name: toolName, arguments: args }, CALL_TIMEOUT_MS)
    return result
  } catch (error) {
    if (error instanceof McpTransportError && stderr.trim()) {
      throw new McpTransportError(`${error.message} (stderr: ${stderr.trim().slice(0, 500)})`)
    }
    throw error
  } finally {
    options.signal?.removeEventListener('abort', abortListener)
    cleanup()
  }
}
