#!/usr/bin/env node
/**
 * A scripted ACP agent, as a real child process.
 *
 * Speaks Agent Client Protocol v1 over stdio the way the adapter expects a
 * conforming agent to: initialize → session/new → session/prompt with
 * session/update notifications, permission requests, cancellation, modes and
 * config options. Deliberately un-Codex vocabulary throughout — a "voice"
 * select and a "verbose" toggle — so anything Codex-shaped in the layers
 * above fails here.
 *
 * Scripted behaviours, keyed on the prompt text:
 *  - "use the tool"   → emits a tool_call, asks permission, completes or
 *                       fails it by the chosen option
 *  - "think"          → emits a thought chunk before the answer
 *  - "slow"           → answers only after 10s (interrupt target)
 *  - anything else    → two message chunks and end_turn
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * With FAKE_ACP_STORE set, completed conversations persist to that file and
 * session/list + session/load serve them — mirroring how Claude Code keeps
 * its own store, so the adapter's resume path is tested across "restarts".
 */
const STORE = process.env.FAKE_ACP_STORE ?? null
/**
 * The ways `session/list` can fail to say where a conversation ran while
 * `session/load` still serves it, which a client asking the listing where to
 * reopen one has to survive:
 *  - FAKE_ACP_UNLISTED=<id>,<id>… leaves those out of it. Claude Code's
 *    bridge skips a conversation its own listing has no folder for, and
 *    Cursor's lists only the workspaces it has been shown.
 *  - FAKE_ACP_LIST_PAGE=<n> answers n rows a page and a `nextCursor` for the
 *    rest, as ACP's `session/list` allows, so a row past the first page is
 *    found only by asking for the next. With FAKE_ACP_LIST_STUCK=1 every page
 *    hands back its own cursor as the next one, and with FAKE_ACP_LIST_ENDLESS=1
 *    every page names a new next one, past the last row as well: the two
 *    walks that never end, which a client reading the pages has to notice.
 *  - FAKE_ACP_NO_LIST=1 declares `loadSession` and no listing, and answers
 *    `session/list` as Gemini CLI 0.59.0 does: -32601, "Method not found".
 *  - FAKE_ACP_LIST_FAILS=1 declares a listing and fails every call to it;
 *    `later` answers the first page and fails every one after it.
 * FAKE_ACP_UNLOADABLE=<id> is the other way round: listed, and refused when
 * it is loaded, with the reason in `data` the way Claude Code gives one.
 * FAKE_ACP_OPENS=<file> records every session it is asked to open, new or
 * loaded, with the folder it was handed, one JSON line each.
 */
const UNLISTED = new Set((process.env.FAKE_ACP_UNLISTED ?? '').split(',').filter(Boolean))
const LIST_PAGE = Number(process.env.FAKE_ACP_LIST_PAGE ?? 0)
const NO_LIST = process.env.FAKE_ACP_NO_LIST === '1'
const recordOpen = (method, sessionId, cwd) => {
  if (process.env.FAKE_ACP_OPENS) {
    appendFileSync(process.env.FAKE_ACP_OPENS, `${JSON.stringify({ method, sessionId, cwd })}\n`)
  }
}
const CONFIG_MODEL_ONLY = process.env.FAKE_ACP_CONFIG_MODEL_ONLY === '1'
const readStore = () => {
  if (!STORE) return {}
  try { return JSON.parse(readFileSync(STORE, 'utf8')) } catch { return {} }
}
const writeStore = (data) => {
  if (STORE) writeFileSync(STORE, JSON.stringify(data))
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
// `data` is optional and rarely used, but real agents lean on it: Claude Code
// answers a load it cannot serve with a terse message and the reason in
// `data.details`, which is the half a user can act on.
const fail = (id, message, data) =>
  send({ jsonrpc: '2.0', id, error: { code: -32600, message, ...(data ? { data } : {}) } })
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })

let nextOutgoingId = 1000
const pendingOutgoing = new Map()
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++nextOutgoingId
    pendingOutgoing.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })

let sessionCounter = 0
const sessions = new Map()
const cancelled = new Set()

const newSession = (id0, cwd) => {
  const id = id0 ?? `acp-session-${Date.now().toString(36)}-${++sessionCounter}`
  const state = {
    id,
    // Where the conversation ran. A real agent stores this and hands it back
    // when the session is listed, which is the only way a client can know
    // where to reopen it.
    cwd: cwd ?? '/w',
    modeId: 'chatty',
    modelId: 'small',
    options: {
      voice: 'plain',
      verbose: false,
      auto_approve: false,
      ponder: 'default',
      // A control that exists but cannot be moved — see `configOptionsOf`.
      wide: false,
    },
  }
  sessions.set(id, state)
  return state
}

