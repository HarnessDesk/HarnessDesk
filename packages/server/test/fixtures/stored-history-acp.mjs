#!/usr/bin/env node
/**
 * A scripted ACP peer that keeps one finished conversation, `stored-1`, and
 * replays it on `session/load` — nothing else ever happens in it.
 *
 * The replay is synthesised from the shape OpenCode 2.0 sends for a stored
 * conversation (#2044): a user chunk per prompt, then each assistant message's
 * parts in order — thinking as `agent_thought_chunk`, every tool as a
 * `tool_call` followed by its finished `tool_call_update`, and the answer as
 * `agent_message_chunk` — every chunk carrying a `messageId`, and none of it
 * carrying a time. Session ids from `session/new` are fresh, so the desk's
 * own draft probe never collides with the stored one.
 *
 * STORED_HISTORY_CWD is the folder the listing records for it.
 */
import { createInterface } from 'node:readline'

const cwd = process.env.STORED_HISTORY_CWD
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

const shell = (id, command, output) => [
  { sessionUpdate: 'tool_call', toolCallId: id, title: command, kind: 'execute', status: 'pending', rawInput: { command } },
  { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: output } }], rawOutput: { metadata: { exit: 0 } } },
]
const edit = (id, path) => [
  { sessionUpdate: 'tool_call', toolCallId: id, title: `Edit ${path}`, kind: 'edit', status: 'pending', rawInput: { filePath: `${cwd}/${path}` } },
  { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', locations: [{ path: `${cwd}/${path}` }],
    content: [{ type: 'diff', path: `${cwd}/${path}`, oldText: 'return a - b\n', newText: 'return a + b\n' }] },
]

const HISTORY = [
  { sessionUpdate: 'user_message_chunk', messageId: 'msg-u1', content: { type: 'text', text: 'Fix the failing sum test' } },
  { sessionUpdate: 'agent_thought_chunk', messageId: 'msg-a1:0', content: { type: 'text', text: 'Run the tests to see the failure.' } },
  ...shell('call-1', 'npm test', 'expected 3, got -1\n'),
  ...edit('call-2', 'sum.js'),
  ...shell('call-3', 'npm test', 'ok\n'),
  { sessionUpdate: 'agent_message_chunk', messageId: 'msg-a2', content: { type: 'text', text: 'Fixed: sum subtracted instead of adding. The tests pass.' } },
  { sessionUpdate: 'user_message_chunk', messageId: 'msg-u2', content: { type: 'text', text: 'Add a test for negatives' } },
  ...edit('call-4', 'sum.test.js'),
  ...shell('call-5', 'npm test', 'ok\n'),
  { sessionUpdate: 'agent_message_chunk', messageId: 'msg-a3', content: { type: 'text', text: 'Added a negatives case; all green.' } },
]

let opened = 0
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: 1, agentInfo: { name: 'stored-history-acp', version: '1.0.0' }, authMethods: [],
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {}, close: {} } } } })
  } else if (method === 'session/new') {
    send({ id, result: { sessionId: `fresh-${++opened}` } })
  } else if (method === 'session/list') {
    send({ id, result: { sessions: [{ sessionId: 'stored-1', cwd, title: 'Fix the failing sum test', updatedAt: '2026-10-18T17:00:00.000Z' }] } })
  } else if (method === 'session/load') {
    if (params.sessionId !== 'stored-1') return send({ id, error: { code: -32002, message: `no stored session ${params.sessionId}` } })
    for (const update of HISTORY) send({ method: 'session/update', params: { sessionId: params.sessionId, update } })
    send({ id, result: {} })
  } else if (method === 'session/resume' || method === 'session/close') {
    send({ id, result: {} })
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: 'Method not found' } })
  }
})
