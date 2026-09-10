import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { describeAdapterConformance } from '@harnessdesk/adapter-testkit'
import type { AgentEvent, AgentItem } from '@harnessdesk/protocol'

import { DatabaseSync } from 'node:sqlite'

import { SCRATCH_TMP, tempDir } from './scratch.js'

import { cursorMeta, readChatPreview, readCursorSkills, readWorkspaceChats, titleOf, workspaceKey } from '../src/index.js'

/**
 * The bridge under the real HarnessDesk ACP adapter — the full path a user's
 * prompt takes: adapter → bridge process → (fake) cursor-agent process →
 * NDJSON back up. The fake emits the stream-json dialect captured from the
 * live CLI, so what these tests prove is the translation, not the tape.
 */

const BRIDGE = fileURLToPath(new URL('../src/main.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-cursor-agent.mjs', import.meta.url))
const WORKDIR = tempDir('cursor-acp-')
// Every runtime in this file gets its own state dir: the bridge keeps a
// session index, and tests must never write fake sessions into the real one.
const STATE = tempDir('cursor-acp-idx-')

/**
 * A Cursor config directory of the test's own. The bridge reads the CLI's
 * `modelParameters` to learn a model's parameterised form, and reading the
 * developer's real `~/.cursor` would make these tests say different things on
 * different machines.
 */
const CURSOR_HOME = tempDir('cursor-acp-home-')

const make = (): AcpRuntime =>
  new AcpRuntime({
    id: 'cursor',
    name: 'Cursor Agent',
    command: process.execPath,
    args: [BRIDGE],
    env: { CURSOR_ACP_COMMAND: FAKE, CURSOR_ACP_STATE_DIR: STATE, CURSOR_CONFIG_DIR: CURSOR_HOME },
  })

describeAdapterConformance('cursor-acp', {
  create: make,
  sessionOptions: { cwd: WORKDIR },
})

/**
 * HarnessDesk offers every agent an MCP server carrying its plugin tools.
 * `cursor-agent` takes it through a generated plugin directory — the
 * marketplace layout, `.cursor-plugin/plugin.json` beside `.mcp.json` —
 * passed as `--plugin-dir` with `--approve-mcps` on every turn. What this
 * pins: the directory holds the offered server with its env (the per-open
 * `HD_TOOLS_CALLER` token among it), the flags actually reach the spawned
 * CLI, and `pluginTools` stays true because nothing was refused.
 */
test('the tool server is accepted through a generated plugin directory', async () => {
  const reasons: string[] = []
  const runtime = new AcpRuntime({
    id: 'cursor',
    name: 'Cursor Agent',
    command: process.execPath,
    args: [BRIDGE],
    env: { CURSOR_ACP_COMMAND: FAKE, CURSOR_ACP_STATE_DIR: STATE, CURSOR_CONFIG_DIR: CURSOR_HOME },
    toolServer: {
      name: 'harnessdesk',
      command: process.execPath,
      args: ['-e', ''],
      env: { HD_TOOLS_SOCKET: '/tmp/nowhere.sock' },
    },
    logger: { info: (_message: string, details?: Record<string, unknown>) => reasons.push(String(details?.['reason'] ?? '')) },
  })
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    assert.ok(session, 'the session opens with the tool server')
    assert.ok(
      !reasons.some((reason) => /mcpServers/.test(reason)),
      `nothing was refused: ${JSON.stringify(reasons)}`,
    )
    assert.equal(runtime.info.capabilities.pluginTools, true, 'the tools were taken, so the capability stands')

    const dir = join(SCRATCH_TMP, 'harnessdesk-cursor-acp', String(session.id), 'plugin')
    const manifest = JSON.parse(readFileSync(join(dir, '.cursor-plugin', 'plugin.json'), 'utf8')) as {
      name?: string
    }
    assert.equal(manifest.name, 'harnessdesk')
    const declared = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, { command?: string; env?: Record<string, string> }>
    }
    const server = declared.mcpServers?.['harnessdesk']
    assert.equal(server?.command, process.execPath)
    assert.equal(server?.env?.['HD_TOOLS_SOCKET'], '/tmp/nowhere.sock')
    assert.ok(server?.env?.['HD_TOOLS_CALLER'], 'the per-open correlation token rides the env')

    // The flags reach the CLI: the fake echoes them back in its answer.
    await session.send([{ type: 'text', text: 'echo the flags' }])
    const turn = completedTurn(await tape.until((event) => event.type === 'turn/completed'))
    const message = turn.items.find(
      (item): item is Extract<AgentItem, { type: 'assistantMessage' }> => item.type === 'assistantMessage',
    )
    assert.ok(message)
    assert.ok(
      message.text.includes(`plugin-dir=${dir} approve-mcps=true`),
      `the spawn carried the plugin flags: ${message.text}`,
    )
  } finally {
    await runtime.dispose()
  }
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

/**
 * A chat in Cursor's own store, written the way Cursor writes one: a
 * `meta.json` beside a sqlite `store.db` whose `meta` row names the latest
 * root blob, and whose blobs are the messages, addressed by their hash.
 * Tests build their own store under a temporary home — the real
 * `~/.cursor` is never read here, and never written anywhere.
 */
const writeChat = (
  home: string,
  cwd: string,
  chatId: string,
  chat: {
    title?: string
    updatedAtMs?: number
    hasConversation?: boolean
    schemaVersion?: number
    messages?: readonly { role: string; text: string }[]
  },
): void => {
  const dir = join(home, '.cursor', 'chats', workspaceKey(cwd), chatId)
  mkdirSync(dir, { recursive: true })
  const updatedAtMs = chat.updatedAtMs ?? Date.now()
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      schemaVersion: chat.schemaVersion ?? 1,
      createdAtMs: updatedAtMs,
      updatedAtMs,
      hasConversation: chat.hasConversation ?? true,
      ...(chat.title !== undefined ? { title: chat.title } : {}),
      cwd,
    }),
  )
  const db = new DatabaseSync(join(dir, 'store.db'))
  db.exec('create table blobs (id text primary key, data blob); create table meta (key text primary key, value text)')
  const put = db.prepare('insert or replace into blobs (id, data) values (?, ?)')
  const refs: Buffer[] = []
  for (const message of chat.messages ?? []) {
    const data = Buffer.from(
      JSON.stringify({ role: message.role, content: [{ type: 'text', text: message.text }] }),
    )
    const id = createHash('sha256').update(data).digest()
    put.run(id.toString('hex'), data)
    refs.push(Buffer.concat([Buffer.from([0x0a, 0x20]), id]))
  }
  const root = Buffer.concat(refs)
  const rootId = createHash('sha256').update(root).digest('hex')
  put.run(rootId, root)
  db.prepare('insert or replace into meta (key, value) values (?, ?)').run(
    '0',
    Buffer.from(JSON.stringify({ agentId: chatId, name: chat.title ?? 'New Agent', latestRootBlobId: rootId })).toString('hex'),
  )
  db.close()
}

