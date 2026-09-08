#!/usr/bin/env node
/**
 * A fake `cursor-agent` CLI, emitting the stream-json dialect captured from
 * the real binary (2026.08.11-e8db854). The bridge's tests run against this
 * so they exercise the real process path — spawn, flags, NDJSON, exit codes —
 * without spending Cursor credits.
 *
 * Scripted behaviours, keyed on the prompt text:
 *   - contains "write"   → an editToolCall pair that REALLY writes fake.txt
 *   - contains "slow"    → hangs 30s before the result (for cancellation)
 *   - contains "explode" → a result with is_error: true
 *   - anything else      → thinking + assistant deltas + final repeat
 * The assistant text echoes the prompt, model, and mode, so a test can prove
 * the flags were plumbed rather than assumed.
 */
import { appendFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const out = (line) => process.stdout.write(`${JSON.stringify(line)}\n`)

if (argv[0] === 'create-chat') {
  process.stdout.write(`fake-chat-${Date.now()}-${Math.floor(Math.random() * 1e6)}\n`)
  process.exit(0)
}
const extraModels = () => {
  const file = process.env.FAKE_CURSOR_EXTRA_MODELS
  if (!file) return ''
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

if (argv[0] === 'models') {
  // brain-9 exercises the dimension grammar: efforts, thinking, fast, max.
  process.stdout.write(
    'Available models\n\nauto - Auto (default)\nfast-1 - Fast Model\nsmart-1 - Smart Model\n' +
      'brain-9-low - Brain 9 Low\nbrain-9-high - Brain 9\nbrain-9-high-fast - Brain 9 Fast\n' +
      'brain-9-thinking-low - Brain 9 Low Thinking\nbrain-9-thinking-high - Brain 9 Thinking\n' +
      'brain-9-max - Brain 9 Max\n' +
      // FAKE_CURSOR_EXTRA_MODELS names a file of `id - label` lines that
      // plays models Cursor added after the bridge started: read on every
      // ask, so a test can add one between two asks.
      extraModels(),
  )
  process.exit(0)
}

const valueOf = (flag) => {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}
const terminator = argv.indexOf('--')
const prompt = terminator === -1 ? '' : argv.slice(terminator + 1).join(' ')
const sessionId = valueOf('--resume') ?? 'fake-chat-unresumed'
const model = valueOf('--model') ?? 'auto'
const mode = valueOf('--mode') ?? 'default'
const sandbox = valueOf('--sandbox') ?? 'default'

if (!argv.includes('--trust')) {
  process.stderr.write('Workspace Trust Required\n')
  process.exit(1)
}
// Every spawn leaves a line here when asked, so a test can count processes.
if (process.env.FAKE_CURSOR_SPAWN_LOG) {
  appendFileSync(process.env.FAKE_CURSOR_SPAWN_LOG, `${Date.now()} ${prompt}\n`)
}
// "flaky-start": the first two spawns die the way the real CLI died under a
// burst of forty — a model refused against an empty catalogue, before any
// stream-json — and the third boots normally. The count lives in a file so
// it survives the process dying, which is the point.
if (prompt.includes('flaky-start')) {
  const counter = process.env.FAKE_CURSOR_FLAKY_COUNTER ?? join(process.cwd(), '.flaky-count')
  let n = 0
  try {
    n = Number(readFileSync(counter, 'utf8')) || 0
  } catch {}
  writeFileSync(counter, String(n + 1))
  if (n < 2) {
    // The refusal, and one diagnostic line after it — the real CLI does not
    // always die on its last word, and the bridge reads a tail, not a line.
    process.stderr.write(`Cannot use this model: ${model}. Available models: \nexiting\n`)
    process.exit(1)
  }
}
// "named-refusal": the account's own answer — a model refused against a
// catalogue that *names* what is offered. Every time, before any stream-json.
if (prompt.includes('named-refusal')) {
  process.stderr.write(`Cannot use this model: ${model}. Available models: auto, brain-9-high\n`)
  process.exit(1)
}
// "hold-start": say nothing until a file appears, so a test can look at the
// bridge while this process is still booting.
if (prompt.includes('hold-start')) {
  const gate = process.env.FAKE_CURSOR_HOLD_FILE
  const started = Date.now()
  while (gate && !existsSync(gate) && Date.now() - started < 20000) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
}

out({
  type: 'system',
  subtype: 'init',
  apiKeySource: 'login',
  cwd: process.cwd(),
  session_id: sessionId,
  model,
  permissionMode: 'default',
})
out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, session_id: sessionId })

