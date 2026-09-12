import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentItem } from '@harnessdesk/protocol'

import { toCodexToolResponse } from '../src/capabilities.js'
import { mapItem } from '../src/mapping/items.js'
import * as fixtures from './fixtures/items.js'

const map = (item: Parameters<typeof mapItem>[0]): AgentItem => mapItem(item)
type Dynamic = Extract<Parameters<typeof mapItem>[0], { type: 'dynamicToolCall' }>
const dynamic = fixtures.dynamicToolCall as Dynamic
type Mcp = Extract<Parameters<typeof mapItem>[0], { type: 'mcpToolCall' }>
const mcp = fixtures.mcpToolCall as Mcp
type Command = Extract<Parameters<typeof mapItem>[0], { type: 'commandExecution' }>
const command = fixtures.commandDone as Command
type Patch = Extract<Parameters<typeof mapItem>[0], { type: 'fileChange' }>
const patch = fixtures.fileChange as Patch
type Message = Extract<Parameters<typeof mapItem>[0], { type: 'userMessage' }>
const message = fixtures.userMessage as Message

/**
 * A delegation, which no fixture carries. Shape from
 * `codex app-server generate-ts`: every field the mapper reads, with states for
 * the one child it addresses.
 */
const collab = {
  type: 'collabAgentToolCall',
  id: 'call-collab-1',
  tool: 'spawn',
  status: 'completed',
  senderThreadId: 'thread-parent',
  receiverThreadIds: ['thread-child'],
  prompt: 'Summarise the diff.',
  model: 'gpt-5-codex',
  reasoningEffort: null,
  agentsStates: { 'thread-child': { nickname: 'Ada', role: 'reviewer', status: 'running' } },
} as unknown as Parameters<typeof mapItem>[0]

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
  /* And the reason is a result part too, not only the error. The renderer draws the error in place of the
     result, so this pins the transcript's shape rather than the frame: a regression that dropped the parts of
     a failed call would still derive the error from them and pass on `error` alone (review of #245). */
  assert.deepEqual(refused.type === 'toolCall' ? refused.result : null, [
    { type: 'text', text: 'The hook refused this call.' },
  ])
})

