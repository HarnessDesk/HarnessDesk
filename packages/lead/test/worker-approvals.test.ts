import assert from 'node:assert/strict'
import test from 'node:test'
import { initialLeadState, leadCheckpoint, parseLeadCheckpoint, reduceLeadRecord, replayLeadJournal } from '../src/index.js'
import { leadWorkerApprovalKey, parseLeadAcceptanceContract } from '@harnessdesk/protocol'

const digest = 'a'.repeat(64)
const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest, goal: 'Inspect demo', project: { id: 'demo', path: '/workspace/demo' }, policyRevision: 1,
  steps: [{ id: 'first', title: 'Inspect', flow: 'lead-reviewed-result', sourceRevision: 'source-1', variables: {}, attendance: 'attended', assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' }, ceiling: 'edit' }] }], assertions: [{ id: 'diff', kind: 'diff', description: 'Changes reviewed' }], caps: { usdMicros: 500, rounds: 3 } })
const start = () => replayLeadJournal([
  { version: 1, seq: 1, type: 'policy', policy: { version: 1, revision: 1, mode: 'manage', rules: [] } },
  { version: 1, seq: 2, type: 'card', card: { version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: digest, contract } },
  { version: 1, seq: 3, type: 'card-decision', decision: { version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: digest, choice: 'approve' }, expiresAt: 200 },
])
const key = { kind: 'fileChange', path: '/workspace/demo/demo.ts' }
const save = (state = start()) => reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'worker-rule-saved', rule: { id: 'rule-1', contractDigest: digest, goalStartedSeq: state.goalStartedSeq, key, target: key.path, count: 0 } })

test('goal worker rules create, count and revoke with strict checkpoint round trip', () => {
  let state = save()
  assert.equal(state.workerApprovals.length, 1)
  state = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'worker-rule-used', id: 'rule-1', diff: 'export const demo = 2' })
  assert.equal(state.workerApprovals[0]!.count, 1)
  assert.equal(state.messages.length, 0)
  assert.equal(state.workerApprovals[0]!.entries![0]!.diff, 'export const demo = 2')
  const checkpoint = leadCheckpoint(state, 'b'.repeat(64))
  assert.deepEqual(parseLeadCheckpoint(JSON.parse(JSON.stringify(checkpoint))).state, state)
  for (const change of [(s: any) => s.workerApprovals[0].key.command = 'git push', (s: any) => s.workerApprovals[0].count = -1,
    (s: any) => s.workerApprovals[0].contractDigest = 'b'.repeat(64), (s: any) => s.workerApprovals[0].wildcard = true]) {
    const bad = structuredClone(checkpoint); change(bad.state); assert.throws(() => parseLeadCheckpoint(bad))
  }
  state = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'worker-rule-revoked', id: 'rule-1' })
  assert.deepEqual(state.workerApprovals, [])
  assert.throws(() => save(initialLeadState()))
})

test('worker rule keys are exact and reject questions, publication and authority changes', () => {
  const project = '/workspace/demo'
  for (const type of ['userInput', 'elicitation']) assert.equal(leadWorkerApprovalKey({ type } as any, project), null)
  assert.equal(leadWorkerApprovalKey({ type: 'permission', summary: 'publish', gateway: true } as any, project), null)
  assert.equal(leadWorkerApprovalKey({ type: 'permission', summary: 'mcp__harnessdesk__git_log' } as any, project), null)
  assert.deepEqual(leadWorkerApprovalKey({ type: 'permission', flowBoardTool: { server: 'harnessdesk', tool: 'get_team_status' } } as any, project), { kind: 'tool', tool: 'get_team_status' })
  const file = { type: 'fileChange', changes: [{ path: '/workspace/demo/demo.ts', kind: { type: 'update' }, diff: 'demo' }] } as any
  assert.deepEqual(leadWorkerApprovalKey(file, project), { kind: 'fileChange', path: '/workspace/demo/demo.ts' })
  for (const path of ['/workspace/else/demo.ts', '/workspace/demo/.harnessdesk/permissions.yml', '/workspace/demo/.git/config', '/workspace/demo/AGENTS.md'])
    assert.equal(leadWorkerApprovalKey({ ...file, changes: [{ ...file.changes[0], path }] }, project), null)
})

