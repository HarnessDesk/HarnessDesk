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
  assert.equal(state.workerApprovals[0]!.revoked, true)
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
for (const path of ['src/panel.tsx', 'src/profile.ts', 'src/resource.ts', 'docs/guide.md']) test(`file rules allow ordinary ${path} under a dot-folder project`, () => {
  const project = '/workspace/.claude/worktrees/demo', target = `${project}/${path}`
  assert.deepEqual(leadWorkerApprovalKey({ type: 'fileChange', changes: [{ path: target, kind: { type: 'update' }, diff: 'demo' }] } as any, project), { kind: 'fileChange', path: target })
})
for (const obsolete of [{ kind: 'fileChange', path: '/workspace/demo/build.rs' }, { kind: 'command', command: 'git status', cwd: '/workspace/demo' }]) test(`obsolete ${obsolete.kind} rules lose authority on checkpoint load with a host notice`, () => {
  const checkpoint = leadCheckpoint(save(), 'b'.repeat(64)) as any
  checkpoint.state.workerApprovals[0].key = obsolete
  checkpoint.state.workerApprovals[0].target = obsolete.kind === 'fileChange' ? obsolete.path : 'git status in /workspace/demo'
  const loaded = parseLeadCheckpoint(checkpoint).state
  assert.ok(loaded.workerApprovals.every(rule => rule.revoked), 'ineligible file history is inert')
  assert.ok(loaded.messages.some(message => message.role === 'notice' && /saved approvals.*removed/i.test(message.text)))
})

test('an acknowledged answer with a failed audit append stops automatic work and reports a host error', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const journal = await createLeadJournal({ async read() { return [] }, checkpoint() { return save() }, async append(record) { if (record.type === 'worker-rule-used') throw Error('fixture disk failure') } })
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
  const journal = await createLeadJournal({ async read() { return [] }, checkpoint() { return save() }, prepare(record: any) { if (record.type === 'worker-rule-used') throw Error('fixture full journal'); return record }, async append() {} })
  await assert.rejects(journal.useWorkerApproval('rule-1', () => true, async () => { answers++ }, '+demo'))
  await assert.rejects(journal.useWorkerApproval('rule-1', () => true, async () => { answers++ }, '+demo'))
  assert.equal(answers, 1)
})

for (const name of ['src/AGENTſ.md', 'src/gulpﬁle.js', 'src/SKILL.md', 'sourcé/panel.tsx']) test(`non-ASCII relative path has no reusable key: ${name}`, () => {
  const path = '/workspace/demo/' + name
  assert.equal(leadWorkerApprovalKey({ type: 'fileChange', changes: [{ path, kind: { type: 'add' }, diff: 'demo' }] } as any, '/workspace/demo'), null)
  const checkpoint = leadCheckpoint(save(), 'b'.repeat(64)) as any
  checkpoint.state.workerApprovals[0].key.path = path; checkpoint.state.workerApprovals[0].target = path
  const loaded = parseLeadCheckpoint(checkpoint).state
  assert.ok(loaded.workerApprovals.every(rule => rule.revoked), 'ineligible file history is inert')
  assert.ok(loaded.messages.some(message => message.role === 'notice'))
})
for (const name of ['src.ts', 'proc.ts', 'arc.ts']) test(`ordinary ASCII rc-containing source remains eligible: ${name}`, () => {
  const path = '/workspace/demo/src/' + name
  assert.deepEqual(leadWorkerApprovalKey({ type: 'fileChange', changes: [{ path, kind: { type: 'update' }, diff: 'demo' }] } as any, '/workspace/demo'), { kind: 'fileChange', path })
})
for (const name of ['karma.conf.js', 'docs/conf.py', '.npmrc', '.babelrc.js', 'eslintrc.json']) test(`executed config or rc file stays ineligible: ${name}`, () => {
  const path = '/workspace/demo/' + name
  assert.equal(leadWorkerApprovalKey({ type: 'fileChange', changes: [{ path, kind: { type: 'update' }, diff: 'demo' }] } as any, '/workspace/demo'), null)
})

