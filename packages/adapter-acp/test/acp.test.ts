import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { describeAdapterConformance } from '@harnessdesk/adapter-testkit'
import {
  isFolderGone,
  isSessionGone,
  OptionRefusedError,
  sessionId,
  type AgentEvent,
  type AgentRuntime,
  wrapContext,
} from '@harnessdesk/protocol'

import { AcpRuntime, type AcpUsageRecord } from '../src/index.js'

/**
 * The ACP adapter against a scripted agent that is a real child process.
 * The conformance suite runs unmodified; the tests below cover what the suite
 * cannot know is ACP-specific — permissions, cancellation, dying agents, and
 * the `fs`/`terminal` refusals.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))

const make = (env: Record<string, string> = {}): AcpRuntime =>
  new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    env,
  })

describeAdapterConformance('adapter-acp', {
  create: make,
  sessionOptions: { cwd: '/tmp/acp-conformance' },
})

const record = (runtime: AcpRuntime) => {
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  return {
    events,
    async until(predicate: (event: AgentEvent) => boolean, timeoutMs = 5000): Promise<AgentEvent> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = events.find(predicate)
        if (found) return found
        if (Date.now() > deadline) {
          throw new Error(`timed out; saw ${events.map((e) => e.type).join(', ')}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }
}

test('a prompt streams chunks, a plan, and completes', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'hello there' }])
    const completed = await tape.until((event) => event.type === 'turn/completed')
    assert.equal((completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn.status, 'completed')
    const items = (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn.items
    const message = items.find((item) => item.type === 'assistantMessage')
    assert.ok(message && message.type === 'assistantMessage')
    assert.match(message.text, /hearing: hello there/)
    assert.ok(tape.events.some((event) => event.type === 'turn/plan'))
  } finally {
    await runtime.dispose()
  }
})

test('a prompt response with omitted stopReason completes cleanly without dropping the turn (#408)', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'omit stop reason' }])
    const completed = await tape.until((event) => event.type === 'turn/completed')
    assert.equal((completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn.status, 'completed')
    const idle = await tape.until(
      (event) => event.type === 'session/status' && (event as Extract<AgentEvent, { type: 'session/status' }>).status.type === 'idle',
    )
    assert.deepEqual((idle as Extract<AgentEvent, { type: 'session/status' }>).status, { type: 'idle' })

    await session.send([{ type: 'text', text: 'null stop reason' }])
    const completed2 = await tape.until(
      (event) => event.type === 'turn/completed' && tape.events.filter((e) => e.type === 'turn/completed').length === 2,
    )
    assert.equal((completed2 as Extract<AgentEvent, { type: 'turn/completed' }>).turn.status, 'completed')
  } finally {
    await runtime.dispose()
  }
})

test('one call announced twice is one row, and an unannounced completion still lands', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'announce twice please' }])
    const completed = await tape.until((event) => event.type === 'turn/completed')
    const turn = (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn
    const calls = turn.items.filter(
      (item): item is Extract<(typeof turn.items)[number], { type: 'toolCall' }> => item.type === 'toolCall',
    )
    // Claude Code's bridge announces one call twice — the permission flow
    // first with a bare title, the stream again with the real input. A second
    // row for the same id shows the call twice, and the copy the completion
    // never reaches sits "running" forever.
    assert.equal(calls.length, 2, `two calls, two rows: ${JSON.stringify(calls.map((call) => call.id))}`)
    const twice = calls.find((call) => String(call.id).includes('tc-twice'))
    assert.ok(twice)
    assert.equal(twice.status, 'completed')
    assert.equal(twice.tool, '`cat notes.txt`', 'the later announcement names it')
    assert.deepEqual(twice.args, { command: 'cat notes.txt', description: 'Show the notes' })
    const orphan = calls.find((call) => String(call.id).includes('tc-orphan'))
    assert.ok(orphan, 'a completion with no announcement still makes a row')
    assert.equal(orphan.status, 'completed')
  } finally {
    await runtime.dispose()
  }
})

test('a call whose output arrives only as content blocks keeps that output', async () => {
  // DeepSeek Harness's own server sends no rawOutput: the output is text in
  // the completing update's `content`. Only rawOutput and images were kept,
  // so every DeepSeek step was stored with no result and drew an empty box.
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'output as content please' }])
    const completed = await tape.until((event) => event.type === 'turn/completed')
    const turn = (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn
    const call = turn.items.find((item) => item.type === 'toolCall' && String(item.id).includes('tc-content'))
    assert.ok(call && call.type === 'toolCall')
    assert.equal(call.status, 'completed')
    assert.deepEqual(call.result, [
      { type: 'text', text: '.\n..\nREADME.md\n' },
      { type: 'text', text: 'second block' },
    ])
  } finally {
    await runtime.dispose()
  }
})

test('a later update carrying only text does not replace an earlier structured result (#961 review)', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'structured then text please' }])
    const completed = await tape.until((event) => event.type === 'turn/completed')
    const turn = (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn
    const call = turn.items.find((item) => item.type === 'toolCall' && String(item.id).includes('tc-structured-then-text'))
    assert.ok(call && call.type === 'toolCall')
    assert.equal(call.status, 'completed')
    assert.deepEqual(call.result, [{ type: 'json', value: { stdout: 'first, structured' } }], 'the structured result from the earlier update survives the later, text-only one')
  } finally {
    await runtime.dispose()
  }
})

test('a later update carrying only an image does not replace an earlier structured result, the same rule as text (#961 review)', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'structured then image please' }])
    const completed = await tape.until((event) => event.type === 'turn/completed')
    const turn = (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn
    const call = turn.items.find((item) => item.type === 'toolCall' && String(item.id).includes('tc-structured-then-image'))
    assert.ok(call && call.type === 'toolCall')
    assert.equal(call.status, 'completed')
    assert.deepEqual(call.result, [{ type: 'json', value: { path: '/tmp/shot.png' } }], 'the structured result from the earlier update survives the later, image-only one')
  } finally {
    await runtime.dispose()
  }
})

test('an agent that can say what the context is made of gets it read, defensively', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'compose for me' }])
    await tape.until((event) => event.type === 'turn/completed')
    const usage = (await runtime.readSession(session.id)).usage
    assert.ok(usage?.breakdown)
    assert.equal(usage.breakdown.source, 'a fake meter')
    assert.equal(usage.breakdown.approximate, true)
    // The zero-token row and the row with no id are gone: `_meta` is an open
    // slot, and a segment nobody measured must not become a row that says 0.
    assert.deepEqual(
      usage.breakdown.segments.map((segment) => [segment.id, segment.tokens, segment.count ?? null]),
      [
        ['system', 700, null],
        ['tools', 4300, 15],
      ],
    )
    // The later fill carried no composition; the composition still stands.
    assert.equal(usage.contextUsed, 4400)
    assert.equal(usage.breakdown.segments.length, 2)
  } finally {
    await runtime.dispose()
  }
})

test('a runtime that reports no composition has none, and nothing is invented for it', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'count for me' }])
    await tape.until((event) => event.type === 'turn/completed')
    const usage = (await runtime.readSession(session.id)).usage
    assert.equal(usage?.breakdown ?? null, null)
  } finally {
    await runtime.dispose()
  }
})

test('the unstable usage shapes become the session usage: fill from the update, the turn from the reply', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'count for me' }])
    await tape.until((event) => event.type === 'turn/completed')
    const usage = (await runtime.readSession(session.id)).usage
    assert.ok(usage)
    assert.equal(usage.contextUsed, 4321)
    assert.equal(usage.contextWindow, 32000)
    assert.deepEqual(usage.cost, { amount: 0.5, currency: 'EUR' })
    assert.deepEqual(usage.last, {
      totalTokens: 900,
      inputTokens: 800,
      cachedInputTokens: 600,
      outputTokens: 100,
      reasoningOutputTokens: 25,
    })
    assert.deepEqual(usage.total, usage.last)
    // Both landed before the turn closed, so the finished turn's tail has them.
    const types = tape.events.map((event) => event.type)
    assert.equal(types.filter((type) => type === 'usage/updated').length, 2)
    assert.ok(types.lastIndexOf('usage/updated') < types.indexOf('turn/completed'))

    await session.send([{ type: 'text', text: 'count again' }])
    await tape.until((event) => event.type === 'turn/completed' && tape.events.filter((e) => e.type === 'turn/completed').length === 2)
    const again = (await runtime.readSession(session.id)).usage
    assert.equal(again?.total.totalTokens, 1800, 'turns add up')
    assert.equal(again?.total.cachedInputTokens, 1200)
    assert.equal(again?.last.totalTokens, 900, 'last is one turn')
  } finally {
    await runtime.dispose()
  }
})

test('a turn counted in `_meta.quota` is the turn usage, with no window and no cache figure claimed', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'quota for me' }])
    await tape.until((event) => event.type === 'turn/completed')
    const usage = (await runtime.readSession(session.id)).usage
    // Gemini CLI sends no `usage` and no `usage_update`; before this was
    // read, its sessions had no usage at all and the composer no ring.
    assert.ok(usage)
    assert.deepEqual(usage.last, {
      totalTokens: 12780,
      inputTokens: 12400,
      cachedInputTokens: 0,
      outputTokens: 380,
      reasoningOutputTokens: 0,
    })
    assert.equal(usage.contextUsed ?? null, null, 'nothing in the block says what is in the window')
    assert.equal(usage.contextWindow ?? null, null)
    const types = tape.events.map((event) => event.type)
    assert.ok(types.lastIndexOf('usage/updated') < types.indexOf('turn/completed'), 'in before the turn closes')

    await session.send([{ type: 'text', text: 'quota again' }])
    await tape.until((event) => event.type === 'turn/completed' && tape.events.filter((e) => e.type === 'turn/completed').length === 2)
    const again = (await runtime.readSession(session.id)).usage
    assert.equal(again?.total.totalTokens, 25560, 'turns add up')
    assert.equal(again?.last.totalTokens, 12780, 'last is one turn')
  } finally {
    await runtime.dispose()
  }
})

test('FAKE_ACP_USAGE=quota makes an ordinary turn answer as Gemini CLI does — the screenshot rig’s knob, held', async () => {
  const runtime = new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_USAGE: 'quota' },
  })
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'hello there' }])
    await tape.until((event) => event.type === 'turn/completed')
    assert.deepEqual((await runtime.readSession(session.id)).usage?.last, {
      totalTokens: 15230,
      inputTokens: 14900,
      cachedInputTokens: 0,
      outputTokens: 330,
      reasoningOutputTokens: 0,
    })
  } finally {
    await runtime.dispose()
  }
})

/** The fake agent, with a usage record of its own — the way Antigravity keeps one. */
const withRecord = (usageRecord: AcpUsageRecord): AcpRuntime =>
  new AcpRuntime({ id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath, args: [FAKE], usageRecord })

test('an agent that says nothing about usage has its turn read from its own record', async () => {
  const asked: unknown[] = []
  const runtime = withRecord({
    mark(id) {
      asked.push(['mark', id])
      return 7
    },
    since(id, mark) {
      asked.push(['since', id, mark])
      return { totalTokens: 1000, inputTokens: 900, outputTokens: 100, cachedReadTokens: 600, thoughtTokens: 40 }
    },
  })
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'hello there' }])
    await tape.until((event) => event.type === 'turn/completed')
    const usage = (await runtime.readSession(session.id)).usage
    assert.deepEqual(usage?.last, {
      totalTokens: 1000,
      inputTokens: 900,
      cachedInputTokens: 600,
      outputTokens: 100,
      reasoningOutputTokens: 40,
    })
    assert.deepEqual(
      asked,
      [
        ['mark', String(session.id)],
        ['since', String(session.id), 7],
      ],
      'marked before the turn and read after it, for this session',
    )
    const types = tape.events.map((event) => event.type)
    assert.ok(types.lastIndexOf('usage/updated') < types.indexOf('turn/completed'), 'in before the turn closes')
  } finally {
    await runtime.dispose()
  }
})

test('usage the agent put on the wire outranks its record, which is then not read', async () => {
  let reads = 0
  const runtime = withRecord({
    mark: () => 3,
    since: () => {
      reads += 1
      return { totalTokens: 1, inputTokens: 1, outputTokens: 0 }
    },
  })
  await runtime.start()
  const tape = record(runtime)
  const completed = (count: number) => (event: AgentEvent) =>
    event.type === 'turn/completed' && tape.events.filter((e) => e.type === 'turn/completed').length === count
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'count for me' }])
    await tape.until(completed(1))
    assert.equal((await runtime.readSession(session.id)).usage?.last.totalTokens, 900)
    await session.send([{ type: 'text', text: 'quota for me' }])
    await tape.until(completed(2))
    assert.equal((await runtime.readSession(session.id)).usage?.last.totalTokens, 12780)
    assert.equal(reads, 0)
  } finally {
    await runtime.dispose()
  }
})

test('a turn its record cannot account for shows no last turn, rather than the one before it', async () => {
  let reads = 0
  const runtime = withRecord({
    mark: () => 0,
    since: () => (++reads === 1 ? { totalTokens: 150, inputTokens: 100, outputTokens: 50 } : null),
  })
  await runtime.start()
  const tape = record(runtime)
  const completed = (count: number) => (event: AgentEvent) =>
    event.type === 'turn/completed' && tape.events.filter((e) => e.type === 'turn/completed').length === count
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'hello there' }])
    await tape.until(completed(1))
    assert.equal((await runtime.readSession(session.id)).usage?.last.totalTokens, 150)
    await session.send([{ type: 'text', text: 'hello again' }])
    await tape.until(completed(2))
    const usage = (await runtime.readSession(session.id)).usage
    assert.equal(usage?.last.totalTokens, 0, 'unknown, so nothing: not the first turn under the second one’s name')
    assert.equal(usage?.total.totalTokens, 150, 'and the total keeps what it knew')
  } finally {
    await runtime.dispose()
  }
})