test('a failure that came with several text parts says all of them, in order (#245)', () => {
  const mapped = map({
    ...dynamic,
    id: 'call-dyn-4',
    status: 'failed',
    success: false,
    contentItems: [
      { type: 'inputText', text: 'The hook refused this call.' },
      { type: 'inputImage', imageUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      { type: 'inputText', text: 'Edit the hook to allow it.' },
    ],
  })
  // `failureOf` joins every text part with a newline; a reason that arrives in pieces arrives whole.
  assert.equal(
    mapped.type === 'toolCall' && mapped.error,
    'The hook refused this call.\nEdit the hook to allow it.',
  )
  // The control: the parts the error skipped are still on the result, the picture among them.
  assert.deepEqual(mapped.type === 'toolCall' ? mapped.result : null, [
    { type: 'text', text: 'The hook refused this call.' },
    { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=', mimeType: '' },
    { type: 'text', text: 'Edit the hook to allow it.' },
  ])
})

test('a contentItems that is not a list keeps what came, rather than taking the item down (#245)', () => {
  /* Measured before the guard, on the built mapper: every one of these threw `TypeError: items.map is not a
     function`. The element guard shipped with #242 runs too late to catch a container. */
  const loose = map({ ...dynamic, contentItems: 'the hook refused this call.' as never })
  assert.deepEqual(loose.type === 'toolCall' ? loose.result : null, [
    { type: 'text', text: 'the hook refused this call.' },
  ])
  const object = map({ ...dynamic, contentItems: { type: 'inputText', text: 'formatted 1 file' } as never })
  assert.deepEqual(object.type === 'toolCall' ? object.result : null, [
    { type: 'json', value: { type: 'inputText', text: 'formatted 1 file' } },
  ])
  // Not `undefined` and not `[]`: a container we can't read is neither "nothing came" nor "no parts came".
  assert.equal(loose.type === 'toolCall' && 'result' in loose, true)
  // And a failed call whose whole reason arrived as the container still says it, which is what #241 was for.
  const failed = map({
    ...dynamic,
    status: 'failed',
    success: false,
    contentItems: 'the hook refused this call.' as never,
  })
  assert.equal(failed.type === 'toolCall' && failed.error, 'the hook refused this call.')
})

/* ---------------------------------------------------------------------------
   The six containers of #272, each measured on the built mapper before it was
   changed and each answered on what its own field means downstream. The
   measurements are in the commit message; the sentence in each test names the
   answer, and the code comment beside the guard says why that answer and not
   another.
   ------------------------------------------------------------------------- */

test('an MCP result whose content is not a list keeps what came (#272)', () => {
  // Measured before: every one of these threw. `[null]` did not — `mapToolContent` already took it.
  const plain = map({ ...mcp, result: { content: 'projectPath: (not set)', structuredContent: null, _meta: null } as never })
  assert.deepEqual(plain.type === 'toolCall' ? plain.result : null, [
    { type: 'text', text: 'projectPath: (not set)' },
  ])
  const one = map({ ...mcp, result: { content: { type: 'text', text: 'one block, unwrapped' } } as never })
  assert.deepEqual(one.type === 'toolCall' ? one.result : null, [{ type: 'text', text: 'one block, unwrapped' }])
  // A result object with no `content` at all keeps the result, rather than reading `undefined.map`.
  const bare = map({ ...mcp, result: { structuredContent: null, _meta: null } as never })
  assert.deepEqual(bare.type === 'toolCall' ? bare.result : null, [
    { type: 'json', value: { structuredContent: null, _meta: null } },
  ])
  /* The two readings that were already spoken for, unchanged: `result: null` is "no result came" and
     answers with no `result` at all, and a result that reads normally still reads normally. */
  const none = map({ ...mcp, result: null })
  assert.equal(none.type === 'toolCall' && 'result' in none, false)
  /* One field up, the same collapse the comment on #272 names: `result` and `error` were read with
     truthiness, so a falsy one that had in fact arrived was answered as "nothing came". */
  const falsy = map({ ...mcp, result: 0 as never })
  assert.deepEqual(falsy.type === 'toolCall' ? falsy.result : null, [{ type: 'json', value: 0 }])
  const errored = map({ ...mcp, status: 'failed', result: null, error: 0 as never })
  assert.equal(errored.type === 'toolCall' && errored.error, 'Tool call failed')
  const normal = map(mcp)
  assert.deepEqual(normal.type === 'toolCall' ? normal.result : null, [
    { type: 'text', text: 'projectPath: (not set)' },
  ])
  // The control: the call is still the same call, whatever its result did.
  assert.equal(plain.type === 'toolCall' && plain.tool, 'session_show_defaults')
})

test('a functionCallOutput whose output is not a list is read as the one part it is (#272)', () => {
  const base = { type: 'functionCallOutput', id: 'fco-3', name: 'read_file', namespace: null } as const
  const out = (output: unknown) => map({ ...base, output } as Parameters<typeof mapItem>[0])
  // Measured before: an unwrapped part threw on `.map`, and a null element threw on `part.type`.
  const one = out({ type: 'input_text', text: 'the contents' })
  assert.deepEqual(one.type === 'toolCall' ? one.result : null, [{ type: 'text', text: 'the contents' }])
  const loose = out([null])
  assert.deepEqual(loose.type === 'toolCall' ? loose.result : null, [{ type: 'json', value: null }])
  /* This item *is* its output, so there is no "nothing came" to fall back on — but "no parts" is still
     its own answer, and the string the wire's own type allows is still a string. Both are the control. */
  const empty = out([])
  assert.deepEqual(empty.type === 'toolCall' ? empty.result : null, [])
  const text = out('the contents')
  assert.deepEqual(text.type === 'toolCall' ? text.result : null, [{ type: 'text', text: 'the contents' }])
})

test('a user message whose content is not a list still says what the person said (#272)', () => {
  // Measured before: a bare sentence threw on `.some`, and a bare string *element* was replaced by "[unknown]".
  const said = map({ ...message, content: 'Summarise the diff, then stop.' as never })
  assert.deepEqual(said.type === 'userMessage' ? said.content : null, [
    { type: 'text', text: 'Summarise the diff, then stop.' },
  ])
  const inAList = map({ ...message, content: ['Summarise the diff, then stop.'] as never })
  assert.deepEqual(inAList.type === 'userMessage' ? inAList.content : null, [
    { type: 'text', text: 'Summarise the diff, then stop.' },
  ])
  // A part that is not words at all is named, the way an input kind we do not know already is.
  const nothing = map({ ...message, content: [null] as never })
  assert.deepEqual(nothing.type === 'userMessage' ? nothing.content : null, [{ type: 'text', text: '[null]' }])
  /* `[]` stays "the message carried no parts" — what the peel itself leaves when a message was all
     envelope — so it is never the answer for a container we could not read. */
  const bare = map({ ...message, content: [] })
  assert.deepEqual(bare.type === 'userMessage' ? bare.content : null, [])
  // The control: a message that reads normally still keeps its text and its mention.
  const normal = map(message)
  assert.equal(normal.type === 'userMessage' && normal.content.length, 2)
})

test("a command's actions are a label over the command, so an unreadable parse is no parse (#272)", () => {
  // Measured before: a non-list threw, `[null]` threw, and a kind the switch did not know became `undefined`.
  const loose = map({ ...command, commandActions: 'ls -la' as never })
  assert.deepEqual(loose.type === 'command' ? loose.actions : null, [])
  /* Nothing draws this list — only its first entry, and only to title the row, which falls back to the
     command itself. So `[]` claims nothing here, and the command is the control: it is still on the item. */
  assert.equal(loose.type === 'command' && loose.command, 'ls -la')
  assert.equal(loose.type === 'command' && loose.output, 'README.md\nsrc\n')
  // An element inside a list we *can* read keeps its place, as the kind the protocol has for "not classified".
  const missed = map({ ...command, commandActions: [{ type: 'brandNewKind', command: 'rg -n todo' }] as never })
  assert.deepEqual(missed.type === 'command' ? missed.actions : null, [{ type: 'unknown', command: 'rg -n todo' }])
  const nothing = map({ ...command, commandActions: [null] as never })
  assert.deepEqual(nothing.type === 'command' ? nothing.actions : null, [{ type: 'unknown', command: '' }])
  // The control: a parse that reads normally still reads normally.
  const normal = map(command)
  assert.deepEqual(normal.type === 'command' ? normal.actions : null, [
    { type: 'listFiles', command: 'ls -la', path: '/w' },
  ])
})

test('a patch whose changes are not a list keeps the edits, rather than saying nothing changed (#272)', () => {
  // Measured before: every one of these threw, and on the load path took the session with it.
  const one = map({ ...patch, changes: { path: '/w/src/new.ts', kind: { type: 'add' }, diff: 'export const x = 1\n' } as never })
  assert.deepEqual(one.type === 'fileChange' ? one.changes : null, [
    { path: '/w/src/new.ts', kind: { type: 'add' }, diff: 'export const x = 1\n' },
  ])
  // A bare string is read as a path: a list of paths is what this degrades into, and the path is what a reader navigates by.
  const paths = map({ ...patch, changes: ['/w/src/a.ts'] as never })
  assert.deepEqual(paths.type === 'fileChange' ? paths.changes : null, [
    { path: '/w/src/a.ts', kind: { type: 'update', movePath: null }, diff: '' },
  ])
  /* A change whose fields we cannot read at all keeps what came where a patch goes, under no path: an
     empty row would say a file changed by nothing, and say it exactly as a real empty diff does. */
  const drifted = map({ ...patch, changes: [{ file: '/w/src/a.ts' }] as never })
  assert.deepEqual(drifted.type === 'fileChange' ? drifted.changes : null, [
    { path: '', kind: { type: 'update', movePath: null }, diff: '{\n "file": "/w/src/a.ts"\n}' },
  ])
  // `update` for a kind we cannot read, because it is the one of the three that claims the least.
  const kindless = map({ ...patch, changes: [{ path: '/w/src/a.ts', diff: '@@ -1 +1 @@\n' }] as never })
  assert.deepEqual(kindless.type === 'fileChange' ? kindless.changes : null, [
    { path: '/w/src/a.ts', kind: { type: 'update', movePath: null }, diff: '@@ -1 +1 @@\n' },
  ])
  // The control: `[]` is still a patch that named no file, and four changes still map as four.
  const empty = map({ ...patch, changes: [] })
  assert.deepEqual(empty.type === 'fileChange' ? empty.changes : null, [])
  const normal = map(patch)
  assert.equal(normal.type === 'fileChange' ? normal.changes.length : 0, 4)
})

test('a delegation keeps the handles it can open and drops the rest (#272)', () => {
  const spawn = (fields: Record<string, unknown>) =>
    map({ ...(collab as unknown as Record<string, unknown>), ...fields } as Parameters<typeof mapItem>[0])
  // Measured before: a non-list threw, and a null *id* did not — it reached `members` as `sessionId: null`,
  // where the renderer's `nickname ?? sessionId.slice(0, 8)` throws on it.
  const loose = spawn({ receiverThreadIds: 42 })
  assert.deepEqual(loose.type === 'subagent' ? loose.members : null, [])
  const mixed = spawn({ receiverThreadIds: [null, 'thread-child'] })
  assert.deepEqual(mixed.type === 'subagent' ? mixed.members : null, [
    { sessionId: 'thread-child', nickname: 'Ada', role: 'reviewer', state: 'running' },
  ])
  // One id that came unwrapped is still a handle that opens something, so it is kept.
  const single = spawn({ receiverThreadIds: 'thread-child' })
  assert.deepEqual(single.type === 'subagent' ? single.members : null, [
    { sessionId: 'thread-child', nickname: 'Ada', role: 'reviewer', state: 'running' },
  ])
  // Measured before: the states are "when available" on the wire, and a missing one threw on the same line.
  const stateless = spawn({ agentsStates: null })
  assert.deepEqual(stateless.type === 'subagent' ? stateless.members : null, [
    { sessionId: 'thread-child', nickname: null, role: null, state: null },
  ])
  /* The control, and the reason `[]` is not a silence here: what was asked, what it ran on and how it
     ended are the substance of the row, and they are untouched by any of this. */
  for (const mapped of [loose, mixed, single, stateless]) {
    assert.equal(mapped.type === 'subagent' && mapped.prompt, 'Summarise the diff.')
    assert.equal(mapped.type === 'subagent' && mapped.model, 'gpt-5-codex')
    assert.equal(mapped.type === 'subagent' && mapped.status, 'completed')
    assert.equal(mapped.type === 'subagent' && mapped.action, 'spawn')
  }
})

test('a contentItems that is present but falsy is a container that arrived, not "nothing came" (#272)', () => {
  /* `!items` collapsed every falsy value into the one answer reserved for `null`. Measured before: `0`,
     `false` and `''` each mapped to an item with no `result` at all — the wire's own word for "the call
     returned nothing" — while the container had in fact arrived and could not be read. */
  const zero = map({ ...dynamic, contentItems: 0 as never })
  assert.deepEqual(zero.type === 'toolCall' ? zero.result : null, [{ type: 'json', value: 0 }])
  const no = map({ ...dynamic, contentItems: false as never })
  assert.deepEqual(no.type === 'toolCall' ? no.result : null, [{ type: 'json', value: false }])
  const blank = map({ ...dynamic, contentItems: '' as never })
  assert.deepEqual(blank.type === 'toolCall' ? blank.result : null, [{ type: 'text', text: '' }])
  // The control: `null` and `undefined` are the absence they always were, and still answer with no result.
  for (const absent of [null, undefined]) {
    const none = map({ ...dynamic, contentItems: absent as never })
    assert.equal(none.type === 'toolCall' && 'result' in none, false, String(absent))
  }
})