const completedTurn = (event: AgentEvent) =>
  (event as Extract<AgentEvent, { type: 'turn/completed' }>).turn

test('a turn streams thinking, a real tool call, and deduplicated text', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  const cwd = tempDir('cursor-acp-turn-')
  try {
    const session = await runtime.createSession({ cwd })
    await session.send([{ type: 'text', text: 'please write a file' }])
    const turn = completedTurn(await tape.until((event) => event.type === 'turn/completed'))
    assert.equal(turn.status, 'completed')

    const reasoning = turn.items.find((item) => item.type === 'reasoning')
    assert.ok(reasoning, 'thinking deltas surface as reasoning')

    const tool = turn.items.find((item): item is Extract<AgentItem, { type: 'toolCall' }> => item.type === 'toolCall')
    assert.ok(tool, 'the editToolCall surfaces as a tool call')
    assert.equal(tool.status, 'completed')
    assert.equal(tool.tool, 'Edit fake.txt')
    assert.equal(readFileSync(join(cwd, 'fake.txt'), 'utf8'), 'hi', 'the tool call really ran')

    const messages = turn.items.filter(
      (item): item is Extract<AgentItem, { type: 'assistantMessage' }> => item.type === 'assistantMessage',
    )
    // The CLI re-sends each message's full text after its deltas — with
    // timestamp_ms mid-turn, without it at the end. Both repeats must be
    // dropped, so each text appears exactly once.
    assert.deepEqual(
      messages.map((item) => item.text),
      [
        'Writing the file now.',
        'heard: please write a file [model=auto mode=default sandbox=default plugin-dir=none approve-mcps=false]',
      ],
    )
  } finally {
    await runtime.dispose()
  }
})

test('model and mode picks reach the cursor-agent command line', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await session.setOption('model', 'fast-1')
    await session.setOption('mode', 'ask')
    await session.send([{ type: 'text', text: 'echo the flags' }])
    const turn = completedTurn(await tape.until((event) => event.type === 'turn/completed'))
    const message = turn.items.find(
      (item): item is Extract<AgentItem, { type: 'assistantMessage' }> => item.type === 'assistantMessage',
    )
    assert.ok(message)
    assert.match(message.text, /\[model=fast-1 mode=ask sandbox=default plugin-dir=none/)
  } finally {
    await runtime.dispose()
  }
})

test('the sandbox is a session control, and off by default it says nothing', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    const sandbox = session.options().find((option) => option.id === 'sandbox')
    assert.ok(sandbox && sandbox.type === 'select', 'every session has one, model or not')
    assert.equal(sandbox.currentValue, 'default')

    await session.setOption('sandbox', 'enabled')
    await session.send([{ type: 'text', text: 'echo the flags' }])
    const turn = completedTurn(await tape.until((event) => event.type === 'turn/completed'))
    const message = turn.items.find(
      (item): item is Extract<AgentItem, { type: 'assistantMessage' }> => item.type === 'assistantMessage',
    )
    assert.match(message?.text ?? '', /sandbox=enabled/)
    await assert.rejects(session.setOption('sandbox', 'maybe'), /not one of the values|not one of default/)
  } finally {
    await runtime.dispose()
  }
})

test('a conversation carries the name Cursor gave it, not one of this bridge\'s', () => {
  // Cursor files a chat under the md5 of its workspace path and writes the
  // name its own picker shows into meta.json.
  const home = tempDir('cursor-home-')
  const cwd = '/Users/someone/code/thing'
  const chatId = '2e62119d-66de-4424-bb48-57180aac291e'
  const workspace = createHash('md5').update(cwd).digest('hex')
  mkdirSync(join(home, '.cursor', 'chats', workspace, chatId), { recursive: true })
  writeFileSync(
    join(home, '.cursor', 'chats', workspace, chatId, 'meta.json'),
    JSON.stringify({ schemaVersion: 1, title: 'Safe continuous scraper', updatedAtMs: 1787433657598, cwd }),
  )
  assert.deepEqual(cursorMeta(chatId, cwd, home), {
    title: 'Safe continuous scraper',
    updatedAt: 1787433657598,
  })

  // A chat Cursor has not named — one started here and never opened there —
  // reports no name, and the bridge's own first-line one stands in.
  writeFileSync(
    join(home, '.cursor', 'chats', workspace, chatId, 'meta.json'),
    JSON.stringify({ schemaVersion: 1, hasConversation: true, cwd }),
  )
  assert.deepEqual(cursorMeta(chatId, cwd, home), { title: null, updatedAt: null })
  assert.deepEqual(cursorMeta('no-such-chat', cwd, home), { title: null, updatedAt: null })
})

test("Cursor's skills are declared from the folders Cursor scans", async () => {
  // A workspace skill, written the way Cursor writes them — description as a
  // folded block scalar, which is what its own shipped skills use.
  const skill = join(WORKDIR, '.cursor', 'skills', 'greet')
  mkdirSync(skill, { recursive: true })
  writeFileSync(
    join(skill, 'SKILL.md'),
    ['---', 'name: greet', 'description: >-', '  Says hello, at length', '  and over two lines.', '---', '# Greet'].join('\n'),
  )
  assert.deepEqual(readCursorSkills(WORKDIR, join(WORKDIR, 'nowhere')), [
    { name: 'greet', description: 'Says hello, at length and over two lines.' },
  ])

  const runtime = make()
  await runtime.start()
  try {
    const skills = await runtime.listSkills(WORKDIR)
    const greet = skills.find((entry) => entry.name === 'greet')
    assert.ok(greet, "the agent's declaration reached the runtime")
    assert.equal(greet.toggleable, false, 'Cursor configures them, not this client')
  } finally {
    await runtime.dispose()
  }
})

