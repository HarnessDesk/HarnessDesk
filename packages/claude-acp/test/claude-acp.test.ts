import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { scratch } from './scratch.js'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { describeAdapterConformance } from '@harnessdesk/adapter-testkit'
import type { AgentEvent, AgentItem, AgentSession, ConfigOption } from '@harnessdesk/protocol'

import { acpSafeToolContent, classifyReplayed, commandsFor, optionsIn, storedTitle, unwrap, withOptions } from '../src/index.js'

/**
 * claude-acp through HarnessDesk's ACP adapter, against a fake Claude Code
 * that speaks the Agent SDK's wire protocol. What is under test is the one
 * thing this bridge adds to the Zed one: the effort control — declared from
 * the agent's model list, applied at spawn, re-applied by resume, remembered
 * across bridge restarts.
 */

const BRIDGE = fileURLToPath(new URL('../src/main.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
const WORKDIR = scratch('claude-acp-')

const make = (extra: Record<string, string> = {}): AcpRuntime =>
  new AcpRuntime({
    id: 'claude-code',
    name: 'Claude Code',
    command: process.execPath,
    args: [BRIDGE],
    env: {
      CLAUDE_CODE_EXECUTABLE: FAKE,
      CLAUDE_ACP_STATE_DIR: scratch('claude-acp-state-'),
      CLAUDECODE: '',
      ...extra,
    },
  })

describeAdapterConformance('claude-acp', {
  create: make,
  sessionOptions: { cwd: WORKDIR },
})

const record = (runtime: AcpRuntime) => {
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  return {
    events,
    async until(predicate: (event: AgentEvent) => boolean, timeoutMs = 10_000): Promise<AgentEvent> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = events.find(predicate)
        if (found) return found
        if (Date.now() > deadline) throw new Error(`timed out; saw ${events.map((e) => e.type).join(', ')}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }
}

const effortOf = (options: readonly ConfigOption[]): Extract<ConfigOption, { type: 'select' }> | undefined =>
  options.find((option): option is Extract<ConfigOption, { type: 'select' }> => option.id === 'effort' && option.type === 'select')

/** Runs one turn and returns what the agent said — which names the effort its process was spawned with. */
const ask = async (runtime: AcpRuntime, session: AgentSession, text: string, tape: ReturnType<typeof record>): Promise<string> => {
  const before = tape.events.length
  await session.send([{ type: 'text', text }])
  await tape.until(
    (event) => event.type === 'turn/completed' && event.sessionId === session.id && tape.events.indexOf(event) >= before,
  )
  const completed = tape.events
    .slice(before)
    .find((event): event is Extract<AgentEvent, { type: 'turn/completed' }> => event.type === 'turn/completed' && event.sessionId === session.id)
  return completed!.turn.items
    .flatMap((item) => (item.type === 'assistantMessage' ? [item.text] : []))
    .join('\n')
}

test('the effort control is declared from the model the agent reports, beside the model', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const options = await runtime.defaultSessionOptions(WORKDIR)
    const effort = effortOf(options)
    assert.ok(effort, 'an effort select is declared')
    assert.equal(effort.category, 'thought_level')
    assert.equal(effort.currentValue, 'default')
    assert.deepEqual(
      effort.choices.map((choice) => choice.value),
      ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
    )
    assert.equal(effort.choices.find((choice) => choice.value === 'xhigh')?.label, 'Extra high')
  } finally {
    await runtime.dispose()
  }
})

test("the catalogue carries each model's own levels — including the model that has none", async () => {
  const runtime = make()
  await runtime.start()
  try {
    const models = await runtime.listModels()
    assert.deepEqual(
      models.map((model) => model.id),
      ['default', 'sonnet', 'haiku'],
    )
    assert.equal(models[0]?.displayName, 'Default (recommended)')
    assert.deepEqual(
      models[0]?.reasoningLevels.map((level) => level.label),
      ['Low', 'Medium', 'High', 'Extra high', 'Max'],
    )
    // The session's one effort option can only describe the current model;
    // these come from the models themselves, so Sonnet's three and Haiku's
    // none survive the trip.
    assert.deepEqual(
      models[1]?.reasoningLevels.map((level) => level.id),
      ['low', 'medium', 'high'],
    )
    assert.deepEqual(models[2]?.reasoningLevels, [])
  } finally {
    await runtime.dispose()
  }
})

test('a session created with an effort is spawned at it', async () => {
  const runtime = make()
  const tape = record(runtime)
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR, options: { effort: 'xhigh' } })
    assert.equal(effortOf(session.options())?.currentValue, 'xhigh')
    const said = await ask(runtime, session, 'hello', tape)
    assert.match(said, /effort=xhigh/)
    assert.match(said, /resumed=none/)
  } finally {
    await runtime.dispose()
  }
})

test('the auto-compact window is a control too: spawned with it, and moved by resume', async () => {
  const runtime = make()
  const tape = record(runtime)
  await runtime.start()
  try {
    // Every model has this one, so it is offered before a session exists.
    const draft = await runtime.defaultSessionOptions(WORKDIR)
    const option = draft.find((entry) => entry.id === 'autocompact')
    assert.ok(option && option.type === 'select')
    assert.deepEqual(
      option.choices.map((choice) => choice.value),
      ['default', 'auto', '100k', '200k', '500k', '1m'],
    )

    const session = await runtime.createSession({ cwd: WORKDIR, options: { autocompact: '500k' } })
    assert.match(await ask(runtime, session, 'hello', tape), /autocompact=500k/)

    // Changed on a conversation with history: a new process, resumed, with
    // the new window — and the effort it already had left alone.
    await session.setOption('autocompact', '200k')
    const said = await ask(runtime, session, 'again', tape)
    assert.match(said, /autocompact=200k/)
    assert.match(said, new RegExp(`resumed=${String(session.id)}`))

    // Below Claude Code's floor: refused with the value named, never sent.
    await assert.rejects(session.setOption('autocompact', '5k'), /5k/)
  } finally {
    await runtime.dispose()
  }
})

test('changing the effort mid-conversation resumes the same conversation in a new process', async () => {
  const log = join(scratch('claude-acp-log-'), 'spawns.log')
  const runtime = make({ FAKE_CLAUDE_LOG: log })
  const tape = record(runtime)
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    const first = await ask(runtime, session, 'one', tape)
    assert.match(first, /effort=default/)
    const firstPid = /spawn (\d+) effort=default autocompact=default style=default resume=none/.exec(readFileSync(log, 'utf8'))?.[1]
    assert.ok(firstPid, 'the first process is on record')

    await session.setOption('effort', 'low')
    assert.equal(effortOf(session.options())?.currentValue, 'low')
    const second = await ask(runtime, session, 'two', tape)
    assert.match(second, /effort=low/)
    assert.match(second, new RegExp(`resumed=${String(session.id)}`), 'the new process resumed the session')
    // The replaced process is gone, not leaked.
    const deadline = Date.now() + 5_000
    while (!readFileSync(log, 'utf8').includes(`exit ${firstPid}`) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.match(readFileSync(log, 'utf8'), new RegExp(`exit ${firstPid}`))

    // Back to the default: spawned with no --effort at all.
    await session.setOption('effort', 'default')
    assert.match(await ask(runtime, session, 'three', tape), /effort=default/)
  } finally {
    await runtime.dispose()
  }
})

test('an effort chosen before the first turn is applied through the agent\'s own command', async () => {
  const runtime = make()
  const tape = record(runtime)
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await session.setOption('effort', 'max')
    assert.equal(effortOf(session.options())?.currentValue, 'max')
    const said = await ask(runtime, session, 'go', tape)
    assert.match(said, /Effort set to max/)
    assert.match(said, /effort=max/)
    // Applied once; the next turn is plain.
    const next = await ask(runtime, session, 'again', tape)
    assert.doesNotMatch(next, /Effort set to/)
    assert.match(next, /effort=max/)
  } finally {
    await runtime.dispose()
  }
})

test('a model without effort levels has no effort control, and one with fewer drops an unsupported pick', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR, options: { effort: 'max' } })
    await session.setOption('model', 'haiku')
    assert.equal(effortOf(session.options()), undefined, 'Haiku declares no levels, so there is no control')
    await session.setOption('model', 'sonnet')
    const sonnet = effortOf(session.options())
    assert.deepEqual(sonnet?.choices.map((c) => c.value), ['default', 'low', 'medium', 'high'])
    assert.equal(sonnet?.currentValue, 'default', 'max is not a Sonnet level here; the default shows rather than a silent downgrade')
  } finally {
    await runtime.dispose()
  }
})

test('an effort survives the bridge being restarted: the loaded session resumes at it', async () => {
  const state = scratch('claude-acp-state-')
  const first = make({ CLAUDE_ACP_STATE_DIR: state })
  const tape = record(first)
  await first.start()
  let id: AgentSession['id']
  try {
    const session = await first.createSession({ cwd: WORKDIR, options: { effort: 'high' } })
    id = session.id
    await ask(first, session, 'remember me', tape)
  } finally {
    await first.dispose()
  }
  const index = JSON.parse(readFileSync(join(state, 'efforts.json'), 'utf8')) as Record<string, Record<string, string>>
  assert.deepEqual(index[String(id)], { effort: 'high' })
  const meta = withOptions({ keep: 1 }, { effort: 'high', autocompact: '500k' }, new AbortController()) as {
    claudeCode: { options: Record<string, unknown> }
  }
  assert.equal(meta.claudeCode.options['effort'], 'high')
  // `--autocompact` is not an option the SDK types; it rides its passthrough.
  assert.deepEqual(meta.claudeCode.options['extraArgs'], { autocompact: '500k' })
  assert.ok(meta.claudeCode.options['abortController'] instanceof AbortController)
  const none = withOptions({}, { effort: 'default', autocompact: 'default' }, new AbortController()) as typeof meta
  assert.equal(none.claudeCode.options['effort'], undefined)
  assert.equal(none.claudeCode.options['extraArgs'], undefined)
  assert.deepEqual(optionsIn({ harnessdesk: { options: { effort: 'low', model: 'sonnet' } } }), { effort: 'low' })
  assert.deepEqual(optionsIn({}), {})
  // Only what differs from the running process is asked for, and `default`
  // is asked for in the word Claude Code's own commands take.
  assert.deepEqual(commandsFor({ effort: 'max', autocompact: '200k' }, { effort: 'max' }), ['/autocompact 200k'])
  assert.deepEqual(commandsFor({ effort: 'default' }, { effort: 'low' }), ['/effort auto'])
})

test('an output style travels as --settings JSON, and never as a slash command', () => {
  // The only road: `/output-style` is refused under stream-json and there is
  // no dedicated flag, so the choice merges into the settings passthrough.
  const styled = withOptions({}, { output_style: 'Explanatory' }, new AbortController()) as {
    claudeCode: { options: Record<string, unknown> }
  }
  assert.deepEqual(styled.claudeCode.options['extraArgs'], {
    settings: JSON.stringify({ outputStyle: 'Explanatory' }),
  })
  // A caller's own settings JSON keeps its other keys.
  const merged = withOptions(
    { claudeCode: { options: { extraArgs: { settings: JSON.stringify({ theme: 'dark' }) } } } },
    { output_style: 'Concise' },
    new AbortController(),
  ) as typeof styled
  assert.deepEqual(merged.claudeCode.options['extraArgs'], {
    settings: JSON.stringify({ theme: 'dark', outputStyle: 'Concise' }),
  })
  // Back to default: only outputStyle leaves; a lone outputStyle takes the
  // whole flag with it.
  const restored = withOptions(
    { claudeCode: { options: { extraArgs: { settings: JSON.stringify({ theme: 'dark', outputStyle: 'Concise' }) } } } },
    { output_style: 'default' },
    new AbortController(),
  ) as typeof styled
  assert.deepEqual(restored.claudeCode.options['extraArgs'], { settings: JSON.stringify({ theme: 'dark' }) })
  const bare = withOptions(
    { claudeCode: { options: { extraArgs: { settings: JSON.stringify({ outputStyle: 'Concise' }) } } } },
    { output_style: 'default' },
    new AbortController(),
  ) as typeof styled
  assert.equal(bare.claudeCode.options['extraArgs'], undefined)
  // Style changes are respawns, never commands — the command is refused.
  assert.deepEqual(commandsFor({ output_style: 'Explanatory' }, {}), [])
})

test('the output style control is declared from the agent, rides the spawn, and a change respawns', async () => {
  const log = join(scratch('claude-acp-style-'), 'fake.log')
  const runtime = make({ FAKE_CLAUDE_LOG: log })
  const tape = record(runtime)
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR, options: { output_style: 'Explanatory' } })
    const style = session
      .options()
      .find((option): option is Extract<ConfigOption, { type: 'select' }> => option.id === 'output_style' && option.type === 'select')
    assert.ok(style, 'the styles the agent reported become a control')
    assert.equal(style.currentValue, 'Explanatory')
    assert.deepEqual(
      style.choices.map((choice) => choice.value),
      ['default', 'Explanatory', 'Concise'],
    )
    const first = await ask(runtime, session, 'one', tape)
    assert.match(first, /style=Explanatory/, 'the initial choice rode the spawn as --settings')

    // A mid-session change cannot ride a command; the turn after it runs in
    // a re-spawned process that resumed the conversation.
    await session.setOption('output_style', 'Concise')
    const second = await ask(runtime, session, 'two', tape)
    assert.match(second, /style=Concise/)
    assert.match(second, new RegExp(`resumed=${String(session.id)}`), 'the styled process resumed the session')

    // A style the agent never declared is refused, not passed through.
    await assert.rejects(session.setOption('output_style', 'Poetic'))
  } finally {
    await runtime.dispose()
  }
})

test('a Read of an image completes and the picture reaches the transcript', async () => {
  const runtime = make()
  const tape = record(runtime)
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await ask(runtime, session, 'readimage please', tape)
    const turn = (await runtime.readSession(session.id)).turns.at(-1)
    const read = turn?.items.find(
      (item): item is Extract<AgentItem, { type: 'toolCall' }> => item.type === 'toolCall' && /read/i.test(item.tool),
    )
    assert.ok(read, 'the Read tool call is on the turn')
    // The regression: the CLI streams the image as an Anthropic-API block
    // (`source`, `media_type`), the base bridge passed it through raw, and
    // the invalid ACP block took the whole completion update down — the row
    // sat "in progress" forever and no picture ever arrived.
    assert.equal(read.status, 'completed')
    const image = read.result?.find((part) => part.type === 'image')
    assert.ok(image, 'the screenshot is an image part')
    assert.equal(image.url, 'data:image/png;base64,UE5HYnl0ZXM=')
    // The raw copy keeps its shape but not the same bytes twice.
    const raw = read.result?.find((part) => part.type === 'json')
    assert.ok(raw)
    assert.ok(!JSON.stringify(raw.value).includes('UE5HYnl0ZXM='), 'base64 is not shipped twice')
  } finally {
    await runtime.dispose()
  }
})

test('a Read of what ACP cannot carry still completes, as a named placeholder', async () => {
  const runtime = make()
  const tape = record(runtime)
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await ask(runtime, session, 'readurlimage please', tape)
    await ask(runtime, session, 'readpdf please', tape)
    const turns = (await runtime.readSession(session.id)).turns
    const calls = turns.flatMap((turn) =>
      turn.items.filter(
        (item): item is Extract<AgentItem, { type: 'toolCall' }> => item.type === 'toolCall',
      ),
    )
    assert.equal(calls.length, 2)
    for (const call of calls) assert.equal(call.status, 'completed', 'no block shape wedges the row')
    // The raw copy is where such a result shows; what matters is that it is
    // still there to show, on a row that finished.
    const raws = calls.map((call) =>
      JSON.stringify((call.result ?? []).find((part) => part.type === 'json')?.value ?? null),
    )
    assert.ok(raws[0]?.includes('https://example.test/shot.png'), `the URL survives: ${raws[0]}`)
    assert.ok(raws[1]?.includes('document'), `the PDF is named, not dropped: ${raws[1]}`)
  } finally {
    await runtime.dispose()
  }
})

test('an image from a tool the base converts itself still arrives untouched', async () => {
  const runtime = make()
  const tape = record(runtime)
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await ask(runtime, session, 'bashimage please', tape)
    const turn = (await runtime.readSession(session.id)).turns.at(-1)
    const call = turn?.items.find(
      (item): item is Extract<AgentItem, { type: 'toolCall' }> => item.type === 'toolCall',
    )
    assert.ok(call, 'the Bash tool call is on the turn')
    assert.equal(call.status, 'completed')
    const image = call.result?.find((part) => part.type === 'image')
    assert.ok(image, 'the base converts non-Read images; the guard must not mangle them first')
    assert.equal(image.url, 'data:image/png;base64,UE5HYnl0ZXM=')
  } finally {
    await runtime.dispose()
  }
})

test('context fill and turn usage reach the client, from the agent\'s own counts', async () => {
  const runtime = make()
  const tape = record(runtime)
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    assert.equal((await runtime.readSession(session.id)).usage, null, 'nothing to say before the first turn')

    await ask(runtime, session, 'first', tape)
    const usages = tape.events.filter(
      (event): event is Extract<AgentEvent, { type: 'usage/updated' }> => event.type === 'usage/updated' && event.sessionId === session.id,
    )
    assert.ok(usages.length >= 2, `a fill update and a turn update; saw ${usages.length}`)
    const after = (await runtime.readSession(session.id)).usage
    assert.ok(after)
    // The fake's first call: 12 fresh + 3000 cache written + 20000 cache read in, 40 out.
    assert.equal(after.contextUsed, 23012, 'what the latest call put in context')
    assert.equal(after.contextWindow, 200000, 'the window, from modelUsage')
    assert.deepEqual(after.last, {
      totalTokens: 23052,
      inputTokens: 23012,
      cachedInputTokens: 20000,
      // Both cache halves survive the boundary. The write count arrived from
      // the first day ACP had a usage shape and was dropped in the adapter,
      // which left the turn tail dividing hits by input and calling the
      // quotient cache health — see `ui/src/lib/cache-health.ts`.
      cacheWriteTokens: 3000,
      outputTokens: 40,
      reasoningOutputTokens: 0,
    })
    assert.deepEqual(after.total, after.last, 'one turn in, the total is the turn')
    assert.equal(after.cost?.currency, 'USD')
    assert.ok(after.cost && Math.abs(after.cost.amount - 0.0123) < 1e-9)

    // The turn's tokens are on the finished turn's event too, before it completes.
    const order = tape.events.map((event) => event.type)
    assert.ok(order.lastIndexOf('usage/updated') < order.lastIndexOf('turn/completed'), 'usage lands before the turn does')

    await ask(runtime, session, 'second', tape)
    const again = (await runtime.readSession(session.id)).usage
    assert.ok(again)
    assert.equal(again.contextUsed, 43012, 'the context grew by the previous call')
    assert.equal(again.total.totalTokens, 23052 + 43052, 'two turns summed')
    assert.equal(again.last.totalTokens, 43052, 'last is the latest turn alone')
    assert.ok(again.cost && Math.abs(again.cost.amount - 0.0246) < 1e-9, 'cost is cumulative')
  } finally {
    await runtime.dispose()
  }
})

/**
 * A session's name.
 *
 * The base bridge names a stored session after its first user message, so a
 * conversation opened with a slash command is called
 * `<local-command-caveat>Caveat: …`. Claude Code writes the real name into
 * the same transcript, and this bridge reads it.
 */

const transcript = (lines: readonly unknown[]): string => {
  const path = join(scratch('claude-acp-titles-'), 'session.jsonl')
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return path
}

test('the name is the one Claude Code kept, not the first thing typed', () => {
  const path = transcript([
    { type: 'user', message: { content: 'hi' } },
    { type: 'ai-title', aiTitle: 'Early guess' },
    { type: 'assistant', message: { content: 'hello' } },
    { type: 'ai-title', aiTitle: 'Fix the session list grouping' },
  ])
  assert.equal(storedTitle(path), 'Fix the session list grouping', 'the last ai-title is the current one')
})

test('a name the session was given wins over the model’s running one', () => {
  const path = transcript([
    { type: 'custom-title', customTitle: 'Session list' },
    { type: 'ai-title', aiTitle: 'Fix the session list grouping' },
  ])
  assert.equal(storedTitle(path), 'Session list', 'even though the model wrote its own later')
})

test('a transcript with no name of its own has none to give', () => {
  const path = transcript([{ type: 'user', message: { content: 'hi' } }])
  assert.equal(storedTitle(path), null, 'and the caller falls back to the first message')
  assert.equal(storedTitle(join(tmpdir(), 'claude-acp-missing', 'nope.jsonl')), null, 'a missing file is not an error')
})

test('the name is read from the tail of a transcript too large to read whole', () => {
  const filler = { type: 'assistant', message: { content: 'x'.repeat(4096) } }
  const path = transcript([
    { type: 'ai-title', aiTitle: 'Buried past the window' },
    ...Array.from({ length: 200 }, () => filler),
    { type: 'ai-title', aiTitle: 'Within the window' },
    ...Array.from({ length: 20 }, () => filler),
  ])
  assert.equal(storedTitle(path), 'Within the window')
})

/**
 * The note Claude Code's desktop app pins to an annotated screenshot, copied
 * verbatim from a transcript in `~/.claude/projects`. It travels in the
 * user's own message, ahead of whatever they typed about the drawing.
 */
const ANNOTATION =
  "<preview-annotation-context>The attached image is a screenshot of the Browser pane's page with the user's freehand annotations drawn on top. Use the Claude_Browser tools to inspect or interact with the live page.</preview-annotation-context>"

test('plumbing is never a name', () => {
  assert.equal(
    unwrap('<local-command-caveat>Caveat: The messages below were generated by…</local-command-caveat>'),
    null,
    'a caveat wrapper is all envelope',
  )
  assert.equal(unwrap('<local-command-caveat>Caveat: the block was cut at 128 charac'), null, 'truncated, too')
  assert.equal(unwrap('<command-name>/compact</command-name> then fix the grouping'), 'then fix the grouping')
  assert.equal(unwrap('<context source="Git">on branch x</context>\nWrite the commit message'), 'Write the commit message')
  // Verbatim from a transcript on disk: the desktop app's note about a
  // screenshot someone drew on. A session is named for the ask under it.
  assert.equal(unwrap(`${ANNOTATION}\nto here.`), 'to here.')
  assert.equal(unwrap('Plain words survive'), 'Plain words survive')
  assert.equal(unwrap(null), null)
})


/**
 * A stored transcript, the way Claude Code writes one: every line an entry,
 * and far more of them `user` than anyone ever typed.
 */
const storedSession = (dir: string, id: string, cwd: string, entries: readonly Record<string, unknown>[]): void => {
  const project = join(dir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  const lines = entries.map((entry) => JSON.stringify({ isSidechain: false, sessionId: id, cwd, ...entry }))
  writeFileSync(join(project, `${id}.jsonl`), `${lines.join('\n')}\n`)
}

const said = (text: string): Record<string, unknown> => ({ type: 'user', message: { role: 'user', content: text } })
const answered = (text: string): Record<string, unknown> => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})

const textIn = (item: AgentItem): string =>
  item.type === 'userMessage'
    ? item.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    : item.type === 'notice'
      ? item.text
      : item.type === 'assistantMessage'
        ? item.text
        : ''

test('a replayed user message is speech, housekeeping, or nothing', () => {
  assert.equal(classifyReplayed('<local-command-caveat>Caveat: the messages below…</local-command-caveat>'), null)
  assert.equal(classifyReplayed('<command-name>/model</command-name>\n<command-args>opus[1m]</command-args>'), null)
  assert.equal(classifyReplayed('<system-reminder>Do not mention this</system-reminder>'), null)
  assert.equal(classifyReplayed('   '), null)
  assert.deepEqual(classifyReplayed('<local-command-stdout>Set model to \u001b[1mOpus 5\u001b[22m</local-command-stdout>'), {
    kind: 'notice',
    // The escape goes; `[1m` on its own stays, because `opus[1m]` is a model.
    text: 'Set model to Opus 5',
    echo: true,
  })
  assert.deepEqual(classifyReplayed('<local-command-stdout>Set model to opus[1m]</local-command-stdout>'), {
    kind: 'notice',
    text: 'Set model to opus[1m]',
    echo: true,
  })
  assert.equal(classifyReplayed('<local-command-stdout></local-command-stdout>'), null, 'a command that said nothing')
  assert.deepEqual(
    classifyReplayed(
      '<task-notification>\n<task-id>b98</task-id>\n<status>completed</status>\n<summary>Background command "seed" completed (exit code 0)</summary>\n</task-notification>',
    ),
    { kind: 'notice', text: 'Background command "seed" completed (exit code 0)' },
  )
  assert.deepEqual(classifyReplayed('<task-notification>\n<task-id>b98</task-id>\n</task-notification>'), {
    kind: 'notice',
    text: 'A background task reported back',
  })
  assert.deepEqual(classifyReplayed('[Request interrupted by user]'), { kind: 'notice', text: 'Interrupted' })
  assert.deepEqual(classifyReplayed('Build a tiny web game'), { kind: 'prompt', text: 'Build a tiny web game' })
  // A stored entry Claude Code wrote for itself: a skill's template becomes
  // one dim attributed line, the note beside a downsized image nothing, a
  // continuation summary one fixed line — and the same texts stay speech
  // when the transcript carried no such flag.
  assert.deepEqual(classifyReplayed('Approach this as the design lead at a small studio.', 'meta'), {
    kind: 'notice',
    text: 'Claude Code added: Approach this as the design lead at a small studio.',
  })
  assert.equal(
    classifyReplayed('[Image: original 2560x1680, displayed at 2000x1313. Multiply coordinates by 1.28 to map to original image.]', 'meta'),
    null,
  )
  assert.deepEqual(classifyReplayed('[Image: original 10x10.] what changed?', 'meta'), {
    kind: 'notice',
    text: 'Claude Code added: what changed?',
  })
  assert.deepEqual(classifyReplayed('[Request interrupted by user]', 'meta'), { kind: 'notice', text: 'Interrupted' })
  assert.deepEqual(classifyReplayed('This session is being continued from a previous conversation…\n\nSummary:\n1. …', 'compact'), {
    kind: 'notice',
    text: 'Continued from a previous conversation',
  })
  assert.deepEqual(classifyReplayed('[Image: original 10x10.]'), {
    kind: 'prompt',
    text: '[Image: original 10x10.]',
  })
  assert.deepEqual(
    classifyReplayed('<system-reminder>be nice</system-reminder>\nand what does the score read?'),
    { kind: 'prompt', text: 'and what does the score read?' },
    'a reminder around speech leaves the speech',
  )
  // HarnessDesk's own envelope is not Claude Code's plumbing: the client
  // renders it as the "Context added" row, so it has to survive the sieve.
  const withContext = classifyReplayed('<context source="notes">the score is 3</context>\nis that right?')
  assert.equal(withContext?.kind, 'prompt')
  assert.match(withContext?.text ?? '', /<context source="notes">/)
  // The screenshot note is folded, not dropped, so it survives this sieve too
  // — the adapter downstream is what turns it into a row beside the picture.
  const annotated = classifyReplayed(`${ANNOTATION}\n\ntoo big …`)
  assert.equal(annotated?.kind, 'prompt')
  assert.match(annotated?.text ?? '', /<preview-annotation-context>/)
  assert.match(annotated?.text ?? '', /too big …/)
})

test('tool-call content is made schema-safe; valid updates pass by reference', () => {
  const entry = (content: unknown): unknown => ({ type: 'content', content })
  const update = (content: unknown[]): Parameters<typeof acpSafeToolContent>[0] =>
    ({ sessionUpdate: 'tool_call_update', toolCallId: 'x', content }) as unknown as Parameters<
      typeof acpSafeToolContent
    >[0]
  const first = (fixed: unknown): unknown =>
    (fixed as { content: { content: unknown }[] }).content[0]?.content

  const anthropic = update([entry({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } })])
  assert.deepEqual(first(acpSafeToolContent(anthropic)), { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' })

  const url = update([entry({ type: 'image', source: { type: 'url', url: 'https://x/y.png' } })])
  assert.deepEqual(first(acpSafeToolContent(url)), { type: 'text', text: '[image: https://x/y.png]' })

  const doc = update([entry({ type: 'document', source: { type: 'base64', data: 'UERG' } })])
  assert.deepEqual(first(acpSafeToolContent(doc)), { type: 'text', text: '[document content]' })

  const shapeless = update([entry(null)])
  assert.deepEqual(first(acpSafeToolContent(shapeless)), { type: 'text', text: '[unreadable content]' })

  const fine = update([entry({ type: 'text', text: 'hi' }), entry({ type: 'image', data: 'QUJD', mimeType: 'image/png' })])
  assert.equal(acpSafeToolContent(fine), fine, 'already-valid content costs nothing')

  const chunk = {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hi' },
  } as unknown as Parameters<typeof acpSafeToolContent>[0]
  assert.equal(acpSafeToolContent(chunk), chunk, 'other notifications are not touched')
})

test('a stored Read of an image survives reopening', async () => {
  const config = scratch('claude-config-')
  const id = '4a1b2c3d-5e6f-4a70-8b91-0c2d3e4f5a61'
  storedSession(config, id, WORKDIR, [
    said('look at the screenshot'),
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_replay_img', name: 'Read', input: { file_path: '/shots/page.png' } }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_replay_img',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'UE5HYnl0ZXM=' } }],
          },
        ],
      },
    },
    answered('that is the settings page'),
  ])

  const runtime = make({ CLAUDE_CONFIG_DIR: config })
  await runtime.start()
  try {
    const session = await runtime.resumeSession(id as AgentSession['id'])
    const turns = (await runtime.readSession(session.id)).turns
    const call = turns
      .flatMap((turn) => turn.items)
      .find((item): item is Extract<AgentItem, { type: 'toolCall' }> => item.type === 'toolCall')
    assert.ok(call, 'the stored Read is on the reopened transcript')
    // The same raw pass-through runs on replay as on a live turn; without the
    // guard the reopened row would be stuck in progress with no picture.
    assert.equal(call.status, 'completed')
    const image = call.result?.find((part) => part.type === 'image')
    assert.ok(image, 'the stored screenshot renders after reopening')
    assert.equal(image.url, 'data:image/png;base64,UE5HYnl0ZXM=')
  } finally {
    await runtime.dispose()
  }
})

test('a reopened conversation replays what was said, not the plumbing around it', async () => {
  const config = scratch('claude-config-')
  const id = '3f2b0c1a-4d5e-4f60-8a71-9b2c3d4e5f60'
  storedSession(config, id, WORKDIR, [
    // What HarnessDesk's own model picker leaves behind: three entries, none
    // of them anything the person said.
    {
      ...said(
        '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>',
      ),
      isMeta: true,
    },
    said('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus[1m]</command-args>'),
    said('<local-command-stdout>Set model to \u001b[1mOpus 5\u001b[22m</local-command-stdout>'),
    // A second and third open re-applied the same remembered setting, and
    // the CLI stored the echo again each time. Three copies, one fact.
    said('<local-command-stdout>Set model to Opus 5</local-command-stdout>'),
    said('<local-command-stdout>Set model to Opus 5</local-command-stdout>'),
    said('Build a tiny web game'),
    answered('Done — one canvas, one square.'),
    // A background task reporting back, and the answer it drew out of the agent.
    {
      type: 'user',
      isMeta: true,
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<task-notification>\n<task-id>b98</task-id>\n<status>completed</status>\n<summary>Background command "deploy" completed (exit code 0)</summary>\n</task-notification>',
          },
        ],
      },
    },
    answered('The deployment is ready.'),
    said('[Request interrupted by user]'),
    // What a skill load feeds the model, the note pinned to a downsized
    // image, and the summary a continued conversation opens on: stored as
    // `user`, none of it typed by the person.
    { ...said('Approach this as the design lead at a small studio.'), isMeta: true },
    {
      ...said('[Image: original 2560x1680, displayed at 2000x1313. Multiply coordinates by 1.28 to map to original image.]'),
      isMeta: true,
    },
    {
      type: 'user',
      isCompactSummary: true,
      message: { role: 'user', content: 'This session is being continued from a previous conversation…\n\nSummary:\n1. Primary Request…' },
    },
    said('<context source="notes">the score is 3</context>\nis that right?<system-reminder>be nice</system-reminder>'),
  ])

  const runtime = make({ CLAUDE_CONFIG_DIR: config })
  await runtime.start()
  try {
    const session = await runtime.resumeSession(id as AgentSession['id'])
    const turns = (await runtime.readSession(session.id)).turns
    const shape = turns.map((turn) => turn.items.map((item) => `${item.type}: ${textIn(item)}`))
    assert.deepEqual(
      shape,
      [
        ['notice: Set model to Opus 5'],
        ['userMessage: Build a tiny web game', 'assistantMessage: Done — one canvas, one square.'],
        ['notice: Background command "deploy" completed (exit code 0)', 'assistantMessage: The deployment is ready.'],
        ['notice: Interrupted'],
        ['notice: Claude Code added: Approach this as the design lead at a small studio.'],
        ['notice: Continued from a previous conversation'],
        ['userMessage: <context source="notes">the score is 3</context>\nis that right?'],
      ],
      'the caveat, the command echo and the image note are gone; the injected template is attributed, not speech',
    )
  } finally {
    await runtime.dispose()
  }
})
