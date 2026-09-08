#!/usr/bin/env node
/**
 * A stand-in for the Claude Code CLI in the Agent SDK's stream-json mode —
 * just enough of the control protocol for `@zed-industries/claude-code-acp`
 * to open a session, list models, and run turns, with none of the model.
 *
 * What it plays back is what the tests need to see:
 *
 * - models with `supportedEffortLevels`, the way Claude Code 2.1.240 reports
 *   them (none on haiku);
 * - every reply names the `--effort` and `--autocompact` it was spawned
 *   with and whether it was `--resume`d, so a test can tell which process
 *   answered and how it was configured;
 * - `/effort <level>` and `/autocompact <window>` as prompts are handled
 *   locally and answer with a line, like the real commands.
 *
 * It also plays background tasks, in the shapes observed from Claude Code
 * 2.1.240 (`background_tasks_changed` with the whole running set,
 * `task_started`, `task_notification`, and a `stop_task` control request):
 *
 * - `bg <command>` starts one and answers with its id;
 * - `endbg <id>` finishes one, as a task ending between turns does;
 * - `idlebg <id>` finishes one after the turn has already ended, which is
 *   what the bridge's continuous pump exists to catch;
 * - a prompt containing `survey` plays a whole research turn — described
 *   shell calls, undescribed reads, narration between them, a test run sent
 *   to the background that finishes on its own with an output file — for a
 *   renderer that wants to watch one arrive.
 *
 * FAKE_CLAUDE_LOG names a file that receives one line per spawn and exit,
 * so a test can see a replaced process actually go away.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import readline from 'node:readline'

const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? null : (argv[index + 1] ?? null)
}

let effort = flag('--effort') ?? 'default'
let autocompact = flag('--autocompact') ?? 'default'
const resumed = flag('--resume')
const sessionId = flag('--session-id') ?? resumed ?? 'fake-session'
let model = flag('--model') ?? 'default'
// Output styles have no flag of their own; the real CLI reads them from the
// `--settings` JSON, so the fake does too.
const settings = (() => {
  try {
    return JSON.parse(flag('--settings') ?? '{}')
  } catch {
    return {}
  }
})()
const outputStyle = typeof settings.outputStyle === 'string' ? settings.outputStyle : 'default'

const log = (line) => {
  const file = process.env.FAKE_CLAUDE_LOG
  if (file) appendFileSync(file, `${line}\n`)
}
log(`spawn ${process.pid} effort=${effort} autocompact=${autocompact} style=${outputStyle} resume=${resumed ?? 'none'} session=${sessionId}`)
process.on('exit', () => log(`exit ${process.pid}`))
// A signal death skips 'exit'; the SDK ends a replaced process with SIGTERM.
process.on('SIGTERM', () => process.exit(0))

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

const MODELS = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Default (recommended)',
    description: 'Opus 5 with 1M context',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    description: 'Sonnet 5',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku', description: 'Haiku 4.5' },
]

// Token counts grow the way a real conversation's do: every call re-sends
// the whole context, most of it served from cache, so `cache_read` climbs by
// the previous call's size and `input_tokens` stays the new part. The real
// CLI's shapes, exactly: the *assistant* message carries `message_start`
// usage whose `output_tokens` is a placeholder (1); the *result* carries the
// turn's true counts, plus `modelUsage` — cumulative over the process — and
// the running cost.
let calls = 0
let spent = 0
const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
const usageOf = () => {
  calls += 1
  const usage = {
    input_tokens: 12,
    output_tokens: 40,
    cache_creation_input_tokens: 3000,
    cache_read_input_tokens: 20000 * calls,
  }
  spent += 0.0123
  totals.inputTokens += usage.input_tokens
  totals.outputTokens += usage.output_tokens
  totals.cacheReadInputTokens += usage.cache_read_input_tokens
  totals.cacheCreationInputTokens += usage.cache_creation_input_tokens
  return usage
}

/** What a streamed assistant message really says: real inputs, output stub. */
const asStreamed = (usage) => ({ ...usage, output_tokens: 1 })

/**
 * A paragraph of the assistant's, mid-turn: the stream events the bridge
 * reads the words from, then the assistant message. No `result` — the turn
 * goes on, which is how the real CLI narrates between tool calls.
 */
