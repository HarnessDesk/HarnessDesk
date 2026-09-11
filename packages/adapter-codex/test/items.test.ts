import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentItem } from '@harnessdesk/protocol'

import { toCodexToolResponse } from '../src/capabilities.js'
import { mapItem } from '../src/mapping/items.js'
import * as fixtures from './fixtures/items.js'

const map = (item: Parameters<typeof mapItem>[0]): AgentItem => mapItem(item)
type Dynamic = Extract<Parameters<typeof mapItem>[0], { type: 'dynamicToolCall' }>
const dynamic = fixtures.dynamicToolCall as Dynamic

test('every fixture maps to an item and keeps its id', () => {
  for (const item of fixtures.allItems) {
    const mapped = map(item)
    assert.ok(mapped.type, `no type produced for ${JSON.stringify(item).slice(0, 60)}`)
    assert.equal(String(mapped.id), (item as { id: string }).id)
  }
})

test('user message content preserves text and mentions', () => {
  const mapped = map(fixtures.userMessage)
  assert.equal(mapped.type, 'userMessage')
  if (mapped.type !== 'userMessage') return
  assert.equal(mapped.content.length, 2)
  assert.deepEqual(mapped.content[0], { type: 'text', text: 'List the files here, then summarise.' })
  assert.deepEqual(mapped.content[1], { type: 'mention', name: 'README.md', path: '/w/README.md' })
})

test('assistant phase distinguishes commentary from the final answer', () => {
  const commentary = map(fixtures.agentCommentary)
  const final = map(fixtures.agentFinal)
  assert.equal(commentary.type === 'assistantMessage' && commentary.phase, 'commentary')
  assert.equal(final.type === 'assistantMessage' && final.phase, 'final')
})

test('reasoning keeps summary and detail separate', () => {
  const mapped = map(fixtures.reasoning)
  assert.equal(mapped.type, 'reasoning')
  if (mapped.type !== 'reasoning') return
  assert.equal(mapped.summary.length, 1)
  assert.equal(mapped.content.length, 1)
})

test('a running command carries no output and no exit code', () => {
  const mapped = map(fixtures.commandRunning)
  assert.equal(mapped.type, 'command')
  if (mapped.type !== 'command') return
  assert.equal(mapped.status, 'inProgress')
  assert.equal(mapped.output, undefined)
  assert.equal(mapped.exitCode, null)
  assert.equal(mapped.processId, 'pty-9')
  assert.deepEqual(mapped.actions, [{ type: 'listFiles', command: 'ls -la', path: '/w' }])
})

test('a finished command carries output, exit code, and duration', () => {
  const mapped = map(fixtures.commandDone)
  assert.equal(mapped.type === 'command' && mapped.status, 'completed')
  assert.equal(mapped.type === 'command' && mapped.output, 'README.md\nsrc\n')
  assert.equal(mapped.type === 'command' && mapped.exitCode, 0)
  assert.equal(mapped.type === 'command' && mapped.durationMs, 42)
})

test('userShell commands are attributed to the user', () => {
  const agent = map(fixtures.commandDone)
  const user = map(fixtures.userShellCommand)
  assert.equal(agent.type === 'command' && agent.origin, 'agent')
  assert.equal(user.type === 'command' && user.origin, 'user')
})

test('file changes keep every kind, including a rename target', () => {
  const mapped = map(fixtures.fileChange)
  assert.equal(mapped.type, 'fileChange')
  if (mapped.type !== 'fileChange') return
  assert.equal(mapped.changes.length, 4)
  assert.deepEqual(mapped.changes[0]?.kind, { type: 'update', movePath: null })
  assert.deepEqual(mapped.changes[1]?.kind, { type: 'add' })
  assert.deepEqual(mapped.changes[2]?.kind, { type: 'delete' })
  assert.deepEqual(mapped.changes[3]?.kind, { type: 'update', movePath: '/w/src/renamed.ts' })
  assert.equal(mapped.changes[1]?.diff, 'export const x = 1\n')
})

test('MCP tool calls carry server, plugin, and rendered result content', () => {
  const mapped = map(fixtures.mcpToolCall)
  assert.equal(mapped.type, 'toolCall')
  if (mapped.type !== 'toolCall') return
  assert.deepEqual(mapped.source, {
    kind: 'mcp',
    server: 'xcodebuildmcp',
    pluginId: 'build-ios-apps@openai-curated-remote',
  })
  assert.deepEqual(mapped.result, [{ type: 'text', text: 'projectPath: (not set)' }])
  assert.equal(mapped.error, undefined)
})

test('a failed MCP tool call surfaces its message', () => {
  const mapped = map(fixtures.mcpToolCallFailed)
  assert.equal(mapped.type === 'toolCall' && mapped.status, 'failed')
  assert.equal(mapped.type === 'toolCall' && mapped.error, 'GITHUB_PAT_TOKEN is not set')
})

test('dynamic tool calls are tagged with their namespace', () => {
  const mapped = map(fixtures.dynamicToolCall)
  assert.deepEqual(
    mapped.type === 'toolCall' ? mapped.source : null,
    { kind: 'dynamic', namespace: 'local' },
  )
})