test('a turn of no calls keeps a running cache-write count, because its zeros are known', async () => {
  let reads = 0
  const runtime = withRecord({
    mark: () => 0,
    since: () =>
      ++reads === 1
        ? { totalTokens: 150, inputTokens: 100, outputTokens: 50, cachedReadTokens: 20, cachedWriteTokens: 50 }
        : { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0 },
  })
  await runtime.start()
  const tape = record(runtime)
  const completed = (count: number) => (event: AgentEvent) =>
    event.type === 'turn/completed' && tape.events.filter((e) => e.type === 'turn/completed').length === count
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'hello there' }])
    await tape.until(completed(1))
    await session.send([{ type: 'text', text: 'hello again' }])
    await tape.until(completed(2))
    const usage = (await runtime.readSession(session.id)).usage
    assert.equal(usage?.last.totalTokens, 0)
    assert.equal(usage?.total.cacheWriteTokens, 50, 'the chain of known write counts is unbroken')
  } finally {
    await runtime.dispose()
  }
})

test('a turn that reports no usage at all shows no last turn, whatever the runtime keeps', async () => {
  // Only a runtime with a usage record withdrew the last turn, because only
  // that path knew it had asked and got nothing. An agent that reports usage
  // on some turns and not others left `last` holding the previous turn's
  // figures, and the tail draws `last` under the final turn as its own: turn
  // one's 900 tokens and its cache chip appeared under turn two (#159).
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  const completed = (count: number) => (event: AgentEvent) =>
    event.type === 'turn/completed' && tape.events.filter((e) => e.type === 'turn/completed').length === count
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'count for me' }])
    await tape.until(completed(1))
    assert.equal((await runtime.readSession(session.id)).usage?.last.totalTokens, 900, 'a turn that did report is read')
    await session.send([{ type: 'text', text: 'hello there' }])
    await tape.until(completed(2))
    const usage = (await runtime.readSession(session.id)).usage
    assert.equal(usage?.last.totalTokens, 0, 'unknown, so nothing: not the first turn under the second one’s name')
    assert.equal(usage?.total.totalTokens, 900, 'and the total keeps what it knew')
  } finally {
    await runtime.dispose()
  }
})

test('one turn nobody could account for makes the running cache-write count unknown from then on', async () => {
  // `#recordTurnUsage` states this rule and keeps it for a turn that reported
  // *zeros*; a turn that reported nothing at all never reached it, so the
  // total went on adding and claimed an exact write count for a conversation
  // with a hole in it (#159).
  let reads = 0
  const runtime = withRecord({
    mark: () => 0,
    since: () => {
      reads += 1
      if (reads === 1) return { totalTokens: 150, inputTokens: 100, outputTokens: 50, cachedReadTokens: 20, cachedWriteTokens: 50 }
      if (reads === 2) return null
      return { totalTokens: 60, inputTokens: 40, outputTokens: 20, cachedReadTokens: 10, cachedWriteTokens: 20 }
    },
  })
  await runtime.start()
  const tape = record(runtime)
  const completed = (count: number) => (event: AgentEvent) =>
    event.type === 'turn/completed' && tape.events.filter((e) => e.type === 'turn/completed').length === count
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'turn one' }])
    await tape.until(completed(1))
    assert.equal(
      (await runtime.readSession(session.id)).usage?.total.cacheWriteTokens,
      50,
      'while every turn is accounted for the count is exact',
    )
    await session.send([{ type: 'text', text: 'turn two' }])
    await tape.until(completed(2))
    await session.send([{ type: 'text', text: 'turn three' }])
    await tape.until(completed(3))
    const usage = (await runtime.readSession(session.id)).usage
    assert.equal(usage?.total.totalTokens, 210, 'the turns that did report still add up')
    assert.equal(usage?.total.cacheWriteTokens, undefined, 'and the write total is unknown, permanently')
  } finally {
    await runtime.dispose()
  }
})

test('an unaccountable *first* turn is a gap too, not the start of a chain', async () => {
  // The chain reads an empty total as its own beginning, so without a flag of
  // its own the gap is invisible exactly when it comes first (#159).
  let reads = 0
  const runtime = withRecord({
    mark: () => 0,
    since: () =>
      ++reads === 1 ? null : { totalTokens: 60, inputTokens: 40, outputTokens: 20, cachedReadTokens: 10, cachedWriteTokens: 20 },
  })
  await runtime.start()
  const tape = record(runtime)
  const completed = (count: number) => (event: AgentEvent) =>
    event.type === 'turn/completed' && tape.events.filter((e) => e.type === 'turn/completed').length === count
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'turn one' }])
    await tape.until(completed(1))
    await session.send([{ type: 'text', text: 'turn two' }])
    await tape.until(completed(2))
    const usage = (await runtime.readSession(session.id)).usage
    assert.equal(usage?.total.totalTokens, 60, 'the turn that did report is in the total')
    assert.equal(usage?.total.cacheWriteTokens, undefined, 'a chain that begins in a gap has no exact start')
  } finally {
    await runtime.dispose()
  }
})

test('a record that cannot be read leaves the turn without usage rather than a guess', async () => {
  for (const mark of [() => null, () => { throw new Error('locked') }]) {
    let reads = 0
    const runtime = withRecord({
      mark,
      since: () => {
        reads += 1
        return { totalTokens: 1, inputTokens: 1, outputTokens: 0 }
      },
    })
    await runtime.start()
    const tape = record(runtime)
    try {
      const session = await runtime.createSession({ cwd: '/tmp/w' })
      await session.send([{ type: 'text', text: 'hello there' }])
      await tape.until((event) => event.type === 'turn/completed')
      assert.equal((await runtime.readSession(session.id)).usage, null)
      assert.equal(reads, 0, 'no mark, no read: the turn cannot be told from the ones before it')
    } finally {
      await runtime.dispose()
    }
  }
})

/**
 * A greyed control still has a value, and leaving it where it is must work.
 *
 * This cost two dead sessions to find. Cursor's Gemini and Codex families have
 * one context window, so their Max mode switch is disabled and reads `false` —
 * and setting it to `false` was refused, because the check looked at
 * `disabled` before it looked at whether anything was actually changing. The
 * refusal then rode into the agent's stored picks and every later
 * `session/create` sent it again and died on it: an agent that could not open
 * a session because of a setting nobody had touched, with the only way back
 * being to change it on a session you could no longer open.
 */
test('a disabled option takes the value it already has, and refuses any other', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    const wide = session.options().find((option) => option.id === 'wide')
    assert.ok(wide && wide.type === 'boolean' && wide.disabled, 'the fake declares it greyed')
    assert.equal(wide.currentValue, false)

    // Asking for what is already true changes nothing, so there is nothing to
    // refuse — even though the control cannot be moved.
    await session.setOption('wide', false)
    assert.equal(
      session.options().find((option) => option.id === 'wide')?.currentValue,
      false,
      'still off, and still declared',
    )

    // Asking for what the agent cannot do is still refused, in its own words.
    await assert.rejects(session.setOption('wide', true), /one window/)
  } finally {
    await runtime.dispose()
  }
})

/**
 * One stale pick must not cost the agent every future session.
 *
 * The draft probe has always dropped a refused *dimension* rather than
 * throwing — a standing preference the model just chosen has no use for is not
 * an error. `createSession` never learned the same split, so a pick stored
 * against the agent that the current family had no place for made every new
 * session throw for the life of the process.
 */
test('a stored pick the session cannot take is dropped, not fatal', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const session = await runtime.createSession({
      cwd: '/tmp/w',
      options: { voice: 'pirate', wide: true },
    })
    // The session exists, and the picks it *could* take were taken.
    assert.equal(session.options().find((option) => option.id === 'voice')?.currentValue, 'pirate')
    assert.equal(session.options().find((option) => option.id === 'wide')?.currentValue, false)

    // A model or a mode is the caller's question answered wrongly, and still
    // fails the call — the split is between identity and preference.
    await assert.rejects(
      runtime.createSession({ cwd: '/tmp/w', options: { mode: 'operatic' } }),
      /operatic/,
    )

    // And so does a dimension carrying a value the option does not offer. That
    // is a typo or a stale preset, not a preference going spare, and quietly
    // dropping it would hide a real mistake — the distinction this rests on is
    // inapplicable versus wrong, not identity versus dimension.
    await assert.rejects(
      runtime.createSession({ cwd: '/tmp/w', options: { voice: 'operatic' } }),
      /not one of the values/,
    )
  } finally {
    await runtime.dispose()
  }
})

test('ACP modes and config options land on the capability surface unchanged', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    const options = session.options()
    const mode = options.find((option) => option.id === 'mode')
    assert.ok(mode && mode.type === 'select' && mode.category === 'mode')
    assert.deepEqual(mode.choices.map((choice) => choice.value), ['chatty', 'terse'])
    const voice = options.find((option) => option.id === 'voice')
    assert.ok(voice && voice.type === 'select')
    const verbose = options.find((option) => option.id === 'verbose')
    assert.ok(verbose && verbose.type === 'boolean')

    // Change one of each; the agent's own confirmation re-declares the list.
    await session.setOption('mode', 'terse')
    await session.setOption('voice', 'pirate')
    await tape.until(
      (event) =>
        event.type === 'session/options' &&
        event.options.some((option) => option.id === 'voice' && option.currentValue === 'pirate'),
    )
    // A refused value fails in the agent's own words, with nothing applied —
    // and as the typed `OptionRefusedError` a caller tells apart from a wire
    // failure by (#1013 finding 5): the real adapter throwing it for real,
    // not only a fake `ctx.seats.open` a seating test injects it into.
    await assert.rejects(session.setOption('voice', 'operatic'), (error: unknown) => {
      assert.ok(error instanceof OptionRefusedError, 'a typed OptionRefusedError, not a plain Error')
      assert.match(error.message, /not one of the values/)
      assert.equal(error.optionId, 'voice')
      assert.equal(error.value, 'operatic')
      assert.equal(error.unknownOption, false, 'the option exists — only the value was refused')
      return true
    })
    // The changed voice is visible in behaviour, not only in state.
    await session.send([{ type: 'text', text: 'ahoy' }])
    const completed = await tape.until((event) => event.type === 'turn/completed')
    const message = (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn.items.find(
      (item) => item.type === 'assistantMessage',
    )
    assert.ok(message && message.type === 'assistantMessage')
    assert.match(message.text, /yarr/)
  } finally {
    await runtime.dispose()
  }
})

test('Cline-style auto_approve is a permission option and round-trips as a boolean', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    const option = session.options().find((entry) => entry.id === 'auto_approve')
    assert.ok(option && option.type === 'boolean')
    assert.equal(option.category, '_permissions')
    assert.equal(option.currentValue, false)

    await session.setOption('auto_approve', true)
    const changed = await tape.until(
      (event) =>
        event.type === 'session/options' &&
        event.options.some((entry) => entry.id === 'auto_approve' && entry.currentValue === true),
    )
    const updated = (changed as Extract<AgentEvent, { type: 'session/options' }>).options.find(
      (entry) => entry.id === 'auto_approve',
    )
    assert.ok(updated && updated.type === 'boolean')
    assert.equal(updated.currentValue, true)

    await session.send([{ type: 'text', text: 'use the tool' }])
    const completed = await tape.until((event) => event.type === 'turn/completed')
    const turn = (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn
    assert.equal(turn.status, 'completed')
    assert.equal(tape.events.some((event) => event.type === 'approval/requested'), false)
    const tool = turn.items.find((item) => item.type === 'toolCall')
    assert.ok(tool && tool.type === 'toolCall' && tool.status === 'completed')
  } finally {
    await runtime.dispose()
  }
})

test('changing the model in ACP emits session/settings as well as session/options (#374)', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    assert.equal(session.settings().model, 'small')
    await session.setOption('model', 'large')
    const settingsEvent = await tape.until((event) => event.type === 'session/settings')
    assert.equal((settingsEvent as Extract<AgentEvent, { type: 'session/settings' }>).settings.model, 'large')
    assert.equal(session.settings().model, 'large')
  } finally {
    await runtime.dispose()
  }
})

test('a source-marked split usage response includes both cache halves in input totals', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'split' }])
    const usage = (await tape.until((event) => event.type === 'usage/updated')) as Extract<AgentEvent, { type: 'usage/updated' }>
    assert.equal(usage.usage.last.inputTokens, 170)
    assert.equal(usage.usage.last.cachedInputTokens, 20)
    assert.equal(usage.usage.last.cacheWriteTokens, 50)
  } finally {
    await runtime.dispose()
  }
})