const configOptionsOf = (state) => [
  ...(CONFIG_MODEL_ONLY ? [{
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: state.modelId,
    options: [
      { value: 'small', name: 'Small' },
      { value: 'large', name: 'Large' },
    ],
  }] : []),
  {
    id: 'voice',
    name: 'Voice',
    description: 'How the fake answers.',
    type: 'select',
    currentValue: state.options.voice,
    options: [
      { value: 'plain', name: 'Plain' },
      { value: 'pirate', name: 'Pirate', description: 'Yarr.' },
    ],
  },
  {
    id: 'verbose',
    name: 'Verbose',
    type: 'toggle',
    currentValue: state.options.verbose,
  },
  {
    id: 'auto_approve',
    name: 'Auto-approve tools',
    description: 'Automatically approve all tool calls without asking for permission.',
    // Cline 3.x reports the ACP-native boolean shape rather than the older
    // toggle spelling; keep the fixture on the wire shape we need to support.
    type: 'boolean',
    currentValue: state.options.auto_approve,
  },
  // A thought-level control the un-Codex way: the levels belong to whatever
  // model is current, which is all a conforming agent can declare.
  // A control the agent declares, shows the state of, and will not let you
  // change. Real agents have these: Cursor greys Max mode on a family with one
  // context window, and it reads `false` because that is what it is. Setting
  // it to `false` is asking for what is already true, and must be allowed;
  // setting it to `true` is asking for something this agent cannot do.
  {
    id: 'wide',
    name: 'Wide window',
    type: 'toggle',
    currentValue: state.options.wide,
    disabled: 'The fake has one window; there is no wider one to switch to.',
  },
  {
    id: 'ponder',
    name: 'Pondering',
    description: 'How long the fake stares into the middle distance.',
    category: 'thought_level',
    type: 'select',
    currentValue: state.options.ponder,
    options: [
      { value: 'default', name: 'Default', description: "The fake's own choice." },
      { value: 'brief', name: 'Brief' },
      { value: 'long', name: 'Long' },
    ],
  },
]

const update = (sessionId, body) => notify('session/update', { sessionId, update: body })

