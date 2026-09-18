#!/usr/bin/env node
/*
 * A scripted ACP agent that settles a pick the way `packages/cursor-acp`'s
 * bridge does: a family is a list of variants, a pick changes what is *wanted*,
 * and the session runs the nearest variant there is — `#resolve`'s score,
 * effort 4 and thinking 2, a tie going to the lower effort.
 *
 * Two variants, (high, no thinking) and (medium, thinking). So high with
 * thinking, and medium without it, do not exist: asked for, each is settled on
 * the other, and the call that asked for it succeeds all the same. That is the
 * agent a desk has to read back rather than believe.
 *
 * Where it says what a pick settled on is the variable, because agents differ:
 *
 *   VARIANT_ANSWER=announce (the default) — the bridge's order: every control
 *     in a `config_option_update`, then `null` as the answer to the call.
 *   VARIANT_ANSWER=reply — ACP's own shape: every control in the answer, and
 *     nothing announced.
 *   VARIANT_ANSWER=own — claude-acp's shape for the controls it keeps itself:
 *     an answer naming only those (here, `thinking`), and nothing announced.
 *
 * Models: `fam`, and `fam-legacy`, which it lists and no longer runs. Picked,
 * `fam-legacy` is settled on `fam`, announced the bridge's way — the model,
 * then every control — and answered with `null`. VARIANT_NO_MODELS=1 declares
 * no models at all: an agent that offers no choice of model, and says so.
 *
 * VARIANT_TRUTH=<file>: every prompt appends what the session really ran it on.
 */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const VARIANTS = [
  { effort: 'high', thinking: false },
  { effort: 'medium', thinking: true },
]
const EFFORTS = ['low', 'medium', 'high', 'xhigh']
const ANSWER = process.env.VARIANT_ANSWER ?? 'announce'

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32600, message } })
const update = (sessionId, body) =>
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } })

const sessions = new Map()
let counter = 0

const resolve = (wanted) =>
  [...VARIANTS].sort((a, b) => {
    const score = (v) => (v.effort === wanted.effort ? 4 : 0) + (v.thinking === wanted.thinking ? 2 : 0)
    return score(b) - score(a) || EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort)
  })[0]

const thinkingOf = (state) => ({
  id: 'thinking',
  name: 'Thinking',
  category: 'thought_level',
  type: 'boolean',
  currentValue: state.actual.thinking,
})

const optionsOf = (state) => [
  {
    id: 'effort',
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: state.actual.effort,
    options: [
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
  thinkingOf(state),
]

const modelsOf = (state) => ({
  currentModelId: state.model,
  availableModels: [
    { modelId: 'fam', name: 'Fam' },
    { modelId: 'fam-legacy', name: 'Fam (legacy)' },
  ],
})

const handlers = {
  initialize: (id) =>
    reply(id, {
      protocolVersion: 1,
      agentInfo: { name: 'variant-acp-agent', version: '1' },
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false } },
      authMethods: [],
    }),
  'session/new': (id) => {
    const sessionId = `variant-${++counter}`
    const wanted = { effort: 'high', thinking: false }
    const state = { id: sessionId, model: 'fam', wanted, actual: resolve(wanted) }
    sessions.set(sessionId, state)
    reply(id, {
      sessionId,
      ...(process.env.VARIANT_NO_MODELS === '1' ? {} : { models: modelsOf(state) }),
      configOptions: optionsOf(state),
    })
  },
  'session/set_model': (id, params) => {
    const state = sessions.get(params.sessionId)
    if (!state) return fail(id, 'no such session')
    if (params.modelId !== 'fam' && params.modelId !== 'fam-legacy') return fail(id, `no model ${params.modelId}`)
    // Listed, and no longer run: the family it became is what runs.
    state.model = 'fam'
    update(state.id, { sessionUpdate: 'current_model_update', currentModelId: state.model })
    update(state.id, { sessionUpdate: 'config_option_update', configOptions: optionsOf(state) })
    reply(id, null)
  },
  'session/set_config_option': (id, params) => {
    const state = sessions.get(params.sessionId)
    if (!state) return fail(id, 'no such session')
    if (params.configId !== 'effort' && params.configId !== 'thinking') return fail(id, `no option ${params.configId}`)
    state.wanted = { ...state.wanted, [params.configId]: params.value }
    state.actual = resolve(state.wanted)
    if (ANSWER === 'reply') return reply(id, { configOptions: optionsOf(state) })
    if (ANSWER === 'own') return reply(id, { configOptions: [thinkingOf(state)] })
    update(state.id, { sessionUpdate: 'config_option_update', configOptions: optionsOf(state) })
    reply(id, null)
  },
  'session/prompt': (id, params) => {
    const state = sessions.get(params.sessionId)
    if (!state) return fail(id, 'no such session')
    if (process.env.VARIANT_TRUTH) {
      appendFileSync(
        process.env.VARIANT_TRUTH,
        `${JSON.stringify({ session: state.id, model: state.model, ...state.actual })}\n`,
      )
    }
    update(state.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } })
    reply(id, { stopReason: 'end_turn' })
  },
  'session/cancel': () => {},
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.method === undefined) return
  const handler = handlers[message.method]
  if (handler) handler(message.id, message.params ?? {})
  else if (message.id !== undefined) fail(message.id, `method not supported: ${message.method}`)
})
