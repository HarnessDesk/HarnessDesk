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
/** The most `tools/list` pages one listing follows — a cursor that never ends is a refusal, not a loop. */
const MAX_LIST_PAGES = 16
/** One deadline for a whole listing, every page included — never one per page. */
const LIST_DEADLINE_MS = 30_000
/** How much of a server's stderr is kept to explain a failure: the tail, never all of it. */
const MAX_STDERR_CHARS = 8 * 1024
/** How long a server has to exit after SIGTERM before it is killed outright. */
const KILL_GRACE_MS = 2_000

export class McpTransportError extends Error {}

/**
 * The last `limit` characters of a stream and nothing more: a server that
 * floods stderr costs this desk a fixed amount of memory, however much it
 * writes, and the tail is what explains a crash.
 */
export class BoundedTail {
  #text = ''
  constructor(readonly limit: number) {}
  push(chunk: string): void {
    this.#text = (this.#text + chunk.slice(-this.limit)).slice(-this.limit)
  }
  text(): string {
    return this.#text
  }
}

export interface ExchangeOptions {
  /** Aborts the exchange and ends the server — SIGTERM, then SIGKILL after a grace period. */
  readonly signal?: AbortSignal
  /** The folder the server runs in: a host-owned one, never a repository a Seat happens to be working in. */
  readonly cwd?: string
  /** A listing's one overall deadline, in milliseconds. */
  readonly deadlineMs?: number
}

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
  options: ExchangeOptions = {},
): Promise<T> {
  if (spec.transport !== 'stdio' || !spec.command) {
    throw new McpTransportError(`${spec.name} is not a stdio server this gateway can reach yet.`)
  }
  // An exchange asked for after the desk began to quit starts nothing at all.
  if (options.signal?.aborted) throw new McpTransportError(`${spec.name} was aborted.`)
  const child = spawn(spec.command, [...(spec.args ?? [])], {
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    // No shell: argument arrays reach the executable exactly as given, the
    // same rule every other process this desk starts already follows.
  })

  const pending = new Map<number, PendingReply>()
  let nextId = 1
  let buffer = ''
  let closed = false
  const stderr = new BoundedTail(MAX_STDERR_CHARS)
  const running = (): boolean => child.exitCode === null && child.signalCode === null

  const cleanup = (): void => {
    if (closed) return
    closed = true
    child.stdout.removeAllListeners('data')
    child.stderr.removeAllListeners('data')
    child.stdin.destroy()
    if (!running()) return
    child.kill('SIGTERM')
    // A server that shrugs off SIGTERM is killed outright: an exchange never
    // leaves a process behind it, however the server was written.
    const escalate = setTimeout(() => {
      if (running()) child.kill('SIGKILL')
    }, KILL_GRACE_MS)
    child.once('exit', () => clearTimeout(escalate))
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
  // A server that exits early closes its pipe; its exit is what gets reported.
  child.stdin.on('error', () => {})
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')))
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
    if (!closed) child.stdin.write(frame)
  }

  const request: Requester = (method, params, timeoutMs) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(new McpTransportError(`${spec.name} was aborted.`))
        return
      }
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
      try {
        send(method, params, id)
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  try {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'harnessdesk', version: '0' } }, CONNECT_TIMEOUT_MS)
    send('notifications/initialized', {})
    return await exchange(request)
  } catch (error) {
    const tail = stderr.text().trim().slice(-500)
    if (error instanceof McpTransportError && tail) {
      throw new McpTransportError(`${error.message} (stderr: ${tail})`)
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
  options: ExchangeOptions = {},
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
  options: ExchangeOptions = {},
): Promise<readonly ListedMcpTool[]> {
  const deadlineMs = options.deadlineMs ?? LIST_DEADLINE_MS
  const deadline = Date.now() + deadlineMs
  const late = (): McpTransportError => new McpTransportError(`${spec.name} did not finish listing its tools within ${deadlineMs}ms.`)
  return withStdioMcpServer(
    spec,
    async (request) => {
      const tools: ListedMcpTool[] = []
      let totalSchemaBytes = 0
      let cursor: string | undefined
      const seen = new Set<string>()
      for (let pages = 1; ; pages += 1) {
        if (pages > MAX_LIST_PAGES) throw new McpTransportError(`${spec.name} listed its tools over more than ${MAX_LIST_PAGES} pages.`)
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw late()
        let page: unknown
        try {
          page = await request('tools/list', cursor !== undefined ? { cursor } : {}, remaining)
        } catch (error) {
          if (Date.now() >= deadline) throw late()
          throw error
        }
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
        // A cursor handed back twice is a loop, never progress.
        if (seen.has(cursor)) throw new McpTransportError(`${spec.name} repeated a page of its tool list.`)
        seen.add(cursor)
      }
      return tools
    },
    options,
  )
}
