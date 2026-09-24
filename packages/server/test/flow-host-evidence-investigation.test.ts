import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BoardEvidence, FlowExecution } from '@harnessdesk/protocol'

import {
  answer, board, claimed, cwdOf, desk, execution, git, person, settled, shipped, start, whenChanged, workInsideTheBrief, write,
} from './fixtures/flow-host-evidence.js'

/*
 * The shipped `investigation` flow: a researcher's committed answer opens
 * the close-out, on a branch or on the project's own default one, and a step
 * that commits nothing says so rather than stalling in silence. Split out of
 * `flow-host-evidence.test.ts` (see that file's sibling `-comparison`,
 * `-review` and `-flows` files) so no single file's cases add up to the
 * suite's `--test-timeout`; the rig they all share lives in
 * `test/fixtures/flow-host-evidence.ts`.
 */

test('investigation: an observed diff of the committed answer opens the close-out, woken by the evidence plane', async (t) => {
  const d = await desk(t)
  // What a window is told: every change to the run's state, pushed whole, not only when it asks.
  const told: FlowExecution[] = []
  d.host.addBroadcaster((notification) => {
    if (notification.method === 'flow/execution-changed') told.push(notification.params.execution)
  })
  const run = await start(d, await shipped(d, 'investigation'), { question: 'Where does the time go?' })
  const [research] = await claimed(d, run.goal, 'research', 1)
  await write(d, research!, 'the answer', 'gathered')
  await person(d, run.goal, 'close', 'closed')
  const done = await settled(d, run.id)
  await whenChanged(d, () => (told.findLast((one) => one.id === run.id)?.state === 'settled' ? true : null), 'the settled run pushed to windows')
  assert.ok(told.some((one) => one.id === run.id && one.state === 'running' && one.rounds.length === 1), 'its first round was pushed too')
  const close = done.rounds.find((one) => one.role === 'close')!
  assert.equal(close.evidence.length, 1, 'the close-out round names the diff fact that opened it')
})

/*
 * The shipped Investigation as it runs by default: its researcher is not
 * isolated and is not told to branch, so it commits on the project's own
 * default branch. The diff that guard reads is what was committed since the
 * step began, so the close-out still opens.
 */
test('investigation on the default branch: the answer committed since the step began opens the close-out', async (t) => {
  const d = await desk(t, undefined, { onMain: true })
  const run = await start(d, await shipped(d, 'investigation'), { question: 'Where does the time go?' })
  const [research] = await claimed(d, run.goal, 'research', 1)
  assert.equal(await git(cwdOf(d, research!), 'symbolic-ref', '--short', 'HEAD'), 'main', 'the researcher works on the default branch')
  const before = await git(cwdOf(d, research!), 'rev-parse', 'HEAD')
  const head = await write(d, research!, 'the answer', 'gathered')
  await person(d, run.goal, 'close', 'closed')
  const done = await settled(d, run.id)
  const close = done.rounds.find((one) => one.role === 'close')!
  assert.equal(close.evidence.length, 1, 'the close-out round names the diff fact that opened it')
  const facts = await d.host.call('evidence/board', { room: run.goal }) as BoardEvidence
  const diff = facts.cards.flatMap((card) => card.facts).map((one) => one.record.fact).find((fact) => fact.kind === 'diff')
  assert.ok(diff?.kind === 'diff', 'the desk observed a diff')
  assert.deepEqual({ from: diff.from, to: diff.to, files: diff.files }, { from: before, to: head, files: 1 })
})

/*
 * A step that commits nothing has no diff to read. The run neither sits on
 * "running" in silence nor ends without a word: while the desk has not looked
 * yet it says what it waits for, and once it has, it ends saying which rule
 * did not apply and why.
 */