const runPrompt = async (id, params) => {
  const state = sessions.get(params.sessionId)
  if (!state) return fail(id, `no session ${params.sessionId}`)
  const text = (params.prompt ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join(' ')

  const say = (chunk) =>
    update(state.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } })

  if (process.env.FAKE_ACP_PROMPT_AUTH_REQUIRED === '1') {
    send({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: 'Please log in to use Devin. Use `/login` to authenticate again.',
      },
    })
    return
  }

  if (process.env.FAKE_ACP_PROMPT_ERROR === '1') {
    send({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: 'Internal server error: model backend timed out',
      },
    })
    return
  }

  if (handleTaskPrompt(state, text.trim())) {
    say('ok.')
    return reply(id, { stopReason: 'end_turn' })
  }

  if (text.includes('echo blocks')) {
    say(JSON.stringify(params.prompt ?? []))
    return reply(id, { stopReason: 'end_turn' })
  }

  if (text.includes('omit stop reason')) {
    say('finished without explicit stop reason')
    return reply(id, { usage: null })
  }

  if (text.includes('null stop reason')) {
    say('finished with null stop reason')
    return reply(id, { stopReason: null })
  }

  if (text.includes('fail with detail')) {
    return fail(id, 'Internal error', { details: 'the session is owned by another process' })
  }

  if (text.includes('slow')) {
    for (let waited = 0; waited < 10_000; waited += 50) {
      if (cancelled.has(state.id)) {
        cancelled.delete(state.id)
        return reply(id, { stopReason: 'cancelled' })
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    say('finally.')
    return reply(id, { stopReason: 'end_turn' })
  }

  if (text.includes('think')) {
    update(state.id, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'pondering quietly' },
    })
  }

  if (text.includes('ask me')) {
    // What our Claude bridge sends for one `AskUserQuestion`: a permission
    // request whose options are the answers, the question beside them.
    const question = {
      question: 'Which library should we use?',
      header: 'Library',
      multiSelect: false,
      options: [
        { label: 'date-fns', description: 'Small, tree-shakeable.' },
        { label: 'dayjs', description: 'Moment-compatible API.' },
      ],
    }
    const { outcome } = await request('session/request_permission', {
      sessionId: state.id,
      toolCall: { toolCallId: 'ask-1', title: question.question, kind: 'think', rawInput: { questions: [question] } },
      options: [
        { optionId: 'answer-0', name: 'date-fns', kind: 'allow_once' },
        { optionId: 'answer-1', name: 'dayjs', kind: 'allow_once' },
      ],
      _meta: { harnessdesk: { question } },
    })
    const chosen = outcome.outcome === 'selected' ? outcome.optionId : 'none'
    say(`you chose ${chosen}.`)
    return reply(id, { stopReason: 'end_turn' })
  }

  if (text.includes('notice me')) {
    // A user-role chunk the agent owns up to as its own housekeeping, live:
    // what DeepSeek Harness relays when a child reports back.
    update(state.id, {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Agent child-1 sent a message: tests pass.' },
      _meta: { harnessdesk: { notice: true, from: { kind: 'agent-message', senderSessionId: 'child-1' } } },
    })
    say('noted.')
    return reply(id, { stopReason: 'end_turn' })
  }

  if (text.includes('use the tool')) {
    update(state.id, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'poke_the_thing',
      kind: 'other',
      status: 'pending',
      rawInput: { target: 'the thing' },
    })
    if (state.options.auto_approve) {
      update(state.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
        rawOutput: { poked: true },
      })
      say('poked it.')
      return reply(id, { stopReason: 'end_turn' })
    }
    const { outcome } = await request('session/request_permission', {
      sessionId: state.id,
      // A real agent says why: Claude Code and DeepSeek Harness both attach
      // the explanation to the request's own tool call, as content blocks.
      toolCall: {
        toolCallId: 'tc-1',
        title: 'poke_the_thing',
        content: [{ type: 'content', content: { type: 'text', text: 'the thing is outside the workspace' } }],
      },
      options: [
        { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    })
    if (outcome.outcome === 'selected' && outcome.optionId !== 'no') {
      update(state.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
        rawOutput: { poked: true },
      })
      say('poked it.')
      return reply(id, { stopReason: 'end_turn' })
    }
    update(state.id, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'failed' })
    say('fine, not poking it.')
    return reply(id, { stopReason: 'end_turn' })
  }

  if (text.includes('use tool with malformed content')) {
    update(state.id, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-null-block',
      title: 'poke_with_null_block',
      kind: 'other',
      status: 'pending',
      rawInput: { target: 'the thing' },
    })
    const { outcome } = await request('session/request_permission', {
      sessionId: state.id,
      toolCall: {
        toolCallId: 'tc-null-block',
        title: 'poke_with_null_block',
        content: [null, { type: 'content', content: { type: 'text', text: 'reason despite null block' } }],
      },
      options: [
        { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    })
    if (outcome.outcome === 'selected' && outcome.optionId !== 'no') {
      update(state.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-null-block',
        status: 'completed',
        rawOutput: { poked: true },
      })
      say('poked it.')
      return reply(id, { stopReason: 'end_turn' })
    }
    update(state.id, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-null-block', status: 'failed' })
    say('fine, not poking it.')
    return reply(id, { stopReason: 'end_turn' })
  }

  if (text.includes('tool update with null content')) {
    update(state.id, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-null-content',
      title: 'test_tool',
      kind: 'other',
      status: 'pending',
    })
    update(state.id, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-null-content',
      status: 'completed',
      content: [null, { type: 'content', content: null }],
      rawOutput: { ok: true },
    })
    say('handled null content update.')
    return reply(id, { stopReason: 'end_turn' })
  }

  // The way Claude Code's bridge actually talks: one call announced twice —
  // the permission flow first, with a bare title, then the stream again with
  // the real input — and one call whose only notice is its completion.
  if (text.includes('announce twice')) {
    update(state.id, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-twice',
      title: 'Terminal',
      kind: 'execute',
      status: 'pending',
    })
    update(state.id, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-twice',
      title: '`cat notes.txt`',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'cat notes.txt', description: 'Show the notes' },
    })
    update(state.id, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-twice',
      status: 'completed',
      rawOutput: { stdout: 'the notes' },
    })
    update(state.id, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-orphan',
      title: 'Read File',
      status: 'completed',
      rawOutput: { text: 'late but here' },
    })
    say('did both.')
    return reply(id, { stopReason: 'end_turn' })
  }

  if (STORE) {
    const store = readStore()
    // Named the way an agent names a conversation — its own summary, not the
    // words the user typed. What the client shows must be this.
    const named = text.replace(/<context[^>]*>[\s\S]*?<\/context>/g, '').trim().slice(0, 40)
    const entry = store[state.id] ?? { sessionId: state.id, cwd: state.cwd, title: `A chat about ${named}`, updatedAt: new Date().toISOString(), turns: [] }
    // Stored the way Claude Code stores it: one entry per content block —
    // text as text, an image as the block itself, bytes and all.
    entry.turns.push(
      (params.prompt ?? [])
        .filter((block) => block.type === 'text' || block.type === 'image')
        .map((block) => (block.type === 'text' ? block.text : block)),
    )
    entry.updatedAt = new Date().toISOString()
    store[state.id] = entry
    writeStore(store)
  }
  const flavour = state.options.voice === 'pirate' ? 'yarr, ' : ''
  say(`${flavour}hearing: ${text}`)
  say(state.options.verbose ? ' …and at great length.' : ' done.')
  update(state.id, {
    sessionUpdate: 'plan',
    entries: [
      { content: 'listen', status: 'completed' },
      { content: 'answer', status: 'in_progress' },
    ],
  })
  if (text.includes('compose')) {
    // The `_meta` an agent attaches when it can say what the context is made
    // of, plus two segments the adapter must throw away: one with no tokens
    // and one with no id. `_meta` is where anyone may put anything.
    update(state.id, {
      sessionUpdate: 'usage_update',
      used: 4321,
      size: 32000,
      _meta: {
        harnessdesk: {
          contextBreakdown: {
            approximate: true,
            source: 'a fake meter',
            segments: [
              { id: 'system', label: 'System prompt', tokens: 700 },
              { id: 'tools', label: 'Tool schemas', tokens: 4300, count: 15 },
              { id: 'empty', label: 'Nothing', tokens: 0 },
              { label: 'Anonymous', tokens: 12 },
            ],
          },
        },
      },
    })
    // A second fill with no composition on it: the composition must survive,
    // because the two move on different events.
    update(state.id, { sessionUpdate: 'usage_update', used: 4400, size: 32000 })
    return reply(id, { stopReason: 'end_turn' })
  }
  // --- delegation, the extension channel -----------------------------------
  //
  // `deleg spawn` starts one and leaves it running; `deleg finish` reports the
  // same id as completed, which a later turn can do — that is the sequence
  // that put a second row on the wrong turn. `deleg floor` reports a child
  // whose output count is still a streaming placeholder. `deleg refused` and
  // `deleg cancelled` report a running child and then end the turn some way
  // other than as asked: the row is there, and the turn is not a finished one.
  if (text.startsWith('deleg ')) {
    const [, verb] = text.split(/\s+/)
    const one = (over) => ({
      id: 'd1',
      label: 'Explore',
      prompt: 'look around',
      models: ['fake-child'],
      startedAt: 1,
      calls: 1,
      ...over,
    })
    if (verb === 'spawn' || verb === 'refused' || verb === 'cancelled') {
      notify('_harnessdesk/delegation/changed', {
        sessionId: state.id,
        delegations: [one({ state: 'running', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedReadTokens: 0, cachedWriteTokens: 0, outputExact: true } })],
        delegated: { inputTokens: 10, outputTokens: 2, totalTokens: 12, outputExact: true },
      })
    }
    if (verb === 'finish') {
      notify('_harnessdesk/delegation/changed', {
        sessionId: state.id,
        delegations: [one({ state: 'completed', endedAt: 2, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedReadTokens: 0, cachedWriteTokens: 0, outputExact: true } })],
        delegated: { inputTokens: 10, outputTokens: 2, totalTokens: 12, outputExact: true },
      })
    }
    if (verb === 'floor') {
      notify('_harnessdesk/delegation/changed', {
        sessionId: state.id,
        delegations: [one({ id: 'd2', state: 'running', usage: { inputTokens: 900, outputTokens: 1, totalTokens: 901, outputExact: false } })],
        delegated: { inputTokens: 900, outputTokens: 1, totalTokens: 901, outputExact: false },
      })
    }
    return reply(id, {
      stopReason: verb === 'refused' ? 'refusal' : verb === 'cancelled' ? 'cancelled' : 'end_turn',
    })
  }
  // A turn that reports cache writes, and one that says nothing about them —
  // the pair that decides whether a running total may claim to be exact.
  if (text === 'writes') {
    return reply(id, {
      stopReason: 'end_turn',
      usage: { totalTokens: 150, inputTokens: 100, outputTokens: 50, cachedReadTokens: 20, cachedWriteTokens: 50 },
    })
  }
  if (text === 'split') {
    return reply(id, {
      stopReason: 'end_turn',
      usage: { totalTokens: 170, inputTokens: 100, outputTokens: 20, cachedReadTokens: 20, cachedWriteTokens: 50 },
      _meta: { harnessdesk: { inputTokensAreUncached: true } },
    })
  }
  if (text === 'nowrites') {
    return reply(id, {
      stopReason: 'end_turn',
      usage: { totalTokens: 60, inputTokens: 40, outputTokens: 20, cachedReadTokens: 10 },
    })
  }
  if (text.includes('quota')) {
    // Gemini CLI's way of counting a turn (0.59.0): no `usage`, no
    // `usage_update` — the sums in `_meta.quota`, then the same split per
    // model, which the adapter has no use for.
    return reply(id, {
      stopReason: 'end_turn',
      _meta: {
        quota: {
          token_count: { input_tokens: 12400, output_tokens: 380 },
          model_usage: [{ model: 'fake-flash', token_count: { input_tokens: 12400, output_tokens: 380 } }],
        },
      },
    })
  }
  if (text.includes('count')) {
    // ACP's unstable usage shapes, both halves: the fill as a session
    // update, the turn's tokens on the reply. Un-Claude, un-Codex numbers.
    update(state.id, { sessionUpdate: 'usage_update', used: 4321, size: 32000, cost: { amount: 0.5, currency: 'EUR' } })
    return reply(id, {
      stopReason: 'end_turn',
      usage: { totalTokens: 900, inputTokens: 800, outputTokens: 100, cachedReadTokens: 600, thoughtTokens: 25 },
    })
  }
  return reply(id, await closingReply(state))
}