test('grouped choices are read as the choices inside them, by name', async () => {
  // ACP lets a select group its choices, and DeepSeek Harness's own server
  // does: one group per provider, each value an opaque `["provider","model"]`.
  // Read as a flat list, the picker offered one choice — the group's name,
  // with no value — and the seat and the model catalogue both printed the
  // raw pair where the model's name belonged.
  const runtime = make({ FAKE_ACP_GROUPED_MODELS: '1' })
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    const model = session.options().find((option) => option.id === 'model')
    assert.ok(model && model.type === 'select')
    assert.deepEqual(
      model.choices.map((choice) => [choice.value, choice.label]),
      [['["house","small"]', 'Small'], ['["house","large"]', 'Large']],
      'the choices inside the group, never the group itself',
    )
    assert.equal(model.choices[1]?.description, 'The big one.')

    const catalog = await runtime.listModels()
    assert.deepEqual(
      catalog.map((entry) => [entry.id, entry.displayName]),
      [['["house","small"]', 'Small'], ['["house","large"]', 'Large']],
      'the catalogue names each model, not the group',
    )

    await session.setOption('model', '["house","large"]')
    assert.equal(session.settings().model, '["house","large"]', 'the opaque value is still what is sent and kept')
    const after = session.options().find((option) => option.id === 'model')
    assert.ok(after && after.type === 'select')
    assert.equal(after.choices.length, 2, "the agent's answer is flattened too")
  } finally {
    await runtime.dispose()
  }
})

test('a model declared only through configOptions updates settings after selection', async () => {
  const runtime = make({ FAKE_ACP_CONFIG_MODEL_ONLY: '1' })
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    assert.equal(session.settings().model, 'small')
    await session.setOption('model', 'large')
    const settingsEvent = await tape.until((event) => event.type === 'session/settings')
    assert.equal((settingsEvent as Extract<AgentEvent, { type: 'session/settings' }>).settings.model, 'large')
    assert.equal(session.settings().model, 'large')
    assert.equal(session.options().find((option) => option.id === 'model')?.currentValue, 'large')
  } finally {
    await runtime.dispose()
  }
})

test('pluginTools is false for an agent that declares no tool server', async () => {
  const runtime = make()
  await runtime.start()
  try {
    assert.equal(runtime.info.capabilities.pluginTools, false, 'no toolServer means no plugin tools')
  } finally {
    await runtime.dispose()
  }
})

test('an agent that refuses the tool server says so, and says it out loud', async () => {
  // The refusal used to be learned only on the first real session, leaving
  // `pluginTools: true` on faith for as long as nobody talked to the agent.
  // The runtime now opens its own probe moments after start, so the claim
  // becomes an observation — accepted or refused — before anyone asks.
  const runtime = new AcpRuntime({
    id: 'refuser',
    name: 'Refuser',
    command: process.execPath,
    args: [FAKE],
    // The retry without the tool server answered late, as under load (#215).
    env: { FAKE_ACP_REFUSE_TOOLS: '1', FAKE_ACP_SLOW_OPEN_MS: '50' },
    toolServer: {
      name: 'harnessdesk',
      command: process.execPath,
      args: ['--version'],
      env: {},
    },
  })
  let announced = 0
  const off = runtime.onInfoChange?.(() => {
    announced += 1
  })
  // The probe's retry opens a session, which observes the sign-in and announces that too.
  let observed = false
  const unsubscribe = runtime.subscribe((event) => {
    if (event.type === 'account/changed') observed = true
  })
  await runtime.start()
  try {
    /* The eager probe observes the refusal without any session being asked
       for. Waited out to its end, the retry's sign-in included: settled on the
       refusal alone, the sign-in's announcement landed during the session
       below whenever the retry answered late, and read as the refusal
       announced twice (#215, 3 !== 2 under load). */
    const deadline = Date.now() + 5_000
    while ((runtime.info.capabilities.pluginTools || !observed) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(
      runtime.info.capabilities.pluginTools,
      false,
      'the refusal was observed eagerly, not left until the first conversation',
    )
    assert.ok(announced >= 2, 'the handshake and the refusal were both announced')
    const settled = announced

    // The retry without the server is what makes this succeed at all.
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    assert.ok(session, 'a refused tool server does not cost the session')
    assert.equal(runtime.info.capabilities.pluginTools, false, 'the refusal is remembered')
    assert.equal(announced, settled, 'a remembered refusal is not announced twice')
    off?.()
    unsubscribe()
  } finally {
    await runtime.dispose()
  }
})

test('a tool-server refusal in error.data retries without the bridge (#358)', async () => {
  const runtime = new AcpRuntime({
    id: 'refuser-data',
    name: 'Refuser Data',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_REFUSE_TOOLS: 'openclaw', FAKE_ACP_SLOW_OPEN_MS: '50' },
    toolServer: {
      name: 'harnessdesk',
      command: process.execPath,
      args: ['--version'],
      env: {},
    },
  })
  let observed = false
  const unsubscribe = runtime.subscribe((event) => {
    if (event.type === 'account/changed') observed = true
  })
  await runtime.start()
  try {
    const deadline = Date.now() + 5_000
    while ((runtime.info.capabilities.pluginTools || !observed) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(
      runtime.info.capabilities.pluginTools,
      false,
      'the refusal stated in error.data was observed eagerly',
    )
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    assert.ok(session, 'a tool server refused in error.data does not cost the session')
    assert.equal(runtime.info.capabilities.pluginTools, false, 'the refusal is remembered')
    unsubscribe()
  } finally {
    await runtime.dispose()
  }
})

test('a restart asks again: an agent upgraded to accept the tool server gets it, token and all', async (t) => {
  // The refusal was remembered for the life of the runtime object, and a
  // restart — Refresh models, a CLI that changed on disk, a crash — reuses
  // that object. So an agent upgraded to take a per-session tool server kept
  // being offered none until the whole app restarted, and every board call
  // its seats made arrived without a caller token and was refused.
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'hd-reask-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const refusing = join(dir, 'refusing')
  const dump = join(dir, 'servers.json')
  await writeFile(refusing, '')
  const claims: [string, string][] = []
  const runtime = new AcpRuntime({
    id: 'upgraded',
    name: 'Upgraded',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_REFUSE_TOOLS_WHILE: refusing, FAKE_ACP_DUMP_SERVERS: dump },
    toolServer: {
      name: 'harnessdesk',
      command: process.execPath,
      args: ['--version'],
      env: {},
      onSession: (token, session) => claims.push([token, session]),
    },
  })
  const settle = async (want: boolean): Promise<void> => {
    const deadline = Date.now() + 5_000
    while (runtime.info.capabilities.pluginTools !== want && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  await runtime.start()
  try {
    await settle(false)
    assert.equal(runtime.info.capabilities.pluginTools, false, 'the old agent refused, and that was learned')

    // The upgrade, then a restart of the same runtime.
    const { rm: remove } = await import('node:fs/promises')
    await remove(refusing)
    const refreshed = await runtime.refreshCatalog()
    assert.equal(refreshed.refreshed, true, 'nothing but the probe was open, so the agent restarted')
    assert.equal(runtime.info.capabilities.pluginTools, true, 'a fresh process is asked afresh')

    const session = await runtime.createSession({ cwd: '/tmp/w' })
    const claim = claims.find(([, id]) => id === String(session.id))
    assert.ok(claim, 'the upgraded agent was offered the tool server for this session')
    const dumped = JSON.parse(await readFile(dump, 'utf8')) as { env?: { name: string; value: string }[] }[]
    const carried = dumped.at(-1)?.env?.find((entry) => entry.name === 'HD_TOOLS_CALLER')
    assert.equal(carried?.value, claim[0], "the session's bridge carries its own caller token")
  } finally {
    await runtime.dispose()
  }
})

test('an agent that reports no version at all is still asked again on its next launch after refusing (#961 review)', async (t) => {
  // The version comparison that spares a steady refuser a repeat question
  // (above) has nothing to compare when the agent names no version at all:
  // `undefined !== undefined` reads as "unchanged" and would leave it refused
  // forever, never asked again until the whole app restarts — unlike a
  // versioned agent, which a fresh launch's differing version already re-asks.
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'hd-reask-noversion-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const refusing = join(dir, 'refusing')
  await writeFile(refusing, '')
  const runtime = new AcpRuntime({
    id: 'versionless-upgraded',
    name: 'Versionless Upgraded',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_REFUSE_TOOLS_WHILE: refusing, FAKE_ACP_NO_AGENT_VERSION: '1' },
    toolServer: { name: 'harnessdesk', command: process.execPath, args: ['--version'], env: {} },
  })
  const settle = async (want: boolean): Promise<void> => {
    const deadline = Date.now() + 5_000
    while (runtime.info.capabilities.pluginTools !== want && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  await runtime.start()
  try {
    await settle(false)
    assert.equal(runtime.info.capabilities.pluginTools, false, 'the versionless agent refused, and that was learned')

    await rm(refusing)
    const refreshed = await runtime.refreshCatalog()
    assert.equal(refreshed.refreshed, true, 'nothing but the probe was open, so the agent restarted')
    assert.equal(runtime.info.capabilities.pluginTools, true, 'a fresh launch is asked afresh even though it names no version to compare')
  } finally {
    await runtime.dispose()
  }
})

test('a build that refused the tool server is not asked again on every restart', async () => {
  const runtime = new AcpRuntime({
    id: 'steady-refuser',
    name: 'Steady Refuser',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_REFUSE_TOOLS: '1', FAKE_ACP_AGENT_VERSION: '2.0.0' },
    toolServer: { name: 'harnessdesk', command: process.execPath, args: ['--version'], env: {} },
  })
  await runtime.start()
  try {
    const deadline = Date.now() + 5_000
    while (runtime.info.capabilities.pluginTools && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(runtime.info.capabilities.pluginTools, false)
    const refreshed = await runtime.refreshCatalog()
    assert.equal(refreshed.refreshed, true)
    // Re-asked, the claim would read true until the probe was refused again.
    assert.equal(runtime.info.capabilities.pluginTools, false, 'the same build keeps its answer')
  } finally {
    await runtime.dispose()
  }
})

test('every open carries a caller token, and the map learns whose it is', async (t) => {
  // §25.3: `tools/invoke` used to carry no scope, so a tool called over MCP
  // could not say which session called it. The agent spawns the bridge from
  // the config it gets in session/new, so the token rides that bridge's env
  // — and the adapter tells whoever built it which session the token names.
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'hd-caller-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dump = join(dir, 'servers.json')
  const claims: [string, string][] = []
  const runtime = new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_DUMP_SERVERS: dump },
    toolServer: {
      name: 'harnessdesk',
      command: process.execPath,
      args: ['--version'],
      env: { HD_TOOLS_SOCKET: '/tmp/hd.sock' },
      onSession: (token, session) => claims.push([token, session]),
    },
  })
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    const claim = claims.find(([, id]) => id === String(session.id))
    assert.ok(claim, 'the open announced which session its token names')

    const dumped = JSON.parse(await readFile(dump, 'utf8')) as {
      env?: { name: string; value: string }[]
    }[]
    const env = dumped.at(-1)?.env ?? []
    const carried = env.find((entry) => entry.name === 'HD_TOOLS_CALLER')
    assert.equal(carried?.value, claim[0], 'the bridge env carries the very token that was claimed')
    assert.ok(
      env.some((entry) => entry.name === 'HD_TOOLS_SOCKET'),
      'the existing env still rides along',
    )

    // Two opens, two tokens: a probe and a session must not share a name.
    const tokens = new Set(claims.map(([token]) => token))
    assert.equal(tokens.size, claims.length, 'every open minted its own token')
  } finally {
    await runtime.dispose()
  }
})

test('an agent that never answered the handshake claims nothing', async () => {
  // Static defaults are how an agent that could not even launch came to
  // claim `interrupt`, `plans`, `reasoning` and `pluginTools`. Capabilities
  // are observations: before a handshake there are none.
  const runtime = new AcpRuntime({
    id: 'ghost',
    name: 'Ghost',
    command: '/nonexistent/ghost-agent',
    toolServer: { name: 'harnessdesk', command: process.execPath, args: ['--version'], env: {} },
    secrets: [{ env: 'GHOST_API_KEY', label: 'Ghost API key' }],
  })
  const before = runtime.info.capabilities
  assert.equal(before.interrupt, false)
  assert.equal(before.plans, false)
  assert.equal(before.reasoning, false)
  assert.equal(before.pluginTools, false)
  // The one truth that does not need a live process: the account surface is
  // answered by the credential broker, and the registry declares a secret.
  assert.equal(before.account, true)

  await assert.rejects(runtime.start())
  const after = runtime.info.capabilities
  assert.equal(after.interrupt, false, 'failing to start observed nothing new')
  assert.equal(after.pluginTools, false)
  assert.equal(runtime.health().state, 'unavailable')
  await runtime.dispose()
})

test('a configured agent that exits cleanly stays restart-recoverable', async () => {
  let repaired = false
  const runtime = new AcpRuntime({
    id: 'clean-exit',
    name: 'Clean Exit',
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    resolveLaunch: async () => repaired
      ? { command: process.execPath, args: [FAKE], version: null }
      : null,
  })
  try {
    await assert.rejects(runtime.start(), (error: unknown) => {
      assert.match(String(error), /The agent exited \(code 0\) while requests were waiting/)
      assert.equal((error as { exitCode?: unknown }).exitCode, 0)
      return true
    })
    assert.deepEqual(runtime.health(), {
      state: 'unavailable',
      reason: 'crashed',
      message: 'Clean Exit exited cleanly before completing the ACP handshake. Check its command and configuration.',
      remediation: "Verify the agent's profile or configuration, then select it again.",
    })
    repaired = true
    assert.deepEqual(await runtime.refreshCatalog(), { refreshed: true })
    assert.equal(runtime.health().state, 'ready')
  } finally {
    await runtime.dispose()
  }
})