test('a model the account does not offer is refused by the bridge', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await assert.rejects(session.setOption('model', 'gpt-imaginary'), /not offered by this Cursor account|not one of the values/)
  } finally {
    await runtime.dispose()
  }
})

test('a prompt that looks like a flag stays a prompt', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await session.send([{ type: 'text', text: '--yolo -p --trust' }])
    const turn = completedTurn(await tape.until((event) => event.type === 'turn/completed'))
    const message = turn.items.find(
      (item): item is Extract<AgentItem, { type: 'assistantMessage' }> => item.type === 'assistantMessage',
    )
    assert.ok(message)
    assert.match(message.text, /heard: --yolo -p --trust/)
  } finally {
    await runtime.dispose()
  }
})

test('an attached image is written to disk and named to cursor-agent with @path', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    assert.equal(runtime.info.capabilities.imageInput, true, 'the bridge declares image input')
    const session = await runtime.createSession({ cwd: WORKDIR })
    // A 1×1 PNG, the smallest real image there is.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    await session.send([
      { type: 'image', url: `data:image/png;base64,${png}`, name: 'dot.png' },
      { type: 'text', text: 'what colour is it' },
    ])
    const turn = completedTurn(await tape.until((event) => event.type === 'turn/completed'))
    const message = turn.items.find(
      (item): item is Extract<AgentItem, { type: 'assistantMessage' }> => item.type === 'assistantMessage',
    )
    assert.ok(message)
    // The user's words come first — they are the title — and the image
    // reference follows them, pointing at a file that really holds the bytes.
    const match = /heard: what colour is it\n\nThe user attached this image; look at it: @(\S+\.png)/.exec(message.text)
    assert.ok(match, `the prompt names the spilled image: ${message.text}`)
    // Under this run's own temp root, not the fixed one every cursor-acp on
    // the machine shares: a parallel test process cleaning that root out from
    // under this read is what used to make this test flaky on CI.
    assert.ok(match[1]!.startsWith(`${SCRATCH_TMP}/`), `the image is spilled inside this run: ${match[1]}`)
    assert.equal(readFileSync(match[1]!).toString('base64'), png)
    // The transcript keeps the image as the user sent it, name included.
    const user = turn.items.find((item): item is Extract<AgentItem, { type: 'userMessage' }> => item.type === 'userMessage')
    assert.ok(user)
    assert.deepEqual(user.content[0], { type: 'image', url: `data:image/png;base64,${png}`, name: 'dot.png' })
  } finally {
    await runtime.dispose()
  }
})

test('interrupt kills the cursor-agent process and lands as interrupted', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await session.send([{ type: 'text', text: 'be slow about it' }])
    await tape.until((event) => event.type === 'item/delta')
    await session.interrupt()
    const turn = completedTurn(await tape.until((event) => event.type === 'turn/completed'))
    assert.equal(turn.status, 'interrupted')
  } finally {
    await runtime.dispose()
  }
})

test('a cursor-agent error fails the turn in its own words', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await session.send([{ type: 'text', text: 'explode' }])
    const turn = completedTurn(await tape.until((event) => event.type === 'turn/completed'))
    assert.equal(turn.status, 'failed')
    assert.match(turn.error?.message ?? '', /the model refused to continue/)
  } finally {
    await runtime.dispose()
  }
})

test('the flat catalog collapses into families with dimension controls', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    const model = session.options().find((option) => option.id === 'model')
    assert.ok(model && model.type === 'select')
    const values = model.choices.map((choice) => choice.value)
    assert.ok(values.includes('brain-9'), 'the family is one row')
    assert.ok(!values.some((value) => value.startsWith('brain-9-')), 'variants are not rows')

    await session.setOption('model', 'brain-9')
    const effort = session.options().find((option) => option.id === 'effort')
    assert.ok(effort && effort.type === 'select', 'picking a family declares its effort control')
    // `max` is a level of reasoning, not Cursor's Max mode — cursor-agent
    // resolves `-max` and `-xhigh` at the same context window — so it is
    // offered like any other level rather than gated behind a switch.
    assert.deepEqual(effort.choices.map((choice) => choice.value), ['low', 'high', 'max'])
    assert.ok(session.options().some((option) => option.id === 'thinking'), 'and its thinking toggle')
    await session.setOption('effort', 'max')
    const after = session.options().find((option) => option.id === 'effort')
    assert.equal(after?.currentValue, 'max', 'and picking it sticks')
  } finally {
    await runtime.dispose()
  }
})

test('a dimension the family has no say in is greyed, not withdrawn', async () => {
  // The break this fixes: switching to a family without a thinking variant
  // used to withdraw the `thinking` switch entirely, and the next round trip
  // — the composer re-offering the picks it is holding — then failed on
  // "Cursor has no session option named \"thinking\"", which ate the model
  // change with it.
  const runtime = make()
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await session.setOption('model', 'brain-9')
    await session.setOption('thinking', true)
    assert.equal(session.options().find((option) => option.id === 'thinking')?.currentValue, true)

    await session.setOption('model', 'fast-1')
    const thinking = session.options().find((option) => option.id === 'thinking')
    assert.ok(thinking, 'the switch is still declared')
    assert.equal(thinking.currentValue, false, 'and switched to what will actually run')
    assert.match(thinking.disabled ?? '', /no thinking mode/, 'greyed, with the reason')
    const effort = session.options().find((option) => option.id === 'effort')
    assert.match(effort?.disabled ?? '', /one level of effort/)

    // The preference outlives the family it could not be honoured on.
    await session.setOption('model', 'brain-9')
    assert.equal(session.options().find((option) => option.id === 'thinking')?.currentValue, true)
  } finally {
    await runtime.dispose()
  }
})

test('the catalogue lists families with every level they have', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const models = await runtime.listModels()
    const brain = models.find((model) => model.id === 'brain-9')
    assert.ok(brain, 'the family is the catalogue row')
    // The catalogue says what the model can do, `max` included: it is the
    // top level of reasoning, not a separate tier to be unlocked.
    assert.deepEqual(
      brain.reasoningLevels.map((level) => level.label),
      ['Low', 'High', 'Max'],
    )
    // A family whose ids carry no effort token has none — and says so, so
    // nothing borrows the levels of whichever family is current.
    assert.deepEqual(models.find((model) => model.id === 'fast-1')?.reasoningLevels, [])
    assert.equal(models.find((model) => model.id === 'auto')?.isDefault, true)
  } finally {
    await runtime.dispose()
  }
})

