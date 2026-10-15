import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { sessionId, type AgentEvent } from '@harnessdesk/protocol'
import { AcpRuntime } from '../src/index.js'

const FAKE = fileURLToPath(new URL('./fixtures/tool-items-acp.mjs', import.meta.url))
const cwd = '/tmp/acp-edit-1670/workspace'
const start = (extra: Record<string, unknown> = {}) => ({
  sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Edit app.js', kind: 'edit', status: 'pending', ...extra,
})
const finish = (extra: Record<string, unknown> = {}) => ({
  sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed', ...extra,
})
const diff = (path = 'app.js') => ({ type: 'diff', path, oldText: 'return a - b\n', newText: 'return a + b\n' })

async function run(t: TestContext, updates: readonly unknown[], replay = false) {
  mkdirSync(cwd, { recursive: true })
  const runtime = new AcpRuntime({
    id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath, args: [FAKE],
    env: { TOOL_UPDATES: JSON.stringify(updates), TOOL_CWD: cwd },
  })
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  await runtime.start()
  const session = replay
    ? await runtime.resumeSession(sessionId('tool-items'), { cwd })
    : await runtime.createSession({ cwd })
  if (!replay) {
    const closed = new Promise<void>(resolve => runtime.subscribe(event => {
      if (event.type === 'turn/completed') resolve()
    }))
    await session.send([{ type: 'text', text: 'Fix the bug' }])
    await closed
  }
  const snapshot = await runtime.readSession(session.id)
  return { items: snapshot.turns.flatMap(turn => turn.items).filter(item => item.type !== 'userMessage'), events }
}

for (const replay of [false, true]) {
  test(`an ACP edit keeps its diff through a text-only completion (${replay ? 'replay' : 'live'})`, async t => {
    const { items, events } = await run(t, [
      start({ rawInput: { file_path: 'app.js', replace_all: false }, content: [diff()] }),
      finish({ content: [{ type: 'content', content: { type: 'text', text: 'File state is current in your context — no need to Read it back' } }], rawOutput: 'Updated app.js' }),
    ], replay)
    assert.equal(items.length, 1)
    const edit = items[0]
    assert.ok(edit?.type === 'fileChange')
    assert.equal(edit.status, 'completed')
    assert.deepEqual(edit.changes, [{ path: `${cwd}/app.js`, kind: { type: 'update' }, diff: '@@ -1,1 +1,1 @@\n-return a - b\n+return a + b\n' }])
    assert.ok(!JSON.stringify(edit).includes('current in your context'))
    assert.ok(!('args' in edit) && !('result' in edit))
    if (!replay) assert.ok(events.some(event => event.type === 'item/completed' && event.item.type === 'fileChange'))
  })
}

test('one multi-file call becomes one file-change item, including a creation', async t => {
  const { items } = await run(t, [start(), finish({ content: [diff(), { type: 'diff', path: '/tmp/new.txt', oldText: null, newText: 'hello\n' }] })])
  assert.equal(items.length, 1)
  const edit = items[0]
  assert.ok(edit?.type === 'fileChange')
  assert.deepEqual(edit.changes.map(change => [change.path, change.kind.type]), [[`${cwd}/app.js`, 'update'], ['/tmp/new.txt', 'add']])
  assert.equal(edit.changes[1]?.diff, 'hello\n')
})

test('late locations refine an edit and survive repeated announcements and status-only updates', async t => {
  const { items, events } = await run(t, [
    start({ title: 'Edit' }),
    finish({ status: 'in_progress', locations: [{ path: 'app.js' }, { path: 'other.js' }, { path: 'app.js' }] }),
    start({ title: 'Edit' }),
    finish({ status: 'failed' }),
  ])
  assert.equal(items.length, 1)
  const edit = items[0]
  assert.ok(edit?.type === 'fileChange')
  assert.equal(edit.status, 'failed')
  assert.deepEqual(edit.changes.map(change => change.path), [`${cwd}/app.js`, `${cwd}/other.js`])
  assert.ok(edit.changes.every(change => change.diff === ''))
  assert.ok(events.some(event => event.type === 'item/started' && event.item.type === 'fileChange' && event.item.changes.length === 2))
})

