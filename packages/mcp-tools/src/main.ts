#!/usr/bin/env node
import { connect, type Socket } from 'node:net'
import { createInterface } from 'node:readline'

import { buildToolIndex, toMcpContent, type GatewayResult, type GatewayTool } from './content.js'

/**
 * HarnessDesk's plugin tools as a stdio MCP server.
 *
 * ACP agents accept MCP servers in `session/new`; this binary is what the
 * adapter hands them. It speaks MCP on stdio and forwards to the host's
 * tool gateway over the state-directory unix socket named in
 * `HD_TOOLS_SOCKET` — filesystem permissions are the auth, so no token
 * rides the environment. Tool results keep their images: a screenshot the
 * plugin took reaches the model as MCP image content.
 *
 * Zero dependencies on purpose: the whole protocol surface used here is
 * initialize / tools/list / tools/call, and a hand-rolled hundred lines
 * beats a supply chain for that.
 *
 * `initialize` also carries the desk's standing instruction as the server's
 * `instructions` — the one sentence MCP lets a server say about itself,
 * which agents fold into their own briefing. It is asked of the gateway at
 * that moment, so a plugin enabled since the bridge was built still has its
 * say; a gateway that cannot answer leaves it out rather than failing the
 * handshake.
 */

const SOCKET = process.env['HD_TOOLS_SOCKET']
if (!SOCKET) {
  process.stderr.write('HD_TOOLS_SOCKET is not set; this binary is launched by HarnessDesk.\n')
  process.exit(1)
}

/**
 * The correlation token the adapter minted for the session this bridge was
 * spawned for. The agent spawned us and only the environment survived the
 * trip, so this is the one way a tool call can say which conversation made
 * it. Optional: an old adapter sets nothing, and the call is simply unscoped.
 */
const CALLER = process.env['HD_TOOLS_CALLER']
/** The agent whose environment this bridge was spawned from — said only when no conversation gave it a token. */
const AGENT = process.env['HD_TOOLS_AGENT']

// ------------------------------------------------------------ gateway client

let socket: Socket | null = null
let nextId = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

const gateway = (): Socket => {
  if (socket && !socket.destroyed) return socket
  socket = connect(SOCKET)
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString()
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try {
        const message = JSON.parse(line) as { id: number; result?: unknown; error?: { message?: string } }
        const waiter = pending.get(message.id)
        if (!waiter) continue
        pending.delete(message.id)
        if (message.error) waiter.reject(new Error(message.error.message ?? 'gateway error'))
        else waiter.resolve(message.result)
      } catch {
        // skip
      }
    }
  })
  const disconnect = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
    socket = null
  }
  socket.on('error', () => {
    disconnect(new Error('The HarnessDesk tool gateway is not reachable.'))
  })
  socket.on('end', () => {
    disconnect(new Error('The HarnessDesk tool gateway disconnected.'))
  })
  socket.on('close', () => {
    disconnect(new Error('The HarnessDesk tool gateway disconnected.'))
  })
  return socket
}

