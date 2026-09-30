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
 *   SHOT_TURN         which scripted turn this seat plays — one index, or a
 *                      comma-separated list (`"4,6"`): the first prompt this
 *                      session gets plays the first index, every prompt after
 *                      plays the last one. A single index behaves exactly as
 *                      before — the same turn, replayed, on every prompt.
 *
 * Two files beside the store, read on every listing rather than at start, so a
 * scene can bend the history while the app runs and put it back:
 *   <store>.list-fails   `session/list` fails as an agent whose index is locked does
 *   <store>.prompt-fails `session/prompt` fails as an agent whose session another process holds does
 *   <store>.page         a number: `session/list` answers that many rows a page
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const NAME = process.env['SHOT_AGENT_NAME'] ?? 'agent'
const STORE = process.env['SHOT_STORE'] ?? null
const ROOM_TILE = process.env['SHOT_ROOM_TILE'] === '1'
const MODELS = (process.env['SHOT_MODELS'] ?? 'sonnet:Sonnet,opus:Opus')
  .split(',')
  .map((one) => one.split(':'))
  .map(([modelId, name]) => ({ modelId, name }))

/**
 * A real board claim, for the board still's "Working" cards.
 *
 * `SHOT_CLAIM` is `[{ intent, files }, ...]` — the intent numbers this seat
 * takes, in order, the moment its first turn starts. Everything else in this
 * fixture narrates a turn; this one actually plays it, over the exact bridge
 * a real agent gets (`session/new`'s own `mcpServers`, read below) — the
 * host's `claim_work` tool, called for real, so the card the board draws as
 * "Working" is genuinely claimed rather than arranged to look that way. Left
 * unset, this seat behaves exactly as it always did.
 */
const CLAIM = process.env['SHOT_CLAIM'] ? JSON.parse(process.env['SHOT_CLAIM']) : null

/**
 * A tiny, real flow worker used only by the GIF rig. It asks the board for
 * its next card, claims it, then completes it through the MCP tools a seated
 * agent receives. Outcomes persist per runtime across the flow's fresh seats.
 */
const FLOW = (() => {
  try {
    const parsed = process.env['SHOT_FLOW'] ? JSON.parse(process.env['SHOT_FLOW']) : null
    return parsed && Array.isArray(parsed.outcomes) && typeof parsed.state === 'string'
      ? {
          outcomes: parsed.outcomes.map(String), state: parsed.state, delayMs: Number(parsed.delayMs) || 0,
          files: Array.isArray(parsed.files) ? parsed.files.map(String) : [],
          intent: Number.isInteger(parsed.intent) && parsed.intent > 0 ? parsed.intent : null,
        }
      : null
  } catch {
    return null
  }
})()

const ROOM_MESSAGE = (() => {
  try {
    const parsed = process.env['SHOT_ROOM_MESSAGE'] ? JSON.parse(process.env['SHOT_ROOM_MESSAGE']) : null
    return parsed && typeof parsed.to === 'string' && typeof parsed.text === 'string'
      ? { to: parsed.to, text: parsed.text, onTurn: Number(parsed.onTurn) || 0 }
      : null
  } catch {
    return null
  }
})()

const flowConfigOptions = () => FLOW ? [
  {
    id: 'permissions', name: 'Permissions', category: 'other', type: 'select', currentValue: ':read-only',
    options: [
      { value: ':read-only', name: 'Read only' },
      { value: ':workspace', name: 'Workspace write' },
    ],
  },
  {
    id: 'approvalsReviewer', name: 'Approvals', category: 'other', type: 'select', currentValue: 'user',
    options: [{ value: 'user', name: 'Ask me' }],
  },
] : undefined

/**
 * Real ACP usage, for the seat this process plays.
 *
 * Nothing above this line ever reported a token: this fixture was written
 * for a room's transcript, not for the composer's context ring. `SHOT_USAGE`
 * is a JSON `{ last, used?, size?, cost? }` — `last` in ACP's own usage
 * shape (`totalTokens`, `inputTokens`, `outputTokens`, `cachedReadTokens`,
 * `cachedWriteTokens`), `used`/`size` the window a `usage_update` reports
 * (left out, the ring stays dashed, the way Cursor's real CLI never sends
 * one), and `cost` its `{ amount, currency }`. Read once, replayed on every
 * turn this seat plays, because a ring photograph wants one true answer, not
 * one that grows.
 */