test('dispatch intent survives crash before acknowledgement and blocks automatic answers after replay', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const records: any[] = [], base = save()
  const journal = await createLeadJournal({ async read() { return [] }, checkpoint() { return base }, async append(record) { records.push(record) } })
  await assert.rejects(journal.useWorkerApproval('rule-1', () => true, async () => {
    assert.equal(records.at(-1)?.type, 'worker-rule-dispatch')
    throw Error('fixture crash before acknowledgement')
  }, '+unacknowledged'))
  const replayed = await createLeadJournal({ async read() { return records }, checkpoint() { return base }, async append(record) { records.push(record) } })
  assert.equal(replayed.state.phase, 'waiting-for-user')
  assert.equal(replayed.state.managementReason, 'lead-worker-audit-failed')
  let answered = false
  assert.equal(await replayed.useWorkerApproval('rule-1', () => true, async () => { answered = true }, '+next'), false)
  assert.equal(answered, false)
  await assert.rejects(replayed.resume())
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(replayed.state, 'b'.repeat(64))).state, replayed.state)
  await replayed.revokeWorkerApproval('rule-1', digest)
  await replayed.resume()
  assert.ok((replayed.state.workerApprovals[0] as any).revoked)
})

test('revoked entries survive checkpoint and become read-only until goal end', () => {
  let state = save()
  state = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'worker-rule-used', id: 'rule-1', diff: '+retained' })
  state = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'worker-rule-revoked', id: 'rule-1' })
  const rule = state.workerApprovals[0] as any
  assert.equal(rule.revoked, true); assert.equal(rule.entries[0].diff, '+retained')
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(state, 'b'.repeat(64))).state, state)
  assert.deepEqual(reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'stop' }).workerApprovals, [])
})

test('live revokes of missing or already revoked rules append nothing', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const records: any[] = []
  const journal = await createLeadJournal({ async read() { return [] }, checkpoint() { return save() }, async append(record) { records.push(record) } })
  await assert.rejects(journal.revokeWorkerApproval('missing', digest), /not.*active/i)
  assert.equal(records.length, 0)
  await journal.revokeWorkerApproval('rule-1', digest)
  await assert.rejects(journal.revokeWorkerApproval('rule-1', digest), /not.*active/i)
  assert.equal(records.length, 1)
})

test('intent persistence rechecks admission before dispatching the answer', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  let admitted = true, answers = 0
  const journal = await createLeadJournal({ async read() { return [] }, checkpoint() { return save() }, async append() { admitted = false } })
  await assert.rejects(journal.useWorkerApproval('rule-1', () => admitted, async () => { answers++ }, '+demo'))
  assert.equal(answers, 0)
})

for (const cause of ['person answered', 'worker withdrew', 'path became unsafe']) test(`a dispatch cancelled before answering restores the phase: ${cause}`, async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const base = save(), records: any[] = []
  let admitted = true, answers = 0
  const journal = await createLeadJournal({ async read() { return [] }, checkpoint() { return base }, async append(record) {
    records.push(record); if (record.type === 'worker-rule-dispatch') admitted = false
  } })
  await assert.rejects(journal.useWorkerApproval('rule-1', () => admitted, async () => { answers++ }, '+never sent'))
  assert.equal(answers, 0)
  assert.equal(records.at(-1).type, 'worker-rule-dispatch-cancelled')
  assert.equal(journal.state.workerApprovals[0]!.dispatch, undefined)
  assert.equal(journal.state.phase, base.phase)
  assert.equal(journal.state.managementReason, base.managementReason)
  const reopened = await createLeadJournal({ async read() { return records }, checkpoint() { return base }, async append() {} })
  assert.deepEqual(reopened.state, journal.state)
})

test('a responder proven not delivered cancels its dispatch and replays without a recovery fence', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const base = save(), records: any[] = []
  const journal = await createLeadJournal({ async read() { return [] }, checkpoint() { return base }, async append(record) { records.push(record) } })
  await assert.rejects(journal.useWorkerApproval('rule-1', () => true, async () => { throw Object.assign(Error('pre-dispatch failure'), { approvalNotDelivered: true }) }, '+never sent'))
  assert.equal(records.at(-1).type, 'worker-rule-dispatch-cancelled')
  assert.equal(journal.state.phase, base.phase)
  assert.equal(journal.state.workerApprovals[0]!.dispatch, undefined)
  const reopened = await createLeadJournal({ async read() { return records }, checkpoint() { return base }, async append() {} })
  assert.deepEqual(reopened.state, journal.state)
})