test('a running generic shell call gains its command before completion and retains output', async t => {
  const { items, events } = await run(t, [
    start({ toolCallId: 'shell', title: 'Terminal', kind: 'execute' }),
    finish({ toolCallId: 'shell', status: 'in_progress', rawInput: { command: 'node app.js' } }),
    finish({ toolCallId: 'shell', content: [{ type: 'content', content: { type: 'text', text: 'ok\n' } }] }),
  ])
  const running = events.find(event => event.type === 'item/started' && event.item.type === 'command')
  assert.ok(running?.type === 'item/started' && running.item.type === 'command')
  assert.equal(running.item.command, 'node app.js')
  assert.equal(running.item.status, 'inProgress')
  const command = items[0]
  assert.ok(command?.type === 'command')
  assert.equal(command.command, 'node app.js')
  assert.equal(command.cwd, cwd)
  assert.equal(command.output, 'ok\n')
  assert.equal(command.status, 'completed')
  assert.equal(items.length, 1)
})

test('a descriptive shell call retains its narrative title', async t => {
  const { items } = await run(t, [start({ title: 'Check the sum', kind: 'execute', rawInput: { command: 'node app.js' } }), finish()])
  assert.equal(items[0]?.type, 'toolCall')
})

test('a completion without an announcement can supply several hunks for the same file', async t => {
  const { items } = await run(t, [finish({ kind: 'edit', locations: [{ path: 'app.js', line: 2 }, { path: 'app.js', line: 8 }], content: [diff(), diff()] })])
  const edit = items[0]
  assert.ok(edit?.type === 'fileChange')
  assert.equal(edit.changes.length, 1)
  assert.equal(edit.changes[0]?.diff, '@@ -2,1 +2,1 @@\n-return a - b\n+return a + b\n@@ -8,1 +8,1 @@\n-return a - b\n+return a + b\n')
})

test('a final diff corrects an optimistic creation without inferring EOF from snippets', async t => {
  const { items } = await run(t, [
    start({ content: [{ type: 'diff', path: 'app.js', oldText: null, newText: 'after' }] }),
    finish({ content: [{ type: 'diff', path: 'app.js', oldText: 'before', newText: 'after' }] }),
    { sessionUpdate: 'tool_call_update', toolCallId: 'edit', title: 'Edited app.js' },
  ])
  const edit = items[0]
  assert.ok(edit?.type === 'fileChange')
  assert.equal(edit.status, 'completed')
  assert.deepEqual(edit.changes, [{ path: `${cwd}/app.js`, kind: { type: 'update' }, diff: '@@ -1,1 +1,1 @@\n-before\n+after\n' }])
})

for (const replay of [false, true]) {
  test(`input-only edits preserve replacement text (${replay ? 'replay' : 'live'})`, async t => {
    const { items } = await run(t, [
      start({ rawInput: { file_path: 'app.js', old_string: 'before', new_string: 'after' } }),
      finish({ rawOutput: 'model-facing reply' }),
    ], replay)
    const edit = items[0]
    assert.ok(edit?.type === 'fileChange')
    assert.equal(edit.changes[0]?.diff, '-before\n+after\n')
    assert.ok(!JSON.stringify(edit).includes('model-facing'))
  })
}

