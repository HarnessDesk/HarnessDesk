import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deskContextContent, wrapContext, leadMessageEnvelope, leadMessageKey, itemId, runtimeId, sessionId, turnId, approvalId, type AgentItem, type LeadChatControl, type Session } from '@harnessdesk/protocol'
import { assessApproval, buildThread, threadProjection } from '../src/phone-thread.js'

const cwd = '/Users/jane/project'
const id = 'agent:chat'
const thread = (items: AgentItem[], control?: LeadChatControl) => buildThread({
  id, session: { id: sessionId('chat'), runtime: runtimeId('agent'), cwd, status: { type: 'idle' }, createdAt: 1, updatedAt: 1, itemsLoaded: true,
    turns: [{ id: turnId('turn'), status: 'completed', items }] } as Session,
  running: false, project: 'project', pending: [], decided: [], ...(control ? { leadControl: control } : {}),
}, { home: '/Users/jane', seat: 'Agent' })
const run = (output: string): AgentItem => ({ id: itemId('run'), type: 'command', command: 'pnpm test', cwd, origin: 'agent', status: 'failed', actions: [], output, exitCode: 1 })
const change = (path: string, diff: string): AgentItem => ({ id: itemId(path), type: 'fileChange', status: 'completed', changes: [{ path, kind: { type: 'update' }, diff }] })
const work = (result: ReturnType<typeof thread>) => result.turns.find(t => t.type === 'work')!
const changes = (result: ReturnType<typeof thread>) => result.turns.find(t => t.type === 'changes')!

test('an empty title and preview fall back to the desktop first-ask rule without injected context', () => {
  const result = buildThread({
    id, session: { id: sessionId('chat'), runtime: runtimeId('agent'), title: '', preview: '', cwd,
      status: { type: 'idle' }, createdAt: 1, updatedAt: 1, itemsLoaded: true,
      turns: [{ id: turnId('turn'), status: 'completed', items: [{ id: itemId('you'), type: 'userMessage', content: [
        deskContextContent(wrapContext('Workspace', 'Private injected context')), { type: 'text', text: 'Fix the importer\nMore details' },
      ] }] }] },
    title: '', running: false, project: null, pending: [], decided: [],
  }, { home: '/Users/jane', seat: 'Agent' })
  assert.equal(result.title, 'Fix the importer')
})

test('phone user words drop desk context without a verified Lead source', () => {
  const result = thread([{ id: itemId('you'), type: 'userMessage', content: [deskContextContent(wrapContext('Workspace', 'Message for host: private injection')), { type: 'text', text: 'Fix the bug.' }] }])
  assert.deepEqual(result.turns[0], { type: 'you', id: 'you', text: 'Fix the bug.', attachments: [] })
  assert.ok(!JSON.stringify(result).includes('<context'))
})

test('verified Lead words drop unrelated injections and retain attribution', () => {
  const envelope = leadMessageEnvelope('Jane Doe', 'Run the checks.')
  const result = thread([{ id: itemId('you'), type: 'userMessage', content: [deskContextContent(envelope + '\n' + wrapContext('Workspace', 'private injection'))] }], { id, holder: 'lead', sent: [leadMessageKey(id, envelope)] })
  assert.deepEqual(result.turns[0], { type: 'you', id: 'you', text: 'Run the checks.', attachments: [], lead: { name: 'Jane Doe' } })
  assert.ok(!JSON.stringify(result).includes('<context'))
})

test('command output sends a scrubbed forty-line tail and keeps failure and exit code', () => {
  const result = thread([run(Array.from({ length: 45 }, (_, i) => `${i}: ${cwd}/src/a.ts sk-abcdefghijklmnop`).join('\n'))])
  const step = work(result).steps[0]!
  assert.equal(step.output.length, 40)
  assert.equal(step.output[0], '5: src/a.ts …')
  assert.equal(step.output.at(-1), '44: src/a.ts …')
  assert.equal(step.exitCode, 1)
  assert.equal(step.failed, true)
  assert.equal(threadProjection(result)?.truncated, true)
})

