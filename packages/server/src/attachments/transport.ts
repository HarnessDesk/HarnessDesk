import { spawn } from 'node:child_process'

import type { McpServerSpec } from '@harnessdesk/agent-inventory'

/**
 * The one real road out of the gateway: a single bounded MCP exchange over
 * stdio, spawned fresh and torn down after — never a standing process shared
 * across calls, and never a shell.
 *
 * This is deliberately the smallest thing that can be called a real
 * transport rather than a fake standing in for one: `initialize`, the
 * `notifications/initialized` MCP requires after it, one further request —
 * `tools/call` for `callStdioMcpServer`, a bounded `tools/list` for
 * `listStdioMcpServerTools` — and a teardown that never leaves a child
 * running. No resource discovery, no sampling, no elicitation — those are a
 * named remaining gap, not something silently half-done here. HTTP/SSE
 * servers are refused with their own reason, never attempted through this
 * function, which speaks stdio only.
 *
 * `callStdioMcpServer` is called only from behind `McpToolGateway.call`'s own
 * `invoke` callback, and `listStdioMcpServerTools` only from behind
 * `McpToolGateway.list`'s own `listTools` callback — which means every bound
 * either function skips (approval, ceiling, caller identity) was already
 * checked before either was ever reached. Neither has any opinion about that;
 * this file is the dial-out, not the gate.
 */

const CONNECT_TIMEOUT_MS = 30_000
const CALL_TIMEOUT_MS = 45_000
const MAX_FRAME_BYTES = 64 * 1024
/** Task 4's own bound on live discovery: refuse rather than silently truncate a server offering more than this. */
const MAX_LISTED_TOOLS = 256
/** Combined `inputSchema` JSON size across everything one listing returns. */
const MAX_TOTAL_SCHEMA_BYTES = 128 * 1024

export class McpTransportError extends Error {}

/** One real tool a live listing described, shape-checked before anything downstream trusts it. */
export interface ListedMcpTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
}

interface PendingReply {
  readonly resolve: (value: { readonly result?: unknown; readonly error?: { readonly message?: string } }) => void
  readonly reject: (error: Error) => void
}

type Requester = (method: string, params: unknown, timeoutMs: number) => Promise<unknown>

/**
 * Spawns the child, wires the newline-delimited JSON-RPC framing every
 * exchange in this file shares, completes the one handshake MCP requires
 * (`initialize` then `notifications/initialized`), then hands the caller's
 * `exchange` callback a bound `request` for exactly the one further call this
 * transport permits. Teardown always runs, on success or failure alike, and a
 * failure anywhere in the handshake or the exchange gets the same stderr tail
 * appended that the original single-purpose version of this file always gave
 * a caller trying to tell "refused" apart from "crashed before it could say".
 */
async function withStdioMcpServer<T>(
  spec: McpServerSpec,
  exchange: (request: Requester) => Promise<T>,
  options: { readonly signal?: AbortSignal } = {},
): Promise<T> {
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

  const request: Requester = (method, params, timeoutMs) => {
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
    return await exchange(request)
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

export async function callStdioMcpServer(
  spec: McpServerSpec,
  toolName: string,
  args: unknown,
  options: { readonly signal?: AbortSignal } = {},
): Promise<unknown> {
  return withStdioMcpServer(spec, (request) => request('tools/call', { name: toolName, arguments: args }, CALL_TIMEOUT_MS), options)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const parseListedTool = (serverName: string, raw: unknown): ListedMcpTool => {
  if (!isRecord(raw) || typeof raw['name'] !== 'string' || raw['name'].trim() === '') {
    throw new McpTransportError(`${serverName} listed a tool with no usable name.`)
  }
  return {
    name: raw['name'],
    description: typeof raw['description'] === 'string' ? raw['description'] : '',
    inputSchema: 'inputSchema' in raw ? raw['inputSchema'] : { type: 'object' },
  }
}

/**
 * A live, bounded `tools/list` — the one round trip that lets an approved
 * server's real tools (names, descriptions, real input schemas) reach the
 * gateway at all, rather than the gateway ever inventing or guessing them.
 * Paginates through `nextCursor` itself so a caller sees one already-bounded
 * array; refuses outright, before returning anything, the moment a server's
 * count or combined schema size crosses Task 4's own limits — a partial,
 * silently truncated tool list would be worse than none, since a model could
 * act on a schema this gateway never actually validated as complete.
 */
export async function listStdioMcpServerTools(
  spec: McpServerSpec,
  options: { readonly signal?: AbortSignal } = {},
): Promise<readonly ListedMcpTool[]> {
  return withStdioMcpServer(
    spec,
    async (request) => {
      const tools: ListedMcpTool[] = []
      let totalSchemaBytes = 0
      let cursor: string | undefined
      for (;;) {
        const page = await request('tools/list', cursor !== undefined ? { cursor } : {}, CONNECT_TIMEOUT_MS)
        const rawTools = isRecord(page) && Array.isArray(page['tools']) ? page['tools'] : []
        for (const raw of rawTools) {
          const tool = parseListedTool(spec.name, raw)
          tools.push(tool)
          if (tools.length > MAX_LISTED_TOOLS) {
            throw new McpTransportError(`${spec.name} offered more than ${MAX_LISTED_TOOLS} tools.`)
          }
          totalSchemaBytes += Buffer.byteLength(JSON.stringify(tool.inputSchema ?? null), 'utf8')
          if (totalSchemaBytes > MAX_TOTAL_SCHEMA_BYTES) {
            throw new McpTransportError(`${spec.name}’s combined tool schema exceeds ${MAX_TOTAL_SCHEMA_BYTES / 1024} KiB.`)
          }
        }
        const next = isRecord(page) ? page['nextCursor'] : undefined
        cursor = typeof next === 'string' ? next : undefined
        if (cursor === undefined) break
      }
      return tools
    },
    options,
  )
}
