import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { scratch } from './scratch.js'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import type { AgentEvent, AgentItem, SubagentItem } from '@harnessdesk/protocol'

import { DelegationRegistry } from '../src/delegation.js'

/**
 * Delegation, both halves.
 *
 * The unit half replays the message shapes Claude Code emits when it hands
 * work to a sub-agent — a tool call, then the child's own API calls carrying
 * `parent_tool_use_id`, then the result. The end-to-end half drives the real
 * bridge and the real ACP adapter against the fake CLI, so the extension
 * channel is exercised on the wire rather than asserted about, and the thing
 * that finally comes out is a transcript item.
 */

const BRIDGE = fileURLToPath(new URL('../src/main.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
const WORKDIR = scratch('claude-acp-delegation-')

const make = (): AcpRuntime =>
  new AcpRuntime({
    id: 'claude-code',
    name: 'Claude Code',
    command: process.execPath,
    args: [BRIDGE],
    env: {
      CLAUDE_CODE_EXECUTABLE: FAKE,
      CLAUDE_ACP_STATE_DIR: scratch('claude-acp-delegation-state-'),
      CLAUDECODE: '',
    },
  })

// ------------------------------------------------------------------- the unit

const spawn = (id: string, subagentType: string, prompt: string) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: {
    model: 'parent-model',
    content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: subagentType, prompt } }],
  },
})

const childCall = (
  parent: string,
  model: string,
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  },
) => ({ type: 'assistant', parent_tool_use_id: parent, message: { model, usage } })

const finished = (id: string, isError = false) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] },
})

test('two children keep disjoint counts that sum to what the session delegated', () => {
  const registry = new DelegationRegistry(() => 1_000)
  registry.observe(spawn('toolu_a', 'Explore', 'find the config loader'))
  registry.observe(spawn('toolu_b', 'general-purpose', 'summarise it'))
  registry.observe(childCall('toolu_a', 'haiku', { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 900 }))
  registry.observe(childCall('toolu_a', 'haiku', { input_tokens: 100, output_tokens: 60, cache_read_input_tokens: 900 }))
  registry.observe(childCall('toolu_b', 'opus', { input_tokens: 200, output_tokens: 300, cache_creation_input_tokens: 1800 }))

  const [a, b] = registry.list()
  assert.equal(a?.label, 'Explore')
  assert.equal(a?.prompt, 'find the config loader')
  assert.deepEqual(a?.models, ['haiku'])
  assert.equal(a?.calls, 2)
  // 100 + 900, twice: input carries the cache halves, as it does everywhere else.
  assert.equal(a?.usage?.inputTokens, 2000)
  assert.equal(a?.usage?.cachedReadTokens, 1800)
  assert.equal(a?.usage?.cachedWriteTokens, 0)
  assert.equal(a?.usage?.outputTokens, 100)

  assert.equal(b?.label, 'general-purpose')
  assert.deepEqual(b?.models, ['opus'])
  assert.equal(b?.usage?.inputTokens, 2000)
  assert.equal(b?.usage?.cachedWriteTokens, 1800)

  // The whole point: the counts stay apart, and the sum is still available.
  const totals = registry.totals()
  assert.equal(totals?.inputTokens, 4000)
  assert.equal(totals?.outputTokens, 400)
  assert.equal(totals?.cachedReadTokens, 1800)
  assert.equal(totals?.cachedWriteTokens, 1800)
})

test('a delegation ends the way its tool result did', () => {
  const registry = new DelegationRegistry(() => 2_000)
  registry.observe(spawn('ok', 'Explore', 'look'))
  registry.observe(spawn('bad', 'Explore', 'look harder'))
  assert.deepEqual(registry.list().map((one) => one.state), ['running', 'running'])
  registry.observe(finished('ok'))
  registry.observe(finished('bad', true))
  const states = new Map(registry.list().map((one) => [one.id, one]))
  assert.equal(states.get('ok')?.state, 'completed')
  assert.equal(states.get('ok')?.endedAt, 2_000)
  assert.equal(states.get('bad')?.state, 'failed')
})

test("a child's calls that outrun its spawn are still counted against it", () => {
  // Two messages on one stream race. A spawn arriving second must fill in
  // the placeholder the calls created, not replace it and drop the tokens.
  const registry = new DelegationRegistry(() => 3_000)
  registry.observe(childCall('late', 'haiku', { input_tokens: 500, output_tokens: 20 }))
  registry.observe(spawn('late', 'Explore', 'the prompt'))
  const [one] = registry.list()
  assert.equal(one?.label, 'Explore')
  assert.equal(one?.prompt, 'the prompt')
  assert.equal(one?.usage?.inputTokens, 500)
  assert.equal(one?.calls, 1)
})