test('command output caps characters and UTF-8 bytes while keeping the tail', () => {
  const result = thread([run(Array.from({ length: 40 }, (_, i) => `${i} ${'界'.repeat(400)}`).join('\n'))])
  const output = work(result).steps[0]!.output
  assert.ok(output.length > 0)
  assert.ok(output.every(line => line.length <= 300))
  assert.ok(Buffer.byteLength(output.join('\n')) <= 8192)
  assert.match(output.at(-1)!, /^39 /)
  assert.equal(threadProjection(result)?.truncated, true)
  assert.equal(threadProjection(thread([run('done')]))?.truncated, false)
})

test('diff hunks carry old and new numbers and scrub paths and tokens', () => {
  const result = thread([change('src/a.ts', `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -8,2 +10,2 @@ ${cwd}/src/a.ts\n same\n-old\n+${cwd}/src/a.ts sk-abcdefghijklmnop\n\\ No newline at end of file\n@@ -20,0 +21,1 @@\n+new`)])
  assert.deepEqual(changes(result).files[0], { path: 'src/a.ts', added: 2, removed: 1, hunks: [
    { header: '@@ -8,2 +10,2 @@ src/a.ts', lines: [{ kind: 'context', number: 10, text: 'same' }, { kind: 'remove', number: 9, text: 'old' }, { kind: 'add', number: 11, text: 'src/a.ts …' }] },
    { header: '@@ -20,0 +21,1 @@', lines: [{ kind: 'add', number: 21, text: 'new' }] },
  ] })
  assert.equal(threadProjection(result)?.truncated, false)
})

test('diff line bounds apply across repeated file changes and across the turn without cutting totals', () => {
  const diff = (count: number) => `@@ -0,0 +1,${count} @@\n${Array.from({ length: count }, (_, i) => `+line ${i} ${'word '.repeat(90)}`).join('\n')}`
  const result = thread([change('one.ts', diff(250)), change('one.ts', diff(250)), ...['two.ts', 'three.ts', 'four.ts', 'five.ts'].map(path => change(path, diff(400)))])
  const files = changes(result).files
  assert.deepEqual(files.map(f => f.added), [500, 400, 400, 400, 400])
  assert.deepEqual(files.map(f => f.hunks.flatMap(h => h.lines).length), [400, 400, 400, 300, 0])
  assert.ok(files.every(f => f.hunks.every(h => h.lines.every(l => l.text.length <= 300))))
  assert.equal(threadProjection(result)?.truncated, true)
  assert.deepEqual(changes(thread([change('image.png', 'Binary files a/image.png and b/image.png differ'), change('missing.ts', '')])).files.map(f => f.hunks), [[], []])
})

test('phone output and diff lines preserve source indentation', () => {
  const result = thread([run('  nested output'), change('a.py', '@@ -1 +1 @@\n-    old()\n+    new()')])
  assert.equal(work(result).steps[0]!.output[0], '  nested output')
  assert.equal(changes(result).files[0]!.hunks[0]!.lines[1]!.text, '    new()')
})

test('new files expose numbered add lines including empty lines', () => {
  const result = thread([{ id: itemId('add'), type: 'fileChange', status: 'completed', changes: [{ path: 'new.py', kind: { type: 'add' }, diff: 'if ready:\n    run()\n\n' }] }])
  assert.deepEqual(changes(result).files[0], { path: 'new.py', added: 3, removed: 0, hunks: [{ header: '@@ -0,0 +1,3 @@', lines: [
    { kind: 'add', number: 1, text: 'if ready:' }, { kind: 'add', number: 2, text: '    run()' }, { kind: 'add', number: 3, text: '' },
  ] }] })
})

