#!/usr/bin/env node
/**
 * A scripted ACP agent that plays one piece of real-looking work.
 *
 * The repository's own `fake-acp-agent.mjs` fixture is the right tool for
 * testing the adapter and the wrong one for a photograph: it answers
 * "hearing: … done." and can be made to say "yarr", because its job is to be
 * deliberately un-Codex so that anything Codex-shaped above it fails. A
 * transcript reading `hearing: Retry the checkout call on a 502` is not a
 * screenshot anybody should publish.
 *
 * So this is a second fake, written for the camera rather than for the suite:
 * the same protocol, a turn shaped like work — reasoning, a plan, tool calls
 * with real arguments, and a summary that says what changed. It is a real
 * child process over real pipes, so every pixel is the renderer's own.
 *
 * Read from the environment:
 *   SHOT_AGENT_NAME   what it calls itself on the wire
 *   SHOT_STORE        conversation store, in `seed.mjs`'s shape
 *   SHOT_MODELS       `id:Name,id:Name` — the composer's model picker
 *   SHOT_TURN         which of the four scripted turns this seat plays
 */
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const NAME = process.env['SHOT_AGENT_NAME'] ?? 'agent'
const STORE = process.env['SHOT_STORE'] ?? null
const MODELS = (process.env['SHOT_MODELS'] ?? 'sonnet:Sonnet,opus:Opus')
  .split(',')
  .map((one) => one.split(':'))
  .map(([modelId, name]) => ({ modelId, name }))

const readStore = () => {
  if (!STORE) return {}
  try {
    return JSON.parse(readFileSync(STORE, 'utf8'))
  } catch {
    return {}
  }
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32600, message } })
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })
const update = (sessionId, body) => notify('session/update', { sessionId, update: body })
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

let seq = 0
const sessions = new Map()
const cancelled = new Set()
const newSession = (id, cwd) => {
  const state = { id, cwd, modelId: MODELS[0].modelId, modeId: 'default' }
  sessions.set(id, state)
  return state
}

/* ------------------------------------------------------------------ the turn */

const say = (id, text) => update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const think = (id, text) => update(id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } })

/**
 * One tool call, from pending to completed.
 *
 * `title` is a display string and `kind` is what the interface classifies on,
 * which is the way round it has caught people out before — a title is written
 * for a reader and must never be parsed. `rawInput` carries the arguments the
 * app writes its own sentence from, so the row reads "Read src/checkout/
 * retry.ts" rather than the bare tool name.
 */
const tool = async (id, { toolCallId, title, kind, input, output, ms = 420 }) => {
  update(id, { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'pending', rawInput: input })
  await sleep(ms)
  update(id, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    ...(output ? { rawOutput: output } : {}),
  })
}

/**
 * Four turns, one per seat.
 *
 * A room where every agent says the same sentence is not a picture of four
 * agents; it is a picture of one fixture running four times, and it reads that
 * way instantly. So each seat plays a different piece of the same work — the
 * pieces that are on the board — chosen by `SHOT_TURN`.
 *
 * They are paced rather than dumped, because a recording of this is a GIF and
 * a transcript that lands all at once has nothing to show. The waits are the
 * animation.
 */