test('dimension picks compose the concrete id on the command line', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await session.setOption('model', 'brain-9')
    await session.setOption('thinking', true)
    await session.setOption('effort', 'high')
    await session.send([{ type: 'text', text: 'which variant?' }])
    const turn = completedTurn(await tape.until((event) => event.type === 'turn/completed'))
    const message = turn.items.find(
      (item): item is Extract<AgentItem, { type: 'assistantMessage' }> => item.type === 'assistantMessage',
    )
    assert.ok(message)
    assert.match(message.text, /\[model=brain-9-thinking-high /)
  } finally {
    await runtime.dispose()
  }
})

test('a Cursor conversation survives the bridge process', async () => {
  const { mkdtempSync: mkTemp, rmSync } = await import('node:fs')
  const dir = mkTemp(join(tmpdir(), 'cursor-acp-state-'))
  const withState = (): AcpRuntime =>
    new AcpRuntime({
      id: 'cursor',
      name: 'Cursor Agent',
      command: process.execPath,
      args: [BRIDGE],
      env: { CURSOR_ACP_COMMAND: FAKE, CURSOR_ACP_STATE_DIR: dir },
    })

  const first = withState()
  await first.start()
  const tapeA = record(first)
  let id: string
  try {
    // A chat nobody speaks to is not a conversation: options probes and
    // abandoned drafts create chats, and the list must not fill with them.
    await first.createSession({ cwd: WORKDIR })
    const session = await first.createSession({ cwd: WORKDIR })
    id = String(session.id)
    await session.send([{ type: 'text', text: 'remember this cursor chat' }])
    await tapeA.until((event) => event.type === 'turn/completed')
    const indexed = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')) as { sessions: { sessionId: string }[] }
    assert.deepEqual(
      indexed.sessions.map((row) => row.sessionId),
      [id],
      'only the chat that was spoken to is remembered',
    )
  } finally {
    await first.dispose()
  }

  const second = withState()
  await second.start()
  const tapeB = record(second)
  try {
    assert.equal(second.info.capabilities.listHistory, true)
    const listed = await second.listSessions()
    const row = listed.data.find((entry) => String(entry.id) === id)
    assert.ok(row, 'the conversation is listed by a fresh process')
    // Cursor has not named this chat — its CLI never does — so it carries
    // no title here either, and what the user asked is the preview.
    assert.equal(row.title, null, 'a name is Cursor’s to write, not this bridge’s')
    assert.match(row.preview ?? '', /remember this cursor chat/)

    // Loading opens it empty — Cursor keeps the transcript — but the chat
    // continues: the next prompt resumes the same chat id.
    const resumed = await second.resumeSession(row.id)
    await resumed.send([{ type: 'text', text: 'still there?' }])
    const completed = await tapeB.until((event) => event.type === 'turn/completed')
    assert.equal(
      (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn.status,
      'completed',
    )
  } finally {
    await second.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a title is the first line the user wrote, not the context block prepended for the model', () => {
  assert.equal(titleOf('Fix the bug\nmore detail'), 'Fix the bug')
  assert.equal(
    titleOf('<context source="Handed off from Claude Code — “x”">\n## Goal\nstuff\n</context>\n\nAdd a New game button'),
    'Add a New game button',
  )
  assert.equal(titleOf('<context source="x">only context</context>'), 'x')
})

test('a message that is only a context block is named by what the block says it is, never by its markup', () => {
  // #47: with nothing of the user's left, the title fell back to the raw envelope.
  assert.equal(
    titleOf('<context source="Handed off from Claude Code — “x”">\n## Goal\nstuff\n</context>'),
    'Handed off from Claude Code — “x”',
  )
  assert.equal(titleOf("<context source='single'>x</context>"), 'single')
  assert.equal(titleOf('<context>only context</context>'), '')
})

test('the model list ages out, so a long-lived bridge sees models Cursor adds later', async () => {
  // TTL 0: every session/new re-asks; the extra-models file is what Cursor
  // "added" between the two asks.
  const extra = join(tempDir('cursor-acp-extra-'), 'models.txt')
  const runtime = new AcpRuntime({
    id: 'cursor',
    name: 'Cursor Agent',
    command: process.execPath,
    args: [BRIDGE],
    env: {
      CURSOR_ACP_COMMAND: FAKE,
      CURSOR_ACP_STATE_DIR: STATE,
      CURSOR_ACP_MODELS_TTL_MS: '0',
      FAKE_CURSOR_EXTRA_MODELS: extra,
    },
  })
  await runtime.start()
  try {
    const first = await runtime.createSession({ cwd: WORKDIR })
    const before = first.options().find((option) => option.id === 'model')
    assert.ok(before?.type === 'select' && !before.choices.some((c) => c.value === 'later-1'))
    writeFileSync(extra, 'later-1 - Later Model\n')
    const second = await runtime.createSession({ cwd: WORKDIR })
    const after = second.options().find((option) => option.id === 'model')
    assert.ok(after?.type === 'select' && after.choices.some((c) => c.value === 'later-1'), 'the new family is offered')
  } finally {
    await runtime.dispose()
  }
})

/**
 * The window in a label is not the family's name. Cursor's flat catalogue
 * labels a slug with a context figure — "Claude Opus 4.6 1M" — which is per
 * variant, pinned by the slug, and not what runs (a "1M" label resolved to
 * 200K on the wire). Cursor's own picker leaves it off. Shown, the picker read
 * a wide window beside a Max mode switch that was off.
 */
test('a family is named without the window its flat labels carry', async () => {
  const extra = join(tempDir('cursor-acp-window-'), 'models.txt')
  writeFileSync(
    extra,
    'orb-2-high - Orb 2 1M\norb-2-high-thinking - Orb 2 1M Thinking\norb-2-low - Orb 2 1M Low\n' +
      'spark-3 - Spark 3 200K\nzed-4k-high - Zed-4K High\n',
  )
  const runtime = new AcpRuntime({
    id: 'cursor',
    name: 'Cursor Agent',
    command: process.execPath,
    args: [BRIDGE],
    env: { CURSOR_ACP_COMMAND: FAKE, CURSOR_ACP_STATE_DIR: STATE, FAKE_CURSOR_EXTRA_MODELS: extra },
  })
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    const model = session.options().find((option) => option.id === 'model')
    assert.ok(model && model.type === 'select')
    const named = Object.fromEntries(model.choices.map((choice) => [choice.value, choice.label]))
    assert.equal(named['orb-2'], 'Orb 2', 'the window and the dimensions both come off')
    assert.equal(named['spark-3'], 'Spark 3', 'a K window too')
    assert.equal(named['brain-9'], 'Brain 9', 'and a label without one is untouched')
    assert.equal(named['zed-4k'], 'Zed-4K', 'a figure that is part of the name is not a window')
  } finally {
    await runtime.dispose()
  }
})

/**
 * An id nobody has a record of is answered as JSON-RPC `-32602`, the params
 * naming nothing — the same answer the Claude bridge gives — rather than as
 * the `-32603` internal error every other thrown reason becomes. The host
 * reads that code to tell "the agent disowned this conversation" from "the
 * agent could not, right now".
 *
 * Only when the client names no folder, and so on the wire rather than
 * through the adapter, which always names one: given a folder the bridge
 * opens the chat and lets `--resume` decide on the first turn, because a
 * chat that never took a turn has no folder in Cursor's store and cannot
 * be told from an unknown id here.
 */
test('a conversation Cursor has no record of is refused as an unknown id, not an internal error', async () => {
  const child = spawn(process.execPath, [BRIDGE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CURSOR_ACP_COMMAND: FAKE, CURSOR_ACP_STATE_DIR: STATE, CURSOR_CONFIG_DIR: CURSOR_HOME },
  })
  const answers = new Map<number, (message: Record<string, unknown>) => void>()
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return
    const message = JSON.parse(line) as Record<string, unknown>
    if (typeof message['id'] === 'number') answers.get(message['id'])?.(message)
  })
  const ask = (id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      answers.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  try {
    await ask(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
    const refused = await ask(2, 'session/load', { sessionId: 'no-such-chat' })
    const error = refused['error'] as { code?: unknown; message?: unknown } | undefined
    assert.ok(error, 'the load is refused')
    assert.equal(error.code, -32602, 'the params name nothing')
    assert.match(String(error.message), /no record of session no-such-chat/)
  } finally {
    child.stdin.end()
    child.kill('SIGTERM')
  }
})

