import assert from 'node:assert/strict'
import { test } from 'node:test'
import { seatDoing, doingSentence, inFlightItem, toolCallVerb, type SeatDoing } from '../src/index.js'
import { itemId, runtimeId, sessionId, turnId } from '../src/ids.js'
import type { AgentItem } from '../src/items.js'
import type { Session } from '../src/session.js'

const tool = (name: string, args: unknown = {}): Extract<AgentItem, { type: 'toolCall' }> => ({
  id: itemId(name), type: 'toolCall', tool: name, args, status: 'inProgress', source: { kind: 'builtin' },
})
const session = (items: readonly AgentItem[], running = true): Session => ({
  id: sessionId('seat'), runtime: runtimeId('agent'), cwd: '/project', status: { type: running ? 'active' : 'idle' },
  createdAt: 100, updatedAt: 300, itemsLoaded: true,
  turns: [{ id: turnId('turn'), status: running ? 'inProgress' : 'completed', startedAt: 250, completedAt: running ? null : 300, items }],
})

// These words are the existing overview's output for the same scripted items.
const rows: readonly [AgentItem, SeatDoing, string][] = [
  [{ id: itemId('command'), type: 'command', command: 'TOKEN=value curl https://example.com', cwd: '/project', origin: 'agent', status: 'inProgress', actions: [] }, { kind: 'tool', tool: 'command' }, 'Running a command'],
  [tool('mcp__desk__exec_command', { cmd: 'TOKEN=value curl https://example.com' }), { kind: 'tool', tool: 'command' }, 'Running a command'],
  [tool('Read', { path: 'src/a.ts' }), { kind: 'tool', tool: 'read', target: 'src/a.ts' }, 'Read src/a.ts'],
  [tool('Read src/a.ts'), { kind: 'tool', tool: 'read', target: 'src/a.ts' }, 'Read src/a.ts'],
  [tool('Explain why the build failed'), { kind: 'tool', tool: 'tool' }, 'Using a tool'],
  [tool('mcp__desk__browser_open', { url: 'https://example.com', token: 'value' }), { kind: 'tool', tool: 'browser_open' }, 'Browser open'],
  [{ id: itemId('search'), type: 'webSearch', query: 'private query', status: 'inProgress' }, { kind: 'tool', tool: 'web_search' }, 'Searching the web'],
  [tool('Grep', { pattern: 'private query', path: 'src' }), { kind: 'tool', tool: 'search' }, 'Searching files'],
  [tool('Write src/a.ts'), { kind: 'tool', tool: 'Write', target: 'src/a.ts' }, 'Created src/a.ts'],
  [tool('Edit', { path: 'src/a.ts', old_string: 'old', new_string: 'new' }), { kind: 'tool', tool: 'Edit', target: 'src/a.ts' }, 'Edited src/a.ts'],
  [{ id: itemId('change'), type: 'fileChange', status: 'inProgress', changes: [{ path: 'src/a.ts', kind: { type: 'update' }, diff: '' }] }, { kind: 'tool', tool: 'edit', target: 'src/a.ts' }, 'Edited src/a.ts'],
  [tool('Read'), { kind: 'tool', tool: 'read' }, 'Reading a file'],
  [tool('Write', { path: 'https://example.com', content: 'value' }), { kind: 'tool', tool: 'Write' }, 'Editing a file'],
  [{ id: itemId('empty-change'), type: 'fileChange', status: 'inProgress', changes: [] }, { kind: 'tool', tool: 'edit' }, 'Editing files'],
]
for (const [item, doing, words] of rows) {
  test(`seat activity retains the overview words: ${words} (${item.id})`, () => {
    assert.equal(typeof seatDoing, 'function', 'protocol exposes seatDoing')
    assert.deepEqual(seatDoing(item), doing)
    assert.equal(doingSentence(seatDoing(item)), words)
  })
}
test('seat activity rejects prose, shell syntax and network paths as targets', () => {
  for (const path of ['https://example.com', '//example.com/file', '\\\\example.com\\file', 'TOKEN=value', '$TOKEN/file', 'src/a.ts echo value', 'src/line\nfile']) {
    assert.deepEqual(seatDoing(tool('Read', { path })), { kind: 'tool', tool: 'read' })
  }
})
test('wording uses the shared plugin sentence and refuses unsafe fallback sentences', () => {
  assert.equal(doingSentence(seatDoing(tool('mcp__desk__browser_open')), new Map([['browser_open', 'Open the browser']])), 'Open the browser')
  for (const words of ['Open https://example.com', 'TOKEN=value', 'Read `value`', 'Read <value>', 'Read\nvalue']) {
    assert.equal(doingSentence(seatDoing(tool('browser_open')), new Map([['browser_open', words]])), 'Using a tool')
  }
  assert.equal(doingSentence({ kind: 'thinking' }), 'Thinking')
})
test('in-flight item is the newest live action in the current live turn', () => {
  assert.equal(typeof inFlightItem, 'function', 'protocol exposes inFlightItem')
  const first = tool('Read', { path: 'src/a.ts' })
  const newest = tool('Edit', { path: 'src/b.ts' })
  const finished = { ...tool('Read'), status: 'completed' } as const
  const prose: AgentItem = { id: itemId('prose'), type: 'assistantMessage', text: 'text' }
  const data = session([first, newest, finished, prose])
  const before = JSON.stringify(data)
  assert.equal(inFlightItem(data), newest)
  assert.equal(JSON.stringify(data), before)
  assert.equal(inFlightItem(session([first], false)), undefined)
  assert.equal(inFlightItem(session([finished, prose])), undefined)
  assert.equal(inFlightItem({ ...data, turns: [] }), undefined)
})
test('classifier preserves malformed MultiEdit refusal', () => {
  assert.equal(typeof toolCallVerb, 'function', 'protocol exposes toolCallVerb')
  assert.equal(toolCallVerb(tool('MultiEdit', { path: 'src/a.ts', edits: [] })), 'toolCall')
  assert.equal(toolCallVerb(tool('MultiEdit', { path: 'src/a.ts', edits: [{ old_string: 'old' }] })), 'toolCall')
  assert.equal(toolCallVerb(tool('MultiEdit', { path: 'src/a.ts', edits: [{ old_string: 'old', new_string: 'new' }] })), 'fileChange')
})

test('generic identifiers keep their own wording when they match action verbs', () => {
  for (const name of ['Write', 'Edit', 'edit', 'tool', 'web_search', 'activity_tool_Edit', 'activity_tool_activity_tool_Edit']) {
    const sentences = new Map([[name, `Shared words for ${name}`]])
    assert.equal(doingSentence(seatDoing(tool(name)), sentences), `Shared words for ${name}`)
  }
  assert.equal(doingSentence(seatDoing(tool('Write'))), 'Write')
  assert.equal(doingSentence(seatDoing(tool('Edit'))), 'Edit')
})