test('the handshake is what turns the protocol-level claims on', async () => {
  const runtime = make()
  assert.equal(runtime.info.capabilities.interrupt, false, 'nothing claimed before start')
  let announced = 0
  runtime.onInfoChange?.(() => {
    announced += 1
  })
  await runtime.start()
  try {
    assert.equal(runtime.info.capabilities.interrupt, true)
    assert.equal(runtime.info.capabilities.plans, true)
    assert.equal(runtime.info.capabilities.reasoning, true)
    assert.ok(announced >= 1, 'the flip was announced, so a drawn window redraws')
  } finally {
    await runtime.dispose()
  }
})

test('a permission request becomes an approval; the decision reaches the agent', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'use the tool' }])
    const requested = await tape.until((event) => event.type === 'approval/requested')
    const approval = (requested as Extract<AgentEvent, { type: 'approval/requested' }>).approval
    assert.equal(approval.type, 'permission')
    assert.equal(approval.summary, 'poke_the_thing')
    // Why it is asking, not just what it is asking about. The agent attaches
    // that to the request's tool call; reading only the title left the user
    // approving a verb.
    assert.equal(approval.reason, 'the thing is outside the workspace')
    assert.deepEqual(
      approval.options.map((option) => option.intent),
      ['approve', 'approveAlways', 'deny'],
    )
    await session.respondToApproval(approval.id, { type: 'option', optionId: 'yes' })
    const completed = await tape.until((event) => event.type === 'turn/completed')
    const turn = (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn
    assert.equal(turn.status, 'completed')
    const tool = turn.items.find((item) => item.type === 'toolCall')
    assert.ok(tool && tool.type === 'toolCall' && tool.status === 'completed')
  } finally {
    await runtime.dispose()
  }
})

test('a permission request with null/non-object blocks in content does not throw and becomes an approval', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'use tool with malformed content' }])
    const requested = await tape.until((event) => event.type === 'approval/requested')
    const approval = (requested as Extract<AgentEvent, { type: 'approval/requested' }>).approval
    assert.equal(approval.type, 'permission')
    assert.equal(approval.summary, 'poke_with_null_block')
    assert.equal(approval.reason, 'reason despite null block')
    await session.respondToApproval(approval.id, { type: 'option', optionId: 'yes' })
    const completed = await tape.until((event) => event.type === 'turn/completed')
    const turn = (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn
    assert.equal(turn.status, 'completed')
  } finally {
    await runtime.dispose()
  }
})

test('a tool_call_update with null or malformed content blocks does not crash the host', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'tool update with null content' }])
    const completed = await tape.until((event) => event.type === 'turn/completed')
    const turn = (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn
    assert.equal(turn.status, 'completed')
    const tool = turn.items.find((item) => item.type === 'toolCall')
    assert.ok(tool && tool.type === 'toolCall' && tool.status === 'completed')
  } finally {
    await runtime.dispose()
  }
})

test('interrupt cancels a slow turn as interrupted, not failed', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'slow' }])
    await new Promise((resolve) => setTimeout(resolve, 100))
    await session.interrupt()
    const completed = await tape.until((event) => event.type === 'turn/completed')
    assert.equal((completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn.status, 'interrupted')
  } finally {
    await runtime.dispose()
  }
})

/**
 * The splice that put an agent's answer in a room twice.
 *
 * ACP's `session/update` names a session and not a prompt, so two prompts in
 * flight are unattributable: the second `send` overwrote the one turn slot,
 * stranded the first turn `inProgress` for ever, and folded both answers into
 * the newest turn's single message item — end to end, no separator. The room
 * shows the last thing a woken conversation said, so it showed both.
 *
 * A turn in flight and a second send is all it takes, which is a room post and
 * a prompt typed in the same second.
 */
test('one prompt at a time: a second send is refused, never spliced onto the turn in flight', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    // `slow` holds its turn open until something interrupts it.
    await session.send([{ type: 'text', text: 'slow' }])
    await tape.until((event) => event.type === 'turn/started')

    await assert.rejects(
      () => session.send([{ type: 'text', text: 'hello there' }]),
      /still working on the last message/,
    )
    // Refused before the wire: no second turn to strand, and nothing of the
    // second prompt for the first turn's message to absorb.
    assert.equal(
      tape.events.filter((event) => event.type === 'turn/started').length,
      1,
      'the refused prompt started no turn',
    )

    await session.interrupt()
    const completed = await tape.until((event) => event.type === 'turn/completed')
    const turn = (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn
    assert.equal(turn.status, 'interrupted')
    const said = turn.items
      .filter((item) => item.type === 'assistantMessage')
      .map((item) => (item.type === 'assistantMessage' ? item.text : ''))
      .join('')
    assert.ok(!said.includes('hearing: hello there'), `one turn, one answer: ${JSON.stringify(said)}`)
    assert.equal(
      tape.events.filter((event) => event.type === 'turn/completed').length,
      1,
      'the turn that was in flight is the one that ended',
    )
  } finally {
    await runtime.dispose()
  }
})

test('an agent dying mid-turn fails the turn cleanly — never hangs', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'slow' }])
    await new Promise((resolve) => setTimeout(resolve, 100))
    // Kill the agent out from under the adapter.
    runtime.connection.kill()
    const completed = await tape.until((event) => event.type === 'turn/completed')
    const turn = (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn
    assert.equal(turn.status, 'failed')
    assert.ok(turn.error, 'the turn carries why')
    assert.equal(runtime.health().state, 'unavailable')
  } finally {
    await runtime.dispose()
  }
})

test('the client declines fs and terminal, and the agent can tell', async () => {
  // The fake refuses any client that offers fs or terminal capabilities, so
  // this passing start IS the proof of the refusals, from both sides of the wire.
  const runtime = make()
  await runtime.start()
  assert.equal(runtime.health().state, 'ready')
  await runtime.dispose()
})

test('a stored conversation survives the agent and this process', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = join(dir, 'store.json')
  const withStore = (): AcpRuntime =>
    new AcpRuntime({
      id: 'fake-acp',
      name: 'Fake ACP Agent',
      command: process.execPath,
      args: [FAKE],
      env: { FAKE_ACP_STORE: store },
    })

  const first = withStore()
  await first.start()
  const tapeA = record(first)
  let sessionId: string
  try {
    // A real folder: a stored conversation can only be reopened where it ran.
    const session = await first.createSession({ cwd: dir })
    sessionId = String(session.id)
    // Three blocks — a context chip, an image, and the ask — the way the
    // composer sends them.
    await session.send([
      { type: 'text', text: '<context source="x">ctx</context>' },
      { type: 'image', url: 'data:image/png;base64,AAAA', name: 'dot.png' },
      { type: 'text', text: 'remember me' },
    ])
    await tapeA.until((event) => event.type === 'turn/completed')
  } finally {
    await first.dispose() // the agent process dies with it
  }

  const second = withStore()
  await second.start()
  try {
    assert.equal(second.info.capabilities.listHistory, true)
    const listed = await second.listSessions()
    const row = listed.data.find((entry) => String(entry.id) === sessionId)
    assert.ok(row, 'the stored conversation is listed by a fresh process')
    assert.match(row.title ?? '', /remember me/)

    // Reading loads it: the transcript is there, and the session takes turns.
    const read = await second.readSession(row.id)
    assert.equal(read.turns.length, 1, 'one prompt is one turn, however many blocks it had')
    const user = read.turns[0]!.items.find((item) => item.type === 'userMessage')
    assert.ok(user, 'the replayed turn carries the original user message')
    assert.equal(user.type === 'userMessage' ? user.content.length : 0, 3, 'all blocks, one message')
    // The image comes back as the bytes that were sent, renderable again —
    // the name was never the agent's to keep.
    assert.deepEqual(user.type === 'userMessage' ? user.content[1] : null, {
      type: 'image',
      url: 'data:image/png;base64,AAAA',
    })
    assert.ok(read.turns[0]!.items.some((item) => item.type === 'assistantMessage'), 'and the answer')
  } finally {
    await second.dispose()
  }
})

test("a client's own wrapper comes back folded beside the words, not inside them", async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-envelope-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = join(dir, 'store.json')
  const withStore = (): AcpRuntime =>
    new AcpRuntime({
      id: 'fake-acp',
      name: 'Fake ACP Agent',
      command: process.execPath,
      args: [FAKE],
      env: { FAKE_ACP_STORE: store },
    })

  // Verbatim from a transcript on disk: what Claude Code's desktop app pins
  // to a screenshot someone drew on, inside the message it stores as theirs.
  const annotation =
    "<preview-annotation-context>The attached image is a screenshot of the Browser pane's page with the user's freehand annotations drawn on top. Use the Claude_Browser tools to inspect or interact with the live page.</preview-annotation-context>"

  const first = withStore()
  await first.start()
  const tape = record(first)
  let sessionId: string
  try {
    const session = await first.createSession({ cwd: dir })
    sessionId = String(session.id)
    await session.send([
      { type: 'text', text: `${annotation}\n\ntoo big …` },
      { type: 'image', url: 'data:image/png;base64,AAAA', name: 'shot.png' },
    ])
    await tape.until((event) => event.type === 'turn/completed')
  } finally {
    await first.dispose()
  }

  const second = withStore()
  await second.start()
  try {
    const listed = await second.listSessions()
    const row = listed.data.find((entry) => String(entry.id) === sessionId)
    assert.ok(row, 'the conversation is there to reopen')
    const read = await second.readSession(row.id)
    const user = read.turns[0]!.items.find((item) => item.type === 'userMessage')
    assert.ok(user, 'the replayed turn carries the user message')
    const content = user.type === 'userMessage' ? user.content : []
    const context = user.type === 'userMessage' ? user.context ?? [] : []
    // The bubble is the two words the person typed about their drawing; the
    // picture is still beside them, and the note is a row of its own.
    assert.deepEqual(content[0], { type: 'text', text: 'too big …' })
    assert.equal(content.length, 2, 'the text and the image, the envelope gone from both')
    assert.equal(context.length, 1)
    assert.equal(context[0]?.label, 'Annotated screenshot')
    assert.match(context[0]?.text ?? '', /freehand annotations/, 'folded whole, not summarised away')
  } finally {
    await second.dispose()
  }
})

test('the catalogue is the agent\'s models, each with the levels it declared', async () => {
  const runtime = make()
  await runtime.start()
  try {
    // Nobody has opened a conversation: ACP declares models per session, so
    // the catalogue is what the draft probe hears — and it is heard here.
    const models = await runtime.listModels()
    assert.deepEqual(
      models.map((model) => model.id),
      ['small', 'large'],
    )
    const small = models.find((model) => model.id === 'small')
    const large = models.find((model) => model.id === 'large')
    assert.equal(small?.isDefault, true, 'the model the agent started on is the default')
    assert.equal(large?.description, 'Slower, wiser.')
    // `small` says nothing of its own, so the session's thought-level option
    // answers for it — without the choice that only means "leave it alone".
    // Marked shared (#1013): a caller must not refuse an effort against this
    // list, since it is only known to be true of whatever model the probe
    // itself was actually on, not necessarily `small`.
    assert.deepEqual(small?.reasoningLevels, [
      { id: 'brief', label: 'Brief' },
      { id: 'long', label: 'Long' },
    ])
    assert.equal(small?.reasoningLevelsShared, true)
    // `large` names its own, and they win — never marked shared.
    assert.deepEqual(large?.reasoningLevels, [
      { id: 'brief', label: 'Brief' },
      { id: 'long', label: 'Long' },
      { id: 'eternal', label: 'Eternal' },
    ])
    assert.equal(large?.reasoningLevelsShared, undefined)
    // A draft pick moves the probe's model; the agent's default does not move.
    await runtime.defaultSessionOptions('/tmp/acp-catalog', { model: 'large' })
    const after = await runtime.listModels()
    assert.equal(after.find((model) => model.id === 'small')?.isDefault, true)
  } finally {
    await runtime.dispose()
  }
})

/*
 * Two questions about the catalogue, with different answers when it could not
 * be read. The picker's — what is there to draw — is answered with what is
 * known, which is nothing, exactly as it always was. A seating's — does this
 * agent offer that model — must not take "could not say" for "offers none",
 * so `knownModels` answers null until the agent has declared its models once.
 */

test('a catalogue the agent never managed to declare is unknown, though the picker still draws it empty', async () => {
  // Every conversation this agent is asked to open fails, the draft probe included.
  const runtime = make({ FAKE_ACP_SERVER_ERROR: '1' })
  await runtime.start()
  try {
    assert.deepEqual(await runtime.listModels(), [], 'the picker is answered as it always was')
    const asked: AgentRuntime = runtime
    assert.equal(await asked.knownModels?.(), null, 'and a seating is told nothing is known')
  } finally {
    await runtime.dispose()
  }
})

test('a catalogue the agent declared is known — and one that declares no models is known to have none', async () => {
  const declared: AgentRuntime = make()
  const none: AgentRuntime = new AcpRuntime({
    id: 'variant',
    name: 'Variant',
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/variant-acp-agent.mjs', import.meta.url))],
    env: { VARIANT_NO_MODELS: '1' },
  })
  await Promise.all([declared.start(), none.start()])
  try {
    assert.deepEqual((await declared.knownModels?.())?.map((model) => model.id), ['small', 'large'])
    assert.deepEqual(await none.knownModels?.(), [], 'it opened a conversation and named no model: that is an answer')
    assert.deepEqual(await none.listModels(), [])
  } finally {
    await Promise.all([declared.dispose(), none.dispose()])
  }
})

