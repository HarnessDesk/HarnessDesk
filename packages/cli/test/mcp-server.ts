/**
 * `harnessdesk mcp`, spawned as an MCP client spawns it, and spoken to the way
 * one speaks: newline-delimited JSON-RPC over its standard input and output.
 * Shared by the MCP end-to-end files; it holds no `test(...)` of its own.
 */
import { spawn } from 'node:child_process'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

export const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url))
/** A ceiling sized for a starved machine, not a wait: every wait ends on the message it waits for (#1289). */
export const LOADED_MACHINE_MS = 30_000
/** What the person and a seat put in the environment, which a test sets only on purpose. */
const AMBIENT = ['HARNESSDESK_GOAL_ID', 'HARNESSDESK_LANE_ID', 'HARNESSDESK_MCP_TRACE', 'HARNESSDESK_MCP_MAY_START', 'HARNESSDESK_CLIENTS_MAY_ANSWER']

export const cleanEnv = (extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of AMBIENT) delete env[name]
  return { ...env, ...extra }
}

export interface McpMessage {
  readonly id?: number | string
  readonly method?: string
  readonly params?: any
  readonly result?: any
  readonly error?: { readonly code: number; readonly message: string }
}

export interface McpServer {
  readonly send: (message: object) => void
  readonly request: (method: string, params?: object) => Promise<McpMessage>
  readonly tool: (name: string, input?: object, meta?: object) => Promise<any>
  readonly waitFor: (predicate: (message: McpMessage) => boolean, what: string) => Promise<McpMessage>
  readonly messages: McpMessage[]
  readonly nextId: () => number
  readonly stderr: () => string
}

/** Starts `harnessdesk mcp` for one desk; standard input is closed after the test, which is how a client says goodbye. */
export const mcpServer = (t: TestContext, env: Readonly<Record<string, string>>): McpServer => {
  const child = spawn(process.execPath, [bin, 'mcp'], { env: cleanEnv(env), stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = '', stderr = ''
  const messages: McpMessage[] = []
  const waiters = new Set<() => void>()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) messages.push(JSON.parse(line) as McpMessage)
    }
    for (const wake of [...waiters]) wake()
  })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const exit = new Promise<number | null>(resolve => child.once('close', resolve))
  t.after(async () => {
    child.stdin.end()
    const kill = setTimeout(() => child.kill('SIGKILL'), LOADED_MACHINE_MS)
    await exit
    clearTimeout(kill)
  })
  let next = 1
  const send = (message: object) => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
  const waitFor = (predicate: (message: McpMessage) => boolean, what: string) => new Promise<McpMessage>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`no ${what} after ${LOADED_MACHINE_MS}ms: ${JSON.stringify(messages)}\n${stderr}`)) }, LOADED_MACHINE_MS)
    const check = () => {
      const found = messages.find(predicate)
      if (found) { clearTimeout(timer); waiters.delete(check); resolve(found) }
    }
    waiters.add(check); check()
  })
  const request = (method: string, params: object = {}) => {
    const id = next++
    send({ id, method, params })
    return waitFor(message => message.id === id && (message.result !== undefined || message.error !== undefined), `answer to ${method} #${id}`)
  }
  const tool = async (name: string, input: object = {}, meta?: object) =>
    (await request('tools/call', { name, arguments: input, ...(meta ? { _meta: meta } : {}) })).result
  return { send, request, tool, waitFor, messages, nextId: () => next++, stderr: () => stderr }
}

/** Says hello as the placeholder client every MCP test uses. */
export const initialize = async (server: McpServer, protocolVersion = '2025-06-18') => {
  const hello = await server.request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'example-client', version: '1.0.0' } })
  server.send({ method: 'notifications/initialized' })
  return hello
}
