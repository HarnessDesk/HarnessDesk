import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sessionId, type AgentEvent, type SubagentItem } from '@harnessdesk/protocol'
import { AcpRuntime } from '../src/index.js'

const FAKE = fileURLToPath(new URL('./fixtures/tool-items-acp.mjs', import.meta.url))
const delegationTools = {
  spawn: ['subagent', 'subagent_fork'], send: ['send_message'], wait: ['wait_agent'], cancel: ['interrupt_agent'],
}
const spawn = (args: unknown = { name: 'helper', description: 'Inspect the fixture', prompt: 'Read the fixture' }, tool = 'subagent') => ({
  sessionUpdate: 'tool_call', toolCallId: 'spawn-1', title: tool, status: 'in_progress', rawInput: args,
})
const finish = (text = 'started subagent helper') => ({
  sessionUpdate: 'tool_call_update', toolCallId: 'spawn-1', status: 'completed',
  content: [{ type: 'content', content: { type: 'text', text } }],
})

async function run(t: TestContext, updates: readonly unknown[], reason = 'end_turn', declared = true, replay = false) {
  // Deliberately unrelated to DSH's runtime id: the declaration is the switch.
  const runtime = new AcpRuntime({
    id: 'tool-peer', name: 'Tool Peer', command: process.execPath, args: [FAKE],
    env: { TOOL_UPDATES: JSON.stringify(updates), TOOL_STOP_REASON: reason, TOOL_CWD: '/tmp' },
    ...(declared ? { delegationTools } : {}),
  })
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  await runtime.start()
  const session = replay
    ? await runtime.resumeSession(sessionId('tool-items'), { cwd: '/tmp' })
    : await runtime.createSession({ cwd: '/tmp' })
  if (!replay) {
    const closed = new Promise<void>(resolve => runtime.subscribe(event => { if (event.type === 'turn/completed') resolve() }))
    await session.send([{ type: 'text', text: 'Delegate the fixture' }])
    await closed
  }
  const read = await runtime.readSession(session.id)
  return { items: read.turns.flatMap(turn => turn.items).filter(item => item.type !== 'userMessage'), events }
}

for (const tool of delegationTools.spawn) {
  test(`${tool} projects a non-openable member, running past the spawn's completion until end_turn`, async t => {
    const { items, events } = await run(t, [spawn(undefined, tool), finish()])
    assert.equal(items.length, 1)
    const item = items[0]
    assert.ok(item?.type === 'subagent')
    assert.equal(item.action, 'spawn')
    assert.equal(item.members[0]?.sessionId, 'helper')
    assert.equal(item.members[0]?.nickname, 'Inspect the fixture')
    assert.equal(item.members[0]?.openable, false)
    assert.equal(item.prompt, 'Read the fixture')
    assert.equal(item.usage, undefined)
    assert.equal(item.members[0]?.usage, undefined)
    assert.equal(item.status, 'completed')
    assert.equal(item.members[0]?.state, 'completed')
    const rows = events.filter((event): event is Extract<AgentEvent, { type: 'item/started' | 'item/completed' }> =>
      (event.type === 'item/started' || event.type === 'item/completed') && event.item.type === 'subagent')
    assert.deepEqual(rows.map(event => [event.type, (event.item as SubagentItem).status]), [
      ['item/started', 'inProgress'], ['item/started', 'inProgress'], ['item/completed', 'completed'],
    ])
  })
}

for (const [args, result, handle] of [
  [{}, 'started subagent Scout', 'Scout'],
  [{}, 'No child name was reported', 'spawn-1'],
  [{ name: 'asked' }, 'started subagent different', 'asked'],
  [{ name: '', description: 12, prompt: {} }, 'No name', 'spawn-1'],
] as const) {
  test(`member handle falls back to ${handle} (${result})`, async t => {
    const { items } = await run(t, [spawn(args), finish(result)])
    const item = items[0]
    assert.ok(item?.type === 'subagent')
    assert.equal(item.members[0]?.sessionId, handle)
    assert.equal(item.members[0]?.nickname, 'name' in args && typeof args.name === 'string' && args.name ? args.name : handle)
    assert.equal(item.members[0]?.openable, false)
  })
}

test('send, wait and cancel for a known member fold into its spawn row', async t => {
  const updates: unknown[] = [spawn(), finish()]
  for (const tool of ['send_message', 'wait_agent', 'interrupt_agent']) {
    updates.push({ sessionUpdate: 'tool_call', toolCallId: tool, title: tool, status: 'in_progress', rawInput: { agent: 'helper', prompt: 'Continue' } },
      { sessionUpdate: 'tool_call_update', toolCallId: tool, status: 'completed' })
  }
  const { items } = await run(t, updates)
  assert.equal(items.length, 1)
  assert.ok(items[0]?.type === 'subagent')
  assert.equal(items[0].prompt, 'Read the fixture')
})

test('a follow-up without a known spawn stays a tool row naming its member', async t => {
  const { items } = await run(t, [{ sessionUpdate: 'tool_call', toolCallId: 'send', title: 'send_message', status: 'completed', rawInput: { agent: 'helper' } }])
  assert.ok(items[0]?.type === 'toolCall')
  assert.match(items[0].tool, /helper/)
})

test('cancelled marks the projected member stopped, rather than completing it at spawn return', async t => {
  const { items } = await run(t, [spawn(), finish()], 'cancelled')
  assert.ok(items[0]?.type === 'subagent')
  assert.equal(items[0].status, 'failed')
  assert.equal(items[0].members[0]?.state, 'stopped')
  assert.ok(items[0].completedAt)
})

test('replayed spawn tools do not leave historical members running', async t => {
  const { items } = await run(t, [spawn(), finish()], 'end_turn', true, true)
  assert.ok(items[0]?.type === 'subagent')
  assert.equal(items[0].status, 'completed')
  assert.equal(items[0].members[0]?.state, 'completed')
})

test('every replayed turn closes its projected children before the next user message', async t => {
  const { items } = await run(t, [spawn(), finish(),
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Another request' } },
  ], 'end_turn', true, true)
  assert.ok(items[0]?.type === 'subagent')
  assert.equal(items[0].status, 'completed')
})

test('a failed prompt ends the projected row as failed', async t => {
  const { items } = await run(t, [spawn(), finish()], 'error')
  assert.ok(items[0]?.type === 'subagent')
  assert.equal(items[0].status, 'failed')
  assert.equal(items[0].members[0]?.state, 'failed')
})

test('a failed spawn does not become completed when the root ends', async t => {
  const { items } = await run(t, [spawn(), { ...finish('Could not start the helper'), status: 'failed' }])
  assert.ok(items[0]?.type === 'subagent')
  assert.equal(items[0].status, 'failed')
  assert.equal(items[0].members[0]?.state, 'failed')
  assert.ok(items[0].completedAt)
})

test('an ACP peer without a declaration keeps the ordinary tool row', async t => {
  const { items } = await run(t, [spawn(), finish()], 'end_turn', false)
  assert.ok(items[0]?.type === 'toolCall')
  assert.equal(items[0].tool, 'subagent')
  assert.equal(items[0].status, 'completed')
})
