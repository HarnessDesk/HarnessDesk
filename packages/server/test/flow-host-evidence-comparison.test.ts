import assert from 'node:assert/strict'
import { test } from 'node:test'

import { INDEPENDENT } from '../src/flow-execution.js'
import {
  board, claimed, comparison, cwdOf, desk, E2E, execution, git, person, review, settled, start, TASK, UNKNOWN, whenChanged, write,
} from './fixtures/flow-host-evidence.js'

/*
 * The shipped `comparison` flow: several competitors, a judge that picks
 * among their revisions, and the referee card that carries the pick to a
 * merge. Split out of `flow-host-evidence.test.ts` (see that file's sibling
 * `-investigation`, `-review` and `-flows` files) so no single file's cases
 * add up to the suite's `--test-timeout`; the rig they all share lives in
 * `test/fixtures/flow-host-evidence.ts`.
 */

for (const count of [1, 2]) {
  test(`comparison with ${count} competitor(s): the judge's recorded review carries the picked revision to the merge card`, E2E, async (t) => {
    const d = await desk(t)
    const run = await start(d, await comparison(d, count), TASK)
    const competitors = await claimed(d, run.goal, 'competitor', count)
    const heads: string[] = []
    for (const [index, card] of competitors.entries()) heads.push(await write(d, card, `attempt ${index + 1}`))
    assert.equal(new Set(competitors.map((one) => cwdOf(d, one))).size, count, 'each competitor has its own checkout')

    const [judge] = await claimed(d, run.goal, 'judge', 1)
    const verifies = (await board(d, run.goal)).filter((one) => one.role === 'verify')
    assert.equal(verifies.length, count, 'one check card per competitor revision')
    assert.ok(verifies.every((one) => one.outcome === 'pass'))
    const picked = heads.at(-1)!
    await review(d, judge!, 'picked', picked)

    const referee = await person(d, run.goal, 'referee', 'merged')
    assert.match(`${referee.title}\n${referee.detail ?? ''}`, new RegExp(picked), 'the merge card names the exact revision the judge picked')
    const done = await settled(d, run.id)
    const refereeRound = done.rounds.find((one) => one.role === 'referee')!
    assert.ok(refereeRound.evidence.length > 0, 'the merge round keeps the fact ids that authorized it')
  })
}

/*
 * A judge that may change files is still a judge: the revision it is judged
 * on is the one it picked among its predecessors, never its own checkout's
 * head — the same walk its candidates came from.
 */
test('a judge granted edit is judged on the competitor it picked, never on its own checkout', E2E, async (t) => {
  const d = await desk(t)
  const text = await comparison(d, 1)
  assert.match(text, /uses: \[judge\]\n    grant: read\n/)
  const run = await start(d, text.replace('uses: [judge]\n    grant: read\n', 'uses: [editing-judge]\n    grant: edit\n'), TASK)
  const [competitor] = await claimed(d, run.goal, 'competitor', 1)
  const picked = await write(d, competitor!, 'attempt 1')
  const [judge] = await claimed(d, run.goal, 'judge', 1)
  assert.notEqual(await git(cwdOf(d, judge!), 'rev-parse', 'HEAD'), picked, 'the judge sits on a head of its own')
  await review(d, judge!, 'picked', picked)
  const referee = await person(d, run.goal, 'referee', 'merged')
  assert.match(referee.detail ?? '', new RegExp(picked))
  await settled(d, run.id)
})

/*
 * Independence is read from what each runtime's adapter reports about the
 * vendor behind it. A runtime that cannot rule out an override reports
 * none, and one that says nothing is unknown too — even one whose id names
 * a vendor. Either way the judge is refused a seat, never assumed
 * independent.
 */
for (const second of UNKNOWN) {
  test(`a judge on a runtime ${second.why} is never taken for independent`, E2E, async (t) => {
    const d = await desk(t, second)
    const run = await start(d, await comparison(d, 1), TASK)
    const [competitor] = await claimed(d, run.goal, 'competitor', 1)
    await write(d, competitor!, 'attempt 1')
    const stalled = await whenChanged(d, async () => {
      const now = await execution(d, run.id)
      return now.state === 'stalled' ? now : null
    }, 'the run to stall at the judge')
    assert.equal(stalled.reason, INDEPENDENT)
    assert.equal((await board(d, run.goal)).find((one) => one.role === 'judge')?.state, 'open', 'no Seat took the judge’s card')
  })
}