const call = <T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> => {
  const id = ++nextId
  gateway().write(`${JSON.stringify({ id, method, params })}\n`)
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out.`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value as T)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
  })
}

// ------------------------------------------------------------------ MCP side

/** A real MCP `CallToolResult` shape — content is required, so anything else is not one and gets wrapped as text instead of forwarded blind. */
const isMcpContent = (value: unknown): value is { content: unknown[] } =>
  typeof value === 'object' && value !== null && Array.isArray((value as { content?: unknown }).content)

/**
 * A Seat's approved external MCP servers reach the real agent through this
 * exact bridge — the same `tools/list`/`tools/call` verbs an agent already
 * uses for the desk's own plugin tools, merged into one index. `mcp/list`
 * gives real names, descriptions and input schemas the gateway actually
 * fetched from each approved server; an older host without it (or a host not
 * wired for phase 12 at all) simply contributes nothing here, exactly like
 * `server/info`'s missing-instructions fallback above.
 */
const mcpToolIndex = async (): Promise<GatewayTool[]> => {
  try {
    const { tools } = await call<{
      tools: { name: string; server: string; description?: string; inputSchema?: unknown }[]
    }>('mcp/list', CALLER ? { caller: CALLER } : {}, 10_000) // bounded: a host that never answers this verb must not stall the desk's own tools too
    return (tools ?? []).map((tool) => ({
      namespace: tool.server,
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? { type: 'object' },
      mcp: { server: tool.server },
    }))
  } catch {
    return []
  }
}

/** MCP tool names must be unique; namespaces disambiguate only on clashes. */
const toolIndex = async (): Promise<Map<string, GatewayTool>> => {
  const [{ tools }, mcpTools] = await Promise.all([call<{ tools: GatewayTool[] }>('tools/list'), mcpToolIndex()])
  return buildToolIndex([...(tools ?? []), ...mcpTools])
}

const respond = (id: unknown, result: object): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

const fail = (id: unknown, code: number, message: string): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  void (async () => {
    let message: { id?: unknown; method?: string; params?: Record<string, unknown> }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    const { id, method, params } = message
    if (!method) return
    try {
      switch (method) {
        case 'initialize': {
          let instructions = ''
          try {
            instructions = (
              await call<{ instructions?: unknown }>('server/info', CALLER ? { caller: CALLER } : AGENT ? { agent: AGENT } : {})
            ).instructions as string
          } catch {
            // An older host without the verb: the tools still work, unbriefed.
          }
          respond(id, {
            protocolVersion: (params?.['protocolVersion'] as string) ?? '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'harnessdesk', version: '0.1.0' },
            ...(typeof instructions === 'string' && instructions.trim() !== '' ? { instructions } : {}),
          })
          return
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return // notifications take no reply
        case 'ping':
          respond(id, {})
          return
        case 'tools/list': {
          const index = await toolIndex()
          respond(id, {
            tools: [...index.entries()].map(([name, tool]) => ({
              name,
              description: tool.description,
              inputSchema: tool.inputSchema ?? { type: 'object' },
            })),
          })
          return
        }
        case 'tools/call': {
          const name = String(params?.['name'] ?? '')
          const index = await toolIndex()
          const tool = index.get(name)
          if (!tool) {
            fail(id, -32602, `No tool named ${name}.`)
            return
          }
          if (tool.mcp) {
            // A Seat's approved external server: the gateway's own gate
            // (approval, ceiling, caller identity) runs on `mcp/call`, never
            // on the plugin verb — this tool never reaches `tools/invoke`.
            const mcpResult = await call<{ ok: true; result: unknown } | { ok: false; reason: string }>('mcp/call', {
              server: tool.mcp.server,
              tool: tool.name,
              args: params?.['arguments'] ?? {},
              ...(CALLER ? { caller: CALLER } : {}),
            })
            if (mcpResult.ok) {
              // Already a real upstream MCP `CallToolResult` — passed through
              // exactly as the server answered, never reshaped by a
              // converter built for the desk's own internal tool result
              // shape.
              respond(id, isMcpContent(mcpResult.result) ? mcpResult.result : { content: [{ type: 'text', text: String(mcpResult.result) }] })
            } else {
              respond(id, { content: [{ type: 'text', text: mcpResult.reason }], isError: true })
            }
            return
          }
          const result = await call<GatewayResult>('tools/invoke', {
            namespace: tool.namespace,
            name: tool.name,
            args: params?.['arguments'] ?? {},
            ...(CALLER ? { caller: CALLER } : {}),
          })
          respond(id, toMcpContent(result))
          return
        }
        default:
          if (id !== undefined) fail(id, -32601, `Method not supported: ${method}`)
      }
    } catch (error) {
      if (id !== undefined) fail(id, -32603, error instanceof Error ? error.message : String(error))
    }
  })()
})