test('a dynamic tool’s result reads as its text and its picture, not as the JSON of its parts (#205)', () => {
  // The protocol's own parts. Read as MCP content, each fell through to JSON and was drawn as that.
  const mapped = map({
    type: 'dynamicToolCall',
    id: 'call-dyn-2',
    namespace: 'reports',
    tool: 'browser_open',
    arguments: { url: 'http://reports.test/q3' },
    status: 'completed',
    contentItems: [
      { type: 'inputText', text: 'Opened: Quarterly report' },
      { type: 'inputImage', imageUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      { type: 'inputAudio', audioUrl: 'https://example.test/brief.mp3' },
    ],
    success: true,
    durationMs: 12,
  })
  assert.deepEqual(mapped.type === 'toolCall' ? mapped.result : null, [
    { type: 'text', text: 'Opened: Quarterly report' },
    { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=', mimeType: '' },
    // Nothing on the desk plays audio, so that part stays as it came, both before and after.
    { type: 'json', value: { type: 'inputAudio', audioUrl: 'https://example.test/brief.mp3' } },
  ])
  // Field by field: an expected value built out of the actual one checks only what it overrides (#242).
  assert.deepEqual(map(fixtures.dynamicToolCall), {
    id: 'call-dyn-1',
    type: 'toolCall',
    tool: 'format',
    source: { kind: 'dynamic', namespace: 'local' },
    status: 'completed',
    args: { path: '/w/src/a.ts' },
    result: [{ type: 'text', text: 'formatted 1 file' }],
    durationMs: 15,
  })
})

test('compaction and review markers keep their own item types', () => {
  assert.equal(map(fixtures.compaction).type, 'compaction')
  const review = map(fixtures.enteredReview)
  assert.equal(review.type === 'review' && review.phase, 'entered')
})

test('an unrecognised item degrades visibly instead of disappearing', () => {
  const mapped = map(fixtures.unknownFuture)
  assert.equal(mapped.type, 'toolCall')
  if (mapped.type !== 'toolCall') return
  assert.equal(mapped.tool, 'somethingCodexAddedLater')
  assert.equal(String(mapped.id), 'item-future-1')
})

test('a functionCallOutput item (0.153.0) is a finished tool row named for its tool', () => {
  const mapped = map({
    type: 'functionCallOutput',
    id: 'fco-1',
    name: 'read_file',
    namespace: null,
    output: 'the contents',
  } as Parameters<typeof mapItem>[0])
  assert.equal(mapped.type, 'toolCall')
  if (mapped.type !== 'toolCall') return
  assert.equal(mapped.tool, 'read_file')
  assert.equal(mapped.status, 'completed')
  assert.deepEqual(mapped.result, [{ type: 'text', text: 'the contents' }])
})

test('a namespaced functionCallOutput keeps its namespace, and content items map', () => {
  const mapped = map({
    type: 'functionCallOutput',
    id: 'fco-2',
    name: 'browser_open',
    namespace: 'harnessdesk',
    output: [{ type: 'input_text', text: 'opened' }],
  } as Parameters<typeof mapItem>[0])
  assert.equal(mapped.type, 'toolCall')
  if (mapped.type !== 'toolCall') return
  assert.deepEqual(mapped.source, { kind: 'dynamic', namespace: 'harnessdesk' })
  assert.deepEqual(mapped.result, [{ type: 'text', text: 'opened' }])
})

test('a failed dynamic call shows the reason it came with, and the constant only when it came with none (#241)', () => {
  const failed = (contentItems: Dynamic['contentItems']) =>
    map({ ...dynamic, id: 'call-dyn-3', status: 'failed', contentItems, success: false })
  const reason = 'HarnessDesk has no tool named format. Its plugin was reloaded or removed after this session started.'
  const said = failed([{ type: 'inputText', text: reason }])
  assert.equal(said.type === 'toolCall' && said.error, reason)
  // The control: the call is failed either way.
  assert.equal(said.type === 'toolCall' && said.status, 'failed')
  for (const nothing of [null, [], [{ type: 'inputImage', imageUrl: 'data:image/png;base64,iVBORw0KGgo=' }], [{ type: 'inputText', text: '  ' }]] as Dynamic['contentItems'][]) {
    const none = failed(nothing)
    assert.equal(none.type === 'toolCall' && none.error, 'Tool reported failure', JSON.stringify(nothing))
  }
})

test('a dynamic result with no parts is an empty result, and one with none at all has no result (#242)', () => {
  const empty = map({ ...dynamic, contentItems: [] })
  assert.deepEqual(empty.type === 'toolCall' ? empty.result : 'not a tool call', [])
  const none = map({ ...dynamic, contentItems: null })
  assert.equal(none.type === 'toolCall' && 'result' in none, false)
})

test('a part that is not an object keeps its place, rather than taking the item down (#242)', () => {
  const mapped = map({ ...dynamic, contentItems: [null, 'loose words', { type: 'inputText', text: 'formatted 1 file' }] as never })
  assert.deepEqual(mapped.type === 'toolCall' ? mapped.result : null, [
    { type: 'json', value: null },
    { type: 'text', text: 'loose words' },
    { type: 'text', text: 'formatted 1 file' },
  ])
})

test('what the desk sends Codex for a plugin tool reads back as what the tool returned (#242)', () => {
  /* Both halves live in this package and were only ever tested apart. The fixture that stood in for the reply had
     a shape Codex can't send, which is how #205 went unseen. */
  const back = (result: Parameters<typeof toCodexToolResponse>[0]) => {
    const response = toCodexToolResponse(result)
    return map({ ...dynamic, status: response.success ? 'completed' : 'failed', contentItems: response.contentItems, success: response.success })
  }
  const ok = back({ ok: true, content: [{ type: 'text', text: 'Opened: Quarterly report' }, { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' }] })
  assert.deepEqual(ok.type === 'toolCall' ? ok.result : null, [
    { type: 'text', text: 'Opened: Quarterly report' },
    { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=', mimeType: '' },
  ])
  assert.equal(ok.type === 'toolCall' && 'error' in ok, false)
  const refused = back({ ok: false, error: 'The hook refused this call.' })
  assert.equal(refused.type === 'toolCall' && refused.error, 'The hook refused this call.')
})