test('the turn\'s tokens reach the client; the context fill stays unknown, as Cursor does not report it', async () => {
  const runtime = make()
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await session.send([{ type: 'text', text: 'count me' }])
    await tape.until((event) => event.type === 'turn/completed')
    const usage = (await runtime.readSession(session.id)).usage
    assert.ok(usage, 'result.usage became the session usage')
    assert.equal(usage.last.inputTokens, 1200)
    assert.equal(usage.last.outputTokens, 80)
    assert.equal(usage.total.totalTokens, 1280)
    // The cache split the CLI reports since 2026.08.31, in ACP's slots for it.
    assert.equal(usage.last.cachedInputTokens, 900, 'cacheReadTokens is the cached share of the input')
    assert.equal(usage.last.cacheWriteTokens, 100, 'cacheWriteTokens travels as the write half')
    assert.equal(usage.contextUsed ?? null, null, 'no window size, no fill — never a guess')
    assert.equal(usage.contextWindow ?? null, null)

    await session.send([{ type: 'text', text: 'again' }])
    await tape.until((event) => event.type === 'turn/completed' && tape.events.indexOf(event) > 0 && tape.events.filter((e) => e.type === 'turn/completed').length === 2)
    const again = (await runtime.readSession(session.id)).usage
    assert.equal(again?.total.totalTokens, 2560, 'turns accumulate')
    assert.equal(again?.last.totalTokens, 1280)
  } finally {
    await runtime.dispose()
  }
})

/**
 * A workspace's chats as Cursor records them, including the ones this
 * bridge never ran. `hasConversation` is Cursor's own record of whether
 * anyone has spoken: `create-chat` mints ids for options probes and
 * abandoned drafts too, and those must not fill the list.
 */
test('Cursor’s store lists the workspace’s chats, newest first, and skips the ones nobody spoke to', () => {
  const home = tempDir('cursor-store-')
  const cwd = '/tmp/some-workspace'
  writeChat(home, cwd, 'named-in-the-ide', {
    title: 'Payment Retry Audit',
    updatedAtMs: 3_000,
    messages: [{ role: 'user', text: '<user_query>\nlook at the retry path\n</user_query>' }],
  })
  writeChat(home, cwd, 'made-by-the-cli', {
    updatedAtMs: 9_000,
    messages: [{ role: 'user', text: '<user_query>\nadd a health check\n</user_query>' }],
  })
  writeChat(home, cwd, 'never-spoken-to', { updatedAtMs: 10_000, hasConversation: false })

  const chats = readWorkspaceChats(cwd, home)
  assert.deepEqual(
    chats.map((chat) => [chat.chatId, chat.title]),
    [
      ['made-by-the-cli', null],
      ['named-in-the-ide', 'Payment Retry Audit'],
    ],
  )
  assert.equal(readWorkspaceChats('/tmp/a-workspace-cursor-never-saw', home).length, 0)
})

/**
 * The opening ask of a chat this bridge never ran. Without it an unnamed
 * chat — every chat Cursor's own CLI creates — is a row reading "Untitled
 * session", which is true and useless.
 */
