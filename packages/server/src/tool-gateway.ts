import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

import type { CapabilityContribution, ToolResult } from '@harnessdesk/protocol'

/**
 * The tool gateway: plugin tools for out-of-process projections.
 *
 * One unix socket in the state directory, NDJSON JSON-RPC, three verbs.
 * Filesystem permissions are the auth — the socket is chmod 0600 in a
 * directory the user owns — so projections like the MCP bridge need neither
 * the wire token nor the window's transport. Resolution is by NAME against
 * the registry as it is now, the rule the Codex dynamic-tool bug taught.
 */

export interface ToolGatewayBackend {
  listTools(): readonly (CapabilityContribution & { kind: 'tool' })[]
  /**
   * `caller` is the correlation token from the invoking bridge's
   * environment, when it has one — the backend resolves it to the session
   * that spawned the bridge, which is how an MCP tool call gets a scope.
   */
  invokeByName(namespace: string, name: string, args: unknown, caller?: string): Promise<ToolResult>
  /**
   * The standing instruction for the agent behind a bridge, or nothing. MCP
   * lets a server say a sentence about itself at `initialize`, and the
   * bridge relays this one — it is how an agent with no other instruction
   * channel hears what the desk's tools are for. `caller` is the bridge's
   * token, as on `tools/invoke`: the backend answers nothing for an agent
   * whose own bridge already carries the sentence, so nobody hears it twice.
   */
  instructions?(caller?: string): string
}

interface Request {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
}

export class ToolGateway {
  #server: Server | null = null

  constructor(
    private readonly socketPath: string,
    private readonly backend: ToolGatewayBackend,
  ) {}

  start(): void {
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 })
    rmSync(this.socketPath, { force: true })
    this.#server = createServer((socket) => this.#serve(socket))
    this.#server.listen(this.socketPath, () => {
      try {
        chmodSync(this.socketPath, 0o600)
      } catch {
        // Permissions on the parent directory still hold.
      }
    })
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve()
      this.#server.close(() => resolve())
    })
    rmSync(this.socketPath, { force: true })
    this.#server = null
  }

  #serve(socket: Socket): void {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim() === '') continue
        void this.#handle(line, socket)
      }
    })
    socket.on('error', () => {})
  }

  async #handle(line: string, socket: Socket): Promise<void> {
    let request: Request
    try {
      request = JSON.parse(line) as Request
    } catch {
      return
    }
    const reply = (body: object): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, ...body })}\n`)
    }
    try {
      switch (request.method) {
        case 'tools/list': {
          const tools = this.backend.listTools().map((tool) => ({
            namespace: tool.namespace,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          }))
          reply({ result: { tools } })
          return
        }
        case 'server/info': {
          const params = request.params ?? {}
          const caller = typeof params['caller'] === 'string' ? params['caller'] : undefined
          reply({ result: { instructions: this.backend.instructions?.(caller) ?? '' } })
          return
        }
        case 'tools/invoke': {
          const params = request.params ?? {}
          const result = await this.backend.invokeByName(
            String(params['namespace'] ?? ''),
            String(params['name'] ?? ''),
            params['args'],
            typeof params['caller'] === 'string' ? params['caller'] : undefined,
          )
          reply({ result })
          return
        }
        default:
          reply({ error: { message: `unknown method ${String(request.method)}` } })
      }
    } catch (error) {
      reply({ error: { message: error instanceof Error ? error.message : String(error) } })
    }
  }
}
