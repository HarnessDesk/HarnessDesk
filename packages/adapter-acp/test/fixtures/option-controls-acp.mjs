import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

// A controlled peer: effort reveals thinking, and a file can hold fresh
// session/new requests unanswered without slowing or loading the machine.
const sessions = new Map()
const prompts = new Map()
let counter = 0
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
const optionsOf = (state) => [
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: state.effort,
    options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  ...(state.effort === 'high' ? [{ id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'boolean', currentValue: state.thinking }] : []),
]
const models = { currentModelId: 'fam', availableModels: [{ modelId: 'fam', name: 'Fam' }] }
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialize') reply(id, {
    protocolVersion: 1, agentInfo: { name: 'Option controls', version: '1' },
    agentCapabilities: { loadSession: true }, authMethods: [],
  })
  else if (method === 'session/new') {
    if (counter > 0 && process.env.OPTION_READ_BLOCK && existsSync(process.env.OPTION_READ_BLOCK)) return
    const sessionId = `controls-${process.pid}-${++counter}`
    const state = { effort: 'low', thinking: false }
    sessions.set(sessionId, state)
    reply(id, { sessionId, models, configOptions: optionsOf(state) })
  } else if (method === 'session/set_config_option') {
    const state = sessions.get(params.sessionId)
    state[params.configId] = params.value
    reply(id, { configOptions: optionsOf(state) })
  } else if (method === 'session/prompt') prompts.set(params.sessionId, id)
  else if (method === 'session/cancel') {
    const prompt = prompts.get(params.sessionId)
    if (prompt !== undefined) { prompts.delete(params.sessionId); reply(prompt, { stopReason: 'cancelled' }) }
  } else if (id !== undefined) reply(id, {})
})