test('two questions about a draft on the same tick open one probe, not two', async () => {
  // The composer asking what a draft would start with, and the settings
  // screen asking the same, arrive together — and on start the adapter is
  // already opening a probe of its own to see whether tools reach the agent.
  // Each open that loses this race used to become a registered session that
  // nothing would ever prompt or name: an "Untitled session" in the agent's
  // list, one per race, for the life of the process.
  const runtime = make()
  await runtime.start()
  try {
    const [first, second] = await Promise.all([
      runtime.defaultSessionOptions('/tmp/acp-probe'),
      runtime.defaultSessionOptions('/tmp/acp-probe', { model: 'large' }),
    ])
    assert.deepEqual(
      first.map((option) => option.id),
      second.map((option) => option.id),
      'both callers were answered by the same session',
    )
    const listed = await runtime.listSessions()
    assert.deepEqual(listed.data, [], 'and there is exactly one probe to hide')
  } finally {
    await runtime.dispose()
  }
})

test("the agent's own commands are its skills, listed but not switchable", async () => {
  const runtime = make()
  await runtime.start()
  try {
    assert.equal(runtime.info.capabilities.skills, false, 'nothing has been declared yet')
    const skills = await runtime.listSkills()
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ['forget', 'rehearse'],
    )
    assert.equal(skills[1]?.description, 'Practises the answer first.')
    // ACP has no way to turn one off, so the interface is told not to offer it.
    assert.ok(skills.every((skill) => skill.toggleable === false))
    assert.equal(runtime.info.capabilities.skills, true, 'and now the agent has some')
  } finally {
    await runtime.dispose()
  }
})

test('a session whose opening options are refused leaves nothing behind', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const before = (await runtime.listSessions()).data.length
    await assert.rejects(
      runtime.createSession({ cwd: '/tmp/w', options: { voice: 'operatic' } }),
      /not one of the values/,
    )
    const after = await runtime.listSessions()
    assert.equal(after.data.length, before, 'no untitled, turnless session is left in the list')
  } finally {
    await runtime.dispose()
  }
})

test("a session open here wears the agent's own name, not the first thing typed", async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-name-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = join(dir, 'store.json')
  const runtime = new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_STORE: store },
  })
  const tape = record(runtime)
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'name this one' }])
    await tape.until((event) => event.type === 'turn/completed')

    const listed = await runtime.listSessions()
    const row = listed.data.find((entry) => entry.id === session.id)
    assert.ok(row, 'the open session is in the list once, as itself')
    // The agent named it; the client shows that name even though this
    // session is live here and was never re-read from the store.
    assert.equal(row.title, 'A chat about name this one')
    assert.match(row.preview ?? '', /name this one/, 'the first message stays the preview')
    assert.equal(
      listed.data.filter((entry) => entry.id === session.id).length,
      1,
      'the stored row does not double the live one',
    )
  } finally {
    await runtime.dispose()
  }
})

test('an ACP placeholder title leaves the opening ask available to the sidebar (#667)', async (t) => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-placeholder-title-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = join(dir, 'store.json')
  const runtime = new AcpRuntime({
    id: 'antigravity-acp',
    name: 'Antigravity',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_STORE: store },
  })
  const tape = record(runtime)
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: dir })
    await session.send([{ type: 'text', text: 'Fix the Antigravity session title' }])
    await tape.until((event) => event.type === 'turn/completed')

    const saved = JSON.parse(await readFile(store, 'utf8')) as Record<string, { title: string }>
    saved[String(session.id)]!.title = `Session ${String(session.id)}`
    await writeFile(store, JSON.stringify(saved))

    const row = (await runtime.listSessions()).data.find((entry) => entry.id === session.id)
    assert.ok(row)
    assert.equal(row.title, null, 'the machine placeholder is not a conversation name')
    assert.equal(row.preview, 'Fix the Antigravity session title')
  } finally {
    await runtime.dispose()
  }
})

test('an ACP placeholder title using Antigravity\'s own short id is still recognized', async (t) => {
  // Measured on the real, signed-in Antigravity binary (2026-09-25, recording
  // UC3): its own store stamped an unnamed session's title as `Session
  // a5b55539` while HarnessDesk's own id for that same session was the full
  // `a5b55539-b2f3-415b-8dc0-6546bb707217` — only the first UUID segment, not
  // `row.sessionId` in full. The `===` check this guards against only ever
  // matched the full-id shape the fake agent below produces by default, so
  // the placeholder was never recognized and "Session a5b55539" leaked onto
  // the board and the sidebar as if it were a real conversation name.
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-placeholder-short-id-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = join(dir, 'store.json')
  const runtime = new AcpRuntime({
    id: 'antigravity-acp',
    name: 'Antigravity',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_STORE: store },
  })
  const tape = record(runtime)
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: dir })
    await session.send([{ type: 'text', text: 'Review the refill fix' }])
    await tape.until((event) => event.type === 'turn/completed')

    // Beside it, a stored conversation with the real agent's UUID-shaped id,
    // titled with only that id's first segment.
    const uuid = 'a5b55539-b2f3-415b-8dc0-6546bb707217'
    const saved = JSON.parse(await readFile(store, 'utf8')) as Record<string, Record<string, unknown>>
    saved[uuid] = { ...saved[String(session.id)]!, sessionId: uuid, title: 'Session a5b55539', turns: [] }
    await writeFile(store, JSON.stringify(saved))

    const row = (await runtime.listSessions()).data.find((entry) => String(entry.id) === uuid)
    assert.ok(row)
    assert.equal(row.title, null, 'the truncated machine placeholder is not a conversation name either')
  } finally {
    await runtime.dispose()
  }
})

test('an id placeholder is recognised by its shape on any ACP agent, and a session-shaped name that is not the id is kept', async (t) => {
  // Rule 8: never gated on which agent is running. A title that is only the
  // conversation's own id names nothing whoever wrote it; one that merely
  // starts with "Session" — or names a prefix too short to be an id's own
  // segment — is somebody's name.
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-session-shaped-title-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = join(dir, 'store.json')
  const runtime = new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_STORE: store },
  })
  const tape = record(runtime)
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: dir })
    await session.send([{ type: 'text', text: 'Keep this provider title' }])
    await tape.until((event) => event.type === 'turn/completed')

    const titled = async (id: string, title: string): Promise<string | null | undefined> => {
      const saved = JSON.parse(await readFile(store, 'utf8')) as Record<string, Record<string, unknown>>
      saved[id] = { ...saved[String(session.id)]!, sessionId: id, title, turns: [] }
      await writeFile(store, JSON.stringify(saved))
      return (await runtime.listSessions()).data.find((entry) => String(entry.id) === id)?.title
    }

    assert.equal(await titled(String(session.id), `Session ${String(session.id)}`), null, 'its own full id')
    assert.equal(await titled('1b2c3d4e-0000-4000-8000-000000000000', 'Session 1'), 'Session 1', 'a short prefix is a name')
    assert.equal(await titled('2b2c3d4e-0000-4000-8000-000000000000', 'Session planning'), 'Session planning')
    assert.equal(await titled('3b2c3d4e-0000-4000-8000-000000000000', 'Session 3b2c3d4e'), null, 'a UUID id\'s first segment')
  } finally {
    await runtime.dispose()
  }
})

test('refreshCatalog restarts an idle agent and picks up what it now declares', async () => {
  const runtime = make()
  const { until } = record(runtime)
  await runtime.start()
  const saved = process.env['FAKE_ACP_EXTRA_MODEL']
  try {
    const bridgeBefore = runtime.info.version
    const before = await runtime.defaultSessionOptions('/tmp/acp-refresh')
    const modelsBefore = before.find((option) => option.id === 'model')
    assert.equal(modelsBefore?.type, 'select')
    assert.ok(!(modelsBefore?.type === 'select' && modelsBefore.choices.some((c) => c.value === 'newer')))

    // The vendor adds a model: only a process started from now on declares it.
    process.env['FAKE_ACP_EXTRA_MODEL'] = 'newer'
    assert.deepEqual(await runtime.refreshCatalog(), { refreshed: true })
    await until((event) => event.type === 'catalog/changed')
    assert.notEqual(runtime.info.version, bridgeBefore, 'a fresh process answered')
    assert.equal(runtime.health().state, 'ready')
    const after = await runtime.defaultSessionOptions('/tmp/acp-refresh')
    const models = after.find((option) => option.id === 'model')
    assert.ok(models?.type === 'select' && models.choices.some((c) => c.value === 'newer'), 'the new model is offered')
  } finally {
    if (saved === undefined) delete process.env['FAKE_ACP_EXTRA_MODEL']
    else process.env['FAKE_ACP_EXTRA_MODEL'] = saved
    await runtime.dispose()
  }
})

test('refreshCatalog leaves an agent that keeps no sessions alone while one is open', async () => {
  // This fake, without a store, cannot load a session back: a restart would
  // lose the conversation, so none happens while it is open.
  const runtime = make()
  await runtime.start()
  try {
    // The agent declares its commands just after a session exists, and a
    // first declaration is a catalogue change of its own — one that lands
    // whenever the pipe hands it over, which under load is inside the
    // `session/new` reply's own read. Learn them here, where the wait is
    // deliberate, so that below the only thing left that could announce a
    // change is the restart this test says must not happen.
    assert.equal((await runtime.listSkills()).length, 2, 'the agent has declared its commands')
    const { events } = record(runtime)
    const pidBefore = runtime.info.version
    const session = await runtime.createSession({ cwd: '/tmp/acp-busy' })
    const verdict = await runtime.refreshCatalog()
    assert.equal(runtime.info.version, pidBefore, 'the same process is still answering')
    assert.ok(!events.some((event) => event.type === 'catalog/changed'))
    // And it says so. The call resolving is not the same as the agent having
    // looked again — a caller that reads "it resolved" as "it re-read" tells
    // somebody a refusal was a success.
    assert.equal(verdict.refreshed, false)
    assert.match(verdict.reason ?? '', /keeps no conversations/)
    // The session is untouched and still usable.
    await session.send([{ type: 'text', text: 'hello' }])
  } finally {
    await runtime.dispose()
  }
})

test('refreshCatalog restarts an agent that keeps sessions when none has a turn in flight', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'acp-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = join(dir, 'sessions.json')
  const runtime = new AcpRuntime({
    id: 'fake-acp-stored',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_STORE: store },
  })
  const { until } = record(runtime)
  await runtime.start()
  try {
    assert.equal(runtime.info.capabilities.resume, true)
    const session = await runtime.createSession({ cwd: '/tmp/acp-stored' })
    const pidBefore = runtime.info.version

    // A turn in flight holds the restart back — and the answer names it,
    // rather than resolving like a refresh that happened.
    await session.send([{ type: 'text', text: 'slow' }])
    await until((event) => event.type === 'turn/started')
    const busy = await runtime.refreshCatalog()
    assert.equal(runtime.info.version, pidBefore, 'not while a turn runs')
    assert.equal(busy.refreshed, false)
    assert.match(busy.reason ?? '', /turn is in flight/)
    await session.interrupt()
    await until((event) => event.type === 'turn/completed')

    // Idle with a session open: the agent keeps it, so the restart goes ahead.
    const done = await runtime.refreshCatalog()
    assert.equal(done.refreshed, true)
    assert.equal(done.reason, undefined)
    assert.notEqual(runtime.info.version, pidBefore, 'a fresh process answers')
    await until((event) => event.type === 'catalog/changed')
    assert.equal(runtime.health().state, 'ready')
  } finally {
    await runtime.dispose()
  }
})

test('checkInstallation without an executable has nothing to compare', async () => {
  const runtime = make()
  await runtime.start()
  try {
    assert.deepEqual(await runtime.checkInstallation(), { changed: false })
  } finally {
    await runtime.dispose()
  }
})