const narrate = (text) => {
  const usage = usageOf()
  // The bridge asks for partial messages and takes assistant text from the
  // stream events, not from the assistant message itself.
  const stream = (event) => send({ type: 'stream_event', event, session_id: sessionId, parent_tool_use_id: null })
  stream({ type: 'message_start', message: { id: `msg_${Date.now()}`, role: 'assistant', content: [] } })
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  stream({ type: 'content_block_stop', index: 0 })
  stream({ type: 'message_stop' })
  send({
    type: 'assistant',
    message: {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: 'fake',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: asStreamed(usage),
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  })
  return usage
}

const reply = (text) => {
  const usage = narrate(text)
  send({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: text,
    session_id: sessionId,
    total_cost_usd: spent,
    usage,
    modelUsage: { fake: { contextWindow: 200000, ...totals } },
    permission_denials: [],
    stop_reason: 'end_turn',
  })
}

// --- background tasks ----------------------------------------------------

/** Running tasks, by id, in the shape `background_tasks_changed` reports. */
const tasks = new Map()
let taskCounter = 0

const announce = () =>
  send({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [...tasks.values()].map((task) => ({
      task_id: task.task_id,
      task_type: 'local_bash',
      description: task.description,
    })),
    uuid: `uuid-${Date.now()}-${taskCounter}`,
    session_id: sessionId,
  })

/** Where a finished task's output is written, the way the real CLI keeps one per task. */
const OUTPUT_DIR = `${tmpdir()}/fake-claude-${process.pid}`

/* Best effort: this stand-in is stopped by a signal, and an exit handler is
   the only hook a signal leaves room for. A SIGKILL still skips it, so the
   directory is made per-pid and never reused. */
process.on('exit', () => {
  try {
    rmSync(OUTPUT_DIR, { recursive: true, force: true })
  } catch {
    /* nothing to do at exit */
  }
})
const outputFileOf = (id) => `${OUTPUT_DIR}/${id}.output`

/**
 * Which wire to play. `2.1.240` (the default) sends `background_tasks_changed`
 * and `task_started` and names the tool use on the notification; `2.1.258`,
 * traced on 2026-09-05, sends none of those — the backgrounded call's own
 * tool result is the only start message, and the notification carries no
 * `tool_use_id`. `FAKE_CLAUDE_TASK_WIRE=modern` plays the second.
 */
const MODERN_WIRE = process.env.FAKE_CLAUDE_TASK_WIRE === 'modern'

/**
 * `FAKE_CLAUDE_LATE_OUTPUT=<ms>` writes a finished task's output file that
 * many milliseconds *after* the notification names it — the race a client
 * that reads the file once, at the notification, would lose. `never` names
 * a file and never writes it, which is the loss a client has to be able to
 * tell from the race.
 */
const LATE_OUTPUT = process.env.FAKE_CLAUDE_LATE_OUTPUT ?? ''
const NEVER_WRITE_OUTPUT = LATE_OUTPUT === 'never'
const LATE_OUTPUT_MS = NEVER_WRITE_OUTPUT ? 0 : Number(LATE_OUTPUT) || 0

const startTask = (command, description = `Run ${command}`, output = '') => {
  taskCounter += 1
  const id = `bg${taskCounter}`
  const toolUseId = `toolu_${id}`
  // The assistant's own tool_use block, which is where the command text is;
  // the task messages never carry it.
  send({
    type: 'assistant',
    message: {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: 'fake',
      content: [
        { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command, description, run_in_background: true } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: asStreamed(usageOf()),
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  })
  tasks.set(id, { task_id: id, description, tool_use_id: toolUseId, command, output })
  if (!MODERN_WIRE) {
    announce()
    send({
      type: 'system',
      subtype: 'task_started',
      task_id: id,
      tool_use_id: toolUseId,
      description,
      is_backgrounded: true,
      task_type: 'local_bash',
      uuid: `uuid-start-${id}`,
      session_id: sessionId,
    })
  }
  // The tool's own answer, which is all the transcript row ever gets: the
  // real CLI closes the call at once and the work goes on beside the turn.
  // On the newer wire it is also the only message that says the task began.
  send({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `Command running in background with ID: ${id}. Output is being written to: ${outputFileOf(id)}`,
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  })
  return id
}

const endTask = (id, status = 'completed') => {
  const task = tasks.get(id)
  if (!task) return false
  tasks.delete(id)
  // The output file exists by the time the notification names it — a client
  // that reads it on arrival must find the whole of it there. Unless the
  // fixture is asked to be late, which is the case such a client must survive.
  const outputFile = outputFileOf(id)
  const writeOutput = () => {
    try {
      mkdirSync(OUTPUT_DIR, { recursive: true })
      writeFileSync(outputFile, task.output ?? '')
    } catch {
      /* a fixture on a read-only disk still finishes its task */
    }
  }
  if (NEVER_WRITE_OUTPUT) {
    /* named, never written */
  } else if (LATE_OUTPUT_MS > 0) setTimeout(writeOutput, LATE_OUTPUT_MS)
  else writeOutput()
  send({
    type: 'system',
    subtype: 'task_notification',
    task_id: id,
    ...(MODERN_WIRE ? {} : { tool_use_id: task.tool_use_id }),
    status,
    output_file: outputFile,
    // 2.1.258 writes a sentence here; 2.1.240 repeated the description.
    summary: MODERN_WIRE
      ? `Background command "${task.description}" ${status === 'completed' ? 'completed' : `${status} with exit code 1`}`
      : task.description,
    uuid: `uuid-end-${id}`,
    session_id: sessionId,
  })
  if (!MODERN_WIRE) announce()
  return true
}

// --- a survey turn --------------------------------------------------------

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One tool call, opened and then answered a moment later, as the CLI streams it. */
const call = async (name, input, resultContent, ms = 650) => {
  const toolUseId = `toolu_${name.toLowerCase()}_${Date.now()}`
  send({
    type: 'assistant',
    message: {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: 'fake',
      content: [{ type: 'tool_use', id: toolUseId, name, input }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: asStreamed(usageOf()),
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  })
  await wait(ms)
  send({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: resultContent }] },
    parent_tool_use_id: null,
    session_id: sessionId,
  })
}

const LIMITER = `/** A token bucket, one per caller. */
export class Limiter {
  constructor (capacity = 20, perSecond = 5) {
    this.capacity = capacity
    this.perSecond = perSecond
    this.buckets = new Map()
  }

  take (key, now = Date.now()) {
    const seat = this.buckets.get(key) ?? { tokens: this.capacity, at: now }
    // Refill for the time that has passed since we last looked.
    const gained = (now - seat.at) * this.perSecond
    seat.tokens = Math.min(this.capacity, seat.tokens + gained)
    seat.at = now
    if (seat.tokens < 1) {
      this.buckets.set(key, seat)
      return false
    }
    seat.tokens -= 1
    this.buckets.set(key, seat)
    return true
  }
}`

const TOTALS = `/** Order totals, in minor units. */
export const total = (items, discount) => {
  let sum = 0
  for (const item of items) sum += item.price * item.quantity
  if (discount) sum = sum - sum * discount
  return Math.round(sum)
}

export const withTax = (amount, rate) => amount + amount * rate`

const numbered = (text) =>
  text
    .split('\n')
    .map((line, index) => `${String(index + 1).padStart(6)}\t${line}`)
    .join('\n')

const TEST_OUTPUT = `▶ adds up an order
✔ adds up an order (1.184ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 43.512
`

/**
 * A research turn the way Claude Code plays one: a sentence, a burst of
 * shell calls each carrying the description the tool asks for, two reads
 * and a search with no description of their own, a second sentence, one
 * more described call, a test run sent to the background, and the answer.
 * The background run finishes on its own half a minute after the turn.
 */
const survey = async () => {
  narrate('I will read both files, check the arithmetic against a real clock, and keep the tests running while I look.')
  await wait(500)
  await call(
    'Bash',
    { command: "sed -n '1,40p' src/limiter.js", description: 'Read the limiter and its refill arithmetic' },
    LIMITER,
  )
  await call(
    'Bash',
    { command: 'grep -rn "take(" src/', description: 'Find every caller of Limiter.take' },
    'src/server.js:9:  if (!limiter.take(caller)) {\nsrc/limiter.js:9:  take (key, now = Date.now()) {',
  )
  await call(
    'Bash',
    {
      command: "node -e \"import('./src/totals.js').then(m => console.log(m.total([{ price: 333, quantity: 3 }], 0.1)))\"",
      description: 'Check how totals rounds a discounted order',
    },
    '899',
  )
  await call('Read', { file_path: 'src/totals.js' }, numbered(TOTALS), 450)
  await call('Read', { file_path: 'test/totals.test.js' }, numbered("import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { total } from '../src/totals.js'\n\ntest('adds up an order', () => {\n  assert.equal(total([{ price: 500, quantity: 2 }], 0), 1000)\n})"), 450)
  await call('Grep', { pattern: 'discount', path: 'src' }, 'src/totals.js:5:  if (discount) sum = sum - sum * discount\nsrc/server.js:15:    const discount = Number(url.searchParams.get(\'discount\'))', 450)
  narrate('Two findings so far. Let me confirm the refill rate against a real clock before I say which comes first.')
  await wait(500)
  await call(
    'Bash',
    {
      command: "node -e \"import('./src/limiter.js').then(({ Limiter }) => { const l = new Limiter(20, 5); l.take('k', 0); console.log('tokens after 1ms:', l.buckets.get('k').tokens + 5) })\"",
      description: 'Measure the refill rate over one millisecond',
    },
    'tokens after 1ms: 24',
  )
  await wait(400)
  const id = startTask('node --test test/', 'Run the test suite in the background', TEST_OUTPUT)
  await wait(500)
  reply(
    [
      'Fix the limiter first. `take()` multiplies the elapsed **milliseconds** by `perSecond`, so a bucket refills a thousand times faster than the name promises: one millisecond of waiting hands back 5 tokens and the 20-token cap is reached almost instantly. Divide the elapsed time by 1000 (or rename the rate) and add a test that asserts one token per 200ms.',
      '',
      'Second, `total()` applies the discount to the sum and only rounds at the end, so a 10% discount on three 333-cent items comes out at 899 — the caller in `server.js` also trusts `Number(url.searchParams.get("discount"))`, which accepts `1.5` and turns the order negative. Clamp it to 0–1 at the route.',
      '',
      `The test suite is running in the background (${id}); I will read its result when it reports back.`,
    ].join('\n'),
  )
  await wait(28_000)
  endTask(id)
}

const textOf = (message) => {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  return ''
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  if (process.env.FAKE_CLAUDE_TRACE) log(`recv ${line.slice(0, 300)}`)
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.type === 'control_request') {
    const { request_id, request } = message
    const respond = (response) =>
      send({ type: 'control_response', response: { subtype: 'success', request_id, response } })
    const refuse = (error) => send({ type: 'control_response', response: { subtype: 'error', request_id, error } })
    switch (request.subtype) {
      case 'initialize':
        respond({
          commands: [
            { name: 'effort', description: 'Set effort level for model usage', argumentHint: '<low|medium|high|xhigh|max>' },
            { name: 'autocompact', description: 'Set the auto-compact window', argumentHint: '<auto|tokens>' },
          ],
          output_style: outputStyle,
          available_output_styles: ['default', 'Explanatory', 'Concise'],
          models: MODELS,
          account: { email: 'fake@example.com', subscriptionType: 'fake' },
        })
        return
      case 'stop_task':
        // Claude Code refuses an id it does not have running, the way its own
        // TaskStop tool does ("No task found with ID: …").
        if (!tasks.has(request.task_id)) {
          refuse(`No task found with ID: ${request.task_id}`)
          return
        }
        respond({})
        // It says so on the stream a moment later, which is the only thing
        // that makes the row change for a second window watching.
        setTimeout(() => endTask(request.task_id, 'stopped'), 5)
        return
      case 'set_model':
        model = request.model ?? model
        respond({})
        return
      default:
        respond({})
        return
    }
  }
  if (message.type === 'user') {
    const text = textOf(message.message).trim()
    // A whole research turn, for a client that wants to watch one arrive.
    if (/\bsurvey\b/i.test(text)) {
      void survey()
      return
    }
    const background = /^bg\s+(.+)$/.exec(text)
    if (background) {
      reply(`started ${startTask(background[1])}`)
      return
    }
    const ending = /^endbg\s+(\S+)/.exec(text)
    if (ending) {
      endTask(ending[1])
      reply(`ended ${ending[1]}`)
      return
    }
    // Ends *after* the turn has: nothing is pumping the stream at that point
    // unless the bridge pumps it on its own, which is the whole point.
    const idle = /^idlebg\s+(\S+)/.exec(text)
    if (idle) {
      reply(`will end ${idle[1]}`)
      setTimeout(() => endTask(idle[1]), 50)
      return
    }
    // A tool round trip the way the real CLI streams it: tool_use, then a
    // tool_result whose content is Anthropic-API blocks — nested `source`,
    // `media_type` — which is NOT the ACP shape. Several triggers share it
    // so every stored block shape the CLI can produce has a rehearsal.
    const roundTrip = (name, input, resultContent) => {
      const toolUseId = `toolu_rt_${Date.now()}`
      send({
        type: 'assistant',
        message: {
          id: `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          model: 'fake',
          content: [{ type: 'tool_use', id: toolUseId, name, input }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: asStreamed(usageOf()),
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      })
      send({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUseId, content: resultContent }],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      })
    }
    // A delegation the way the CLI plays one: the Agent tool call, then the
    // child's own API calls carrying `parent_tool_use_id`, then the result.
    // Two children on two models, so the panel has something to tell apart
    // and the token counts have to stay separate to be right.
    if (/^delegate\b/.test(text)) {
      const spawn = (id, subagentType, prompt) =>
        send({
          type: 'assistant',
          message: {
            id: `msg_${id}`,
            type: 'message',
            role: 'assistant',
            model: 'fake',
            content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: subagentType, prompt } }],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: asStreamed(usageOf()),
          },
          parent_tool_use_id: null,
          session_id: sessionId,
        })
      const childCall = (parent, model, usage) =>
        send({
          type: 'assistant',
          message: {
            id: `msg_child_${parent}_${usage.input_tokens}`,
            type: 'message',
            role: 'assistant',
            model,
            content: [{ type: 'text', text: 'working' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage,
          },
          parent_tool_use_id: parent,
          session_id: sessionId,
        })
      const finish = (id) =>
        send({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
          parent_tool_use_id: null,
          session_id: sessionId,
        })
      spawn('toolu_kid_a', 'Explore', 'find the config loader')
      spawn('toolu_kid_b', 'general-purpose', 'summarise the findings')
      childCall('toolu_kid_a', 'fake-haiku', {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 0,
      })
      childCall('toolu_kid_a', 'fake-haiku', {
        input_tokens: 100,
        output_tokens: 60,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 0,
      })
      childCall('toolu_kid_b', 'fake-opus', {
        input_tokens: 200,
        output_tokens: 300,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 1800,
      })
      finish('toolu_kid_a')
      finish('toolu_kid_b')
      reply('both sub-agents reported back')
      return
    }
    if (/^readimage\b/.test(text)) {
      roundTrip('Read', { file_path: '/shots/page.png' }, [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'UE5HYnl0ZXM=' } },
      ])
      reply('the screenshot shows a settings page')
      return
    }
    if (/^readurlimage\b/.test(text)) {
      roundTrip('Read', { file_path: '/shots/remote.png' }, [
        { type: 'image', source: { type: 'url', url: 'https://example.test/shot.png' } },
      ])
      reply('the linked image is noted')
      return
    }
    if (/^readpdf\b/.test(text)) {
      roundTrip('Read', { file_path: '/docs/spec.pdf' }, [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'UERGYnl0ZXM=' } },
      ])
      reply('the pdf says hello')
      return
    }
    if (/^bashimage\b/.test(text)) {
      roundTrip('Bash', { command: 'screencap out.png', description: 'Grab the screen' }, [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'UE5HYnl0ZXM=' } },
      ])
      reply('captured')
      return
    }
    const command = /^\/(effort|autocompact)\s+(\S+)/.exec(text)
    if (command) {
      const value = command[2] === 'auto' ? 'default' : command[2]
      if (command[1] === 'effort') effort = value
      else autocompact = value
      reply(`${command[1] === 'effort' ? 'Effort' : 'Auto-compact'} set to ${command[2]}`)
      return
    }
    reply(
      `[effort=${effort}; autocompact=${autocompact}; style=${outputStyle}; resumed=${resumed ?? 'none'}; session=${sessionId}; model=${model}] ${text}`,
    )
  }
})
rl.on('close', () => process.exit(0))