/**
 * How an ordinary turn closes, for the rigs that photograph a usage ring.
 * Off unless set, so the adapter's own suite sees the plain reply.
 *  - FAKE_ACP_USAGE=quota answers as Gemini CLI does (0.59.0): no `usage`,
 *    the turn's tokens in `_meta.quota`.
 *  - FAKE_ACP_AGY_STORE=<a .gemini folder> answers as Antigravity's server
 *    does: nothing about usage on the wire, and the turn's model calls
 *    written to a conversation store laid out the way that server lays out
 *    its own, held open for as long as the agent runs.
 */
const closingReply = async (state) => {
  state.turn = (state.turn ?? 0) + 1
  if (process.env.FAKE_ACP_USAGE === 'quota') {
    const counts = { input_tokens: 11800 + 3100 * state.turn, output_tokens: 240 + 90 * state.turn }
    return {
      stopReason: 'end_turn',
      _meta: { quota: { token_count: counts, model_usage: [{ model: state.modelId, token_count: counts }] } },
    }
  }
  if (process.env.FAKE_ACP_AGY_STORE) await recordAgyCalls(state)
  return { stopReason: 'end_turn' }
}

const agyStores = new Map()

/** Two model calls a turn, the context growing call on call and most of it cached. */
const recordAgyCalls = async (state) => {
  let store = agyStores.get(state.id)
  if (!store) {
    const { DatabaseSync } = await import('node:sqlite')
    const folder = join(process.env.FAKE_ACP_AGY_STORE, 'antigravity-acp', 'conversations')
    mkdirSync(folder, { recursive: true })
    const db = new DatabaseSync(join(folder, `${state.id}.db`))
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('CREATE TABLE IF NOT EXISTS `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))')
    store = { db, next: 0 }
    agyStores.set(state.id, store)
  }
  const cached = 9000 + 6500 * (state.turn - 1)
  for (const [input, read, thinking, response] of [
    [2400, cached, 310, 96],
    [1800, cached + 2600, 120, 180],
  ]) {
    const data = agyCall({ input, read, thinking, response })
    store.db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(store.next++, data, data.length)
  }
}

const pbVarint = (value) => {
  const out = []
  let rest = value
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  out.push(rest)
  return out
}
const pbInt = (field, value) => [...pbVarint(field * 8), ...pbVarint(value)]
const pbBytes = (field, body) => [...pbVarint(field * 8 + 2), ...pbVarint(body.length), ...body]

