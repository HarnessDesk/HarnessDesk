import assert from 'node:assert/strict'
import { test } from 'node:test'
import { itemId, type AgentItem, type ItemStatus } from '@harnessdesk/protocol'
import { mergeReplayItem } from '../src/replay-item.js'

const command = { id: itemId('cmd'), type: 'command' as const, command: 'synthetic', cwd: '/', origin: 'agent' as const,
  actions: [], status: 'inProgress' as const, output: 'partial output', exitCode: null, durationMs: 10 }
const tool = { id: itemId('tool'), type: 'toolCall' as const, tool: 'Read', source: { kind: 'builtin' as const },
  status: 'inProgress' as const, args: { path: '/demo' }, result: [{ type: 'text' as const, text: 'first result' }] }

for (const status of ['completed', 'failed', 'declined'] as const) {
  test(`running commands accept terminal ${status} and lifecycle values`, () => {
    const replay = { ...command, status, exitCode: status === 'completed' ? 0 : 1, durationMs: 0, output: 'rewritten output' }
    assert.deepEqual(mergeReplayItem(command, replay), replay)
    assert.deepEqual(mergeReplayItem({ ...command, status }, command), { ...command, status })
  })
}
for (const type of ['command', 'fileChange', 'toolCall', 'webSearch', 'subagent'] as const) {
  test(`${type} uses the protocol's shared terminal statuses`, () => {
    // Only the discriminant and lifecycle vary; the merge does not interpret payloads.
    for (const status of ['completed', 'failed', 'declined'] as const) {
      const saved = { ...command, type, status } as unknown as AgentItem
      const replay = { ...saved, status: 'inProgress' as ItemStatus, output: 'extended output' }
      assert.equal(mergeReplayItem(saved, replay), saved)
    }
  })
}
test('final fields preserve omissions and rewrites independently of extensions', () => {
  const saved = { ...tool, status: 'completed' as const, error: 'saved error' }
  const replay = { ...saved, args: { path: '/changed' }, error: undefined,
    result: [...tool.result, { type: 'text' as const, text: 'second result' }] }
  assert.deepEqual(mergeReplayItem(saved, replay), { ...saved, result: replay.result })
})
test('a final tool does not take an error from a replay with a different final status', () => {
  const saved = { ...tool, status: 'completed' as const }
  const replay = { ...saved, status: 'failed' as const, result: undefined, error: 'boom' }
  assert.deepEqual(mergeReplayItem(saved, replay), saved)
})
test('a final command does not take an exit code from a replay with a different final status', () => {
  const { exitCode: _, ...fields } = command
  const saved = { ...fields, status: 'completed' as const, output: 'all good' }
  const replay = { ...saved, status: 'failed' as const, output: '', exitCode: 1 }
  assert.deepEqual(mergeReplayItem(saved, replay), saved)
})
test('a final command takes a replay exit code when the saved value is null and statuses match', () => {
  const saved = { ...command, status: 'completed' as const }
  const replay = { ...saved, exitCode: 0 }
  assert.deepEqual(mergeReplayItem(saved, replay), replay)
})
test('items without a lifecycle preserve saved strings, arrays and nested facts', () => {
  const saved: AgentItem = { id: itemId('answer'), type: 'assistantMessage', text: 'saved answer', citation: { label: 'source', href: 'https://example.com' } }
  const replay = { ...saved, text: 'saved answer extended', citation: { label: 'changed' } }
  assert.deepEqual(mergeReplayItem(saved, replay), { ...saved, text: replay.text })
  const reasoning: AgentItem = { id: itemId('thought'), type: 'reasoning', summary: ['first', 'second'], content: ['detail'] }
  assert.deepEqual(mergeReplayItem(reasoning, { ...reasoning, summary: ['first'], content: ['rewritten'] }), reasoning)
})
test('running fields keep omissions and strict prefixes but accept rewritten strings and arrays', () => {
  assert.deepEqual(mergeReplayItem(command, { ...command, output: 'partial' }), command)
  assert.deepEqual(mergeReplayItem(command, { ...command, output: undefined }), command)
  const rewrite = { ...tool, tool: 'New title', result: [{ type: 'text' as const, text: 'rewritten' }] }
  assert.deepEqual(mergeReplayItem(tool, rewrite), rewrite)
  assert.deepEqual(mergeReplayItem(tool, { ...tool, result: [] }), tool)
  const missing = { ...tool, args: {} }
  assert.deepEqual(mergeReplayItem(tool, missing), tool)
})
test('matching ids with a different item type cannot replace the saved item', () => {
  assert.equal(mergeReplayItem(command, { id: command.id, type: 'assistantMessage', text: 'unrelated' }), command)
})