test('input-only writes preserve file content until an authoritative diff arrives', async t => {
  const { items, events } = await run(t, [
    start({ title: 'Write app.js', rawInput: { file_path: 'app.js', content: 'written\n' } }),
    finish({ content: [{ type: 'diff', path: 'app.js', oldText: 'previous\n', newText: 'written\n' }] }),
  ])
  assert.ok(events.some(event => event.type === 'item/started' && event.item.type === 'fileChange' && event.item.changes[0]?.kind.type === 'update' && event.item.changes[0]?.diff === '+written\n'))
  const edit = items[0]
  assert.ok(edit?.type === 'fileChange')
  assert.equal(edit.changes[0]?.kind.type, 'update')
  assert.equal(edit.changes[0]?.diff, '@@ -1,1 +1,1 @@\n-previous\n+written\n')
})

for (const [input, after] of [
  [{ content: 'written\n' }, 'written\n'],
  [{ content: '' }, ''],
  [{ old_string: '', new_string: 'written\n' }, 'written\n'],
  [{ old_string: 'a - b', new_string: 'a + b' }, 'return a + b\n'],
  [{ diff: '--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-return a - b\n+return a + b\n' }, 'return a + b\n'],
  [{ patch: '--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-return a - b\n+return a + b\n' }, 'return a + b\n'],
  [{ content: '--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-return a - b\n+return a + b\n' }, 'return a + b\n'],
] as const) {
  test(`input-only ${JSON.stringify(input)} preserves content without inventing an undo patch`, async t => {
    const { items } = await run(t, [start({ rawInput: { file_path: 'app.js', ...input } }), finish()])
    const edit = items[0]
    assert.ok(edit?.type === 'fileChange')
    const change = edit.changes[0]
    assert.ok(change)
    assert.equal(change.kind.type, 'update', 'input alone cannot establish file creation')
    assert.ok(!change.diff.includes('@@'), 'substring edits have no line context')
    const root = mkdtempSync('/tmp/acp-edit-1670/input-undo-')
    t.after(() => rmSync(root, { recursive: true, force: true }))
    execFileSync('git', ['init', '-q', root])
    writeFileSync(join(root, 'app.js'), after)
    const undo = spawnSync('git', ['apply', '-R', '-'], { cwd: root, input: `--- a/app.js\n+++ b/app.js\n${change.diff}` })
    assert.equal(undo.error, undefined)
    assert.notEqual(undo.status, 0, 'Undo must refuse input-only previews')
    assert.equal(readFileSync(join(root, 'app.js'), 'utf8'), after)
  })
}

for (const replay of [false, true]) {
  for (const [input, expected] of [
    [{ path: 'app.js', streamContent: 'streamed\n\ntext\n' }, '+streamed\n+\n+text\n'],
    [{ file_path: 'app.js', old_str: 'before', new_str: 'after' }, '-before\n+after\n'],
    [{ file_path: 'app.js', edits: [{ old_string: 'one', new_string: 'two' }, { old_str: 'three\n\nfour', new_str: 'five' }] }, '-one\n+two\n-three\n-\n-four\n+five\n'],
  ] as const) {
    test(`input-only dialect ${JSON.stringify(input)} survives ${replay ? 'replay' : 'live updates'}`, async t => {
      const { items } = await run(t, [start({ rawInput: input }), finish({ rawOutput: 'model-facing reply' }), finish()], replay)
      const edit = items[0]
      assert.ok(edit?.type === 'fileChange')
      assert.deepEqual(edit.changes, [{ path: `${cwd}/app.js`, kind: { type: 'update' }, diff: expected }])
      assert.ok(!JSON.stringify(edit).includes('model-facing'))
    })
  }
}