/** A `gen_metadata` row as Antigravity writes one: field 1 the call, field 4 in it Codeium's `ModelUsageStats`. */
const agyCall = ({ input, read, thinking, response }) =>
  Uint8Array.from(
    pbBytes(1, [
      ...pbInt(3, 326),
      ...pbBytes(4, [...pbInt(2, input), ...pbInt(3, thinking + response), ...pbInt(5, read), ...pbInt(9, thinking), ...pbInt(10, response)]),
      ...pbBytes(19, [...Buffer.from('gemini-3.8-flash')]),
    ]),
  )

/**
 * The background-task extension, agent side.
 *
 * Off unless FAKE_ACP_TASKS=1, because most ACP agents have no such concept
 * and the honest thing for them is to have no panel at all — that state needs
 * a fixture too, and it is this one with the flag unset.
 *
 * A prompt of `bg <command>` starts one, `endbg <id>` ends it. The whole list
 * is pushed on every change, and the three requests are served.
 */
const TASKS = process.env.FAKE_ACP_TASKS === '1'

/** Whether this agent serves `_harnessdesk/session/delete`. Off by default. */
const DELETES = process.env.FAKE_ACP_DELETE === '1'

/**
 * Phase 12's attachment extension, agent side. Off by default — most ACP
 * agents have never heard of it, and that is the state a conformance suite
 * needs to see honestly reported as `unsupported`, not merely untested.
 *
 *  - FAKE_ACP_ATTACHMENTS=1 declares `{version:1, skills:true, mcp:true,
 *    suppressUnapproved:true}` at `initialize` and actually answers
 *    `_harnessdesk/attachment_receipt` from what `session/new`/`session/load`
 *    handed it under `_meta.harnessdesk.attachments.input` — an honest
 *    fake, the way `FakeRuntime` on the host side is.
 *  - FAKE_ACP_ATTACHMENTS_VERSION=<n> declares a different version number.
 *  - FAKE_ACP_ATTACHMENTS_MALFORMED=1 declares the capability with a
 *    non-boolean field, which a strict decoder must refuse.
 *  - FAKE_ACP_ATTACHMENTS_RECEIPT=<json> overrides the honest receipt this
 *    agent would otherwise answer, for a test that wants to hand the host a
 *    dishonest one (wrong key, an extra unrequested item, excess bytes).
 */
const ATTACHMENTS = process.env.FAKE_ACP_ATTACHMENTS === '1'
const attachmentsBySession = new Map()

/**
 * Whether this agent answers ACP's own `logout` and declares it in
 * `agentCapabilities.auth`, the way Google Antigravity's server does. Off by
 * default: most ACP agents hold no credentials of their own, and an agent
 * that declares nothing must never be asked. FAKE_ACP_LOGOUT_FAILS=1 plays
 * one that declares it and then refuses the call.
 */
const LOGS_OUT = process.env.FAKE_ACP_LOGOUT === '1' || process.env.FAKE_ACP_LOGOUT_FAILS === '1'
/**
 * FAKE_ACP_LOGOUT_NULL=1 plays the other half of ACP's rule: the capability
 * is *present and null*, which means exactly what omitting it means — the
 * agent does not support `logout`, and a client MUST NOT call it. Such an
 * agent still refuses the request, which is how a client that ignores the
 * rule is caught.
 */
const LOGOUT_NULL = process.env.FAKE_ACP_LOGOUT_NULL === '1'
/** Set by a served `logout`, after which this agent opens nothing. */
let signedOut = false
const tasks = new Map()
let taskCounter = 0

const pushTasks = (sessionId) => {
  if (!TASKS) return
  send({
    jsonrpc: '2.0',
    method: '_harnessdesk/tasks/changed',
    params: { sessionId, tasks: [...tasks.values()] },
  })
}

/** Returns true when the prompt was a task command and has been handled. */
const handleTaskPrompt = (state, text) => {
  if (!TASKS) return false
  const starting = /^bg\s+(.+)$/.exec(text)
  if (starting) {
    taskCounter += 1
    const id = `t${taskCounter}`
    tasks.set(id, {
      id,
      label: `Run ${starting[1]}`,
      kind: 'command',
      state: 'running',
      command: starting[1],
      cwd: state.cwd ?? null,
      startedAt: Date.now(),
      stoppable: true,
    })
    pushTasks(state.id)
    return true
  }
  const ending = /^endbg\s+(\S+)$/.exec(text)
  if (ending) {
    const task = tasks.get(ending[1])
    if (task) tasks.set(task.id, { ...task, state: 'completed', endedAt: Date.now(), stoppable: false })
    pushTasks(state.id)
    return true
  }
  return false
}