test('dispatch leaves live phase unchanged but an open journal and checkpoint fence its unfinished answer', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const base = save(), records: any[] = []
  const journal = await createLeadJournal({ async read() { return [] }, checkpoint() { return base }, async append(record) { records.push(record) } })
  await assert.rejects(journal.useWorkerApproval('rule-1', () => true, async () => {
    assert.equal(journal.state.phase, base.phase)
    assert.equal(journal.state.managementReason, base.managementReason)
    const loaded = parseLeadCheckpoint(leadCheckpoint(journal.state, 'b'.repeat(64))).state
    assert.equal(loaded.phase, 'waiting-for-user')
    assert.equal(loaded.managementReason, 'lead-worker-audit-failed')
    throw Error('uncertain delivery')
  }, '+uncertain'), /uncertain delivery/)
  const reopened = await createLeadJournal({ async read() { return records }, checkpoint() { return base }, async append() {} })
  assert.equal(reopened.state.phase, 'waiting-for-user')
})

test('revoke retains the uncertain diff without counting an acknowledged answer', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const base = save(), records: any[] = []
  const journal = await createLeadJournal({ async read() { return [] }, checkpoint() { return base }, async append(record) { records.push(record) } })
  await assert.rejects(journal.useWorkerApproval('rule-1', () => true, async () => { throw Error('uncertain') }, '+needs inspection'))
  const reopened = await createLeadJournal({ async read() { return records }, checkpoint() { return base }, async append() {} })
  const revision = reopened.state.workerApprovals[0]!.dispatch!.revision
  await reopened.revokeWorkerApproval('rule-1', digest)
  const rule = reopened.state.workerApprovals[0]!
  assert.equal(rule.count, 0)
  assert.deepEqual(rule.entries, [{ id: `audit-${revision}`, number: 1, diff: '+needs inspection', uncertain: true }])
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(reopened.state, 'b'.repeat(64))).state, reopened.state)
})

for (const name of ['gulpfile.babel.js', 'jakefile.custom.ts', 'Jakefile.js', 'pnpmfile.cjs', 'vitest.workspace.ts', 'ember-cli-build.js', 'WARP.md', 'QWEN.md', 'CRUSH.md']) test(`follow-up refuses executable or instruction file ${name}`, () => {
  const path = '/workspace/demo/' + name
  assert.equal(leadWorkerApprovalKey({ type: 'fileChange', changes: [{ path, kind: { type: 'update' }, diff: '+demo' }] } as any, '/workspace/demo'), null)
})

test('ordinary profile source keeps a reusable key', () => {
  const path = '/workspace/demo/src/profile.ts'
  assert.deepEqual(leadWorkerApprovalKey({ type: 'fileChange', changes: [{ path, kind: { type: 'update' }, diff: '+source' }] } as any, '/workspace/demo'), { kind: 'fileChange', path })
})

test('later management bookkeeping cannot erase an uncertain worker dispatch wait', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const journal = await createLeadJournal({ async read() { return [] }, checkpoint() { return save() }, async append() {} })
  await assert.rejects(journal.useWorkerApproval('rule-1', () => true, async () => { throw Error('uncertain') }, '+inspect'))
  await journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
  assert.equal(journal.state.phase, 'waiting-for-user')
  assert.equal(journal.state.managementReason, 'lead-worker-audit-failed')
})

