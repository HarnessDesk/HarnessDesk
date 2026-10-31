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
  assert.equal(state.messages.at(-1)!.role, 'notice')
  assert.equal((state.messages.at(-1) as any).approval.diff, 'export const demo = 2')
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
