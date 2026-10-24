import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as lead from '../src/index.js'

const run = (over: Record<string, unknown> = {}) => ({ id: 'run-1', state: 'running', reason: null, end: null, startedAt: 0,
  rounds: [{ n: 1, role: 'implement', state: 'open' }], operations: [{ key: 'turn-1', kind: 'turn', state: 'running' }], ...over })
const desk = (runs: unknown[], waiting: unknown[] = []) => ({ teams: [], runs, boards: [], seats: [], approvals: [], reviews: [], waiting }) as any
const owned = { runs: ['run-1'], teams: ['team-1'] }

test('activity that only adds lines is a check, not a wake, and the counts say so', () => {
  const gate = lead.createLeadWakeGate(60_000)
  const first = gate.look(desk([run()]), owned, [], 0)
  assert.equal(first.wake, true); gate.shown(first.fingerprint)
  for (let i = 1; i <= 3; i++) assert.equal(gate.look(desk([run()]), owned, [], i * 1000).wake, false)
  assert.deepEqual(gate.counts, { checked: 3, quiet: 3, lastCheckedAt: 3000 })
  const moved = gate.look(desk([run({ rounds: [{ n: 1, role: 'implement', state: 'closed' }] })]), owned, [], 4000)
  assert.equal(moved.wake, true); assert.equal(moved.why, 'changed')
})

test('a run quiet past the threshold wakes the model once and reads stuck', () => {
  const gate = lead.createLeadWakeGate(60_000)
  gate.shown(gate.look(desk([run()]), owned, [], 0).fingerprint)
  assert.equal(gate.look(desk([run()]), owned, [], 30_000).wake, false)
  const stuck = gate.look(desk([run()]), owned, [], 61_000)
  assert.equal(stuck.wake, true); assert.equal(stuck.why, 'stuck')
  gate.shown(stuck.fingerprint)
  assert.equal(gate.look(desk([run()]), owned, [], 120_000).wake, false, 'stuck is said once per quiet stretch')
  assert.deepEqual(lead.classifyLeadRuns(desk([run()]), owned, [], gate.lastMoved, 121_000, 60_000), [{ runId: 'run-1', kind: 'stuck', quietMinutes: 2 }])
})

test('runs read as done, blocked, plan only or advanced', () => {
  const read = (value: unknown, waiting: unknown[] = []) => lead.classifyLeadRuns(desk([value], waiting), owned, [], new Map([['run-1', 0]]), 1000, 60_000)[0]!.kind
  assert.equal(read(run({ state: 'settled' })), 'done')
  assert.equal(read(run({ state: 'stalled' })), 'blocked')
  assert.equal(read(run(), [{ id: 'w', team: 'team-1', kind: 'approval', summary: 'Approve' }]), 'blocked')
  assert.equal(read(run({ rounds: [{ n: 1, role: 'implement', state: 'closed' }], operations: [] })), 'plan-only')
  assert.equal(read(run()), 'advanced')
  assert.deepEqual(lead.classifyLeadRuns(desk([run({ id: 'other' })]), owned, [], new Map(), 0), [], 'only owned runs are read')
})

test('the quiet marker is recognised only on its own', () => {
  assert.equal(lead.isLeadQuiet(lead.LEAD_QUIET), true)
  assert.equal(lead.isLeadQuiet(`  ${lead.LEAD_QUIET}\n`), true)
  assert.equal(lead.isLeadQuiet(`Still running. ${lead.LEAD_QUIET}`), false)
})

test('a reply offers at most three lines to keep, each from its own line', () => {
  assert.deepEqual(lead.leadRememberLines('Plan drafted.\nRemember: the person prefers small pull requests\n  Remember:   run the linter first  \nRemember:'),
    ['the person prefers small pull requests', 'run the linter first'])
  assert.deepEqual(lead.leadRememberLines('Nothing to remember: here'), [])
  assert.equal(lead.leadRememberLines(Array.from({ length: 5 }, (_, i) => `Remember: line ${i}`).join('\n')).length, 3)
})