test('checkInstallation notices the driven CLI changing and restarts when idle', async (t) => {
  // The "CLI" is a file whose --version output we control.
  const { mkdtempSync, rmSync, writeFileSync, chmodSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'acp-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cli = join(dir, 'agent-cli')
  const write = (version: string) => {
    writeFileSync(cli, `#!/bin/sh\necho "${version} (Agent)"\n`)
    chmodSync(cli, 0o755)
  }
  write('1.0.0')
  const runtime = new AcpRuntime({
    id: 'fake-acp-driven',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    executable: { command: cli, env: 'FAKE_AGENT_CLI' },
  })
  const { until } = record(runtime)
  await runtime.start()
  try {
    assert.deepEqual(runtime.info.drives, { command: cli, version: '1.0.0' })
    assert.deepEqual(await runtime.checkInstallation(), { changed: false })
    const pidBefore = runtime.info.version
    write('1.1.0')
    const moved = await runtime.checkInstallation()
    assert.deepEqual(moved, { changed: true, from: '1.0.0', to: '1.1.0', restarted: true })
    assert.deepEqual(runtime.info.drives, { command: cli, version: '1.1.0' })
    assert.notEqual(runtime.info.version, pidBefore)
    await until((event) => event.type === 'catalog/changed')
    assert.deepEqual(await runtime.checkInstallation(), { changed: false })
  } finally {
    await runtime.dispose()
  }
})

test('a conversation whose folder is gone says so, rather than failing inside the agent', async (t) => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'acp-gone-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = join(dir, 'sessions.json')
  // A stored conversation that worked in a folder which has since been
  // deleted — a scratch directory, a cleaned-up worktree, a removed clone.
  const gone = join(dir, 'went-away')
  mkdirSync(gone)
  writeFileSync(
    store,
    JSON.stringify({
      ghost: { sessionId: 'ghost', cwd: gone, title: 'Gone', updatedAt: new Date().toISOString(), turns: [] },
    }),
  )
  rmSync(gone, { recursive: true })

  const runtime = new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_STORE: store },
  })
  await runtime.start()
  try {
    // The folder is named, so the person reading it knows which one to blame.
    await assert.rejects(() => runtime.resumeSession(sessionId('ghost')), (error: Error) => {
      assert.match(error.message, /folder no longer exists/)
      assert.match(error.message, new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      /* Named on the wire, and the folder carried as a field. The sentence is
         for the person; these two are what let the interface offer the way
         out — a copy somewhere that exists — without recognising English.
         Still a `SessionGoneError`, so "will asking again help" is unchanged. */
      assert.equal((error as { wireCode?: string }).wireCode, 'sessionFolderGone')
      assert.equal((error as { folder?: string }).folder, gone)
      assert.ok(isSessionGone(error))
      assert.ok(isFolderGone(error))
      return true
    })
    // Nothing was registered for a session that never opened.
    assert.equal(await runtime.readSession(sessionId('ghost')).then(() => 'read', () => 'refused'), 'refused')
  } finally {
    await runtime.dispose()
  }
})

test('an agent error keeps the detail it arrived with', async (t) => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'acp-detail-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = join(dir, 'sessions.json')
  // Listed, in a folder that is there, so the load is the agent's to refuse.
  writeFileSync(
    store,
    JSON.stringify({
      unreadable: { sessionId: 'unreadable', cwd: dir, title: 'Unreadable', updatedAt: new Date().toISOString(), turns: [] },
    }),
  )
  const runtime = new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_STORE: store, FAKE_ACP_UNLOADABLE: 'unreadable' },
  })
  await runtime.start()
  try {
    // The fake refuses this load the way Claude Code does: a terse message
    // with the reason in `data`. Losing that half was what left the UI
    // showing "Internal error" and nothing else.
    await assert.rejects(() => runtime.resumeSession(sessionId('unreadable')), (error: Error) => {
      assert.equal(error.message, 'Internal error')
      assert.equal((error as { details?: string }).details, 'the transcript could not be read')
      return true
    })

    // Prompt failure also folds data.details into the turn error message (#358)
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    const tape = record(runtime)
    await session.send([{ type: 'text', text: 'fail with detail' }])
    const completed = await tape.until((event) => event.type === 'turn/completed')
    const turn = (completed as { turn?: { error?: { message?: string } } }).turn
    assert.match(turn?.error?.message ?? '', /the session is owned by another process/)
  } finally {
    await runtime.dispose()
  }
})

/**
 * Where a stored conversation is reopened, and what happens when its agent
 * does not say.
 *
 * The folder comes from the agent's own `session/list`, and every reopen is a
 * `session/load` in it. Where the listing had no row for the conversation it
 * used to be this process's working directory — the dev checkout under `pnpm
 * dev`, `/` from Finder — and the agent loaded the conversation there. The
 * host then held a conversation whose folder was its own working directory,
 * and a conversation's folder is an open root. So these read what the agent
 * was asked to open, off the agent's own record (`FAKE_ACP_OPENS`): a refusal
 * is told apart from a load that happened somewhere else.
 */
interface StoredConversation {
  readonly cwd: string
  readonly turns?: readonly (readonly string[])[]
}

interface Opened {
  readonly method: string
  readonly sessionId: string
  readonly cwd: string
}

/**
 * An agent keeping the conversations `stored` names, each in its folder. The
 * callback is handed a scratch folder of the test's own to make those in.
 */
const storedAgent = async (
  t: TestContext,
  stored: (dir: string) => Readonly<Record<string, StoredConversation>>,
  env: Readonly<Record<string, string>> = {},
): Promise<{ runtime: AcpRuntime; opened: () => Opened[] }> => {
  const { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  // The real path, so a folder is compared as the agent is handed it.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'acp-where-')))
  const store = join(dir, 'sessions.json')
  const opens = join(dir, 'opens.jsonl')
  const at = new Date().toISOString()
  writeFileSync(
    store,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(stored(dir)).map(([id, { cwd, turns = [] }]) => [
          id,
          { sessionId: id, cwd, title: id, updatedAt: at, turns },
        ]),
      ),
    ),
  )
  const runtime = new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_STORE: store, FAKE_ACP_OPENS: opens, ...env },
  })
  // The agent goes before the folder it writes in.
  t.after(async () => {
    await runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  await runtime.start()
  const opened = (): Opened[] => {
    let text = ''
    try {
      text = readFileSync(opens, 'utf8')
    } catch {
      // Nothing opened yet.
    }
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Opened)
  }
  return { runtime, opened }
}

/** A folder made inside `dir`, for a conversation to have run in. */
const folderIn = (dir: string, name: string): string => {
  const path = join(dir, name)
  mkdirSync(path)
  return path
}

/** What a reopen came to: the folder it answered in, or the refusal. */
const reopening = (runtime: AcpRuntime, id: string) =>
  runtime.resumeSession(sessionId(id)).then(
    (session) => ({ cwd: session.settings().cwd }),
    (error: Error) => ({ refused: error.message, gone: isSessionGone(error) }),
  )

test('a conversation its agent does not list is refused by name, and loaded nowhere', async (t) => {
  // Both ran in a folder that is still there, so nothing but the listing
  // tells them apart. The agent serves both and lists one — as Claude Code's
  // bridge leaves out a conversation its own listing has no folder for, and
  // Cursor's lists only the workspaces it has been shown.
  let listedAt = ''
  const { runtime, opened } = await storedAgent(
    t,
    (dir) => {
      listedAt = folderIn(dir, 'listed')
      return {
        listed: { cwd: listedAt, turns: [['in the listing']] },
        hidden: { cwd: folderIn(dir, 'hidden'), turns: [['out of it']] },
      }
    },
    { FAKE_ACP_UNLISTED: 'hidden' },
  )

  // The control: listed, it reopens in the folder it ran in, with its turn.
  assert.deepEqual(await reopening(runtime, 'listed'), { cwd: listedAt })
  assert.equal((await runtime.readSession(sessionId('listed'))).turns.length, 1)

  // Not listed, it is refused by name, and as gone: asking again asks the
  // same listing.
  const refusal = 'Fake ACP Agent does not list conversation hidden, so the folder it worked in is not known.'
  assert.deepEqual(await reopening(runtime, 'hidden'), { refused: refusal, gone: true })
  // A read is a load too.
  assert.equal(
    await runtime.readSession(sessionId('hidden')).then(
      () => 'read',
      (error: Error) => error.message,
    ),
    refusal,
  )
  // The agent was never asked to load it, anywhere — least of all here.
  assert.deepEqual(opened(), [{ method: 'session/load', sessionId: 'listed', cwd: listedAt }])
})

test("a conversation on a later page of its agent's listing reopens where it ran", async (t) => {
  // One row a page, and a fourth conversation on none of them.
  let thirdAt = ''
  const { runtime, opened } = await storedAgent(
    t,
    (dir) => {
      thirdAt = folderIn(dir, 'third')
      return {
        first: { cwd: folderIn(dir, 'first') },
        second: { cwd: folderIn(dir, 'second') },
        third: { cwd: thirdAt },
        unlisted: { cwd: thirdAt },
      }
    },
    { FAKE_ACP_LIST_PAGE: '1', FAKE_ACP_UNLISTED: 'unlisted' },
  )

  // Found on the third page, in its own folder.
  assert.deepEqual(await reopening(runtime, 'third'), { cwd: thirdAt })
  // Every page read and still no row: refused, and the walk ends.
  assert.deepEqual(await reopening(runtime, 'unlisted'), {
    refused: 'Fake ACP Agent does not list conversation unlisted, so the folder it worked in is not known.',
    gone: true,
  })
  assert.deepEqual(opened(), [{ method: 'session/load', sessionId: 'third', cwd: thirdAt }])
})

/**
 * What a listing answers when the agent pages it.
 *
 * Every page, in one answer. It used to read the first page and drop the
 * agent's cursor, so nothing older was ever listed. Handing the cursor on, as
 * the Codex adapter does, would reach the older pages only where the
 * interface follows `nextCursor`: the sidebar does for the agent it pages and
 * for no other, and the archive reads one page per agent. ACP keeps no
 * archive, so the host takes archived rows out of each answer itself, and a
 * conversation archived past the first page would have been in neither list.
 * Every agent measured so far answers in one page anyway (claude-agent-acp
 * 0.77.0, the Cursor bridge, OpenCode 1.18.30, Antigravity 1.1.1 with 665
 * rows).
 */
test('a paged listing is listed whole, each conversation once, the draft probe on none of it', async (t) => {
  // Two rows a page, five conversations: three pages.
  const { runtime } = await storedAgent(
    t,
    (dir) => ({
      first: { cwd: folderIn(dir, 'first') },
      second: { cwd: folderIn(dir, 'second') },
      third: { cwd: folderIn(dir, 'third') },
      fourth: { cwd: folderIn(dir, 'fourth') },
      fifth: { cwd: folderIn(dir, 'fifth'), turns: [['on the last page']] },
    }),
    { FAKE_ACP_LIST_PAGE: '2' },
  )
  // One of them open here, from the last page, and the draft probe beside it.
  await runtime.resumeSession(sessionId('fifth'))
  await runtime.defaultSessionOptions()

  const listed = await runtime.listSessions()
  assert.deepEqual(
    listed.data.map((row) => [String(row.id), row.title, row.status.type]).sort(),
    [
      // Open here, so listed as open — once — under the name its row on the
      // last page gives it.
      ['fifth', 'fifth', 'idle'],
      ['first', 'first', 'notLoaded'],
      ['fourth', 'fourth', 'notLoaded'],
      ['second', 'second', 'notLoaded'],
      ['third', 'third', 'notLoaded'],
    ],
  )
  // Nothing left to ask for.
  assert.equal(listed.nextCursor, null)
})

/**
 * A listing that cannot be read to its end is a failure, not a shorter list.
 * The sidebar keeps the list it has when a listing fails, and the archive
 * names an agent that did not answer; a shorter list was taken for the whole
 * one by both.
 */
const unlistable = (why: string): string => `Fake ACP Agent could not list its conversations (${why}).`

test('a listing that fails on any page is a failure, not a shorter list', async (t) => {
  for (const fails of ['1', 'later']) {
    await t.test(fails === '1' ? 'on the first page' : 'past the first page', async (t) => {
      const { runtime } = await storedAgent(
        t,
        (dir) => ({
          first: { cwd: folderIn(dir, 'first') },
          second: { cwd: folderIn(dir, 'second') },
          third: { cwd: folderIn(dir, 'third') },
        }),
        { FAKE_ACP_LIST_PAGE: '2', FAKE_ACP_LIST_FAILS: fails },
      )
      await assert.rejects(runtime.listSessions(), { message: unlistable('Internal error: the index is locked') })
    })
  }
})

// A bound of its own: `pnpm verify` runs with no test timeout, and a walk that
// never ends would hang the gate rather than fail it.
test('a cursor the agent hands back twice ends the walk, as a failure', { timeout: 30_000 }, async (t) => {
  // Every page names itself as the next one: without an end, a listing and a
  // reopen would ask for it forever, and what was read by then is not the list.
  const { runtime } = await storedAgent(
    t,
    (dir) => ({
      first: { cwd: folderIn(dir, 'first') },
      second: { cwd: folderIn(dir, 'second') },
      third: { cwd: folderIn(dir, 'third') },
    }),
    { FAKE_ACP_LIST_PAGE: '2', FAKE_ACP_LIST_STUCK: '1' },
  )
  await assert.rejects(runtime.listSessions(), { message: unlistable('it named the same next page twice') })
  assert.deepEqual(await reopening(runtime, 'third'), {
    refused:
      'Fake ACP Agent could not list its conversations (it named the same next page twice), so the folder conversation third worked in is not known.',
    gone: false,
  })
})

test('a listing that names a new next page every time is given up at a bound, not read forever', { timeout: 60_000 }, async (t) => {
  // Every cursor fresh, so no repeat ever ends it: only a bound on the pages does.
  const { runtime } = await storedAgent(
    t,
    (dir) => ({ first: { cwd: folderIn(dir, 'first') }, unlisted: { cwd: folderIn(dir, 'unlisted') } }),
    { FAKE_ACP_LIST_PAGE: '1', FAKE_ACP_LIST_ENDLESS: '1', FAKE_ACP_UNLISTED: 'unlisted' },
  )
  await assert.rejects(runtime.listSessions(), {
    message: unlistable('it named a next page 1000 times without an end'),
  })
  assert.deepEqual(await reopening(runtime, 'unlisted'), {
    refused:
      'Fake ACP Agent could not list its conversations (it named a next page 1000 times without an end), so the folder conversation unlisted worked in is not known.',
    gone: false,
  })
})