test('rules end on accepted, declined, stopped, a new goal, or a changed contract', () => {
  const state = save()
  for (const choice of ['accept', 'decline'] as const) {
    let finished = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'card', card: { version: 1, id: 'result', revision: 1, type: 'result', contractDigest: digest,
      outcome: 'reviewed', summary: 'Reviewed', assertions: [], budget: { version: 1, revision: 1, caps: contract.caps, leadUsdMicros: 0, workerUsdMicros: 0, reservedUsdMicros: 0, roundsAdmitted: 0, spend: 'known', stop: null } } })
    finished = reduceLeadRecord(finished, { version: 1, seq: finished.seq + 1, type: 'card-decision', decision: { version: 1, cardId: 'result', cardType: 'result', expectedRevision: 1, contractDigest: digest, choice }, expiresAt: null })
    assert.equal(finished.phase, choice === 'accept' ? 'accepted' : 'declined')
    assert.deepEqual(finished.workerApprovals, [])
  }
  assert.deepEqual(reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'stop' }).workerApprovals, [])
  const next = { ...contract, revision: 2, digest: 'b'.repeat(64) }
  let changed = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'card', card: { version: 1, id: 'plan', revision: 2, type: 'plan', contractDigest: next.digest, contract: next } })
  changed = reduceLeadRecord(changed, { version: 1, seq: changed.seq + 1, type: 'card-decision', decision: { version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 2, contractDigest: next.digest, choice: 'approve' }, expiresAt: 300 })
  assert.deepEqual(changed.workerApprovals, [])
})

test('a fresh goal including a scheduled repeat cannot inherit a saved rule', () => {
  let state = save()
  state = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'budget', event: { version: 1, type: 'initialize', now: 1, logicalGoalId: 'old', caps: contract.caps, freshnessMs: 1000 } })
  state = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'stop' })
  state = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'stop-effects-done', stopSeq: state.stopEffectsPending })
  state = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'new-goal', id: 'repeat-next', now: 2 })
  assert.deepEqual(state.workerApprovals, [])
  assert.equal(state.contract, null)
  assert.equal(state.budget!.logicalGoalId, 'repeat-next')
})

test('commands never receive a reusable key, even read-looking commands', () => {
  for (const command of ['pwd', 'git status', 'git status --short', 'git log', 'git diff'])
    assert.equal(leadWorkerApprovalKey({ type: 'command', command, cwd: '/workspace/demo' } as any, '/workspace/demo'), null)
})

test('the file allowlist excludes every authority and automation shape', () => {
  const refused = ['.mcp.json', '.gitattributes', '.gitmodules', '.github/workflows/demo.md', '.vscode/tasks.json', '.envrc', '.husky/demo.ts', '.agents/demo.md',
    'data.json', 'data.yaml', 'data.yml', 'config.toml', 'pnpm-lock.yaml', 'deps.lock', 'run.sh', 'run.zsh', 'package.json', 'Makefile', 'Dockerfile', 'demo.config.ts', 'postcss.config.js', 'myrc.ts',
    'AGENTS.md', 'agents.MD', 'CLAUDE.md', 'GEMINI.md', 'AGENT.md', 'copilot-instructions.md']
  for (const name of refused) {
    const path = '/workspace/demo/' + name
    assert.equal(leadWorkerApprovalKey({ type: 'fileChange', changes: [{ path, kind: { type: 'update' }, diff: 'demo' }] } as any, '/workspace/demo'), null, name)
  }
})

for (const char of ['\u200b', '\ufeff', '\u2028', '\u2029']) test(`file targets reject hidden character ${char.codePointAt(0)}`, () => {
  const path = `/workspace/demo/de${char}mo.ts`
  assert.equal(leadWorkerApprovalKey({ type: 'fileChange', changes: [{ path, kind: { type: 'update' }, diff: 'demo' }] } as any, '/workspace/demo'), null)
})