const TURNS = [
  {
    think: 'The checkout client retries on a timeout but not on a 502, so a bad gateway surfaces to the customer as a failed order. Worth reading what the retry policy actually covers.',
    tools: [
      { id: 'r1', title: 'Read src/checkout/retry.ts', kind: 'read', input: { path: 'src/checkout/retry.ts' }, output: { text: '42 lines' } },
      { id: 'r2', title: 'Grep 50[0-9] in src/checkout', kind: 'search', input: { pattern: '50[0-9]', path: 'src/checkout' }, output: { text: '3 matches in 2 files' } },
      { id: 'r3', title: 'Edit src/checkout/retry.ts', kind: 'edit', input: { path: 'src/checkout/retry.ts' }, output: { text: '+14 −6' } },
    ],
    second: 'Only 503 and 504 are listed as retryable, and the backoff is a flat 200ms — three retries against a gateway that is still restarting is three failures in 600ms.',
    plan: ['Add 502 to the retryable set', 'Cap the backoff and add jitter', 'Hand the tests to whoever claimed #3'],
    say: [
      '502 is retryable alongside 503 and 504 now, and the backoff is exponential with a 2s cap and full jitter, so three retries span about 3.5s rather than 600ms.\n\n',
      'I have left `retry.test.ts` alone — #3 is claimed and I would only conflict with it.',
    ],
  },
  {
    think: 'Taking #3, the tests. The interesting case is not the 502 that recovers — it is the one that never does, because the caller has to see the original status rather than a synthesised timeout.',
    tools: [
      { id: 't1', title: 'Read src/checkout/retry.test.ts', kind: 'read', input: { path: 'src/checkout/retry.test.ts' }, output: { text: '88 lines, 4 tests' } },
      { id: 't2', title: 'Edit src/checkout/retry.test.ts', kind: 'edit', input: { path: 'src/checkout/retry.test.ts' }, output: { text: '+41 −0' } },
      { id: 't3', title: '`pnpm vitest run checkout`', kind: 'execute', input: { command: 'pnpm vitest run checkout' }, output: { text: 'Test Files  1 passed (1)\n     Tests  6 passed (6)' }, ms: 900 },
    ],
    second: 'Both new cases fail against the old policy and pass against the new one, which is the only way to know the test is testing the change.',
    plan: ['Cover a 502 that recovers', 'Cover a 502 that never does', 'Assert the original status reaches the caller'],
    say: [
      'Two cases added. Six pass.\n\n',
      'The second one asserts the caller sees the original 502 rather than a synthesised timeout — that was the part the old policy got wrong quietly.',
    ],
  },
  {
    think: '#4, the webhook receiver. A redelivery today runs the whole handler again, so a retried delivery can charge twice — which is worse than the 502 everyone is looking at.',
    tools: [
      { id: 'w1', title: 'Grep handleDelivery in src', kind: 'search', input: { pattern: 'handleDelivery', path: 'src' }, output: { text: '2 matches' } },
      { id: 'w2', title: 'Read src/webhooks/receiver.ts', kind: 'read', input: { path: 'src/webhooks/receiver.ts' }, output: { text: '117 lines' } },
      { id: 'w3', title: 'Edit src/webhooks/receiver.ts', kind: 'edit', input: { path: 'src/webhooks/receiver.ts' }, output: { text: '+28 −3' } },
    ],
    second: 'Keying on the delivery id with a 24h window is enough — the provider guarantees the id is stable across retries of the same delivery.',
    plan: ['Key on the delivery id', 'Keep seen ids for 24h', 'Return 200 on a repeat, not 409'],
    say: [
      'Idempotent on the delivery id, with a 24h window. A redelivery is now a no-op that still answers 200, so the provider stops escalating.\n\n',
      'Worth noting for #5: the provider resets its own backoff on any 2xx, so a flapping endpoint can be retried indefinitely. That is the storm you would be alerting on.',
    ],
  },
  {
    think: '#5 needs a number, so the useful thing I can do is find out what the current rate actually is rather than guess a threshold.',
    tools: [
      { id: 'a1', title: '`gh api /repos/:owner/:repo/actions/runs`', kind: 'execute', input: { command: 'gh api …' }, output: { text: '412 runs' }, ms: 700 },
      { id: 'a2', title: 'Grep retry.exhausted in logs', kind: 'search', input: { pattern: 'retry.exhausted', path: 'logs' }, output: { text: '61 matches over 7d' } },
    ],
    second: 'Sixty-one exhausted retries in a week, and fifty-four of them are one client that does not back off at all. A threshold set on the total would alert on that client for ever.',
    plan: ['Measure the current rate', 'Separate the one noisy client', 'Propose a threshold that excludes it'],
    say: [
      'Not proposing a number yet — the data says the threshold is the wrong shape.\n\n',
      '61 exhausted retries in 7 days, 54 of them one client retrying a 400 without backing off. Alerting on the total would page us about that client weekly and hide a real storm. Suggest we alert on distinct clients rather than on volume, and I will write it up for whoever owns the rota.',
    ],
  },
]

