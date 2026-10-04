import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Evidence, EvidenceRecord, FlowExecution, FlowPolicy, TeamState } from '@harnessdesk/protocol'

import { checkAttemptsOf } from '../src/evidence/check-attempts.js'
import { TAIL_LIMIT } from '../src/evidence/records.js'
import { EvidencePlane } from '../src/evidence/plane.js'
import { flowMethods } from '../src/methods/flows.js'
import type { HostContext } from '../src/methods/context.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * `flow/check/attempts` lists what the desk recorded each time a check card's
 * command ran. A retry (#1263) keeps every earlier result as durable evidence
 * on the card, while `evidence/board` folds them to the latest and a
 * `FlowOperation` is one record a retry overwrites — so this is the only read
 * that returns the earlier ones. It reads; nothing runs and no token is minted.
 */

const GOAL = 'goal-1'
const HEAD = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)

const policy: FlowPolicy = {
  version: 2, name: 'Gate', inputs: [], messaging: 'board-only', wait: 240,
  roles: [
    { id: 'gate', kind: 'check', check: { run: 'pnpm verify', timeout: 600, exits: { '0': 'pass', '2': 'fix-it' }, otherwise: 'fail' } },
    { id: 'person', kind: 'person', outcomes: ['done'] },
  ],
  rules: [], seed: { role: 'gate', title: 'Check it' },
}

const execution = (over: Partial<FlowExecution> = {}): FlowExecution => ({
  version: 2, id: 'run-1', goal: GOAL, document: { format: 'agents', flow: policy }, state: 'running',
  rounds: [
    { n: 1, role: 'gate', cards: [1], seats: [], evidence: [], state: 'closed', cause: 'seed' },
    { n: 2, role: 'person', cards: [2], seats: [], evidence: [], state: 'running', cause: 'rule' },
  ],
  operations: [], legacyRun: null, reason: null, ...over,
})

type CheckFact = Extract<Evidence, { kind: 'check' }>
/** What the read answers for a run and a card, over the facts the store holds. */
const attemptsOf = (run: FlowExecution, card: number, records: readonly EvidenceRecord[]) => checkAttemptsOf(run, card, async () => records)

const result = (id: string, observedAt: number, fact: Partial<CheckFact> = {}, record: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id, observedAt, round: 1, card: { board: GOAL, id: 1 },
  fact: { kind: 'check', name: 'gate', run: 'pnpm verify', exit: 1, timedOut: false, at: HEAD, dirty: false, tail: 'one test failed', ...fact },
  ...record,
})

test('lists every recorded result of the card oldest first, each in the Flow’s own word', async () => {
  const records = [
    result('r3', 300, { exit: 0, tail: 'all green', at: MOVED }),
    result('r1', 100, { exit: 2, tail: 'lint: 4 problems' }),
    result('r2', 200, { exit: null, timedOut: true, tail: 'It ran past 600s and was stopped.' }),
  ]
  assert.deepEqual(await attemptsOf(execution(), 1, records), [
    { n: 1, at: 100, commit: HEAD, exit: 2, timedOut: false, outcome: 'fix-it', tail: 'lint: 4 problems' },
    { n: 2, at: 200, commit: HEAD, exit: null, timedOut: true, outcome: 'fail', tail: 'It ran past 600s and was stopped.' },
    { n: 3, at: 300, commit: MOVED, exit: 0, timedOut: false, outcome: 'pass', tail: 'all green' },
  ], 'a status the Flow names, a timeout and an exit it names no outcome for each read as the engine reads them')
})

test('two results recorded at the same time keep the order they were written in', async () => {
  const attempts = await attemptsOf(execution(), 1, [result('first', 100, { tail: 'first' }), result('second', 100, { tail: 'second' })])
  assert.deepEqual(attempts.map((one) => one.tail), ['first', 'second'])
})

test('a result recorded for another card, board, round, command or kind is not this card’s attempt', async () => {
  const mine = result('mine', 100, { tail: 'mine' })
  const records: EvidenceRecord[] = [
    mine,
    result('other-card', 110, {}, { card: { board: GOAL, id: 3 } }),
    result('other-board', 120, {}, { card: { board: 'goal-2', id: 1 } }),
    result('other-round', 130, {}, { round: 2 }),
    result('no-round', 135, {}, { round: null }),
    result('other-role', 140, { name: 'lint' }),
    result('other-command', 150, { run: 'pnpm lint' }),
    result('advisory', 160, { counted: false, advisory: true }),
    result('no-card', 165, {}, { card: null }),
    { id: 'pr', observedAt: 170, round: 1, card: { board: GOAL, id: 1 }, fact: { kind: 'pr', number: 7, head: HEAD, state: 'open', url: null } },
    { id: 'spend', observedAt: 180, round: 1, card: { board: GOAL, id: 1 }, fact: { kind: 'spend', usd: 1, turns: 2, exact: true } },
  ]
  assert.deepEqual((await attemptsOf(execution(), 1, records)).map((one) => one.tail), ['mine'])
})