test('serialized phone threads stay bounded for relay transport and retain readable recent hunks', () => {
  const line = '界'.repeat(300)
  const diff = `@@ -0,0 +1,400 @@\n${Array.from({ length: 400 }, () => `+${line}`).join('\n')}`
  const initial = thread([])
  const result = buildThread({ id, running: false, project: 'project', pending: [], decided: [], session: {
    id: sessionId('chat'), runtime: runtimeId('agent'), cwd, itemsLoaded: true, status: { type: 'idle' }, createdAt: 1, updatedAt: 1,
    turns: Array.from({ length: 4 }, (_, i) => ({ id: turnId(`turn-${i}`), status: 'completed', items: Array.from({ length: 4 }, (_, j) => change(`${i}-${j}.ts`, diff)) })),
  } }, { home: null, seat: initial.agent.name })
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024)
  const recent = result.turns.find(t => t.id === 'turn-3:changes')
  assert.ok(recent?.type === 'changes' && recent.files.some(f => f.hunks.some(h => h.lines.length > 0)))
  assert.equal(threadProjection(result)?.truncated, true)
})

test('diff totals count hunk content beginning with plus or minus pairs', () => {
  const result = thread([change('signs.txt', '--- a/signs.txt\n+++ b/signs.txt\n@@ -1 +1 @@\n---old\n+++new')])
  const file = changes(result).files[0]!
  assert.equal(file.added, 1)
  assert.equal(file.removed, 1)
  assert.deepEqual(file.hunks[0]!.lines.map(line => line.text), ['--old', '++new'])
})

test('the command tail byte bound includes JSON escaping', () => {
  const result = thread([run(Array.from({ length: 40 }, () => '"'.repeat(300)).join('\n'))])
  const output = work(result).steps[0]!.output
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 8192)
  assert.ok(output.length > 0)
  assert.equal(threadProjection(result)?.truncated, true)
})

test('output and diff lines redact secret assignments and credentialed URLs', () => {
  const text = 'DATABASE_URL=postgres://u:pw@db:5432/x PASSWORD=hunter2 AWS_SECRET_ACCESS_KEY=placeholder123 Authorization: Bearer abc123'
  const result = thread([run(text), change('config.txt', `@@ -0,0 +1 @@\n+${text}`)])
  for (const shown of [work(result).steps[0]!.output[0]!, changes(result).files[0]!.hunks[0]!.lines[0]!.text]) {
    assert.ok(!/u:pw|hunter2|placeholder123|abc123/.test(shown), shown)
    assert.ok(shown.includes('PASSWORD=…'), shown)
  }
})

test('output and diff lines preserve comments, regex literals and URLs while rewriting project paths', () => {
  const lines = ['// TODO fix', 's.replace(/\\d+/g, 1)', 'https://example.com/docs/page', `${cwd}/src/a.ts`]
  const expected = [...lines.slice(0, 3), 'src/a.ts']
  const result = thread([run(lines.join('\n')), change('code.ts', `@@ -0,0 +1,4 @@\n${lines.map(line => `+${line}`).join('\n')}`)])
  assert.deepEqual(work(result).steps[0]!.output, expected)
  assert.deepEqual(changes(result).files[0]!.hunks[0]!.lines.map(line => line.text), expected)
})

test('stripped blank context lines advance both numbers but final newlines terminate', () => {
  const result = thread([change('a.txt', '@@ -10,3 +20,3 @@\n first\n\n-old\n+new\n')])
  assert.deepEqual(changes(result).files[0]!.hunks[0]!.lines, [
    { kind: 'context', number: 20, text: 'first' }, { kind: 'context', number: 21, text: '' },
    { kind: 'remove', number: 12, text: 'old' }, { kind: 'add', number: 22, text: 'new' },
  ])
  const incomplete = thread([change('b.txt', '@@ -1,2 +1,2 @@\n first\n')])
  assert.equal(changes(incomplete).files[0]!.hunks[0]!.lines.length, 1)
})

test('CRLF diff headers and body lines are normalized to LF', () => {
  const result = thread([change('a.txt', '@@ -1 +1 @@\r\n-old\r\n+new\r\n')])
  const hunk = changes(result).files[0]!.hunks[0]!
  assert.equal(hunk.header, '@@ -1 +1 @@')
  assert.deepEqual(hunk.lines.map(line => line.text), ['old', 'new'])
})

