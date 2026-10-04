import { createInterface } from 'node:readline'

// Claude-shaped catalogue: Haiku explicitly has no effort levels or thinking
// control, while Opus declares its own levels. No vendor process is invoked.
const models = [
  { modelId: 'haiku', name: 'Haiku 4.5', _meta: { harnessdesk: { effortLevels: [] } } },
  { modelId: 'opus', name: 'Opus', _meta: { harnessdesk: { effortLevels: [{ id: 'high', label: 'High' }] } } },
]
const sessions = new Map()
const optionsOf = (model) => model === 'opus'
  ? [{ id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'high', name: 'High' }] }]
  : []
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialize') reply(id, { protocolVersion: 1, agentInfo: { name: 'Seat fixture', version: '1' }, agentCapabilities: {}, authMethods: [] })
  else if (method === 'session/new') {
    const sessionId = `fixture-${sessions.size + 1}`
    sessions.set(sessionId, 'haiku')
    reply(id, { sessionId, models: { currentModelId: 'haiku', availableModels: models }, configOptions: [] })
  } else if (method === 'session/set_model') {
    sessions.set(params.sessionId, params.modelId)
    reply(id, { configOptions: optionsOf(params.modelId) })
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: optionsOf(params.modelId) } } })}\n`)
  } else if (method === 'session/set_config_option') reply(id, { configOptions: optionsOf(sessions.get(params.sessionId)) })
  else if (id !== undefined) reply(id, {})
})