test('a placeholder output count makes the delegation say its output is a floor', () => {
  const registry = new DelegationRegistry(() => 4_000)
  registry.observe(spawn('s', 'Explore', 'go'))
  registry.observe(childCall('s', 'haiku', { input_tokens: 900, output_tokens: 1 }))
  assert.equal(registry.list()[0]?.usage?.outputExact, false, 'a message_start count is not a total')

  const honest = new DelegationRegistry(() => 4_000)
  honest.observe(spawn('s', 'Explore', 'go'))
  honest.observe(childCall('s', 'haiku', { input_tokens: 900, output_tokens: 420 }))
  assert.equal(honest.list()[0]?.usage?.outputExact, true)
})

test('a tool call that is not a delegation is not one, and a renamed one still is', () => {
  const registry = new DelegationRegistry(() => 5_000)
  registry.observe({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }] },
  })
  assert.equal(registry.list().length, 0)
  // Named something else entirely, but it carries a subagent_type — which is
  // what makes it a delegation, whatever the build decided to call the tool.
  registry.observe({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 'n1', name: 'Delegate', input: { subagent_type: 'Explore' } }] },
  })
  assert.deepEqual(registry.list().map((one) => one.label), ['Explore'])
  assert.equal(registry.observe(null), false)
  assert.equal(registry.observe({ type: 'stream_event' }), false)
})

test('a delegation with no calls has no usage at all, rather than a zeroed one', () => {
  const registry = new DelegationRegistry(() => 6_000)
  registry.observe(spawn('quiet', 'Explore', 'go'))
  assert.equal(registry.list()[0]?.usage, undefined)
  assert.equal(registry.totals(), null)
})

// ----------------------------------------------------------- through the wire

const record = (runtime: AcpRuntime) => {
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  return {
    events,
    async until<T extends AgentEvent>(
      predicate: (event: AgentEvent) => event is T,
      timeoutMs = 10_000,
    ): Promise<T> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = events.find(predicate)
        if (found) return found
        if (Date.now() > deadline) throw new Error(`timed out; saw ${events.map((event) => event.type).join(', ')}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
    /** Every sub-agent row any event has carried, newest wins. */
    subagents(): readonly SubagentItem[] {
      const byId = new Map<string, SubagentItem>()
      for (const event of events) {
        const item = (event as { item?: AgentItem }).item
        if (item?.type === 'subagent') byId.set(item.id, item)
      }
      return [...byId.values()]
    },
    async settle(
      predicate: (rows: readonly SubagentItem[]) => boolean,
      timeoutMs = 10_000,
    ): Promise<readonly SubagentItem[]> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const rows = this.subagents()
        if (predicate(rows)) return rows
        if (Date.now() > deadline) throw new Error(`timed out; last rows were ${JSON.stringify(rows)}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }
}

test('a delegation crosses the wire as a sub-agent row, not one more tool row', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const tape = record(runtime)
    const session = await runtime.createSession({ cwd: WORKDIR })
    await session.send([{ type: 'text', text: 'delegate' }])
    await tape.until(
      (event): event is Extract<AgentEvent, { type: 'turn/completed' }> =>
        event.type === 'turn/completed' && event.sessionId === session.id,
    )

    const rows = await tape.settle((found) => found.length === 2 && found.every((row) => row.status === 'completed'))
    const byName = new Map(rows.map((row) => [row.members[0]?.nickname, row]))

    const explore = byName.get('Explore')
    assert.ok(explore, `expected an Explore row; saw ${[...byName.keys()].join(', ')}`)
    assert.equal(explore.type, 'subagent')
    assert.equal(explore.prompt, 'find the config loader')
    // The child's own model, not the parent's — the fact that makes a
    // delegation not a tool row.
    assert.equal(explore.model, 'fake-haiku')
    assert.equal(explore.usage?.inputTokens, 2000)
    assert.equal(explore.usage?.cachedInputTokens, 1800)
    assert.equal(explore.usage?.cacheWriteTokens, 0)

    const summarise = byName.get('general-purpose')
    assert.ok(summarise)
    assert.equal(summarise.model, 'fake-opus')
    assert.equal(summarise.usage?.cacheWriteTokens, 1800)
    assert.equal(summarise.members[0]?.usage?.inputTokens, 2000)

    // A Claude child runs inside the parent's process, so there is nothing to
    // open and the row must not offer a link that fails after the press.
    assert.equal(explore.members[0]?.openable, false)

    // And the session's own snapshot agrees with the events — a pane opened
    // after the fact must read the same as one that watched it happen.
    const stored = await runtime.readSession(session.id)
    const items: readonly AgentItem[] = stored.turns.flatMap((turn): readonly AgentItem[] => turn.items)
    assert.equal(items.filter((item) => item.type === 'subagent').length, 2)
    assert.equal(
      items.filter((item) => item.type === 'toolCall' && item.id.includes('kid')).length,
      0,
      'the tool row was upgraded in place, not joined by a second row',
    )

    // The session's own usage carries the share the children spent.
    assert.equal(stored.usage?.delegated?.totalTokens, 4400)
  } finally {
    await runtime.dispose()
  }
})
