import { createInterface } from 'node:readline'

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const updates = JSON.parse(process.env.TOOL_UPDATES ?? '[]')
const replay = sessionId => {
  for (const update of updates) send({ method: 'session/update', params: { sessionId, update } })
}

createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } }, authMethods: [] } })
  } else if (method === 'session/new') {
    send({ id, result: { sessionId: 'tool-items' } })
  } else if (method === 'session/prompt') {
    replay(params.sessionId)
    send({ id, result: { stopReason: 'end_turn' } })
  } else if (method === 'session/list') {
    send({ id, result: { sessions: [{ sessionId: 'tool-items', cwd: process.env.TOOL_CWD }] } })
  } else if (method === 'session/load') {
    send({ method: 'session/update', params: { sessionId: params.sessionId, update: {
      sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Fix the bug' },
    } } })
    replay(params.sessionId)
    send({ id, result: {} })
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: 'Not supported' } })
  }
})