test('extra grant facts and rationale exclude all otherwise eligible approval kinds', () => {
  const approvals = [{ type: 'fileChange', changes: [{ path: '/workspace/demo/demo.ts', kind: { type: 'update' }, diff: 'demo' }] },
    { type: 'permission', summary: 'get_team_status', flowBoardTool: { server: 'harnessdesk', tool: 'get_team_status' } }]
  for (const approval of approvals) for (const scope of [{ extraGrants: [{ label: 'Network', value: 'example.com' }] }, { reason: 'Extra scope' }])
    assert.equal(leadWorkerApprovalKey({ ...approval, ...scope } as any, '/workspace/demo'), null)
})

for (const kind of ['tool', 'fileChange'] as const) test(`${kind} audit traffic leaves conversation messages intact and keeps bounded newest diffs`, () => {
  let state = start()
  for (const [role, text] of [['user', 'Keep my steering'], ['assistant', 'I will preserve it']] as const) {
    const seq = state.seq + 1
    state = reduceLeadRecord(state, { version: 1, seq, type: 'message', idempotencyKey: role === 'user' ? 'steering' : null, message: { version: 1, id: `message-${seq}`, revision: seq, role, text } })
  }
  const messages = state.messages
  const ruleKey = kind === 'tool' ? { kind, tool: 'get_team_status' } : key
  state = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'worker-rule-saved', rule: { id: 'traffic', contractDigest: digest, goalStartedSeq: state.goalStartedSeq, key: ruleKey, target: kind === 'tool' ? 'get_team_status' : key.path, count: 0 } })
  const count = kind === 'tool' ? 300 : 20
  for (let i = 1; i <= count; i++) state = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'worker-rule-used', id: 'traffic', diff: kind === 'tool' ? null : `${i}:` + 'x'.repeat(7800) })
  assert.deepEqual(state.messages, messages)
  assert.equal(state.olderMessages, 0)
  const rule = state.workerApprovals[0] as any
  assert.equal(rule.count, count)
  if (kind === 'tool') assert.equal(rule.entries, undefined)
  else {
    assert.ok(rule.entries.length > 0 && rule.entries.length <= 8)
    assert.ok(Buffer.byteLength(JSON.stringify(rule.entries)) <= 32768)
    assert.equal(rule.entries[0].number, 20)
    assert.equal(rule.entries[0].diff, '20:' + 'x'.repeat(7800))
    assert.equal(rule.entries[1].number, 19)
  }
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(state, 'b'.repeat(64))).state, state)
})

for (const name of ['demo.xml', 'demo.kts', 'demo.svg', 'CLAUDE.local.md', 'CONVENTIONS.md', 'pom.xml', 'build.gradle.kts', 'settings.gradle.kts', 'Package.swift', 'build.rs', 'build.py', 'setup.py', 'setup.cfg', 'conftest.py', 'noxfile.py', 'tasks.py', 'fabfile.py', 'manage.py', 'gulpfile.js', 'Gruntfile.js', 'jakefile.ts', 'taskfile.mjs', 'jest.setup.ts', 'vitest.setup.ts', 'demo.config.ts', 'Rakefile', 'Gemfile', 'Podfile', 'demo.gemspec', 'demo.podspec', 'CMakeLists.txt', 'meson.build', 'scripts/demo.ts', 'script/demo.ts', 'bin/demo.ts', 'hooks/demo.ts']) test(`file rules refuse automation or instruction file ${name}`, () => {
  const path = '/workspace/demo/' + name
  assert.equal(leadWorkerApprovalKey({ type: 'fileChange', changes: [{ path, kind: { type: 'update' }, diff: 'demo' }] } as any, '/workspace/demo'), null)
})
for (const path of ['src/panel.tsx', 'src/resource.ts', 'docs/guide.md']) test(`file rules allow ordinary ${path} under a dot-folder project`, () => {
  const project = '/workspace/.claude/worktrees/demo', target = `${project}/${path}`
  assert.deepEqual(leadWorkerApprovalKey({ type: 'fileChange', changes: [{ path: target, kind: { type: 'update' }, diff: 'demo' }] } as any, project), { kind: 'fileChange', path: target })
})
for (const obsolete of [{ kind: 'fileChange', path: '/workspace/demo/build.rs' }, { kind: 'command', command: 'git status', cwd: '/workspace/demo' }]) test(`obsolete ${obsolete.kind} rules are dropped on checkpoint load with a host notice`, () => {
  const checkpoint = leadCheckpoint(save(), 'b'.repeat(64)) as any
  checkpoint.state.workerApprovals[0].key = obsolete
  checkpoint.state.workerApprovals[0].target = obsolete.kind === 'fileChange' ? obsolete.path : 'git status in /workspace/demo'
  const loaded = parseLeadCheckpoint(checkpoint).state
  assert.deepEqual(loaded.workerApprovals, [])
  assert.ok(loaded.messages.some(message => message.role === 'notice' && /saved approvals.*removed/i.test(message.text)))
})