test('the ask a chat opened with is read from Cursor’s transcript, past the context it injects', () => {
  const home = tempDir('cursor-store-')
  const cwd = '/tmp/preview-workspace'
  writeChat(home, cwd, 'chat-1', {
    messages: [
      { role: 'system', text: 'You are an AI coding assistant.' },
      { role: 'user', text: '<user_info>\nOS Version: darwin\n</user_info>' },
      { role: 'user', text: '<timestamp>now</timestamp>\n<user_query>\nrename the exports in app.js\n</user_query>' },
      { role: 'assistant', text: 'Done.' },
    ],
  })
  assert.equal(readChatPreview('chat-1', cwd, home), 'rename the exports in app.js')

  // A context block HarnessDesk prepended is for the model, not a description.
  writeChat(home, cwd, 'chat-2', {
    messages: [
      { role: 'user', text: '<user_query>\n<context source="Handed off">\ngoal\n</context>\n\nfinish the migration\n</user_query>' },
    ],
  })
  assert.equal(readChatPreview('chat-2', cwd, home), 'finish the migration')

  // A schema this reader was not written against is left alone: the row
  // keeps whatever else is known about it rather than a guess.
  writeChat(home, cwd, 'chat-3', {
    schemaVersion: 2,
    messages: [{ role: 'user', text: '<user_query>\nfrom the future\n</user_query>' }],
  })
  assert.equal(readChatPreview('chat-3', cwd, home), null)
  assert.equal(readChatPreview('no-such-chat', cwd, home), null)
})

/**
 * The point of all of it: a conversation the user started in Cursor — its
 * IDE or its CLI — is listed here under Cursor's own name, and can be
 * carried on from here. Nothing about it was ever in this bridge's index.
 */
test('a chat started in Cursor is listed under Cursor’s name and resumes from here', async () => {
  const home = tempDir('cursor-home-')
  const state = tempDir('cursor-acp-idx-')
  const cwd = tempDir('cursor-elsewhere-')
  writeChat(home, cwd, 'a-chat-from-cursor', {
    title: 'Retry Path Audit',
    updatedAtMs: Date.parse('2026-08-23T10:00:00.000Z'),
    messages: [
      { role: 'user', text: '<user_info>\nOS Version: darwin\n</user_info>' },
      { role: 'user', text: '<user_query>\nwhy does the retry loop give up early?\n</user_query>' },
    ],
  })
  writeChat(home, cwd, 'an-empty-draft', { hasConversation: false, updatedAtMs: Date.now() })

  const runtime = new AcpRuntime({
    id: 'cursor',
    name: 'Cursor Agent',
    command: process.execPath,
    args: [BRIDGE],
    env: { CURSOR_ACP_COMMAND: FAKE, CURSOR_ACP_STATE_DIR: state, HOME: home },
  })
  await runtime.start()
  const tape = record(runtime)
  try {
    // The bridge learns the workspace from the session the client opened in
    // it; the chat itself it has never seen.
    const opened = await runtime.createSession({ cwd })
    const listed = await runtime.listSessions()
    const row = listed.data.find((entry) => String(entry.id).endsWith('a-chat-from-cursor'))
    assert.ok(row, 'a chat only Cursor knows about is listed')
    assert.equal(row.title, 'Retry Path Audit', 'Cursor’s own name, unchanged')
    assert.equal(row.preview, 'why does the retry loop give up early?')
    assert.equal(row.cwd, cwd)
    assert.equal(
      listed.data.some((entry) => String(entry.id).endsWith('an-empty-draft')),
      false,
      'a chat nobody spoke to is not a conversation',
    )

    // And it carries on: the id is Cursor's, and `--resume` takes it.
    const resumed = await runtime.resumeSession(row.id)
    // Open, it still reads as itself: nothing is replayed into this process,
    // so the ask it opened with has to come from Cursor's own record.
    const open = (await runtime.listSessions()).data.find((entry) => entry.id === row.id)
    assert.equal(open?.preview, 'why does the retry loop give up early?')
    await resumed.send([{ type: 'text', text: 'carry on' }])
    const completed = await tape.until((event) => event.type === 'turn/completed')
    assert.equal(
      (completed as Extract<AgentEvent, { type: 'turn/completed' }>).turn.status,
      'completed',
    )
  } finally {
    await runtime.dispose()
  }
})

test('Max mode is offered once Cursor has named the model\'s windows', async () => {
  // Cursor's Max mode is a wider context window, and the only way to ask for
  // one is the parameterised selection the CLI keeps in its config — a flat
  // `--model` slug pins the window it was minted with. So the switch can only
  // be offered for a model the CLI has already written parameters for.
  const home = tempDir('cursor-acp-home-')
  const runtime = new AcpRuntime({
    id: 'cursor',
    name: 'Cursor Agent',
    command: process.execPath,
    args: [BRIDGE],
    env: {
      CURSOR_ACP_COMMAND: FAKE,
      CURSOR_ACP_STATE_DIR: tempDir('cursor-acp-idx-'),
      CURSOR_CONFIG_DIR: home,
    },
  })
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await session.setOption('model', 'brain-9')
    const unknown = session.options().find((option) => option.id === 'max-mode')
    assert.ok(unknown, 'the switch is always declared')
    assert.match(unknown.disabled ?? '', /Send one message/, 'and says how to make it available')

    // What an ordinary turn teaches: the CLI writes the parameterised form of
    // whatever slug it was given, windows and all.
    writeFileSync(
      join(home, 'cli-config.json'),
      JSON.stringify({
        modelParameters: {
          'brain-9': [
            { id: 'thinking', value: 'true' },
            { id: 'context', value: '200k' },
            { id: 'effort', value: 'high' },
          ],
          'fast-1': [{ id: 'effort', value: 'high' }],
        },
      }),
    )
    const again = await runtime.createSession({ cwd: WORKDIR })
    await again.setOption('model', 'brain-9')
    const offered = again.options().find((option) => option.id === 'max-mode')
    assert.equal(offered?.disabled, undefined, 'a model with a context window can be widened')
    await again.setOption('max-mode', true)
    assert.equal(again.options().find((option) => option.id === 'max-mode')?.currentValue, true)

    // A model whose parameters carry no context has no wider window to reach.
    await again.setOption('model', 'fast-1')
    const flat = again.options().find((option) => option.id === 'max-mode')
    assert.match(flat?.disabled ?? '', /one context window/)
  } finally {
    await runtime.dispose()
  }
})

/**
 * A short reply arrives once.
 *
 * The CLI re-sends a message's complete text as one more `assistant` event —
 * mid-turn before a tool call (with a `timestamp_ms`) and again at the very end
 * (without one). Equalling everything accumulated since the last boundary is
 * what identifies that repeat, and it is the whole of what identifies it.
 *
 * This used to additionally require sixteen characters, on the theory that a
 * short repeat was more likely a stutter than a boundary. The theory cost
 * correctness on every short answer: "pong" reached the transcript, the room's
 * channel and the audit as "pongpong". Confirmed against the real binary before
 * this was changed — `pong` doubled, `acknowledged and standing by` did not.
 */
