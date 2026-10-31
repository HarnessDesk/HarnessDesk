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


test('a host second look consumes the same stop without suppressing a new round', () => {
  const gate = lead.createLeadWakeGate(), stopped = desk([run({ state: 'settled', end: { kind: 'unrouted' } })])
  gate.handledStop('stop-1', 'run-1', stopped, owned, [])
  assert.equal(gate.look(stopped, owned, [], 100).wake, false)
  const restarted = desk([run({ rounds: [{ n: 1, role: 'implement', state: 'closed' }, { n: 2, role: 'implement', state: 'running' }] })])
  assert.equal(gate.look(restarted, owned, [], 200).wake, true)
  gate.handledStop('stop-1', 'run-1', stopped, owned, [])
  assert.equal(gate.look(restarted, owned, [], 300).wake, true, 'replaying the same claim never consumes later progress')
})


test('second look suppression preserves concurrent person actions and another run change', () => {
  const gate = lead.createLeadWakeGate(), initial = desk([run()])
  gate.shown(gate.look(initial, owned, [], 0).fingerprint)
  const stopped = desk([run({ state: 'settled', end: { kind: 'unrouted' } })])
  const actions = [{ kind: 'check' as const, id: 'new-check', runId: 'run-1', name: 'Unit', command: 'pnpm test' }]
  gate.handledStop('stop-1', 'run-1', stopped, owned, actions)
  assert.equal(gate.look(stopped, owned, actions, 100).wake, true)
  const other = { runs: ['run-1', 'run-2'], teams: ['team-1', 'team-2'] }, next = desk([run({ state: 'settled' }), run({ id: 'run-2' })])
  const independent = lead.createLeadWakeGate()
  independent.shown(independent.look(initial, other, [], 0).fingerprint)
  independent.handledStop('stop-1', 'run-1', next, other, [])
  assert.equal(independent.look(next, other, [], 100).wake, true)
})


test('a handled worker completion consumes its board signal but preserves unrelated channel messages', () => {
  const own = { ...owned }, worker = run({ goal: 'team-1', rounds: [{ n: 1, role: 'implement', state: 'closed', cards: [1] }] })
  const actor = { kind: 'user' }, initialBoard = { id: 'team-1', name: 'Work', updatedAt: 1, members: [], root: '/workspace/acme-web', messaging: true,
    intents: [{ id: 1, title: 'Dependencies', state: 'claimed' }], channel: [] }
  const completed = { ...initialBoard, updatedAt: 2, intents: [{ ...initialBoard.intents[0], state: 'done', outcome: 'blocked' }],
    channel: [{ id: 'completed-1', at: 2, kind: 'signal', by: actor, signal: 'completed', intent: 1, title: 'Dependencies' }] }
  const before = { ...desk([worker]), boards: [initialBoard] }, stopped = { ...desk([{ ...worker, state: 'settled' }]), boards: [completed] }
  const gate = lead.createLeadWakeGate(); gate.shown(gate.look(before, own, [], 0).fingerprint)
  gate.handledStop('stop-1', 'run-1', stopped, own, [])
  assert.equal(gate.look(stopped, own, [], 100).wake, false)
  const message = { id: 'message-2', at: 3, kind: 'message', from: actor, text: 'New person request', state: 'shown' }
  const changed = { ...stopped, boards: [{ ...completed, updatedAt: 3, channel: [...completed.channel, message] }] }
  assert.equal(gate.look(changed, own, [], 200).wake, true)
})
