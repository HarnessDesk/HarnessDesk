#!/usr/bin/env node
import { connect, type Socket } from 'node:net'
import { createInterface } from 'node:readline'

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

interface GatewayTool {
  namespace: string
  name: string
  description: string
  inputSchema: unknown
}

type GatewayResult =
  | { ok: true; content: ({ type: 'text'; text: string } | { type: 'image'; url: string; mimeType?: string })[] }
  | { ok: false; error: string }

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
  socket.on('error', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('The HarnessDesk tool gateway is not reachable.'))
    pending.clear()
    socket = null
  })
  return socket
}

const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
  const id = ++nextId
  gateway().write(`${JSON.stringify({ id, method, params })}\n`)
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out.`))
    }, 120_000)
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

/** MCP tool names must be unique; namespaces disambiguate only on clashes. */
const toolIndex = async (): Promise<Map<string, GatewayTool>> => {
  const { tools } = await call<{ tools: GatewayTool[] }>('tools/list')
  const byName = new Map<string, GatewayTool>()
  for (const tool of tools) {
    const key = byName.has(tool.name) ? `${tool.namespace.replace(/#\d+$/, '')}_${tool.name}` : tool.name
    if (!byName.has(key)) byName.set(key, tool)
  }
  return byName
}

const toMcpContent = (result: GatewayResult): { content: object[]; isError?: boolean } => {
  if (!result.ok) return { content: [{ type: 'text', text: result.error }], isError: true }
  const content = result.content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image',
          data: part.url.replace(/^data:[^,]*,/, ''),
          mimeType: part.mimeType ?? 'image/png',
        },
  )
  return { content: content.length > 0 ? content : [{ type: 'text', text: '' }] }
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
        case 'initialize':
          respond(id, {
            protocolVersion: (params?.['protocolVersion'] as string) ?? '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'harnessdesk', version: '0.1.0' },
          })
          return
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