test('a listing asked for the page after a cursor it never gave answers with nothing', async (t) => {
  // It hands out no cursor — every page is in its one answer — so a cursor
  // is another listing's, and the page after the whole list is empty.
  const { runtime } = await storedAgent(t, (dir) => ({ first: { cwd: folderIn(dir, 'first') } }), {
    FAKE_ACP_LIST_PAGE: '2',
  })
  assert.deepEqual(await runtime.listSessions({ cursor: 'from-somewhere-else' }), { data: [], nextCursor: null })
  // The control: without one, the conversation is there.
  assert.deepEqual((await runtime.listSessions()).data.map((row) => String(row.id)), ['first'])
})

/** The refusal for a conversation an agent with no listing cannot place. */
const unplaced = (id: string): string =>
  `Fake ACP Agent keeps no list of its conversations, and conversation ${id} has not been opened since HarnessDesk started, so the folder it worked in is not known.`

test('an agent that keeps no listing cannot say where a conversation not opened here worked, so it is not reopened', async (t) => {
  // Gemini CLI 0.59.0, measured: `loadSession: true`, no `sessionCapabilities`,
  // and `session/list` answered with -32601. It keeps its conversations by
  // folder, so a load anywhere else finds nothing — or, where that folder is
  // this process's own, finds one and runs it there.
  const { runtime, opened } = await storedAgent(
    t,
    (dir) => ({ stored: { cwd: folderIn(dir, 'stored'), turns: [['kept']] } }),
    { FAKE_ACP_NO_LIST: '1' },
  )
  // The control: it declared that it reopens conversations, and no listing.
  assert.equal(runtime.info.capabilities.resume, true)
  assert.equal(runtime.info.capabilities.listHistory, false)

  assert.deepEqual(await reopening(runtime, 'stored'), { refused: unplaced('stored'), gone: true })
  assert.deepEqual(opened(), [])
})

test('an agent that keeps no listing reopens a conversation opened here in its own folder, after a restart', async (t) => {
  // The one word on where a conversation works that an agent with no listing
  // gives is the folder it accepted in `session/new`, and this process was
  // there to hear it. A catalogue refresh restarts the agent under an open
  // conversation, and the host reopens it on its next use.
  let here = ''
  const { runtime, opened } = await storedAgent(
    t,
    (dir) => {
      here = folderIn(dir, 'here')
      // Kept by the agent from an earlier run, and never opened in this one.
      return { earlier: { cwd: folderIn(dir, 'earlier'), turns: [['from before']] } }
    },
    { FAKE_ACP_NO_LIST: '1' },
  )
  const session = await runtime.createSession({ cwd: here })
  const tape = record(runtime)
  await session.send([{ type: 'text', text: 'remember where' }])
  await tape.until((event) => event.type === 'turn/completed')
  // The draft probe beside it: a session the agent counts, and no conversation.
  await runtime.defaultSessionOptions()
  const probe = opened().find((open) => open.method === 'session/new' && open.sessionId !== String(session.id))
  assert.ok(probe, 'the probe was opened')

  assert.deepEqual(await runtime.refreshCatalog(), { refreshed: true })

  // Reopened where it was opened, with its turn.
  assert.deepEqual(await reopening(runtime, String(session.id)), { cwd: here })
  assert.equal((await runtime.readSession(session.id)).turns.length, 1)
  // The controls: one from an earlier run is still refused, and so is the
  // probe, which is nobody's conversation and was never remembered as one.
  assert.deepEqual(await reopening(runtime, 'earlier'), { refused: unplaced('earlier'), gone: true })
  assert.deepEqual(await reopening(runtime, probe.sessionId), { refused: unplaced(probe.sessionId), gone: true })
  // The agent was asked to load one conversation, in its own folder.
  assert.deepEqual(
    opened().filter((open) => open.method === 'session/load'),
    [{ method: 'session/load', sessionId: String(session.id), cwd: here }],
  )
})

test('where an agent keeps a listing, the listing is the one word asked, over the folder a conversation was opened in', async (t) => {
  // The folder a conversation was opened in is the agent's word then; its
  // listing is its word now. Both are read off the store the fake agent keeps,
  // which is edited below to make them differ.
  const { readFileSync, writeFileSync } = await import('node:fs')
  let openedAt = ''
  let movedTo = ''
  let store = ''
  const { runtime, opened } = await storedAgent(t, (dir) => {
    openedAt = folderIn(dir, 'opened')
    movedTo = folderIn(dir, 'moved')
    store = join(dir, 'sessions.json')
    return {}
  })
  const tape = record(runtime)
  const moved = await runtime.createSession({ cwd: openedAt })
  await moved.send([{ type: 'text', text: 'moved later' }])
  await tape.until((event) => event.type === 'turn/completed' && event.sessionId === moved.id)
  const dropped = await runtime.createSession({ cwd: openedAt })
  await dropped.send([{ type: 'text', text: 'dropped later' }])
  await tape.until((event) => event.type === 'turn/completed' && event.sessionId === dropped.id)
  // Now its listing puts one in another folder, and no longer has the other.
  const kept = JSON.parse(readFileSync(store, 'utf8')) as Record<string, { cwd: string }>
  kept[String(moved.id)]!.cwd = movedTo
  delete kept[String(dropped.id)]
  writeFileSync(store, JSON.stringify(kept))

  assert.deepEqual(await runtime.refreshCatalog(), { refreshed: true })
  assert.deepEqual(await reopening(runtime, String(moved.id)), { cwd: movedTo })
  assert.deepEqual(await reopening(runtime, String(dropped.id)), {
    refused: `Fake ACP Agent does not list conversation ${dropped.id}, so the folder it worked in is not known.`,
    gone: true,
  })
  assert.deepEqual(
    opened().filter((open) => open.method === 'session/load'),
    [{ method: 'session/load', sessionId: String(moved.id), cwd: movedTo }],
  )
})

test('resumeSession trusts only the host-only knownCwd over the listing, never a caller-supplied cwd (#uc3)', async (t) => {
  // Measured on the real, signed-in Google Antigravity binary: a flow's
  // freshly opened Seat, still inside its first turn, was not yet answered
  // back by the agent's own `session/list` — "Antigravity does not list
  // conversation …, so the folder it worked in is not known" — even though
  // this desk had just opened that exact conversation in that exact folder.
  // The host passes the Seat's own durable record as `knownCwd`, a field the
  // wire refuses; `cwd` is one a renderer can write, so it is never trusted.
  let hiddenAt = ''
  const { runtime, opened } = await storedAgent(
    t,
    (dir) => {
      hiddenAt = folderIn(dir, 'hidden')
      return { hidden: { cwd: hiddenAt } }
    },
    { FAKE_ACP_UNLISTED: 'hidden' },
  )

  // Nothing the host knows: the listing is the only word, and it refuses.
  await assert.rejects(() => runtime.resumeSession(sessionId('hidden')), (error: Error) => {
    assert.match(error.message, /does not list conversation/)
    return true
  })
  // A caller's own `cwd` changes nothing — it is the open-root risk itself.
  await assert.rejects(() => runtime.resumeSession(sessionId('hidden'), { cwd: hiddenAt }), (error: Error) => {
    assert.match(error.message, /does not list conversation/)
    return true
  })

  // The host's own record opens it without the listing at all — the agent
  // still serves `session/load` for it.
  const resumed = await runtime.resumeSession(sessionId('hidden'), { knownCwd: hiddenAt })
  assert.equal(resumed.settings().cwd, hiddenAt)
  assert.deepEqual(
    opened().filter((open) => open.method === 'session/load'),
    [{ method: 'session/load', sessionId: 'hidden', cwd: hiddenAt }],
  )
})

test('only a conversation handed out, in a folder named in full, is remembered, and only until it is deleted', async (t) => {
  let refusedAt = ''
  let deletedAt = ''
  const { runtime, opened } = await storedAgent(
    t,
    (dir) => {
      refusedAt = folderIn(dir, 'refused')
      deletedAt = folderIn(dir, 'deleted')
      return {}
    },
    { FAKE_ACP_NO_LIST: '1', FAKE_ACP_DELETE: '1' },
  )
  // Opened by the agent and then refused here, for a voice it does not have:
  // nobody was handed it, so nobody holds its folder open.
  await assert.rejects(runtime.createSession({ cwd: refusedAt, options: { voice: 'operatic' } }))
  const refused = opened().find((open) => open.cwd === refusedAt)
  assert.ok(refused, 'the agent opened it before the refusal')
  // Opened in a folder spelled relative, which the agent reads against its
  // own working directory: this process's.
  const relative = await runtime.createSession({ cwd: 'relative-folder' })
  // Opened, and then deleted from the agent's store.
  const deleted = await runtime.createSession({ cwd: deletedAt })
  const tape = record(runtime)
  await deleted.send([{ type: 'text', text: 'soon gone' }])
  await tape.until((event) => event.type === 'turn/completed')
  await runtime.deleteSession(deleted.id)

  assert.deepEqual(await runtime.refreshCatalog(), { refreshed: true })
  for (const id of [refused.sessionId, String(relative.id), String(deleted.id)]) {
    assert.deepEqual(await reopening(runtime, id), { refused: unplaced(id), gone: true })
  }
  // None of them was loaded, anywhere.
  assert.deepEqual(opened().filter((open) => open.method === 'session/load'), [])
})

test('a listing that fails refuses the reopen as one that may pass, not with a guess', async (t) => {
  const { runtime, opened } = await storedAgent(
    t,
    (dir) => ({ stored: { cwd: folderIn(dir, 'stored') } }),
    { FAKE_ACP_LIST_FAILS: '1' },
  )
  assert.deepEqual(await reopening(runtime, 'stored'), {
    refused:
      'Fake ACP Agent could not list its conversations (Internal error: the index is locked), so the folder conversation stored worked in is not known.',
    gone: false,
  })
  assert.deepEqual(opened(), [])
})

test("a listed folder that is not absolute is not read against this process's", async (t) => {
  // ACP says a listed cwd is absolute. One that is not would be resolved —
  // by the folder check here, and by the agent's own load — against the
  // working directory both have, which is this process's.
  const { runtime, opened } = await storedAgent(t, () => ({ dotted: { cwd: '.' }, empty: { cwd: '' } }))
  assert.deepEqual(await reopening(runtime, 'dotted'), {
    refused: 'Fake ACP Agent lists conversation dotted as working in ".", which is not an absolute path.',
    gone: true,
  })
  assert.deepEqual(await reopening(runtime, 'empty'), {
    refused: 'Fake ACP Agent lists conversation empty as working in "", which is not an absolute path.',
    gone: true,
  })
  assert.deepEqual(opened(), [])
})

test('the draft probe opens in the home folder, and is never handed out as a conversation', async (t) => {
  const { homedir } = await import('node:os')
  const { runtime, opened } = await storedAgent(t, () => ({}))
  // Named no folder, the draft is opened in the user's own — not in this
  // process's working directory, which depends on how the app was started.
  await runtime.defaultSessionOptions()
  const drafts = opened()
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0]!.method, 'session/new')
  assert.equal(drafts[0]!.cwd, homedir())
  const probe = drafts[0]!.sessionId

  // A real session, but no conversation: not listed, not found by a search
  // for anything, and neither read nor reopened by its id.
  assert.deepEqual((await runtime.listSessions()).data, [])
  assert.deepEqual((await runtime.searchSessions('')).data, [])
  const refusal = `Fake ACP Agent has no conversation ${probe}.`
  assert.deepEqual(await reopening(runtime, probe), { refused: refusal, gone: true })
  assert.equal(
    await runtime.readSession(sessionId(probe)).then(
      () => 'read',
      (error: Error) => error.message,
    ),
    refusal,
  )
  // And it is still the probe: the next question about a draft is answered by
  // it, without a second one being opened.
  await runtime.defaultSessionOptions()
  assert.deepEqual(opened(), drafts)
})

/**
 * `SessionOptions.model` is a request, not a decoration.
 *
 * `SessionOptions` is `Partial<SessionSettings> & …`, so `model` is legal to
 * write — and the adapter read it nowhere, which made "start this conversation
 * on that model" a request that was accepted and silently dropped.
 *
 * It cost a live run to find. Three conversations were opened asking for three
 * different models; all three came up on the first one's, and the room named
 * them after their agent because `settings().model` had nothing else to report.
 * The bug looked like two unrelated ones — "models don't apply" and "everyone
 * is called Cursor" — and was this.
 */
test('a session opened with a model starts on it', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w', model: 'large' })
    assert.equal(session.settings().model, 'large', 'the asked-for model is what it runs')

    // An explicit option wins: a caller who wrote both meant the specific one.
    const both = await runtime.createSession({
      cwd: '/tmp/w',
      model: 'large',
      options: { model: 'small' },
    })
    assert.equal(both.settings().model, 'small')

    // And a model the agent does not offer is still refused rather than
    // half-applied — the session does not survive as an untitled ghost.
    await assert.rejects(
      runtime.createSession({ cwd: '/tmp/w', model: 'imaginary' }),
      /not one of the values/,
    )
  } finally {
    await runtime.dispose()
  }
})

test('direct ACP: falls back to launched CLI version when agentInfo version is placeholder (#354)', async () => {
  const runtime = new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_AGENT_VERSION: '0.0.0-dev' },
    resolveLaunch: async () => ({ command: process.execPath, args: [FAKE], version: '3000.10.21' }),
  })
  try {
    await runtime.start()
    assert.equal(runtime.launchedVersion, '3000.10.21')
    assert.equal(runtime.info.version, '3000.10.21')
    assert.equal(runtime.info.drives, null)
  } finally {
    await runtime.dispose()
  }
})