const playTurn = async (id) => {
  const stop = () => cancelled.has(id)
  const turn = TURNS[Number(process.env['SHOT_TURN'] ?? 0) % TURNS.length]

  think(id, turn.think)
  await sleep(700)
  if (stop()) return 'cancelled'

  const [first, ...rest] = turn.tools
  await tool(id, { toolCallId: `tc-${first.id}`, title: first.title, kind: first.kind, input: first.input, output: first.output, ms: first.ms })
  if (stop()) return 'cancelled'

  think(id, turn.second)
  await sleep(600)

  update(id, {
    sessionUpdate: 'plan',
    entries: turn.plan.map((content, n) => ({ content, status: n === 0 ? 'in_progress' : 'pending' })),
  })
  await sleep(500)

  for (const step of rest) {
    if (stop()) return 'cancelled'
    await tool(id, { toolCallId: `tc-${step.id}`, title: step.title, kind: step.kind, input: step.input, output: step.output, ms: step.ms })
  }

  update(id, { sessionUpdate: 'plan', entries: turn.plan.map((content) => ({ content, status: 'completed' })) })

  /* One chunk, not two.
     A conversation renders successive `agent_message_chunk`s as one growing
     message, but a room broadcasts what the agent has said so far — so two
     chunks arrive in the chat as the first sentence, then the first sentence
     and the second concatenated, and the column reads as if every agent
     stuttered. The paragraph break survives inside a single chunk. */
  say(id, turn.say.join(''))
  return 'end_turn'
}

/* -------------------------------------------------------------- the protocol */

const handlers = {
  initialize: (id) => {
    reply(id, {
      protocolVersion: 1,
      agentInfo: { name: NAME, version: '1.0.0' },
      agentCapabilities: {
        loadSession: Boolean(STORE),
        promptCapabilities: { image: true },
        ...(STORE ? { sessionCapabilities: { list: {}, resume: {} } } : {}),
      },
      authMethods: [],
    })
  },

  'session/new': (id, params) => {
    seq += 1
    const state = newSession(`s-${seq}`, params?.cwd ?? process.cwd())
    reply(id, {
      sessionId: state.id,
      models: { currentModelId: state.modelId, availableModels: MODELS },
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan', description: 'Work out the steps first.' },
        ],
      },
    })
  },

  'session/list': (id) => {
    const store = readStore()
    reply(id, {
      sessions: Object.values(store).map((entry) => ({
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        title: entry.title,
        updatedAt: entry.updatedAt,
      })),
    })
  },

  'session/load': (id, params) => {
    const store = readStore()
    const entry = store[params.sessionId]
    if (!entry) return fail(id, `no stored session ${params.sessionId}`)
    const state = newSession(entry.sessionId, entry.cwd)
    /* Replay ask and answer as the stored pair, so a reopened conversation
       reads like one that happened rather than like a prompt with no reply. */
    for (const turn of entry.turns ?? []) {
      const [ask, answer] = Array.isArray(turn) ? turn : [turn, null]
      update(state.id, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: String(ask) } })
      if (answer) update(state.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(answer) } })
    }
    reply(id, {
      sessionId: state.id,
      models: { currentModelId: state.modelId, availableModels: MODELS },
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
    })
  },

  'session/set_model': (id, params) => {
    const state = sessions.get(params.sessionId)
    if (state) state.modelId = params.modelId
    reply(id, null)
  },

  'session/set_mode': (id, params) => {
    const state = sessions.get(params.sessionId)
    if (state) state.modeId = params.modeId
    reply(id, null)
  },

  'session/prompt': async (id, params) => {
    const sessionId = params.sessionId
    cancelled.delete(sessionId)
    const stopReason = await playTurn(sessionId)
    reply(id, { stopReason })
  },

  'session/cancel': (_id, params) => {
    cancelled.add(params.sessionId)
  },
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const handler = handlers[message.method]
  if (!handler) {
    if (message.id !== undefined) fail(message.id, `no such method ${message.method}`)
    return
  }
  void handler(message.id, message.params ?? {})
})