test('a cancellation append failure leaves the durable intent visibly fenced', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  let admitted = true
  const journal = await createLeadJournal({ async read() { return [] }, checkpoint() { return save() }, async append(record) {
    if (record.type === 'worker-rule-dispatch') admitted = false
    if (record.type === 'worker-rule-dispatch-cancelled') throw Error('fixture disk failure')
  } })
  await assert.rejects(journal.useWorkerApproval('rule-1', () => admitted, async () => { assert.fail('no answer') }, '+unsent'))
  assert.ok(journal.state.workerApprovals[0]!.dispatch)
  assert.equal(journal.state.phase, 'waiting-for-user')
  assert.equal(journal.state.managementReason, 'lead-worker-audit-failed')
})

for (const ending of ['worker-rule-used', 'worker-rule-dispatch-cancelled'] as const) for (const checkpoint of [false, true]) test(`newly obsolete rules do not break ${ending} replay (checkpoint: ${checkpoint})`, async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const base = save(), rule = { ...base.workerApprovals[0]!, key: { kind: 'fileChange' as const, path: '/workspace/demo/gulpfile.babel.js' }, target: '/workspace/demo/gulpfile.babel.js' }
  const records: any[] = [
    ...(!checkpoint ? [{ version: 1, seq: base.seq, type: 'worker-rule-saved', rule }] : []),
    { version: 1, seq: base.seq + 1, type: 'worker-rule-dispatch', id: rule.id, diff: '+legacy change' },
    { version: 1, seq: base.seq + 2, type: ending, id: rule.id, ...(ending === 'worker-rule-used' ? { diff: '+legacy change' } : {}) },
  ]
  const loaded = checkpoint ? parseLeadCheckpoint(leadCheckpoint({ ...base, workerApprovals: [rule] }, 'b'.repeat(64))).state : start()
  const journal = await createLeadJournal({ async read() { return records }, checkpoint() { return loaded }, async append() {} })
  assert.ok(journal.state.workerApprovals.every(rule => rule.revoked && !rule.dispatch))
  assert.equal(journal.state.phase, 'running')
  assert.equal(journal.state.messages.filter(message => message.id === 'worker-rules-removed').length, 1)
})

test('automatic consent renewal cannot replace an uncertain worker audit wait', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const journal = await createLeadJournal({ async read() { return [] }, checkpoint() { return save() }, async append() {} })
  await assert.rejects(journal.useWorkerApproval('rule-1', () => true, async () => { throw Error('uncertain') }, '+inspect'))
  const seq = journal.state.seq
  await journal.renewPlan(201)
  assert.equal(journal.state.seq, seq, 'renewal waits for the uncertain rule to be reviewed')
  assert.equal(journal.state.phase, 'waiting-for-user')
  assert.equal(journal.state.managementReason, 'lead-worker-audit-failed')
})

test('a historical same-contract renewal and approval cannot release a recovered worker audit wait', () => {
  let state = save()
  state = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'worker-rule-dispatch', id: 'rule-1', diff: '+inspect' })
  state = parseLeadCheckpoint(leadCheckpoint(state, 'b'.repeat(64))).state
  // Old writers could have offered this renewal before the recovery fence.
  state = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'renew-plan', now: 201 })
  assert.equal(state.phase, 'waiting-for-user')
  state = reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'card-decision',
    decision: { version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 2, contractDigest: digest, choice: 'approve' }, expiresAt: 400 })
  assert.equal(state.phase, 'waiting-for-user')
  assert.equal(state.managementReason, 'lead-worker-audit-failed')
  assert.ok(state.workerApprovals[0]!.dispatch)
})

for (const resume of [false, true]) test(`uncertain revoke keeps a durable wait through replay (resume: ${resume})`, async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const records: any[] = [], base = save()
  const storage = { async read() { return records }, checkpoint() { return base }, async append(record: any) { records.push(record) } }
  const journal = await createLeadJournal(storage)
  await assert.rejects(journal.useWorkerApproval('rule-1', () => true, async () => { throw Error('uncertain') }, '+inspect'))
  await journal.revokeWorkerApproval('rule-1', digest)
  if (resume) await journal.resume()
  const reopened = await createLeadJournal(storage)
  assert.equal(reopened.state.phase, resume ? 'running' : 'waiting-for-user')
  assert.equal(reopened.state.managementReason, resume ? null : 'lead-worker-audit-failed')
})