test('a question carried as a permission request is a question, and the answer reaches the agent', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'ask me' }])
    const requested = await tape.until((event) => event.type === 'approval/requested')
    const approval = (requested as Extract<AgentEvent, { type: 'approval/requested' }>).approval
    // Drawn as a permission this read "Grant additional access?" over a list
    // of libraries; the bridge said it was a question, so it is one.
    assert.equal(approval.type, 'userInput')
    if (approval.type !== 'userInput') return
    assert.equal(approval.tool, 'AskUserQuestion')
    assert.equal(approval.questions[0]?.question, 'Which library should we use?')
    assert.equal(approval.questions[0]?.header, 'Library')
    assert.deepEqual(
      approval.questions[0]?.options.map((option) => [option.id, option.label, option.description]),
      [['answer-0', 'date-fns', 'Small, tree-shakeable.'], ['answer-1', 'dayjs', 'Moment-compatible API.']],
    )
    // The card answers with option ids per question; the agent hears the option.
    await session.respondToApproval(approval.id, { type: 'answers', answers: { q: ['answer-1'] } })
    const completed = await tape.until((event) => event.type === 'turn/completed')
    const turn = (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn
    const said = turn.items.find((item) => item.type === 'assistantMessage')
    assert.ok(said && said.type === 'assistantMessage' && said.text.includes('you chose answer-1'))
  } finally {
    await runtime.dispose()
  }
})

test('a user-role chunk the agent marks as a notice is a notice on the live turn, never the person', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: 'notice me' }])
    const completed = await tape.until((event) => event.type === 'turn/completed')
    const turn = (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn
    const notice = turn.items.find((item) => item.type === 'notice')
    assert.ok(notice && notice.type === 'notice' && notice.text.includes('Agent child-1 sent a message'))
    // Exactly one user message on the turn: the prompt. The relay is not a
    // second one.
    assert.equal(turn.items.filter((item) => item.type === 'userMessage').length, 1)
  } finally {
    await runtime.dispose()
  }
})

test('refreshCatalog restarts an agent that crashed — the restart its own remediation promises', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const bridgeBefore = runtime.info.version
    // Kill the agent out from under the adapter, as a real exit would.
    runtime.connection.kill()
    // Health is not an event on the tape; the exit lands on the next tick or two.
    for (let i = 0; i < 100 && runtime.health().state !== 'unavailable'; i++) await new Promise((r) => setTimeout(r, 20))
    const down = runtime.health()
    assert.equal(down.state, 'unavailable')
    assert.equal((down as { reason?: string }).reason, 'crashed')

    // Before this, the answer here was { refreshed: false, reason: 'It is not running.' }.
    assert.deepEqual(await runtime.refreshCatalog(), { refreshed: true })
    assert.equal(runtime.health().state, 'ready')
    assert.notEqual(runtime.info.version, bridgeBefore, 'a fresh process answered')
  } finally {
    await runtime.dispose()
  }
})

test('refreshCatalog still leaves an agent that is merely starting or blocked alone', async () => {
  const runtime = make()
  // Never started: not ready, and not crashed either.
  assert.deepEqual(await runtime.refreshCatalog(), { refreshed: false, reason: 'It is not running.' })
  await runtime.dispose()
})

/**
 * The token's runtime is told before the open is sent. The agent spawns the
 * bridge while `session/new` is still in flight, and the bridge asks the
 * gateway a question at its own handshake that only the runtime can answer —
 * so the session-level claim, which arrives when the open answers, is too
 * late for it. Same token, in that order.
 */
test('a bridge token is claimed for its runtime before the open, and for its session after', async () => {
  const order: string[] = []
  const tokens: string[] = []
  const runtime = new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    toolServer: {
      name: 'harnessdesk',
      command: process.execPath,
      args: ['--version'],
      env: { HD_TOOLS_SOCKET: '/tmp/hd.sock' },
      onOpen: (token) => {
        order.push('open')
        tokens.push(token)
      },
      onSession: (token) => {
        order.push('session')
        tokens.push(token)
      },
    },
  })
  await runtime.start()
  try {
    await runtime.createSession({ cwd: '/tmp/w' })
    // The eager probe opens one session at start and the create another; each
    // is told twice, open first. The control is the order itself: a claim
    // made only at the answer would put every 'session' before its 'open'.
    assert.ok(order.length >= 2)
    assert.equal(order[0], 'open', 'the runtime is claimed before the open is sent')
    const opened = tokens.filter((_token, index) => order[index] === 'open')
    const named = tokens.filter((_token, index) => order[index] === 'session')
    for (const token of named) assert.ok(opened.includes(token), 'every session claim names a token that was opened first')
  } finally {
    await runtime.dispose()
  }
})

test('a conversation opened with only context blocks is called by the first one, not cut short (#186)', async (t) => {
  // The preview was the raw message cut at 120 characters, so no block arrived whole and the row read "Untitled session".
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-opening-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtime = new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_STORE: join(dir, 'store.json') },
  })
  const tape = record(runtime)
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([
      { type: 'text', text: wrapContext('Handed off from Claude Code', `## Goal\nfinish the migration\n${'- a step taken\n'.repeat(20)}`) },
      { type: 'text', text: wrapContext('Git', `On branch main.\n${'M  src/file.ts\n'.repeat(20)}`) },
    ])
    await tape.until((event) => event.type === 'turn/completed')
    const row = (await runtime.listSessions()).data.find((entry) => entry.id === session.id)
    assert.equal(row?.preview, 'Handed off from Claude Code')
  } finally {
    await runtime.dispose()
  }
})

test('a first message cut off inside a block names nothing (review of #231)', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-cut-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtime = new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_STORE: join(dir, 'store.json') },
  })
  const tape = record(runtime)
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([{ type: 'text', text: '<context source="Handed off from Claude Code — “Migrate the web' }])
    await tape.until((event) => event.type === 'turn/completed')
    const row = (await runtime.listSessions()).data.find((entry) => entry.id === session.id)
    assert.ok(row)
    assert.equal(row.preview, null)
  } finally {
    await runtime.dispose()
  }
})

test('AcpSession send preserves localImage and http image inputs in prompt (#415)', async (t) => {
  const { writeFileSync, unlinkSync, openSync, closeSync, ftruncateSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')

  const imgFile = join(tmpdir(), `test-img-${Date.now()}.png`)
  writeFileSync(imgFile, Buffer.from('fake-png-bytes'))

  const spaceFile = join(tmpdir(), `my space img-${Date.now()}.png`)
  writeFileSync(spaceFile, Buffer.from('space-bytes'))

  const svgFile = join(tmpdir(), `test-${Date.now()}.svg`)
  writeFileSync(svgFile, '<svg></svg>')

  const largeFile = join(tmpdir(), `large-${Date.now()}.png`)
  const fd = openSync(largeFile, 'w')
  ftruncateSync(fd, 11 * 1024 * 1024)
  closeSync(fd)

  t.after(() => {
    for (const f of [imgFile, spaceFile, svgFile, largeFile]) {
      try {
        unlinkSync(f)
      } catch {}
    }
  })

  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: '/tmp/w' })
    await session.send([
      { type: 'text', text: 'echo blocks' },
      { type: 'localImage', path: imgFile },
      { type: 'image', url: 'https://example.com/diagram.png', name: 'diagram.png' },
      { type: 'localImage', path: '/nonexistent/missing.jpg' },
      { type: 'image', url: pathToFileURL(spaceFile).href },
      { type: 'localImage', path: svgFile },
      { type: 'localImage', path: largeFile },
    ])
    const completed = await tape.until((event) => event.type === 'turn/completed')
    const items = (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn.items
    const message = items.find((item) => item.type === 'assistantMessage')
    assert.ok(message && message.type === 'assistantMessage')
    const blocks = JSON.parse(message.text)
    assert.equal(blocks.length, 7, 'all 7 prompt blocks were sent to ACP agent')
    assert.deepEqual(blocks[0], { type: 'text', text: 'echo blocks' })
    assert.deepEqual(blocks[1], {
      type: 'image',
      data: Buffer.from('fake-png-bytes').toString('base64'),
      mimeType: 'image/png',
    })
    assert.deepEqual(blocks[2], {
      type: 'resource_link',
      uri: 'https://example.com/diagram.png',
      name: 'diagram.png',
    })
    assert.deepEqual(blocks[3], {
      type: 'resource_link',
      uri: 'file:///nonexistent/missing.jpg',
      name: 'missing.jpg',
    })
    // Percent-encoded file:// URL correctly decoded and read
    assert.deepEqual(blocks[4], {
      type: 'image',
      data: Buffer.from('space-bytes').toString('base64'),
      mimeType: 'image/png',
    })
    // SVG is non-raster; degrades to resource_link
    assert.equal(blocks[5].type, 'resource_link')
    assert.ok(blocks[5].uri.endsWith('.svg'))
    // Oversize file exceeds MAX_IMAGE_BYTES; degrades to resource_link without inlining bytes
    assert.equal(blocks[6].type, 'resource_link')
    assert.ok(blocks[6].uri.includes(largeFile))
  } finally {
    await runtime.dispose()
  }
})

test('an agent that can resume but not load is reopened with session/resume, tool server and all', async (t) => {
  // DeepSeek Harness's own server keeps its conversations and offers
  // `session/resume`, and has no `session/load`. The capability was read as
  // "can reopen", and then `session/load` was sent anyway — "Method not
  // found" — so every reopened DeepSeek conversation failed. HarnessDesk
  // keeps its own transcript, so a resume that replays nothing loses nothing.
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'acp-resume-only-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = join(dir, 'store.json')
  const opens = join(dir, 'opens.ndjson')
  const dump = join(dir, 'servers.json')
  const claims: [string, string][] = []
  const withStore = (): AcpRuntime =>
    new AcpRuntime({
      id: 'resume-only',
      name: 'Resume Only',
      command: process.execPath,
      args: [FAKE],
      env: { FAKE_ACP_STORE: store, FAKE_ACP_RESUME_ONLY: '1', FAKE_ACP_OPENS: opens, FAKE_ACP_DUMP_SERVERS: dump },
      toolServer: {
        name: 'harnessdesk',
        command: process.execPath,
        args: ['--version'],
        env: {},
        onSession: (token, session) => claims.push([token, session]),
      },
    })

  const first = withStore()
  await first.start()
  const tapeA = record(first)
  let savedId: string
  try {
    const session = await first.createSession({ cwd: dir })
    savedId = String(session.id)
    await session.send([{ type: 'text', text: 'remember me' }])
    await tapeA.until((event) => event.type === 'turn/completed')
  } finally {
    await first.dispose()
  }

  const second = withStore()
  await second.start()
  const tapeB = record(second)
  try {
    assert.equal(second.info.capabilities.resume, true)
    const resumed = await second.resumeSession(sessionId(savedId))
    assert.equal(String(resumed.id), savedId)
    const methods = (await readFile(opens, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method: string; sessionId: string })
    assert.deepEqual(
      methods.filter((open) => open.sessionId === savedId).map((open) => open.method),
      ['session/new', 'session/resume'],
      'reopened with the verb the agent offers',
    )
    const claim = claims.find(([, id]) => id === savedId)
    assert.ok(claim, "the resumed conversation's token names it")
    const dumped = JSON.parse(await readFile(dump, 'utf8')) as { env?: { name: string; value: string }[] }[]
    assert.equal(
      dumped.at(-1)?.env?.find((entry) => entry.name === 'HD_TOOLS_CALLER')?.value,
      claims.at(-1)?.[0],
      'the bridge mounted on resume carries that token',
    )
    await resumed.send([{ type: 'text', text: 'and again' }])
    await tapeB.until((event) => event.type === 'turn/completed')
  } finally {
    await second.dispose()
  }
})

test('concurrent resumeSession deduplicates in-flight resume and returns same instance (#416)', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'acp-concurrent-resume-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = join(dir, 'store.json')
  const withStore = (): AcpRuntime =>
    new AcpRuntime({
      id: 'fake-acp',
      name: 'Fake ACP Agent',
      command: process.execPath,
      args: [FAKE],
      env: { FAKE_ACP_STORE: store },
    })

  const first = withStore()
  await first.start()
  const tapeA = record(first)
  let savedId: string
  try {
    const session = await first.createSession({ cwd: dir })
    savedId = String(session.id)
    await session.send([{ type: 'text', text: 'remember me' }])
    await tapeA.until((event) => event.type === 'turn/completed')
  } finally {
    await first.dispose()
  }

  const second = withStore()
  await second.start()
  try {
    const [resumed1, resumed2] = await Promise.all([
      second.resumeSession(sessionId(savedId)),
      second.resumeSession(sessionId(savedId)),
    ])
    assert.strictEqual(resumed1, resumed2, 'concurrent resumeSession must return the exact same instance')
    const read = await second.readSession(resumed1.id)
    assert.equal(read.turns.length, 1, 'replayed session has the stored turn')

    // Concurrent failing calls clean up #resuming and permit subsequent retries
    await assert.rejects(() => Promise.all([
      second.resumeSession(sessionId('ghost-fail')),
      second.resumeSession(sessionId('ghost-fail')),
    ]))
    await assert.rejects(() => second.resumeSession(sessionId('ghost-fail')))
  } finally {
    await second.dispose()
  }
})