test('a card with no recorded result has no attempts, and says nothing a person has to read as a failure', async () => {
  assert.deepEqual(await attemptsOf(execution(), 1, []), [])
})

test('a card that is not a check card of this run is refused in a sentence, and nothing is read for it', async () => {
  let reads = 0
  const read = async () => { reads += 1; return [] }
  await assert.rejects(checkAttemptsOf(execution(), 9, read), /Card #9 belongs to no round of this run/)
  await assert.rejects(checkAttemptsOf(execution(), 2, read), /Card #2 is not a check/)
  const old = execution({ document: { format: 'legacy', flow: { name: 'Old', roles: [], rules: [], inputs: [], seed: { role: 'a', title: 't' }, wait: 1 } } })
  await assert.rejects(checkAttemptsOf(old, 1, read), /old format/)
  assert.equal(reads, 0)
})

test('the tail comes back exactly as recorded — markup and escape sequences included — and never longer than a record may be', async () => {
  const hostile = '<img src=x onerror=alert(1)>\u001b]0;pwned\u0007\u001b[31mred\u001b[0m & <script>1</script>'
  const kept = 'x'.repeat(TAIL_LIMIT)
  const [first, second] = await attemptsOf(execution(), 1, [result('a', 1, { tail: hostile }), result('b', 2, { tail: kept })])
  assert.equal(first!.tail, hostile, 'the host keeps what the command printed; a surface shows it as text, through its sanitiser')
  assert.equal(second!.tail.length, TAIL_LIMIT)
})

const fakeCtx = (calls: unknown[] = []): HostContext => ({
  flows: {
    executionOf: (run: string) => (run === 'run-1' ? execution() : null),
  },
  evidence: {
    checkResults: async (goal: string, card: number) => {
      calls.push({ goal, card })
      return [result('r1', 100, { exit: 0 }), result('r2', 200, { exit: 2 })]
    },
  },
}) as unknown as HostContext

test('flow/check/attempts reads the run and the evidence through the context, by run and card alone', async () => {
  const calls: unknown[] = []
  const answer = await flowMethods['flow/check/attempts'](fakeCtx(calls), { run: 'run-1', card: 1 })
  assert.deepEqual(calls, [{ goal: GOAL, card: 1 }], 'the evidence is read for the run’s own Goal, never a Goal the caller names')
  assert.deepEqual(answer.attempts.map((one) => [one.n, one.outcome]), [[1, 'pass'], [2, 'fix-it']])
})

test('flow/check/attempts refuses a run the desk does not have before reading any evidence', async () => {
  const calls: unknown[] = []
  await assert.rejects(flowMethods['flow/check/attempts'](fakeCtx(calls), { run: 'nope', card: 1 }), /There is no flow run nope/)
  await assert.rejects(flowMethods['flow/check/attempts'](fakeCtx(calls), { run: 'run-1', card: 2 }), /Card #2 is not a check/)
  assert.deepEqual(calls, [], 'a refused card never reaches the store')
})

test('the plane lists every result recorded for a card, never folded to the latest, and judges none against git', async () => {
  const repo = await makeRepo()
  const dir = tempDir('hd-check-results-')
  const plane = new EvidencePlane({ dir, seenFile: join(dir, 'seen.json') }, {
    board: (room) => (room === GOAL || room === 'goal-2' ? ({ id: room, root: repo.dir, intents: [] } as unknown as TeamState) : null),
    cwdOf: () => null, push: () => {}, log: () => {},
  })
  const run = (goal: string, card: number, command: string) =>
    plane.runFlowCheck(command, { cwd: repo.dir, timeoutSec: 20 }, { goal, card, name: 'gate', round: 1 })
  await run(GOAL, 1, 'echo first && exit 3')
  await run(GOAL, 1, 'echo second')
  await run(GOAL, 4, 'echo another card')
  await run('goal-2', 1, 'echo another goal')
  const results = await plane.checkResults(GOAL, 1)
  assert.deepEqual(results.map((one) => one.fact.kind === 'check' ? [one.fact.exit, one.fact.tail] : null), [[3, 'first\n'], [0, 'second\n']])
  assert.ok(results.every((one) => one.card?.board === GOAL && one.card.id === 1))
  await assert.rejects(plane.checkResults('no-such-room', 1), /There is no room no-such-room on this desk/)
})