test('an acknowledged answer with a failed audit append stops automatic work and reports a host error', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const journal = await createLeadJournal({ async read() { return [] }, checkpoint() { return save() }, async append() { throw Error('fixture disk failure') } })
  let answered = false, notified = false
  journal.onChange(() => { notified = true })
  await assert.rejects(journal.useWorkerApproval('rule-1', () => true, async () => { answered = true }, '+demo'))
  assert.equal(answered, true)
  assert.equal(journal.state.phase, 'waiting-for-user')
  assert.equal(journal.state.managementReason, 'lead-worker-audit-failed')
  assert.equal(notified, true)
})

test('resume finds the last conversational message through a trailing notice', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  let state = start(), seq = state.seq + 1
  state = reduceLeadRecord(state, { version: 1, seq, type: 'message', idempotencyKey: 'person', message: { version: 1, id: `message-${seq}`, revision: seq, role: 'user', text: 'Inspect' } })
  state = { ...state, messages: [...state.messages, { version: 1, id: 'notice-host', revision: seq, role: 'notice', text: 'Host notice', approval: { ruleId: 'old', target: 'get_team_status' } }] }
  const journal = await createLeadJournal({ async read() { return [] }, checkpoint() { return state }, async append() {} })
  await journal.resume(undefined, true)
  assert.equal(journal.state.phase, 'running')
})


test('legacy journal rules are removed without losing the conversation or repeating warnings', () => {
  let state = start()
  for (let i = 0; i < 2; i++) {
    state = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'worker-rule-saved', rule: { id: `old-${i}`, contractDigest: digest, goalStartedSeq: state.goalStartedSeq, key: { kind: 'command', command: 'git status', cwd: '/workspace/demo' }, target: 'git status in /workspace/demo', count: 0 } })
    state = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'worker-rule-used', id: `old-${i}` })
  }
  assert.deepEqual(state.workerApprovals, [])
  assert.equal(state.messages.filter(message => message.role === 'notice').length, 1)
})

test('a legacy file-use record retains its exact count without inventing an unavailable diff', () => {
  const state = reduceLeadRecord(save(), { version: 1, seq: 5, type: 'worker-rule-used', id: 'rule-1' })
  assert.equal(state.workerApprovals[0]!.count, 1)
  assert.equal(state.workerApprovals[0]!.entries, undefined)
})

test('an audit preparation failure after acknowledgement also latches further automatic answers', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  let answers = 0
  const journal = await createLeadJournal({ async read() { return [] }, checkpoint() { return save() }, prepare() { throw Error('fixture full journal') }, async append() {} })
  await assert.rejects(journal.useWorkerApproval('rule-1', () => true, async () => { answers++ }, '+demo'))
  await assert.rejects(journal.useWorkerApproval('rule-1', () => true, async () => { answers++ }, '+demo'))
  assert.equal(answers, 1)
})