const USAGE = process.env['SHOT_USAGE'] ? JSON.parse(process.env['SHOT_USAGE']) : null

const readStore = () => {
  if (!STORE) return {}
  try {
    return JSON.parse(readFileSync(STORE, 'utf8'))
  } catch {
    return {}
  }
}

/** A file beside the store, named for it: `claude-code.json` has `claude-code.page`. */
const beside = (suffix) => (STORE ? join(dirname(STORE), `${basename(STORE, '.json')}.${suffix}`) : null)
const readPage = () => {
  const file = beside('page')
  if (!file) return 0
  try {
    return Number(readFileSync(file, 'utf8'))
  } catch {
    return 0
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
const newSession = (id, cwd, mcpServers) => {
  const state = { id, cwd, modelId: MODELS[0].modelId, modeId: 'default', mcpServers: mcpServers ?? [] }
  sessions.set(id, state)
  return state
}

/**
 * The tool bridge a real agent gets over `session/new`'s own `mcpServers` —
 * one stdio child, speaking the same newline-delimited JSON-RPC
 * `initialize`/`tools/call` protocol `packages/mcp-tools/src/main.ts`
 * implements, connected once per session and kept open so a claim this
 * process takes stays claimed for as long as the process runs (closing the
 * bridge is indistinguishable from the agent going away, which is exactly
 * what would strand the claim — so `board`'s own claimed cards stay
 * "Working" only while this process is still up for its screenshot).
 */
const mcpClients = new Map()

const mcpConnect = (state) => {
  if (mcpClients.has(state.id)) return mcpClients.get(state.id)
  const server = state.mcpServers?.[0]
  if (!server) return null
  const env = { ...process.env }
  for (const { name, value } of server.env ?? []) env[name] = value
  const proc = spawn(server.command, server.args ?? [], { env, stdio: ['pipe', 'pipe', 'ignore'] })
  const client = { proc, pending: new Map(), nextId: 0, buffer: '' }
  proc.stdout.on('data', (chunk) => {
    client.buffer += chunk.toString()
    for (;;) {
      const newline = client.buffer.indexOf('\n')
      if (newline === -1) return
      const line = client.buffer.slice(0, newline)
      client.buffer = client.buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = client.pending.get(message.id)
      if (!waiter) continue
      client.pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message ?? 'tool bridge error'))
      else waiter.resolve(message.result)
    }
  })
  mcpClients.set(state.id, client)
  return client
}