const finish = (text) => {
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: sessionId })
  out({
    type: 'result',
    subtype: 'success',
    duration_ms: 5,
    is_error: false,
    result: text,
    session_id: sessionId,
    // The cache split arrived with cursor-agent 2026.08.31; older builds sent
    // input and output only, and the bridge must serve both shapes.
    usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 900, cacheWriteTokens: 100 },
  })
  process.exit(0)
}

if (prompt.includes('slow')) {
  // Emit one delta so the client sees a live turn, then stall until killed.
  out({ type: 'thinking', subtype: 'delta', text: 'pondering forever', session_id: sessionId, timestamp_ms: Date.now() })
  setTimeout(() => finish('finally'), 30_000)
} else if (prompt.includes('explode')) {
  out({
    type: 'result',
    subtype: 'error',
    duration_ms: 5,
    is_error: true,
    result: 'the model refused to continue',
    session_id: sessionId,
  })
  process.exit(1)
} else {
  out({ type: 'thinking', subtype: 'delta', text: 'thinking about it', session_id: sessionId, timestamp_ms: Date.now() })
  out({ type: 'thinking', subtype: 'completed', session_id: sessionId, timestamp_ms: Date.now() })
  if (prompt.includes('write')) {
    // A mid-turn message: deltas, then the full text re-sent WITH
    // timestamp_ms — captured from the real CLI, which only omits the
    // timestamp on the very last repeat of the turn.
    const announce = 'Writing the file now.'
    for (const piece of [announce.slice(0, 10), announce.slice(10), announce]) {
      out({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: piece }] },
        session_id: sessionId,
        timestamp_ms: Date.now(),
      })
    }
    const path = join(process.cwd(), 'fake.txt')
    const callId = 'toolu_fake_1'
    out({
      type: 'tool_call',
      subtype: 'started',
      call_id: callId,
      tool_call: { editToolCall: { args: { path, streamContent: 'hi' }, toolCallId: callId } },
      session_id: sessionId,
      timestamp_ms: Date.now(),
    })
    writeFileSync(path, 'hi')
    out({
      type: 'tool_call',
      subtype: 'completed',
      call_id: callId,
      tool_call: {
        editToolCall: {
          args: { path, streamContent: 'hi' },
          result: { success: { path, linesAdded: 1, linesRemoved: 0 } },
          toolCallId: callId,
        },
      },
      session_id: sessionId,
      timestamp_ms: Date.now(),
    })
  }
  if (prompt.includes('terse')) {
    // A reply shorter than the old sixteen-character floor: one delta, then the
    // closing repeat without a timestamp. This used to arrive doubled.
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }] }, session_id: sessionId, timestamp_ms: Date.now() })
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }] }, session_id: sessionId })
    out({ type: 'result', subtype: 'success', is_error: false, result: 'pong', session_id: sessionId, duration_ms: 1 })
    process.exit(0)
  }
  const pluginDir = valueOf('--plugin-dir') ?? 'none'
  const approveMcps = argv.includes('--approve-mcps')
  const text = `heard: ${prompt} [model=${model} mode=${mode} sandbox=${sandbox} plugin-dir=${pluginDir} approve-mcps=${approveMcps}]`
  const middle = Math.ceil(text.length / 2)
  for (const piece of [text.slice(0, middle), text.slice(middle)]) {
    out({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: piece }] },
      session_id: sessionId,
      timestamp_ms: Date.now(),
    })
  }
  // The real CLI repeats the full message without timestamp_ms; so does the fake.
  finish(text)
}