test('raw deleted content becomes bounded numbered removals with complete totals', () => {
  const content = ['first', '', ...Array.from({ length: 400 }, (_, i) => `line ${i}`)].join('\r\n') + '\r\n'
  const result = thread([{ id: itemId('delete'), type: 'fileChange', status: 'completed', changes: [{ path: 'old.txt', kind: { type: 'delete' }, diff: content }] }])
  const file = changes(result).files[0]!
  assert.deepEqual([file.added, file.removed], [0, 402])
  assert.equal(file.hunks[0]!.header, '@@ -1,402 +0,0 @@')
  assert.equal(file.hunks[0]!.lines.length, 400)
  assert.deepEqual(file.hunks[0]!.lines.slice(0, 2), [{ kind: 'remove', number: 1, text: 'first' }, { kind: 'remove', number: 2, text: '' }])
  assert.equal(file.hunks[0]!.lines.at(-1)!.number, 400)
  assert.equal(threadProjection(result)?.truncated, true)
})

test('unified deletion diffs retain their own old-file line numbers', () => {
  const result = thread([{ id: itemId('delete'), type: 'fileChange', status: 'completed', changes: [{ path: 'old.txt', kind: { type: 'delete' }, diff: '@@ -8,2 +0,0 @@\n-old\n-gone\n' }] }])
  const file = changes(result).files[0]!
  assert.deepEqual([file.added, file.removed], [0, 2])
  assert.deepEqual(file.hunks[0]!.lines.map(line => line.number), [8, 9])
})

for (const kind of ['add', 'delete'] as const) test(`raw ${kind} content containing a diff example stays whole-file content`, () => {
  const content = 'Example:\n@@ -1 +1 @@\n-old\n+new\n'
  const result = thread([{ id: itemId(kind), type: 'fileChange', status: 'completed', changes: [{ path: 'guide.md', kind: { type: kind }, diff: content }] }])
  const file = changes(result).files[0]!
  assert.deepEqual([file.added, file.removed], kind === 'add' ? [4, 0] : [0, 4])
  assert.deepEqual(file.hunks[0]!.lines.map(line => line.text), ['Example:', '@@ -1 +1 @@', '-old', '+new'])
})

test('Git deletion patch metadata is not counted or shown as removed content', () => {
  const diff = 'diff --git a/old.txt b/old.txt\ndeleted file mode 100644\nindex abc123..000000\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n'
  const result = thread([{ id: itemId('delete'), type: 'fileChange', status: 'completed', changes: [{ path: 'old.txt', kind: { type: 'delete' }, diff }] }])
  const file = changes(result).files[0]!
  assert.deepEqual([file.added, file.removed], [0, 1])
  assert.deepEqual(file.hunks[0]!.lines, [{ kind: 'remove', number: 1, text: 'old' }])
})


test('shell-wrapped command steps expose the script title used by the phone output header', () => {
  const result = thread([{ ...run('installed'), type: 'command', command: '/bin/zsh -lc "npm install left-pad"' } as AgentItem])
  const step = work(result).steps[0]!
  assert.equal(step.title, 'npm install left-pad')
  assert.equal(step.detail, undefined)
  assert.deepEqual(step.output, ['installed'])
})

test('phone approvals display the full unwrapped script without changing risk classification', () => {
  const assessment = assessApproval({ id: approvalId('shell'), sessionId: sessionId('chat'), requestedAt: 1, type: 'command',
    command: "bash -lc 'pnpm test && pnpm build'", cwd, actions: [], options: [{ id: 'allow', label: 'Allow', intent: 'approve' }] }, cwd, { home: '/Users/jane', seat: 'Agent' })!
  assert.equal(assessment.turn.command, 'pnpm test && pnpm build')
  assert.equal(assessment.readable, true)
  assert.equal(assessment.turn.highRisk, true)
})

test('a run of reasoning with nothing to read shows as one Thinking step, as the desk folds it', () => {
  const think = (name: string, summary: string[] = []): AgentItem => ({ id: itemId(name), type: 'reasoning', summary, content: [] })
  const result = thread([think('a'), think('b', ['', 'a later line']), run('ok'), think('c'), think('d', ['  ']), think('e', ['Checking the lockfile']), think('f')])
  assert.deepEqual(work(result).steps.map(step => step.title), ['Thinking', 'pnpm test', 'Thinking', 'Checking the lockfile', 'Thinking'])
})