const mcpCall = (client, method, params) =>
  new Promise((resolve, reject) => {
    const id = ++client.nextId
    client.pending.set(id, { resolve, reject })
    client.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

const mcpNotify = (client, method, params) => {
  client.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

/** Claims every intent `SHOT_CLAIM` named for this seat, over a real MCP `claim_work` call. */
const playClaim = async (state) => {
  if (!CLAIM || CLAIM.length === 0) return
  const client = mcpConnect(state)
  if (!client) return
  await mcpCall(client, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'harnessdesk-shots-agent', version: '1.0.0' },
  })
  mcpNotify(client, 'notifications/initialized', {})
  for (const { intent, files } of CLAIM) {
    await mcpCall(client, 'tools/call', { name: 'claim_work', arguments: { intent, files: files ?? [] } }).catch(() => {})
  }
}

const flowPass = () => {
  if (!FLOW) return 0
  try {
    const stored = JSON.parse(readFileSync(FLOW.state, 'utf8'))
    return Number.isInteger(stored?.pass) && stored.pass >= 0 ? stored.pass : 0
  } catch {
    return 0
  }
}

const flowText = (value) => {
  const blocks = value?.content ?? value?.contentItems ?? []
  if (!Array.isArray(blocks)) return typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return blocks.map((block) => {
    if (typeof block === 'string') return block
    if (block?.type === 'text' || block?.type === 'inputText') return block.text ?? ''
    if (block?.content?.type === 'text') return block.content.text ?? ''
    return block?.text ?? ''
  }).join('\n')
}

const flowCard = (value) => /(?:work:\s*|card\s*#?|intent\s*#?)#?(\d+)/i.exec(flowText(value))?.[1] ?? null
const flowIntent = (value) => /(?:Claimed|Completed)\s+#(\d+)/.exec(flowText(value))?.[1] ?? null
const flowCandidate = (value) => /(?:^|\n)\s*(\S+)\s+—/.exec(flowText(value))?.[1] ?? null

const flowRole = (prompt) => {
  const text = String(prompt ?? '')
  if (/\b(?:implementer|build)\b/i.test(text)) return 'build'
  if (/\b(?:security|performance|api)-reviewer\b/i.test(text) || /\bspecialist\b/i.test(text)) return 'specialist'
  return null
}

const flowCall = async (client, name, args) => {
  return mcpCall(client, 'tools/call', { name, arguments: args }).catch((error) => ({ error: String(error) }))
}

const playFlow = async (state, prompt) => {
  // The first prompt is the standing brief sent while the flow is still
  // durably opening this Seat. Wait for the flow's own card order, otherwise
  // review_candidates races the journal before it records the Seat id.
  if (!FLOW || state.flowed || !/\bCard\s+#\d+\b/.test(String(prompt)) || !/\bFlow run\b/.test(String(prompt))) return
  state.flowed = true
  const client = mcpConnect(state)
  if (!client) return
  await mcpCall(client, 'initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'harnessdesk-shots-agent', version: '1.0.0' },
  })
  mcpNotify(client, 'notifications/initialized', {})
  // A flow seat is not a Room member, so await_work (which intentionally
  // speaks only to rooms) cannot discover its card. claim_next is the real
  // board operation for both a fresh card and one the flow already assigned.
  const claimed = await flowCall(client, 'claim_next', { files: FLOW.files })
  // Flow seats arrive already holding their exact card; the standing order's
  // card number is the authoritative fallback when the team tools correctly
  // refuse room-only claim_next for this non-room conversation.
  const claimedIntent = flowIntent(claimed) ?? flowCard(claimed) ?? flowCard(prompt) ?? (FLOW.intent === null ? null : String(FLOW.intent))
  if (!claimedIntent) return
  // Every camera seat carrying SHOT_FLOW is one of the shipped specialists;
  // the fallback keeps the worker correct even if an ACP omits the role name
  // from its standing-order text. The native build is handled by its own
  // marker-gated Codex fixture and never enters this process.
  const role = flowRole(prompt) ?? 'specialist'
  if (role === 'specialist') {
    const candidates = await flowCall(client, 'review_candidates', { intent: Number(claimedIntent) })
    const candidate = flowCandidate(candidates)
    if (!candidate) return
    const recorded = await flowCall(client, 'record_review', {
      intent: Number(claimedIntent), candidate, verdict: 'approve',
    })
    if (!/Recorded:\s+approve\b/.test(flowText(recorded))) return
  }
  if (FLOW.delayMs > 0) await sleep(FLOW.delayMs)
  const pass = flowPass()
  const outcome = role === 'specialist'
    ? 'approve'
    : FLOW.outcomes[Math.min(pass, FLOW.outcomes.length - 1)] ?? 'published'
  if (!outcome) return
  const result = await mcpCall(client, 'tools/call', {
    name: 'complete_claim', arguments: {
      intent: Number(claimedIntent), outcome,
      note: role === 'specialist' ? 'Approved the change.' : 'Built the change.',
      context: role === 'specialist'
        ? 'The shipped retry-status change is approved for the person.'
        : 'The retry-status change is ready for specialist review.',
    },
  }).catch(() => null)
  if (/Completed #/.test(JSON.stringify(result))) writeFileSync(FLOW.state, `${JSON.stringify({ pass: pass + 1 })}\n`)
}

const playRoomMessage = async (state) => {
  if (!ROOM_MESSAGE || state.roomMessageSent || (state.turnsPlayed ?? 0) !== ROOM_MESSAGE.onTurn) return
  state.roomMessageSent = true
  const client = mcpConnect(state)
  if (!client) return
  await mcpCall(client, 'initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'harnessdesk-shots-agent', version: '1.0.0' },
  })
  mcpNotify(client, 'notifications/initialized', {})
  await mcpCall(client, 'tools/call', { name: 'agent_message', arguments: { to: ROOM_MESSAGE.to, text: ROOM_MESSAGE.text } }).catch(() => null)
}

const remember = (state) => {
  if (!STORE) return
  const store = readStore()
  const kept = store[state.id]
  store[state.id] = {
    sessionId: state.id,
    cwd: state.cwd,
    // Named from the first thing asked, as a real agent names a session —
    // a seat's brief included, since an agent cannot tell a brief from a
    // person's prompt either. A placeholder here ("Claude conversation") was
    // a name no agent gives, and the sidebar showed it beside a header that
    // read the prompt.
    title: state.title ?? kept?.title ?? null,
    updatedAt: new Date().toISOString(),
    // A seeded conversation keeps its stored turns: renaming or touching it
    // never erases what `session/load` replays.
    turns: kept?.turns ?? [],
  }
  writeFileSync(STORE, `${JSON.stringify(store, null, 2)}\n`)
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
    // The result as content text, the way an agent that reports its output
    // for a reader sends it (DeepSeek Harness's server sends nothing else).
    // A bare `rawOutput: { text }` left the app only a JSON object to show,
    // and a photograph of `{ "text": "42 lines" }` is a picture of this
    // fixture, not of anything a person would see from a real agent.
    ...(output?.text ? { content: [{ type: 'content', content: { type: 'text', text: output.text } }] } : {}),
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
  /**
   * Three more, for `gif2.mjs`'s `hero` scenario alone — two agents in one
   * room, working the same piece rather than four agents each taking a
   * separate card. `TURNS[0]`'s own fix is reused almost verbatim (it is the
   * real change), with the ending rewritten to actually name the hand-off
   * ("Codex — …") rather than leaving it for a reader to infer; `TURNS[5]`
   * is the check that hand-off asks for, real enough that the ACP tool call
   * it announces (`browser_open`, the browser plugin's own name — see
   * `packages/plugins/src/browser.ts`) is what the browser pane's own
   * "driven by" mark reads while it is pending, which is why `gif2.mjs`
   * opens the real browser during exactly that window rather than whenever
   * is convenient; `TURNS[6]` is the reply once that check lands, a second,
   * later turn on the *same* session, which is what `SHOT_TURN`'s new list
   * form (`"4,6"`) exists for.
   */
  {
    think: 'The checkout client retries on a timeout but not on a 502, so a bad gateway surfaces to the customer as a failed order. Worth reading what the retry policy actually covers.',
    tools: [
      { id: 'h1', title: 'Read src/checkout/retry.ts', kind: 'read', input: { path: 'src/checkout/retry.ts' }, output: { text: '42 lines' } },
      { id: 'h2', title: 'Grep 50[0-9] in src/checkout', kind: 'search', input: { pattern: '50[0-9]', path: 'src/checkout' }, output: { text: '3 matches in 2 files' } },
      { id: 'h3', title: 'Edit src/checkout/retry.ts', kind: 'edit', input: { path: 'src/checkout/retry.ts' }, output: { text: '+14 −6' } },
    ],
    second: 'Only 503 and 504 are listed as retryable, and the backoff is a flat 200ms — three retries against a gateway that is still restarting is three failures in 600ms.',
    plan: ['Add 502 to the retryable set', 'Cap the backoff and add jitter', 'Ask Codex to check checkout end to end'],
    say: [
      '502 is retryable alongside 503 and 504 now, with exponential backoff capped at 2s and full jitter (`src/checkout/retry.ts`). Codex — can you check checkout end to end in the browser?',
    ],
  },
  {
    think: "Claude's retry fix just landed on retry.ts. Rather than read the diff, I will run the checkout flow for real and see whether a 502 actually recovers.",
    tools: [
      { id: 'c1', title: 'browser_open', kind: 'fetch', input: { url: 'http://127.0.0.1/checkout' }, output: { text: 'Checkout — order placed' }, ms: 1500 },
    ],
    second: 'The first attempt hit the simulated 502, the retry a moment later got through, and the order posted — the success banner just needs a beat before it agrees.',
    plan: ['Drive the checkout flow with a 502 in the middle', 'Confirm the order actually posts', 'Note anything that would still block a merge'],
    say: [
      'Checked: the 502 retried twice and the order placed. One nit, not blocking: the success banner shows before the second attempt finishes, so a slow retry reads as done a beat early.',
    ],
  },
  {
    say: ["Good catch — I'll tie the banner to the retry settling, not the request firing. Thanks, Codex."],
  },
  {
    say: ["On it. I'll make 502 retryable with a capped backoff, then ask Codex to check the finished checkout in the browser."],
  },
  {
  },
]

/**
 * `SHOT_TURN`'s indices, in the order this session should play them — the
 * last one repeats for every prompt past the list's own length, the same
 * "replay the one turn" behaviour a bare number always had.
 */
const TURN_LIST = String(process.env['SHOT_TURN'] ?? '0')
  .split(',')
  .map((one) => Number(one.trim()))
  .filter((one) => Number.isFinite(one))
const turnFor = (state) => {
  const n = state ? (state.turnsPlayed ?? 0) : 0
  if (state) state.turnsPlayed = n + 1
  const index = TURN_LIST[Math.min(n, TURN_LIST.length - 1)] ?? 0
  if (ROOM_TILE) {
    return {
      Claude: { say: ['502 is retryable now; the capped, jittered backoff gives the gateway time to recover.'] },
      Gemini: { say: ['Two 502 cases now pass, including the terminal case that preserves the original status.'] },
      Copilot: { say: ['Delivery-id keys make a 24-hour redelivery a safe no-op that still answers 200.'] },
      Antigravity: { say: ['Alert on distinct clients, not raw retry volume, so one noisy client cannot hide a real storm.'] },
    }[NAME] ?? TURNS[index % TURNS.length]
  }
  return TURNS[index % TURNS.length]
}

const playTurn = async (id) => {
  const stop = () => cancelled.has(id)
  const turn = turnFor(sessions.get(id))

  // A quick, real chat line before any reasoning shows — "On it." — for a
  // turn that answers another agent's ask rather than opening one. Optional:
  // every turn before this one had none, and still does not.
  if (turn.opening) {
    say(id, turn.opening)
    await sleep(500)
  }

  if (turn.think) {
    think(id, turn.think)
    await sleep(700)
    if (stop()) return 'cancelled'
  }

  const tools = turn.tools ?? []
  const [first, ...rest] = tools
  if (first) {
    await tool(id, { toolCallId: `tc-${first.id}`, title: first.title, kind: first.kind, input: first.input, output: first.output, ms: first.ms })
    if (stop()) return 'cancelled'
  }

  if (turn.second) {
    think(id, turn.second)
    await sleep(600)
  }

  const plan = turn.plan ?? []
  if (plan.length) {
    update(id, {
      sessionUpdate: 'plan',
      entries: plan.map((content, n) => ({ content, status: n === 0 ? 'in_progress' : 'pending' })),
    })
    await sleep(500)
  }

  for (const step of rest) {
    if (stop()) return 'cancelled'
    await tool(id, { toolCallId: `tc-${step.id}`, title: step.title, kind: step.kind, input: step.input, output: step.output, ms: step.ms })
  }

  if (plan.length) update(id, { sessionUpdate: 'plan', entries: plan.map((content) => ({ content, status: 'completed' })) })

  /* One chunk, not two.
     A conversation renders successive `agent_message_chunk`s as one growing
     message, but a room broadcasts what the agent has said so far — so two
     chunks arrive in the chat as the first sentence, then the first sentence
     and the second concatenated, and the column reads as if every agent
     stuttered. The paragraph break survives inside a single chunk. */
  say(id, (turn.say ?? []).join(''))
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
    const state = newSession(`s-${seq}`, params?.cwd ?? process.cwd(), params?.mcpServers)
    remember(state)
    reply(id, {
      sessionId: state.id,
      models: { currentModelId: state.modelId, availableModels: MODELS },
      ...(flowConfigOptions() ? { configOptions: flowConfigOptions() } : {}),
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan', description: 'Work out the steps first.' },
        ],
      },
    })
  },

  'session/list': (id, params) => {
    const failing = beside('list-fails')
    if (failing && existsSync(failing)) {
      return send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error', data: { details: 'the index is locked' } } })
    }
    const rows = Object.values(readStore()).map((entry) => ({
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      title: entry.title,
      updatedAt: entry.updatedAt,
    }))
    const perPage = readPage()
    if (!(perPage > 0)) return reply(id, { sessions: rows })
    // ACP's paging: a page, and a cursor for the next one while there is one.
    const from = Number(params?.cursor ?? 0)
    reply(id, {
      sessions: rows.slice(from, from + perPage),
      ...(from + perPage < rows.length ? { nextCursor: String(from + perPage) } : {}),
    })
  },

  'session/load': (id, params) => {
    const store = readStore()
    const entry = store[params.sessionId]
    if (!entry) return fail(id, `no stored session ${params.sessionId}`)
    const state = newSession(entry.sessionId, entry.cwd)
    // Reopened under the name it was stored with, so a first prompt here does
    // not rename a seeded conversation after itself.
    if (entry.title) state.title = entry.title
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
      ...(flowConfigOptions() ? { configOptions: flowConfigOptions() } : {}),
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

  'session/set_config_option': (id, params) => {
    if (!FLOW) return fail(id, 'no such option')
    reply(id, {
      configOptions: [
        {
          id: params?.configId === 'permissions' ? 'permissions' : 'approvalsReviewer',
          name: params?.configId === 'permissions' ? 'Permissions' : 'Approvals',
          category: 'other', type: 'select', currentValue: params?.value === undefined ? ':read-only' : params.value,
          options: params?.configId === 'permissions'
            ? [{ value: ':read-only', name: 'Read only' }, { value: ':workspace', name: 'Workspace write' }]
            : [{ value: 'user', name: 'Ask me' }],
        },
      ],
    })
  },

  'session/prompt': async (id, params) => {
    const failing = beside('prompt-fails')
    if (failing && existsSync(failing)) {
      return send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error', data: { details: 'the session is owned by another process' } } })
    }
    const sessionId = params.sessionId
    cancelled.delete(sessionId)
    const state = sessions.get(sessionId)
    const asked = (params.prompt ?? []).find((block) => block?.type === 'text')?.text?.split('\n').find((line) => line.trim())
    if (state && !state.title && asked) {
      state.title = asked.trim()
      remember(state)
    }
    // Claimed once, on this seat's first turn — never repeated on a second
    // prompt to the same session, the way a real agent would not re-claim
    // work it already holds.
    if (state && !state.claimed) {
      state.claimed = true
      await playClaim(state).catch(() => {})
    }
    const promptText = (params.prompt ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n')
    await playFlow(state, promptText).catch(() => {})
    await playRoomMessage(state).catch(() => {})
    const stopReason = await playTurn(sessionId)
    // A window only when the seat's usage names one — an agent that never
    // sends a size, like the real Cursor CLI, must not gain one by being
    // asked twice. A composition (`breakdown`) travels on the same update,
    // in the extension slot the real DeepSeek Harness bridge uses.
    if (USAGE && (USAGE.size != null || USAGE.breakdown)) {
      update(sessionId, {
        sessionUpdate: 'usage_update',
        ...(USAGE.size != null ? { used: USAGE.used, size: USAGE.size } : {}),
        ...(USAGE.cost ? { cost: USAGE.cost } : {}),
        ...(USAGE.breakdown ? { _meta: { harnessdesk: { contextBreakdown: USAGE.breakdown } } } : {}),
      })
    }
    reply(id, { stopReason, ...(USAGE?.last ? { usage: USAGE.last } : {}) })
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
