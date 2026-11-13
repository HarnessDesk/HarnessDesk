import { createInterface } from 'node:readline'

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const updates = JSON.parse(process.env.TOOL_UPDATES ?? '[]')
const permissions = new Map()
let promptCount = 0
const turns = process.env.TOOL_TURNS ? JSON.parse(process.env.TOOL_TURNS) : null
const reasons = process.env.TOOL_STOP_REASONS ? JSON.parse(process.env.TOOL_STOP_REASONS) : null
const replay = async (sessionId, batch = updates) => {
  for (const update of batch) {
    if (update.delegations) {
      send({ method: '_harnessdesk/delegation/changed', params: { sessionId, delegations: update.delegations } })
      continue
    }
    send({ method: 'session/update', params: { sessionId, update } })
    if (update.toolCallId === process.env.TOOL_PERMISSION && update.sessionUpdate === 'tool_call') {
      const id = `permission-${update.toolCallId}`
      const answered = new Promise(resolve => permissions.set(id, resolve))
      send({ id, method: 'session/request_permission', params: {
        sessionId, toolCall: update,
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
      } })
      await answered
    }
  }
}

createInterface({ input: process.stdin }).on('line', async line => {
  const { id, method, params } = JSON.parse(line)
  if (!method && permissions.has(id)) { permissions.get(id)(); permissions.delete(id); return }
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } }, authMethods: [] } })
  } else if (method === 'session/new') {
    send({ id, result: { sessionId: 'tool-items' } })
  } else if (method === 'session/prompt') {
    const index = promptCount++
    const reason = reasons?.[index] ?? process.env.TOOL_STOP_REASON ?? 'end_turn'
    await replay(params.sessionId, turns?.[index] ?? updates)
    if (reason === 'error') send({ id, error: { code: -32603, message: 'Fixture prompt failed' } })
    else send({ id, result: { stopReason: reason } })
  } else if (method === 'session/list') {
    send({ id, result: { sessions: [{ sessionId: 'tool-items', cwd: process.env.TOOL_CWD }] } })
  } else if (method === 'session/load') {
    send({ method: 'session/update', params: { sessionId: params.sessionId, update: {
      sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Fix the bug' },
    } } })
    await replay(params.sessionId)
    send({ id, result: {} })
  } else if (method === 'session/close') {
    if (process.env.TOOL_CLOSE_FAIL) send({ id, error: { code: -32603, message: 'Fixture close failed' } })
    else send({ id, result: {} })
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: 'Not supported' } })
  }
})