test('a reply shorter than the old length floor is not doubled', async () => {
  const runtime = new AcpRuntime({
    id: 'cursor',
    name: 'Cursor Agent',
    command: process.execPath,
    args: [BRIDGE],
    env: { CURSOR_ACP_COMMAND: FAKE, CURSOR_ACP_STATE_DIR: STATE, CURSOR_CONFIG_DIR: CURSOR_HOME },
  })
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    assert.ok(session)
    await session.send([{ type: 'text', text: 'be terse' }])
    const turn = completedTurn(await tape.until((event) => event.type === 'turn/completed'))
    const messages = turn.items.filter(
      (item): item is Extract<AgentItem, { type: 'assistantMessage' }> => item.type === 'assistantMessage',
    )
    assert.equal(messages.length, 1, `one message, not one per repeat: ${JSON.stringify(messages)}`)
    assert.equal(messages[0]?.text, 'pong')
  } finally {
    await runtime.dispose()
  }
})

/*
 * Forty members handed a page each spawned forty CLIs inside two seconds,
 * and seventeen died on the spot: each boots by fetching the model
 * catalogue, the burst had some of those fetches fail, and the CLI checked
 * `--model` against an empty list and refused — before any stream-json. The
 * bridge now lets a few boot at a time and starts a turn again when its
 * process dies before its first word for a reason that reads as the
 * network's. The fake plays both: `flaky-start` dies twice that way and then
 * boots; `hold-start` says nothing until a file appears.
 */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const spawnsIn = (log: string): string[] =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []

test('a CLI that dies before its first word is started again, and the turn completes', async () => {
  const counter = join(tempDir('cursor-acp-flaky-'), 'count')
  const runtime = new AcpRuntime({
    id: 'cursor',
    name: 'Cursor Agent',
    command: process.execPath,
    args: [BRIDGE],
    env: { CURSOR_ACP_COMMAND: FAKE, CURSOR_ACP_STATE_DIR: STATE, CURSOR_CONFIG_DIR: CURSOR_HOME, FAKE_CURSOR_FLAKY_COUNTER: counter, CURSOR_ACP_START_RETRY_MS: '100' },
  })
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await session.send([{ type: 'text', text: 'flaky-start: say hello' }])
    const turn = completedTurn(await tape.until((event) => event.type === 'turn/completed'))
    assert.equal(turn.status, 'completed', turn.error?.message)
    assert.equal(readFileSync(counter, 'utf8'), '3', 'two deaths, then the boot that answered')
  } finally {
    await runtime.dispose()
  }
})

test('a refusal that names the models the account offers is the account\'s answer, and is not retried', async () => {
  const log = join(tempDir('cursor-acp-named-'), 'spawns')
  const runtime = new AcpRuntime({
    id: 'cursor',
    name: 'Cursor Agent',
    command: process.execPath,
    args: [BRIDGE],
    env: { CURSOR_ACP_COMMAND: FAKE, CURSOR_ACP_STATE_DIR: STATE, CURSOR_CONFIG_DIR: CURSOR_HOME, FAKE_CURSOR_SPAWN_LOG: log },
  })
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await session.send([{ type: 'text', text: 'named-refusal' }])
    const turn = completedTurn(await tape.until((event) => event.type === 'turn/completed'))
    assert.equal(turn.status, 'failed')
    assert.match(turn.error?.message ?? '', /Available models: auto, brain-9-high/)
    assert.equal(spawnsIn(log).length, 1, 'a named refusal is final')
  } finally {
    await runtime.dispose()
  }
})

test('only a few cursor-agents boot at once; the rest wait for a seat', async () => {
  const dir = tempDir('cursor-acp-gate-')
  const hold = join(dir, 'go')
  const log = join(dir, 'spawns')
  const runtime = new AcpRuntime({
    id: 'cursor',
    name: 'Cursor Agent',
    command: process.execPath,
    args: [BRIDGE],
    env: {
      CURSOR_ACP_COMMAND: FAKE,
      CURSOR_ACP_STATE_DIR: STATE,
      CURSOR_CONFIG_DIR: CURSOR_HOME,
      CURSOR_ACP_START_LIMIT: '1',
      FAKE_CURSOR_HOLD_FILE: hold,
      FAKE_CURSOR_SPAWN_LOG: log,
    },
  })
  await runtime.start()
  const tape = record(runtime)
  try {
    const first = await runtime.createSession({ cwd: WORKDIR })
    const second = await runtime.createSession({ cwd: WORKDIR })
    await first.send([{ type: 'text', text: 'hold-start one' }])
    await second.send([{ type: 'text', text: 'hold-start two' }])
    await pause(1200)
    assert.equal(spawnsIn(log).length, 1, 'the second waits while the first is still booting')
    writeFileSync(hold, 'go')
    // Distinct sessions, not evaluations: the predicate runs once per poll
    // over the same tape, so a counter would fire on one turn read twice.
    const ended = new Set<string>()
    await tape.until((event) => event.type === 'turn/completed' && ended.add(String(event.sessionId)).size === 2)
    assert.equal(spawnsIn(log).length, 2, 'the seat was handed on once the first spoke')
  } finally {
    await runtime.dispose()
  }
})

/*
 * A Stop is honoured wherever the turn is — waiting for a start seat, or
 * pausing before another attempt — not only once a process exists. Both
 * intervals used to lose it: cancel returned early with no child to kill,
 * and the process started afterwards ran the prompt the user had ended.
 */