test('a 1951 dispatch revoke resume record sequence replays', () => {
  const base = save()
  const events = [{ type: 'worker-rule-dispatch', id: 'rule-1', diff: '+inspect' }, { type: 'worker-rule-revoked', id: 'rule-1' }, { type: 'resume' }]
  const state = events.reduce((state, event) => reduceLeadRecord(state, { version: 1, seq: state.seq + 1, ...event }), base)
  assert.equal(state.phase, 'running')
})

for (const checkpoint of [false, true]) test(`obsolete unfinished dispatch remains fenced and reviewable (checkpoint: ${checkpoint})`, async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const base = save(), rule = { ...base.workerApprovals[0]!, key: { kind: 'fileChange' as const, path: '/workspace/demo/gulpfile.babel.js' }, target: '/workspace/demo/gulpfile.babel.js' }
  const dispatch = { revision: base.seq + 1, diff: '+unacknowledged runner change', phase: base.phase, reason: base.managementReason }
  const loaded = checkpoint ? parseLeadCheckpoint(leadCheckpoint({ ...base, seq: dispatch.revision, workerApprovals: [{ ...rule, dispatch }] }, 'b'.repeat(64))).state : start()
  const records: any[] = checkpoint ? [] : [{ version: 1, seq: base.seq, type: 'worker-rule-saved', rule }, { version: 1, seq: dispatch.revision, type: 'worker-rule-dispatch', id: rule.id, diff: dispatch.diff }]
  const journal = await createLeadJournal({ async read() { return records }, checkpoint() { return loaded }, async append() {} })
  assert.equal(journal.state.phase, 'waiting-for-user')
  assert.equal(journal.state.managementReason, 'lead-worker-audit-failed')
  await journal.revokeWorkerApproval(rule.id, digest)
  assert.equal(journal.state.workerApprovals[0]!.entries![0]!.diff, dispatch.diff)
  assert.equal(journal.state.workerApprovals[0]!.entries![0]!.uncertain, true)
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(journal.state, 'b'.repeat(64))).state, journal.state)
})

for (const name of ['profile.test.ts', 'profile.spec.ts', 'profile.component.ts', 'profile.service.ts', 'file.utils.ts']) test(`ordinary source variants remain eligible: ${name}`, () => {
  const path = '/workspace/demo/src/' + name
  assert.deepEqual(leadWorkerApprovalKey({ type: 'fileChange', changes: [{ path, kind: { type: 'update' }, diff: '+source' }] } as any, '/workspace/demo'), { kind: 'fileChange', path })
})
for (const name of ['gatsby-config.js', 'gatsby-node.js', 'my-config.ts', 'sitecustomize.py', 'usercustomize.py']) test(`executed config is not reusable: ${name}`, () => {
  const path = '/workspace/demo/' + name
  assert.equal(leadWorkerApprovalKey({ type: 'fileChange', changes: [{ path, kind: { type: 'update' }, diff: '+source' }] } as any, '/workspace/demo'), null)
})

test('a dispatch whose key was removed by an older checkpoint keeps its diff through the next checkpoint', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const base = start()
  const journal = await createLeadJournal({ async read() { return [{ version: 1, seq: base.seq + 1, type: 'worker-rule-dispatch', id: 'removed', diff: '+orphan change' }] }, checkpoint() { return base }, async append() {} })
  assert.equal(journal.state.managementReason, 'lead-worker-audit-failed')
  const loaded = parseLeadCheckpoint(leadCheckpoint(journal.state, 'b'.repeat(64))).state
  assert.equal(loaded.phase, 'waiting-for-user')
  assert.equal(loaded.messages.at(-1)!.approval!.diff, '+orphan change')
})

for (const type of ['worker-rule-used', 'worker-rule-dispatch-cancelled']) test(`a missing-key dispatch settles on its own ${type} record`, async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const base = start()
  const records: any[] = [{ version: 1, seq: base.seq + 1, type: 'worker-rule-dispatch', id: 'removed', diff: '+orphan change' },
    { version: 1, seq: base.seq + 2, type, id: 'removed', ...(type === 'worker-rule-used' ? { diff: '+orphan change' } : {}) }]
  const journal = await createLeadJournal({ async read() { return records }, checkpoint() { return base }, async append() {} })
  assert.equal(journal.state.phase, 'running')
  assert.equal(journal.state.managementReason, null)
  assert.equal(journal.state.messages.some(message => message.id.startsWith('worker-rule-orphan-')), false)
})

