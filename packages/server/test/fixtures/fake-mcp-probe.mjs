#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

/**
 * A scripted stdio MCP server for Test connection (`src/mcp-test.ts`).
 * Newline-delimited JSON-RPC on stdin/stdout, no SDK. `PROBE_MODE` picks the
 * behaviour, from the declaration's own `env`:
 *
 *  - ok (default): answers; `PROBE_TOOLS` tools per page over `PROBE_PAGES` pages.
 *  - hang: never answers `initialize`.
 *  - crash: writes `PROBE_SECRET` to stderr, then exits 3.
 *  - badjson: writes a line that is not JSON.
 *  - error: answers `initialize` with an error that carries `PROBE_SECRET`.
 *  - grandchild: starts a child, in this process's group, that ignores
 *    SIGTERM and writes its pid to `PROBE_PID_FILE`; then answers as ok.
 *
 * `PROBE_ENV_FILE`, when set, receives the names of every variable it was
 * started with; `PROBE_CWD_FILE` the folder it runs in.
 */
const mode = process.env['PROBE_MODE'] ?? 'ok'
const perPage = Number(process.env['PROBE_TOOLS'] ?? '3')
const pages = Number(process.env['PROBE_PAGES'] ?? '1')

if (process.env['PROBE_ENV_FILE']) writeFileSync(process.env['PROBE_ENV_FILE'], Object.keys(process.env).sort().join('\n'))
if (process.env['PROBE_CWD_FILE']) writeFileSync(process.env['PROBE_CWD_FILE'], process.cwd())

if (mode === 'crash') {
  process.stderr.write(`fatal: token ${process.env['PROBE_SECRET'] ?? ''} rejected\n`, () => process.exit(3))
}
// The grandchild writes its own pid once SIGTERM is ignored, and nothing is
// answered before then, so a test knows only SIGKILL can end it.
let ready = Promise.resolve()
if (mode === 'grandchild') {
  const pidFile = process.env['PROBE_PID_FILE'] ?? ''
  const code = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`
  spawn(process.execPath, ['-e', code], { stdio: 'ignore' })
  ready = new Promise((resolve) => {
    const poll = setInterval(() => {
      if (existsSync(pidFile)) {
        clearInterval(poll)
        resolve()
      }
    }, 10)
  })
}

const reply = (id, body) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`)

let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline === -1) return
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim()) void ready.then(() => handle(JSON.parse(line)))
  }
})

function handle(request) {
  if (mode === 'hang' || mode === 'crash') return
  if (mode === 'badjson') {
    process.stdout.write('Server ready on stdio!\n')
    return
  }
  if (request.method === 'initialize') {
    if (mode === 'error') {
      reply(request.id, { error: { code: -32000, message: `bad key ${process.env['PROBE_SECRET'] ?? ''}` } })
      return
    }
    reply(request.id, {
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1.2.3' } },
    })
    return
  }
  if (request.method === 'notifications/initialized') return
  if (request.method === 'tools/list') {
    const page = request.params?.cursor ? Number(request.params.cursor) : 0
    const tools = Array.from({ length: perPage }, (_, index) => ({ name: `t${page}_${index}`, inputSchema: { type: 'object' } }))
    reply(request.id, { result: { tools, ...(page + 1 < pages ? { nextCursor: String(page + 1) } : {}) } })
    return
  }
  reply(request.id, { error: { code: -32601, message: 'unknown' } })
}

process.stdin.resume()