const handlers = {
  initialize: (id, params) => {
    // The refusals from the agent's side: a client that offers fs or terminal is a
    // client this fake refuses, so the declines can never quietly regress.
    const caps = params?.clientCapabilities ?? {}
    if (caps.fs?.readTextFile || caps.fs?.writeTextFile || caps.terminal) {
      return fail(id, 'this fake refuses clients that offer fs or terminal capabilities')
    }
    reply(id, {
      protocolVersion: 1,
      // The process id as the version, so a test can tell a restart from a
      // reconnect; FAKE_ACP_AGENT_VERSION overrides it.
      agentInfo: { name: 'fake-acp-agent', version: process.env.FAKE_ACP_AGENT_VERSION ?? String(process.pid) },
      agentCapabilities: {
        loadSession: Boolean(STORE),
        // FAKE_ACP_NO_IMAGES=1 plays an agent that cannot look at pictures.
        promptCapabilities: { image: process.env.FAKE_ACP_NO_IMAGES !== '1' },
        ...(STORE && !NO_LIST ? { sessionCapabilities: { list: {}, resume: {} } } : {}),
        /* `{}` is the only yes; `null` is a no that is spelled out rather
           than omitted, and both are on the wire. */
        ...(LOGS_OUT ? { auth: { logout: {} } } : LOGOUT_NULL ? { auth: { logout: null } } : {}),
      },
      authMethods: process.env.FAKE_ACP_AUTH_METHODS
        ? JSON.parse(process.env.FAKE_ACP_AUTH_METHODS)
        : [
            { id: 'device', name: 'Sign in on the agent side', description: 'Run the agent login.' },
          ],
      ...(TASKS || DELETES || ATTACHMENTS
        ? {
            _meta: {
              harnessdesk: {
                ...(TASKS ? { backgroundTasks: true } : {}),
                // FAKE_ACP_DELETE=1 plays a bridge that knows where its agent
                // writes. Most ACP agents do not, and declare nothing.
                ...(DELETES ? { deleteSession: true } : {}),
                ...(ATTACHMENTS
                  ? {
                      attachments: process.env.FAKE_ACP_ATTACHMENTS_MALFORMED
                        ? { version: 1, skills: 'yes', mcp: true, suppressUnapproved: true }
                        : {
                            version: Number(process.env.FAKE_ACP_ATTACHMENTS_VERSION ?? 1),
                            skills: true,
                            mcp: true,
                            suppressUnapproved: true,
                          },
                    }
                  : {}),
              },
            },
          }
        : {}),
    })
  },
  /* ACP's own sign-in. Answers nothing, as the schema has it, and takes
     however long the sign-in takes — the real ones open a browser inside
     this call. FAKE_ACP_AUTH_MS delays the reply so a test can watch the
     pending state and cancel it; FAKE_ACP_AUTH_FAILS=1 refuses it. */
  authenticate: (id, params) => {
    const known = (process.env.FAKE_ACP_AUTH_METHODS
      ? JSON.parse(process.env.FAKE_ACP_AUTH_METHODS)
      : [{ id: 'device' }]
    ).map((m) => m.id)
    if (!known.includes(params?.methodId)) return fail(id, `unknown auth method ${String(params?.methodId)}`)
    const answer = () => {
      if (process.env.FAKE_ACP_AUTH_FAILS === '1') return fail(id, 'the browser flow was refused. Try again.')
      // Signed in, so the sessions this agent was refusing now open.
      signedOut = false
      delete process.env.FAKE_ACP_AUTH_REQUIRED
      reply(id, {})
    }
    const wait = Number(process.env.FAKE_ACP_AUTH_MS ?? 0)
    if (wait > 0) setTimeout(answer, wait)
    else answer()
  },
  // ACP's own sign-out. Served only when it was declared: an agent that
  // never put `auth.logout` in its capabilities and is asked anyway should
  // answer the way any agent answers a method it does not have.
  logout: (id) => {
    // Including the `null` form: declaring it null is declaring no support.
    if (!LOGS_OUT) return fail(id, 'Method not found: logout')
    if (process.env.FAKE_ACP_LOGOUT_FAILS === '1') return fail(id, 'the keychain refused to give up the token')
    signedOut = true
    reply(id, {})
  },
  'session/new': (id, params) => {
    // FAKE_ACP_SLOW_OPEN_MS=<n> answers an open that carries no tool server n ms
    // late, as a loaded machine does: the retry after a refusal then lands
    // after the refusal has been seen (#215).
    const slow = Number(process.env.FAKE_ACP_SLOW_OPEN_MS ?? 0)
    if (slow > 0 && (params?.mcpServers?.length ?? 0) === 0 && !params?.late) {
      setTimeout(() => handlers['session/new'](id, { ...params, late: true }), slow)
      return
    }
    // FAKE_ACP_AUTH_REQUIRED=1 plays an agent that wants a sign-in before it
    // opens anything — ACP's auth_required, code and words both, as Google
    // Antigravity's server answers it.
    // FAKE_ACP_AUTH_REQUIRED_AFTER=<n> plays a sign-in that lapses: the first
    // n opens succeed and every later one is refused the same way.
    const opensSoFar = (globalThis.__opens = (globalThis.__opens ?? 0) + 1)
    const lapsed =
      process.env.FAKE_ACP_AUTH_REQUIRED_AFTER !== undefined &&
      opensSoFar > Number(process.env.FAKE_ACP_AUTH_REQUIRED_AFTER)
    // FAKE_ACP_SERVER_ERROR=1 plays an agent that fails to open a session
    // for some other reason, under JSON-RPC's generic server-error code —
    // the same number ACP gives auth_required, without the words.
    if (process.env.FAKE_ACP_SERVER_ERROR === '1') {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Internal server error', data: { details: 'the model backend timed out' } } })
      return
    }
    if (process.env.FAKE_ACP_AUTH_REQUIRED === '1' || lapsed || signedOut) {
      send({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: 'Authentication required',
          data: { message: 'No authentication method selected. Call `authenticate` with one of: device.' },
        },
      })
      return
    }
    // FAKE_ACP_REFUSE_TOOLS makes this agent behave like DeepSeek Harness,
    // OpenClaw, or cursor-agent: it will not be handed an MCP tool server on
    // the session request, and says so in the words the caller learns from.
    if (process.env.FAKE_ACP_REFUSE_TOOLS && (params?.mcpServers?.length ?? 0) > 0) {
      if (process.env.FAKE_ACP_REFUSE_TOOLS === 'openclaw') {
        fail(id, 'Internal error', {
          details: 'ACP bridge mode does not support per-session MCP servers. Configure MCP on the OpenClaw gateway or agent instead.',
        })
        return
      }
      fail(id, 'Invalid params: mcpServers is not supported')
      return
    }
    // FAKE_ACP_DUMP_SERVERS names a file to write the received mcpServers to,
    // so a test can see exactly what an agent would spawn — env and all.
    if (process.env.FAKE_ACP_DUMP_SERVERS) {
      try {
        writeFileSync(process.env.FAKE_ACP_DUMP_SERVERS, JSON.stringify(params?.mcpServers ?? []))
      } catch {}
    }
    const state = newSession(undefined, params?.cwd)
    recordOpen('session/new', state.id, params?.cwd)
    if (ATTACHMENTS && params?._meta?.harnessdesk?.attachments) {
      attachmentsBySession.set(state.id, params._meta.harnessdesk.attachments.input)
    }
    reply(id, {
      sessionId: state.id,
      ...(CONFIG_MODEL_ONLY ? {} : { models: {
        currentModelId: state.modelId,
        availableModels: [
          { modelId: 'small', name: 'Small' },
          {
            modelId: 'large',
            name: 'Large',
            description: 'Slower, wiser.',
            // The per-model form: this model thinks harder than the session
            // option can say, and says so in ACP's extension slot.
            _meta: {
              harnessdesk: {
                effortLevels: [
                  { id: 'brief', label: 'Brief' },
                  { id: 'long', label: 'Long' },
                  { id: 'eternal', label: 'Eternal' },
                ],
              },
            },
          },
          // FAKE_ACP_EXTRA_MODEL plays a model the vendor added since the
          // agent last started: present only in processes started after it was set.
          ...(process.env.FAKE_ACP_EXTRA_MODEL ? [{ modelId: process.env.FAKE_ACP_EXTRA_MODEL, name: 'New' }] : []),
        ],
      } }),
      modes: {
        currentModeId: state.modeId,
        availableModes: [
          { id: 'chatty', name: 'Chatty', description: 'Talks a lot.' },
          { id: 'terse', name: 'Terse' },
        ],
      },
      configOptions: configOptionsOf(state),
    })
    // What this agent can be asked to run, declared the ACP way: after the
    // session exists, as an update rather than in the reply.
    update(state.id, {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'rehearse', description: 'Practises the answer first.' },
        { name: 'forget', description: 'Drops what it was told.', input: { hint: '[what]' } },
      ],
    })
  },
  'session/set_mode': (id, params) => {
    const state = sessions.get(params.sessionId)
    if (!state) return fail(id, 'no such session')
    if (!['chatty', 'terse'].includes(params.modeId)) return fail(id, `no mode ${params.modeId}`)
    state.modeId = params.modeId
    reply(id, null)
    update(state.id, { sessionUpdate: 'current_mode_update', currentModeId: state.modeId })
  },
  'session/set_model': (id, params) => {
    const state = sessions.get(params.sessionId)
    if (!state) return fail(id, 'no such session')
    if (!['small', 'large'].includes(params.modelId)) return fail(id, `no model ${params.modelId}`)
    state.modelId = params.modelId
    reply(id, null)
    update(state.id, { sessionUpdate: 'current_model_update', currentModelId: state.modelId })
  },
  'session/set_config_option': (id, params) => {
    const state = sessions.get(params.sessionId)
    if (!state) return fail(id, 'no such session')
    if (params.configId === 'auto_approve' && params.type !== 'boolean') {
      return fail(id, 'auto_approve must use the ACP boolean option type')
    }
    if (CONFIG_MODEL_ONLY && params.configId === 'model') {
      if (!['small', 'large'].includes(params.value)) return fail(id, `no model ${params.value}`)
      state.modelId = params.value
      reply(id, { configOptions: configOptionsOf(state) })
      update(state.id, { sessionUpdate: 'config_option_update', configOptions: configOptionsOf(state) })
      return
    }
    if (!(params.configId in state.options)) {
      return fail(id, `no option ${params.configId}`)
    }
    if (params.configId === 'voice' && !['plain', 'pirate'].includes(params.value)) {
      return fail(id, `voice cannot be ${params.value}`)
    }
    if (params.configId === 'ponder' && !['default', 'brief', 'long'].includes(params.value)) {
      return fail(id, `ponder cannot be ${params.value}`)
    }
    if (params.configId === 'wide' && params.value !== false) {
      return fail(id, 'the fake has one window')
    }
    state.options[params.configId] = params.value
    reply(id, null)
    update(state.id, { sessionUpdate: 'config_option_update', configOptions: configOptionsOf(state) })
  },
  'session/prompt': (id, params) => void runPrompt(id, params),
  'session/list': (id, params) => {
    if (NO_LIST) {
      return send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: '"Method not found": session/list', data: { method: 'session/list' } },
      })
    }
    if (process.env.FAKE_ACP_LIST_FAILS === '1' || (process.env.FAKE_ACP_LIST_FAILS === 'later' && params?.cursor != null)) {
      return send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error', data: { details: 'the index is locked' } } })
    }
    const rows = Object.values(readStore())
      .filter((entry) => !UNLISTED.has(entry.sessionId))
      .map((entry) => ({
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        title: entry.title,
        updatedAt: entry.updatedAt,
      }))
    if (!(LIST_PAGE > 0)) return reply(id, { sessions: rows })
    const from = Number(params?.cursor ?? 0)
    const rest = from + LIST_PAGE < rows.length
    // Stuck, every page names itself as the next one; endless, a new one.
    const next =
      process.env.FAKE_ACP_LIST_STUCK === '1'
        ? String(from)
        : process.env.FAKE_ACP_LIST_ENDLESS === '1' || rest
          ? String(from + LIST_PAGE)
          : null
    reply(id, { sessions: rows.slice(from, from + LIST_PAGE), ...(next !== null ? { nextCursor: next } : {}) })
  },
  'session/load': (id, params) => {
    recordOpen('session/load', params.sessionId, params.cwd)
    const store = readStore()
    const entry = store[params.sessionId]
    if (!entry) return fail(id, `no stored session ${params.sessionId}`, { details: 'the store has no such id' })
    if (process.env.FAKE_ACP_UNLOADABLE === params.sessionId) {
      return fail(id, 'Internal error', { details: 'the transcript could not be read' })
    }
    const state = newSession(entry.sessionId, entry.cwd)
    // A load carries a reopened Seat's filter the same way session/new does.
    if (ATTACHMENTS && params?._meta?.harnessdesk?.attachments) {
      attachmentsBySession.set(state.id, params._meta.harnessdesk.attachments.input)
    }
    // Replay: every content block of a stored turn as its own user chunk,
    // then an answer chunk — the shape Claude Code replays.
    for (const blocks of entry.turns) {
      const parts = Array.isArray(blocks) ? blocks : [blocks]
      for (const part of parts) {
        const content = typeof part === 'string' ? { type: 'text', text: part } : part
        update(state.id, { sessionUpdate: 'user_message_chunk', content })
      }
      const texts = parts.filter((part) => typeof part === 'string')
      update(state.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `hearing: ${texts.join(' ')} done.` } })
    }
    reply(id, {
      sessionId: state.id,
      ...(CONFIG_MODEL_ONLY ? {} : { models: {
        currentModelId: state.modelId,
        availableModels: [
          { modelId: 'small', name: 'Small' },
          { modelId: 'large', name: 'Large', description: 'Slower, wiser.' },
        ],
      } }),
      modes: {
        currentModeId: state.modeId,
        availableModes: [
          { id: 'chatty', name: 'Chatty', description: 'Talks a lot.' },
          { id: 'terse', name: 'Terse' },
        ],
      },
      configOptions: configOptionsOf(state),
    })
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
  if (typeof message.id === 'number' && pendingOutgoing.has(message.id)) {
    const pending = pendingOutgoing.get(message.id)
    pendingOutgoing.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message))
    else pending.resolve(message.result)
    return
  }
  if (TASKS && typeof message.id === 'number' && message.method?.startsWith('_harnessdesk/tasks/')) {
    const sessionId = message.params?.sessionId
    if (message.method === '_harnessdesk/tasks/list') {
      reply(message.id, { tasks: [...tasks.values()] })
      return
    }
    if (message.method === '_harnessdesk/tasks/stop') {
      const task = tasks.get(message.params?.taskId)
      if (!task || task.state !== 'running') {
        reply(message.id, { stopped: false })
        return
      }
      tasks.set(task.id, { ...task, state: 'stopped', endedAt: Date.now(), stoppable: false })
      reply(message.id, { stopped: true })
      pushTasks(sessionId)
      return
    }
    if (message.method === '_harnessdesk/tasks/clear') {
      for (const [id, task] of tasks) if (task.state !== 'running') tasks.delete(id)
      reply(message.id, {})
      pushTasks(sessionId)
      return
    }
  }
  if (DELETES && typeof message.id === 'number' && message.method === '_harnessdesk/session/delete') {
    const store = readStore()
    const had = Boolean(store[message.params?.sessionId])
    delete store[message.params?.sessionId]
    writeStore(store)
    reply(message.id, { removed: had ? [`${message.params.sessionId}.jsonl`] : [], disposition: 'trash' })
    return
  }
  if (ATTACHMENTS && typeof message.id === 'number' && message.method === '_harnessdesk/attachment_receipt') {
    if (process.env.FAKE_ACP_ATTACHMENTS_RECEIPT) {
      reply(message.id, JSON.parse(process.env.FAKE_ACP_ATTACHMENTS_RECEIPT))
      return
    }
    const input = attachmentsBySession.get(message.params?.sessionId)
    if (!input || input.key !== message.params?.key) {
      fail(message.id, 'no attachments were prepared for this session, or the key has moved on')
      return
    }
    // Honest by default: reports loading exactly what it was asked to load,
    // the same way `FakeRuntime` on the host side does.
    reply(message.id, {
      key: input.key,
      loaded: [
        ...(input.skills ?? []).map((one) => ({ kind: 'skill', name: one.name, digest: one.digest })),
        ...(input.mcp ?? []).map((one) => ({ kind: 'mcp', name: one.name, digest: one.digest })),
      ],
      refused: [],
    })
    return
  }
  const handler = handlers[message.method]
  if (!handler) {
    if (typeof message.id === 'number') fail(message.id, `unknown method ${message.method}`)
    return
  }
  handler(message.id, message.params)
})

process.stdin.on('close', () => process.exit(0))