test('a person can resume after inspecting an unknown-key dispatch observation', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const base = start(), records: any[] = [{ version: 1, seq: base.seq + 1, type: 'worker-rule-dispatch', id: 'removed', diff: '+inspect' }]
  const storage = { async read() { return records }, checkpoint() { return base }, async append(record: any) { records.push(record) } }
  const journal = await createLeadJournal(storage)
  await journal.resume()
  assert.equal(journal.state.phase, 'running')
  assert.equal((await createLeadJournal(storage)).state.phase, 'running')
})

for (const orphan of [false, true]) test(`expired consent can renew an audit wait without releasing it (orphan: ${orphan})`, async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const base = orphan ? start() : save(), records: any[] = orphan ? [{ version: 1, seq: base.seq + 1, type: 'worker-rule-dispatch', id: 'removed', diff: '+inspect' }] : []
  const journal = await createLeadJournal({ async read() { return records }, checkpoint() { return base }, async append(record) { records.push(record) } })
  if (!orphan) {
    await assert.rejects(journal.useWorkerApproval('rule-1', () => true, async () => { throw Error('uncertain') }, '+inspect'))
    await journal.revokeWorkerApproval('rule-1', digest)
  }
  await journal.renewPlan(201)
  assert.equal(journal.state.consent!.renewalCardRevision, 2)
  assert.equal(journal.state.phase, 'waiting-for-user')
  await journal.decideCard({ version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 2, contractDigest: digest, choice: 'approve' }, 400)
  assert.equal(journal.state.phase, 'waiting-for-user')
  await journal.resume()
  assert.equal(journal.state.phase, 'running')
})

test('1951 renewal after revoke replays its admitted start without a new-writer marker', async () => {
  const { summarizeLeadArguments, createLeadJournal } = await import('../src/index.js')
  const base = save(), records: any[] = [
    { type: 'worker-rule-dispatch', id: 'rule-1', diff: '+legacy' },
    { type: 'worker-rule-revoked', id: 'rule-1' }, { type: 'renew-plan', now: 300 },
    { type: 'card-decision', decision: { version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 2, contractDigest: digest, choice: 'approve' }, expiresAt: 900 },
    { type: 'attempt', id: 'a1', correlationId: 'a1', method: 'flow/start-goal', action: null, arguments: summarizeLeadArguments({}), kind: 'mutation', stepId: 'first', policyRevision: 1, projectPolicyRevision: null, contractRevision: 1 },
    { type: 'decision', id: 'a1', effect: 'allow', reason: 'policy', rule: null },
    { type: 'dispatch-start', id: 'a1', dispatched: true },
  ].map((event, i) => ({ version: 1, seq: base.seq + i + 1, ...event }))
  const journal = await createLeadJournal({ checkpoint() { return base }, async read() { return records }, async append() {} })
  assert.equal(journal.state.phase, 'running')
  assert.equal(journal.state.attempts.get('a1')!.dispatched, true)
})

for (const name of ['dangerfile.ts', 'dangerfile.js', 'cakefile.js', 'guardfile.ts', 'makefile.js', 'webpackfile.ts']) test(`runner stem refuses ${name}`, () => {
  const path = '/workspace/demo/' + name
  assert.equal(leadWorkerApprovalKey({ type: 'fileChange', changes: [{ path, kind: { type: 'update' }, diff: '+runner' }] } as any, '/workspace/demo'), null)
})

test('Resume retires the orphan Needs review notice but keeps the reviewed diff openable', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const base = start()
  const journal = await createLeadJournal({ checkpoint() { return base }, async read() { return [{ version: 1, seq: base.seq + 1, type: 'worker-rule-dispatch', id: 'removed', diff: '+inspect' }] }, async append() {} })
  await journal.resume()
  assert.equal(journal.state.messages.some(message => message.id.startsWith('worker-rule-orphan-')), false)
  assert.equal(journal.state.messages.at(-1)!.approval!.diff, '+inspect')
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(journal.state, 'b'.repeat(64))).state, journal.state)
})

