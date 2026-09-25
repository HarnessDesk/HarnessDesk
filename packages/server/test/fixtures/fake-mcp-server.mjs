#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs'

/**
 * A synthetic stdio MCP server for Task 4's real-transport tests.
 *
 * Speaks the minimum this suite needs — `initialize` and `tools/call` for one
 * tool, `flag_issue` — as newline-delimited JSON-RPC 2.0 on stdin/stdout,
 * exactly the framing `attachments/transport.ts` speaks. No vendor SDK: a
 * hand-rolled dozen lines is the whole point of a fixture that stands in for
 * "some MCP server", not for any one real one.
 *
 * `FAKE_MCP_MARKER`, when set, is a file this appends one line to every time
 * `flag_issue` actually runs — the test's only way to tell "the call reached
 * the process" apart from "the gate reported success without ever dialing
 * out", which a mocked `invoke` could not prove either way.
 *
 * `tools/list` answers with this server's one real tool and its real input
 * schema — the thing a mocked `invoke` could never prove either: that a
 * listing actually round-trips to the process instead of being invented by
 * whatever asked for it. `FAKE_MCP_TOOL_COUNT`, when set, pads the list to
 * that many entries (`flag_issue` plus `padding_<n>` tools with an empty
 * schema), so a test can drive this fixture past `listStdioMcpServerTools`'s
 * own bound without hand-building a second fixture just for that.
 */

const marker = process.env['FAKE_MCP_MARKER']
const toolCount = process.env['FAKE_MCP_TOOL_COUNT'] ? Number(process.env['FAKE_MCP_TOOL_COUNT']) : 1

/*
 * Misbehaviours a transport must bound, each opt-in:
 *  - FAKE_MCP_EMPTY_PAGES=1: every `tools/list` page is empty and names a
 *    further cursor, for ever.
 *  - FAKE_MCP_PAGE_DELAY_MS=<n>: every `tools/list` page answers after n ms,
 *    with a further cursor.
 *  - FAKE_MCP_STDERR_BYTES=<n>: answers nothing, writes n bytes to stderr, then exits 1.
 *  - FAKE_MCP_IGNORE_TERM=1: shrugs off SIGTERM and a closed stdin; only SIGKILL ends it.
 *  - FAKE_MCP_PID_FILE=<path>: writes its pid there on start.
 *  - FAKE_MCP_CWD_FILE=<path>: writes the folder it runs in there on start.
 *  - FAKE_MCP_HANG_CALL=1: `tools/call` is never answered (with FAKE_MCP_MARKER, `held` is appended once it arrives).
 */
const emptyPages = process.env['FAKE_MCP_EMPTY_PAGES'] === '1'
const pageDelay = process.env['FAKE_MCP_PAGE_DELAY_MS'] ? Number(process.env['FAKE_MCP_PAGE_DELAY_MS']) : null
const hangCall = process.env['FAKE_MCP_HANG_CALL'] === '1'
const flooding = Boolean(process.env['FAKE_MCP_STDERR_BYTES'])
if (process.env['FAKE_MCP_IGNORE_TERM'] === '1') {
  process.on('SIGTERM', () => {})
  // And outlives its closed stdin too: only SIGKILL ends it.
  setInterval(() => {}, 1000)
}
// Written once SIGTERM is already ignored, so a test that waits for the pid is past that point.
if (process.env['FAKE_MCP_PID_FILE']) writeFileSync(process.env['FAKE_MCP_PID_FILE'], String(process.pid))
if (process.env['FAKE_MCP_CWD_FILE']) writeFileSync(process.env['FAKE_MCP_CWD_FILE'], process.cwd())
if (process.env['FAKE_MCP_STDERR_BYTES']) {
  const total = Number(process.env['FAKE_MCP_STDERR_BYTES'])
  const chunk = 'e'.repeat(64 * 1024)
  for (let written = 0; written < total; written += chunk.length) process.stderr.write(chunk)
  process.stderr.write('', () => process.exit(1))
}

let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline === -1) return
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    handle(line)
  }
})

const reply = (id, body) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`)
}

function handle(line) {
  if (flooding) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request.method === 'initialize') {
    reply(request.id, {
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-server', version: '0.0.0' },
      },
    })
    return
  }
  if (request.method === 'notifications/initialized') return
  if (request.method === 'tools/list' && emptyPages) {
    reply(request.id, { result: { tools: [], nextCursor: `c${request.id}` } })
    return
  }
  if (request.method === 'tools/list' && pageDelay !== null) {
    setTimeout(() => reply(request.id, { result: { tools: [], nextCursor: `c${request.id}` } }), pageDelay)
    return
  }
  if (request.method === 'tools/call' && hangCall) {
    // Said once the call is held, so a test knows the server has nothing more to write.
    if (marker) appendFileSync(marker, 'held\n')
    return
  }
  if (request.method === 'tools/list') {
    const flagIssue = {
      name: 'flag_issue',
      description: 'Flag a line for review.',
      inputSchema: { type: 'object', properties: { line: { type: 'number' } }, required: ['line'] },
    }
    const padding = Array.from({ length: Math.max(0, toolCount - 1) }, (_, index) => ({
      name: `padding_${index}`,
      description: '',
      inputSchema: {},
    }))
    reply(request.id, { result: { tools: [flagIssue, ...padding] } })
    return
  }
  if (request.method === 'tools/call') {
    const name = request.params?.name
    if (name !== 'flag_issue') {
      reply(request.id, { error: { code: -32601, message: `no such tool ${String(name)}` } })
      return
    }
    if (marker) appendFileSync(marker, `${JSON.stringify(request.params?.arguments ?? {})}\n`)
    reply(request.id, { result: { content: [{ type: 'text', text: 'flagged' }], isError: false } })
    return
  }
  reply(request.id, { error: { code: -32601, message: `unknown method ${String(request.method)}` } })
}

process.stdin.resume()