test('investigation with nothing committed ends saying there was no committed change to read', async (t) => {
  const d = await desk(t, undefined, { onMain: true })
  const told: FlowExecution[] = []
  d.host.addBroadcaster((notification) => {
    if (notification.method === 'flow/execution-changed') told.push(notification.params.execution)
  })
  const run = await start(d, await shipped(d, 'investigation'), { question: 'Where does the time go?' })
  const [research] = await claimed(d, run.goal, 'research', 1)
  await answer(d, research!, 'gathered')
  const done = await settled(d, run.id)
  assert.match(done.reason!, /to-close did not apply/)
  assert.match(done.reason!, new RegExp(`card #${research!.id}'s checkout has no committed change since its step began`))
  for (const one of told.filter((each) => each.id === run.id && each.rounds.at(-1)?.state === 'waiting-evidence')) {
    assert.match(one.reason ?? '', /^Rule to-close: /, 'a run waiting on evidence says what for')
  }
})

/*
 * A real agent reads its brief in a turn of its own, and a busy agent refuses
 * a second message until that turn ends. An agent that simply gets on with
 * its card inside that first turn — waits for work, finds its card already
 * claimed for it, does it, completes it — is the ordinary case, not a race:
 * the run follows the board, never stalls on "still working", and the
 * completion is on disk.
 */
test('a Seat that works its card inside its brief turn: the run follows the board and never stalls on "still working"', async (t) => {
  const d = await desk(t, undefined, { refusesWhileBusy: true, onMain: true })
  workInsideTheBrief(d, {
    research: async (desk, card) => { await write(desk, card, 'the answer', 'gathered') },
  })
  const run = await start(d, await shipped(d, 'investigation'), { question: 'Where does the time go?' })
  const close = await person(d, run.goal, 'close', 'closed')
  const done = await settled(d, run.id)
  assert.deepEqual(done.rounds.map((one) => [one.role, one.state]), [['research', 'closed'], ['close', 'closed']])
  const research = (await board(d, run.goal)).find((one) => one.role === 'research')!
  assert.equal(research.state, 'done')
  assert.equal(research.outcome, 'gathered')
  assert.ok(close)
})

/*
 * A Seat that only reads its brief — the ordinary agent, which answers and
 * ends its turn — has its card handed over when that turn is over: the
 * order left for it goes out exactly once, whether the turn ended well or
 * in an error, and the Seat then finishes the card in the turn it started.
 */
for (const ending of ['completes', 'fails'] as const) {
  test(`a brief turn that ${ending} with the card still open is followed by exactly one card order`, async (t) => {
    const d = await desk(t, undefined, { refusesWhileBusy: true })
    const orders: string[] = []
    for (const runtime of d.runtimes) {
      runtime.onSend = (session, text, opts) => {
        if (opts?.recordAs !== 'notice') return
        if (text.startsWith('Do the ')) {
          // Reads its brief, and ends its turn without asking for work — once the run has left its order for that.
          void whenChanged(d, async () => {
            const id = d.runs[0]
            const prepared = id ? (await execution(d, id)).operations.some((one) => one.key === 'turn:1:0' && one.state === 'prepared') : false
            return prepared ? true : null
          }, 'the order left for the end of the brief turn')
            .then(() => (ending === 'completes' ? session.finish() : session.fail('the model is overloaded')))
            .catch((error: unknown) => { console.error('a reading agent failed', error) })
          return
        }
        const card = /^Card #(\d+) on this Goal is yours/.exec(text)
        if (!card) return
        orders.push(card[1]!)
        void (async () => {
          const id = await whenChanged(d, () => d.runs[0] ?? null, 'the run to be started')
          const goal = (await execution(d, id)).goal
          const held = (await board(d, goal)).find((one) => one.id === Number(card[1]))!
          await write(d, held, 'the answer', 'gathered')
          session.finish()
        })().catch((error: unknown) => { console.error('a working agent failed', error) })
      }
    }
    const run = await start(d, await shipped(d, 'investigation'), { question: 'Where does the time go?' })
    await person(d, run.goal, 'close', 'closed')
    const done = await settled(d, run.id)
    assert.deepEqual(orders, ['1'], 'the card was handed over once, after the brief turn')
    assert.equal(done.operations.find((one) => one.key === 'turn:1:0')?.state, 'finished')
    assert.deepEqual(done.operations.filter((one) => one.kind === 'turn').map((one) => one.key), ['turn:1:0'])
  })
}
