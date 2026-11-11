#!/usr/bin/env node
/**
 * A minimal MCP client, as an agent's own would be: it spawns
 * `harnessdesk mcp`, says hello, starts a Flow, waits on the run it started
 * with a progress token, and prints one JSON line for every message the
 * server sends back. Its only argument is a JSON object:
 *   { bin, flow, project, input?, timeout }
 * The desk is found the way the command line finds it, from the environment.
 */
import { spawn } from 'node:child_process'

const { bin, flow, project, input, timeout } = JSON.parse(process.argv[2] ?? '{}')
const server = spawn(process.execPath, [bin, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
let buffer = '', next = 1

server.stdout.setEncoding('utf8')
server.stdout.on('data', chunk => {
  buffer += chunk
  for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    process.stdout.write(`${line}\n`)
    const message = JSON.parse(line)
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
  }
})

const request = (method, params) => new Promise(resolve => {
  const id = next++
  pending.set(id, resolve)
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})

const hello = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'example-client', version: '1.0.0' } })
if (hello.error) throw new Error(hello.error.message)
server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
const started = await request('tools/call', { name: 'flow_start', arguments: { flow, project, ...(input ? { input } : {}) } })
let code = 1
if (!started.error && !started.result.isError) {
  const waited = await request('tools/call', { name: 'run_wait', arguments: { run: started.result.structuredContent.run, timeout }, _meta: { progressToken: 'example-wait' } })
  code = waited.error || waited.result.isError ? 1 : 0
}
server.stdin.end()
await new Promise(resolve => server.once('close', resolve))
process.exit(code)