test('marked revoke fences a non-start mutation from an in-flight Lead request until Resume', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const base = save(), journal = await createLeadJournal({ checkpoint() { return base }, async read() { return [] }, async append() {} })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical', caps: contract.caps, freshnessMs: 1000 })
  await assert.rejects(journal.useWorkerApproval('rule-1', () => true, async () => { throw Error('uncertain') }, '+inspect'))
  await journal.revokeWorkerApproval('rule-1', digest)
  let dispatched = 0
  const input = { request: { method: 'lead/chat/send', params: { id: 'fixture:chat', text: 'Continue' }, project: contract.project, runId: null, start: null },
    context: { desk: journal.state.policy!, projectPolicy: null, project: contract.project, approved: null, now: 100, policyInterpretation: 'idle' as const,
      budget: { version: 1 as const, revision: 1, caps: contract.caps, leadUsdMicros: 0, workerUsdMicros: 0, reservedUsdMicros: 0, roundsAdmitted: 0, spend: 'known' as const, stop: null } } }
  const answer = async () => { dispatched++; return { value: null, identity: null } }
  assert.equal((await journal.execute({ ...input, id: 'before-resume' }, answer)).decision.effect, 'deny')
  assert.equal(dispatched, 0)
  await journal.resume()
  assert.equal((await journal.execute({ ...input, id: 'after-resume' }, answer)).decision.effect, 'allow')
  assert.equal(dispatched, 1)
})

test('revised plan retains an orphaned audit receipt until explicit Resume', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const base = start()
  const journal = await createLeadJournal({ checkpoint() { return base }, async read() { return [{ version: 1, seq: base.seq + 1, type: 'worker-rule-dispatch', id: 'orphan', diff: '+inspect orphan' }] }, async append() {} })
  const next = { ...contract, revision: 2, digest: 'b'.repeat(64) }
  await journal.offerCard({ version: 1, id: 'plan2', revision: 1, type: 'plan', contractDigest: next.digest, contract: next })
  await journal.decideCard({ version: 1, cardId: 'plan2', cardType: 'plan', expectedRevision: 1, contractDigest: next.digest, choice: 'approve' }, 1000)
  assert.equal(journal.state.managementReason, 'lead-worker-audit-failed')
  assert.equal(journal.state.workerAuditWait, true)
  assert.equal(journal.state.orphanedWorkerDispatch!.diff, '+inspect orphan')
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(journal.state, 'b'.repeat(64))).state, journal.state)
  await journal.resume()
  assert.equal(journal.state.phase, 'running')
})

test('legacy dispatch records for a retired rule never re-arm it or block replay', async () => {
  const { createLeadJournal } = await import('../src/index.js')
  const following = parseLeadCheckpoint(leadCheckpoint({ ...save(), phase: 'following' }, 'b'.repeat(64))).state
  assert.equal(following.workerApprovals[0]!.revoked, true, 'older Following checkpoints contain no active authority')
  const records: any[] = [{ version: 1, seq: following.seq + 1, type: 'worker-rule-dispatch', id: 'rule-1', diff: '+legacy request' },
    { version: 1, seq: following.seq + 2, type: 'worker-rule-used', id: 'rule-1', diff: '+legacy request' }]
  const pendingJournal = await createLeadJournal({ checkpoint() { return following }, async read() { return records.slice(0, 1) }, async append() {} })
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(pendingJournal.state, 'b'.repeat(64))).state, pendingJournal.state)
  const journal = await createLeadJournal({ checkpoint() { return following }, async read() { return records }, async append() {} })
  assert.equal(journal.state.workerApprovals[0]!.revoked, true)
  assert.equal(journal.state.workerApprovals[0]!.count, 0)
  assert.equal(journal.state.orphanedWorkerDispatch, null)
  assert.equal(journal.state.phase, 'following')
})
