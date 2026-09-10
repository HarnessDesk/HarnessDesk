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
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

/**
 * With FAKE_ACP_STORE set, completed conversations persist to that file and
 * session/list + session/load serve them — mirroring how Claude Code keeps
 * its own store, so the adapter's resume path is tested across "restarts".
 */
const STORE = process.env.FAKE_ACP_STORE ?? null
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
      ponder: 'default',
      // A control that exists but cannot be moved — see `configOptionsOf`.
      wide: false,
    },
  }
  sessions.set(id, state)
  return state
}

const configOptionsOf = (state) => [
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

  if (handleTaskPrompt(state, text.trim())) {
    say('ok.')
    return reply(id, { stopReason: 'end_turn' })
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
  // whose output count is still a streaming placeholder.
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
    if (verb === 'spawn') {
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
    return reply(id, { stopReason: 'end_turn' })
  }
  // A turn that reports cache writes, and one that says nothing about them —
  // the pair that decides whether a running total may claim to be exact.
  if (text === 'writes') {
    return reply(id, {
      stopReason: 'end_turn',
      usage: { totalTokens: 150, inputTokens: 100, outputTokens: 50, cachedReadTokens: 20, cachedWriteTokens: 50 },
    })
  }
  if (text === 'nowrites') {
    return reply(id, {
      stopReason: 'end_turn',
      usage: { totalTokens: 60, inputTokens: 40, outputTokens: 20, cachedReadTokens: 10 },
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
  return reply(id, { stopReason: 'end_turn' })
}

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
        ...(STORE ? { sessionCapabilities: { list: {}, resume: {} } } : {}),
      },
      authMethods: [
        { id: 'device', name: 'Sign in on the agent side', description: 'Run the agent login.' },
      ],
      ...(TASKS || DELETES
        ? {
            _meta: {
              harnessdesk: {
                ...(TASKS ? { backgroundTasks: true } : {}),
                // FAKE_ACP_DELETE=1 plays a bridge that knows where its agent
                // writes. Most ACP agents do not, and declare nothing.
                ...(DELETES ? { deleteSession: true } : {}),
              },
            },
          }
        : {}),
    })
  },
  'session/new': (id, params) => {
    // FAKE_ACP_AUTH_REQUIRED=1 plays an agent that wants a sign-in before it
    // opens anything — ACP's auth_required, code and words both, as Google
    // Antigravity's server answers it.
    // FAKE_ACP_AUTH_REQUIRED_AFTER=<n> plays a sign-in that lapses: the first
    // n opens succeed and every later one is refused the same way.
    const opensSoFar = (globalThis.__opens = (globalThis.__opens ?? 0) + 1)
    const lapsed =
      process.env.FAKE_ACP_AUTH_REQUIRED_AFTER !== undefined &&
      opensSoFar > Number(process.env.FAKE_ACP_AUTH_REQUIRED_AFTER)
    if (process.env.FAKE_ACP_AUTH_REQUIRED === '1' || lapsed) {
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
    // FAKE_ACP_REFUSE_TOOLS makes this agent behave like DeepSeek Harness and
    // cursor-agent: it will not be handed an MCP tool server on the session
    // request, and says so in the words the caller learns from.
    if (process.env.FAKE_ACP_REFUSE_TOOLS && (params?.mcpServers?.length ?? 0) > 0) {
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
    reply(id, {
      sessionId: state.id,
      models: {
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
      },
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
    if (!entry) return fail(id, `no stored session ${params.sessionId}`, { details: 'the store has no such id' })
    const state = newSession(entry.sessionId, entry.cwd)
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
      models: {
        currentModelId: state.modelId,
        availableModels: [
          { modelId: 'small', name: 'Small' },
          { modelId: 'large', name: 'Large', description: 'Slower, wiser.' },
        ],
      },
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
  const handler = handlers[message.method]
  if (!handler) {
    if (typeof message.id === 'number') fail(message.id, `unknown method ${message.method}`)
    return
  }
  handler(message.id, message.params)
})

process.stdin.on('close', () => process.exit(0))