test('a Stop while a turn waits for a start seat ends it, and nothing is spawned for it', async () => {
  const dir = tempDir('cursor-acp-stop-gate-')
  const hold = join(dir, 'go')
  const log = join(dir, 'spawns')
  const runtime = new AcpRuntime({
    id: 'cursor',
    name: 'Cursor Agent',
    command: process.execPath,
    args: [BRIDGE],
    env: {
      CURSOR_ACP_COMMAND: FAKE,
      CURSOR_ACP_STATE_DIR: STATE,
      CURSOR_CONFIG_DIR: CURSOR_HOME,
      CURSOR_ACP_START_LIMIT: '1',
      FAKE_CURSOR_HOLD_FILE: hold,
      FAKE_CURSOR_SPAWN_LOG: log,
    },
  })
  await runtime.start()
  const tape = record(runtime)
  try {
    const first = await runtime.createSession({ cwd: WORKDIR })
    const second = await runtime.createSession({ cwd: WORKDIR })
    await first.send([{ type: 'text', text: 'hold-start one' }])
    await second.send([{ type: 'text', text: 'never mind' }])
    await pause(600)
    assert.equal(spawnsIn(log).length, 1, 'the second is waiting behind the first')
    const stoppedAt = Date.now()
    await second.interrupt()
    const stopped = completedTurn(
      await tape.until((event) => event.type === 'turn/completed' && String(event.sessionId) === String(second.id)),
    )
    assert.equal(stopped.status, 'interrupted')
    assert.ok(Date.now() - stoppedAt < 3000, 'the Stop was honoured at once, not when a seat came free')
    // The first finishes and hands its seat on — to nobody, because the
    // second turn is over. Nothing is spawned for it.
    writeFileSync(hold, 'go')
    await tape.until((event) => event.type === 'turn/completed' && String(event.sessionId) === String(first.id))
    await pause(400)
    assert.equal(spawnsIn(log).length, 1, 'no process was started for the stopped turn')
  } finally {
    await runtime.dispose()
  }
})

test('a Stop during the pause before another attempt ends the turn without another start', async () => {
  const dir = tempDir('cursor-acp-stop-pause-')
  const counter = join(dir, 'count')
  const runtime = new AcpRuntime({
    id: 'cursor',
    name: 'Cursor Agent',
    command: process.execPath,
    args: [BRIDGE],
    env: {
      CURSOR_ACP_COMMAND: FAKE,
      CURSOR_ACP_STATE_DIR: STATE,
      CURSOR_CONFIG_DIR: CURSOR_HOME,
      FAKE_CURSOR_FLAKY_COUNTER: counter,
      CURSOR_ACP_START_RETRY_MS: '8000',
    },
  })
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await session.send([{ type: 'text', text: 'flaky-start, then stopped' }])
    // The first process dies at once; the bridge is now pausing eight seconds.
    for (let i = 0; i < 50 && !existsSync(counter); i += 1) await pause(100)
    await pause(300)
    assert.equal(readFileSync(counter, 'utf8'), '1', 'one death so far')
    const stoppedAt = Date.now()
    await session.interrupt()
    const turn = completedTurn(await tape.until((event) => event.type === 'turn/completed'))
    assert.equal(turn.status, 'interrupted')
    assert.ok(Date.now() - stoppedAt < 3000, 'the pause was cut short')
    await pause(500)
    assert.equal(readFileSync(counter, 'utf8'), '1', 'no second attempt was started')
  } finally {
    await runtime.dispose()
  }
})

test('a scratch config that will not go into place is removed, and the turn still runs', async () => {
  // The private config directory's target is a *directory*, so the rename
  // of the scratch file into it fails; the bridge must not leave the scratch
  // beside it, and the turn goes on with the user's own settings.
  const state = tempDir('cursor-acp-scratch-')
  mkdirSync(join(state, 'cli-config', 'cli-config.json'), { recursive: true })
  const runtime = new AcpRuntime({
    id: 'cursor',
    name: 'Cursor Agent',
    command: process.execPath,
    args: [BRIDGE],
    env: { CURSOR_ACP_COMMAND: FAKE, CURSOR_ACP_STATE_DIR: state, CURSOR_CONFIG_DIR: CURSOR_HOME },
  })
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await session.send([{ type: 'text', text: 'say hello' }])
    const turn = completedTurn(await tape.until((event) => event.type === 'turn/completed'))
    assert.equal(turn.status, 'completed')
    const left = readdirSync(join(state, 'cli-config')).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(left, [], 'no scratch file survives a failed rename')
  } finally {
    await runtime.dispose()
  }
})

/**
 * The client's standing instruction rides ahead of the first prompt of an
 * opened session, and only there — but "first" means the first the agent
 * read. A spawn that died before its first word and was not retried never
 * showed it; the next prompt carries it again. A second turn after a turn
 * that ran does not.
 */
test('the briefing goes ahead of the first prompt the agent reads, and not again after that', async () => {
  const log = join(tempDir('cursor-acp-briefing-'), 'spawns')
  const runtime = new AcpRuntime({
    id: 'cursor',
    name: 'Cursor Agent',
    command: process.execPath,
    args: [BRIDGE],
    env: { CURSOR_ACP_COMMAND: FAKE, CURSOR_ACP_STATE_DIR: STATE, CURSOR_CONFIG_DIR: CURSOR_HOME, FAKE_CURSOR_SPAWN_LOG: log },
    instructions: () => 'Use the pr_create tool rather than gh.',
  })
  await runtime.start()
  const tape = record(runtime)
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    // A refusal the bridge does not retry: the agent died before reading anything.
    await session.send([{ type: 'text', text: 'named-refusal first' }])
    const refused = completedTurn(await tape.until((event) => event.type === 'turn/completed'))
    assert.notEqual(refused.status, 'completed', 'the first spawn died, as the fixture makes it')
    // One entry per spawn: the prompt has newlines of its own, so the log is
    // split where a timestamp starts a new line, not on every newline.
    const entries = (): string[] =>
      existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\n(?=\d{13} )/).map((entry) => entry.replace(/^\d{13} /, '')) : []
    const before = entries().length

    await session.send([{ type: 'text', text: 'hello for real' }])
    await tape.until((event) => event.type === 'turn/completed' && event.turn.status === 'completed')
    const prompts = entries().slice(before)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0] ?? '', /^Use the pr_create tool rather than gh\.\n\nhello for real/, 'the briefing is still ahead of the first prompt the agent reads')

    await session.send([{ type: 'text', text: 'and again' }])
    await tape.until((event) => event.type === 'turn/completed' && entries().length > before + 1)
    const again = entries().at(-1) ?? ''
    assert.doesNotMatch(again, /pr_create/, 'once read, the briefing is not repeated')
    assert.match(again, /^and again/)
  } finally {
    await runtime.dispose()
  }
})