test('bridge hunk snippets without trailing newlines still support Undo', async t => {
  const { items } = await run(t, [start(), finish({
    locations: [{ path: 'app.js', line: 2 }],
    content: [{ type: 'diff', path: 'app.js', oldText: 'context\nbefore', newText: 'context\nafter' }],
  })])
  const edit = items[0]
  assert.ok(edit?.type === 'fileChange')
  const patch = edit.changes[0]?.diff
  assert.ok(patch)
  const root = mkdtempSync('/tmp/acp-edit-1670/undo-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root])
  writeFileSync(join(root, 'app.js'), 'header\ncontext\nafter\n')
  execFileSync('git', ['apply', '-R', '--check', '-'], { cwd: root, input: `--- a/app.js\n+++ b/app.js\n${patch}` })
})

for (const locationsFirst of [true, false]) {
  test(`split diff and locations retain hunk positions (${locationsFirst ? 'locations first' : 'content first'})`, async t => {
    const locations = { locations: [{ path: 'app.js', line: 50 }, { path: 'app.js', line: 80 }] }
    const content = { content: [diff(), diff()] }
    const { items } = await run(t, [
      start(locationsFirst ? locations : content),
      finish(locationsFirst ? content : locations),
      finish(),
    ])
    const edit = items[0]
    assert.ok(edit?.type === 'fileChange')
    assert.equal(edit.changes[0]?.diff, '@@ -50,1 +50,1 @@\n-return a - b\n+return a + b\n@@ -80,1 +80,1 @@\n-return a - b\n+return a + b\n')
  })
}

test('a generic shell completion preserves image results and the running command', async t => {
  const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
  const { items, events } = await run(t, [
    start({ kind: 'execute', title: 'Terminal', rawInput: { command: 'render-chart' } }),
    finish({ content: [{ type: 'content', content: image }], rawOutput: [image] }),
    finish(),
  ])
  assert.ok(events.some(event => event.type === 'item/started' && event.item.type === 'command' && event.item.command === 'render-chart'))
  const shell = items[0]
  assert.ok(shell?.type === 'toolCall')
  assert.ok(shell.result?.some(part => part.type === 'image' && part.url === 'data:image/png;base64,aGVsbG8='))
})

test('an edit with only an input path still becomes a file card without a model reply', async t => {
  const { items } = await run(t, [start({ rawInput: { file_path: 'app.js' } }), finish({ rawOutput: 'model-facing reply' })])
  assert.deepEqual(items.map(item => item.type), ['fileChange'])
  assert.ok(!JSON.stringify(items).includes('model-facing'))
})

test('malformed diff content and locations do not crash or fabricate a patch', async t => {
  const { items } = await run(t, [start({ content: [null, { type: 'diff', path: 'app.js', oldText: 2, newText: 'x' }], locations: [null, { path: 5 }] }), finish()])
  const edit = items[0]
  assert.ok(edit?.type === 'fileChange')
  assert.deepEqual(edit.changes, [])
})

for (const rawOutput of ['ok\n', [{ type: 'text', text: 'ok\n' }], { stdout: 'out\n', stderr: 'err\n', exit_code: 2 }]) {
  test(`a shell completion preserves ${typeof rawOutput === 'string' ? 'plain output' : 'output and failure code'}`, async t => {
    const { items } = await run(t, [start({ kind: 'execute', title: 'Terminal', rawInput: { command: 'node app.js' } }), finish({ rawOutput })])
    const command = items[0]
    assert.ok(command?.type === 'command')
    assert.equal(command.output, typeof rawOutput === 'string' || Array.isArray(rawOutput) ? 'ok\n' : 'out\nerr\n')
    if (typeof rawOutput !== 'string' && !Array.isArray(rawOutput)) assert.equal(command.exitCode, 2)
  })
}

test('a partially streamed shell input gains the complete command', async t => {
  const { items, events } = await run(t, [
    start({ kind: 'execute', title: 'Terminal', rawInput: { description: 'Run the script' } }),
    finish({ status: 'in_progress', rawInput: { command: 'node app.js', description: 'Run the script' } }),
    finish(),
  ])
  assert.ok(items[0]?.type === 'command')
  assert.ok(events.some(event => event.type === 'item/started' && event.item.type === 'command' && event.item.command === 'node app.js'))
})

test('an already completed tool announcement keeps its status', async t => {
  const { items } = await run(t, [start({ status: 'completed', content: [diff()] })])
  assert.ok(items[0]?.type === 'fileChange')
  assert.equal(items[0].status, 'completed')
})
