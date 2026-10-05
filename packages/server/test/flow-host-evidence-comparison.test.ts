import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { INDEPENDENT } from '../src/flow-execution.js'
import {
  board, claimed, comparison, cwdOf, desk, E2E, execution, git, person, review, scopeOf, settled, shipped, start, TASK, UNKNOWN, whenChanged, write,
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
  const competing = cwdOf(d, competitor!)
  const picked = await write(d, competitor!, 'attempt 1')
  const [judge] = await claimed(d, run.goal, 'judge', 1)
  // Handed one competitor's work, the judge opens in a lane of its own cut at it (#1053); a note it commits there moves its head on.
  const lane = cwdOf(d, judge!)
  assert.equal(await git(lane, 'rev-parse', 'HEAD'), picked, 'the judge’s checkout holds the work it judges')
  assert.notEqual(lane, competing, 'in a lane of its own, never the competitor’s')
  await git(lane, 'commit', '-q', '--allow-empty', '-m', 'the judge’s own note')
  assert.notEqual(await git(lane, 'rev-parse', 'HEAD'), picked, 'the judge sits on a head of its own')
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

/*
 * Issue #1032, gap 1: a mixed check result has no rule that covers it, so the
 * run stalled before the judge round instead of letting the judge decide.
 * `to-judge` now fires on `any: [pass]`, so the judge round opens once every
 * competitor's check has finished and at least one passed — with every
 * competitor's own check result still on the board as the judge's evidence,
 * so it sees which one failed.
 * Only when nothing passed at all does no rule fire, which is how this flow
 * already stops a run for a person, plainly, rather than stalling.
 */
test('a mixed pass/fail race still reaches the judge, with every competitor’s check result as evidence', E2E, async (t) => {
  const d = await desk(t)
  const run = await start(d, await comparison(d, 2), TASK)
  const [passer, failer] = await claimed(d, run.goal, 'competitor', 2)
  const passingHead = await write(d, passer!, 'a real attempt')
  // The other competitor never writes attempt.txt, so its own isolated
  // checkout fails "test -s attempt.txt" — a real, distinct check result,
  // not a stand-in for one.
  const said = await d.host.teamPlane.complete(failer!.id, {}, scopeOf(failer!))
  assert.doesNotMatch(said, /^Refused/, said)

  const [judge] = await claimed(d, run.goal, 'judge', 1)
  const verifies = (await board(d, run.goal)).filter((one) => one.role === 'verify')
  assert.equal(verifies.length, 2, 'one check card per competitor, even though only one passed')
  assert.deepEqual(verifies.map((one) => one.outcome).sort(), ['fail', 'pass'], 'both results are on the board, not just the winner’s')

  await review(d, judge!, 'picked', passingHead)
  const referee = await person(d, run.goal, 'referee', 'merged')
  assert.match(`${referee.title}\n${referee.detail ?? ''}`, new RegExp(passingHead), 'the merge card names the passing attempt the judge picked')
  await settled(d, run.id)
})

/*
 * Issue #1032, gap 1's other half: when nothing passed, the run stops for a
 * person instead of opening a judge round with nothing to judge — and the
 * stop names the cards and their outcomes rather than leaving a person to
 * guess why the run went quiet.
 */
test('an all-fail race stops for the person, plainly, instead of opening a judge round', E2E, async (t) => {
  const d = await desk(t)
  const run = await start(d, await comparison(d, 2), TASK)
  const competitors = await claimed(d, run.goal, 'competitor', 2)
  for (const card of competitors) {
    const said = await d.host.teamPlane.complete(card.id, {}, scopeOf(card))
    assert.doesNotMatch(said, /^Refused/, said)
  }
  const done = await settled(d, run.id)
  const finalBoard = await board(d, run.goal)
  const verifies = finalBoard.filter((one) => one.role === 'verify')
  assert.equal(verifies.length, 2, 'a check card ran for each competitor')
  assert.ok(verifies.every((one) => one.outcome === 'fail'), 'no competitor’s check passed')
  assert.equal(finalBoard.find((one) => one.role === 'judge'), undefined, 'no judge round opens when nothing passed')
  assert.match(done.reason ?? '', /fail/, 'the stop names what each card answered, not a silent halt')
})

test('a person review step lists the attempts, records the pick, and opens the referee on that revision', E2E, async (t) => {
  const d = await desk(t)
  const source = await readFile(fileURLToPath(new URL('./fixtures/comparison-person.yml', import.meta.url)), 'utf8')
  const run = await start(d, source, TASK)
  const competitors = await claimed(d, run.goal, 'competitor', 2)
  const heads = [] as string[]
  for (const [index, card] of competitors.entries()) heads.push(await write(d, card, `attempt ${index + 1}`))

  const personCard = await whenChanged(d, async () => {
    const next = (await board(d, run.goal)).find((one) => one.role === 'judge')
    return next?.state === 'open' ? next : null
  }, 'the open person judge card')
  const call = d.host.call.bind(d.host) as (method: string, params: Record<string, unknown>) => Promise<unknown>
  const offered = await call('flow/review/candidates', { run: run.id, card: personCard.id }) as readonly { id: string; card: number; at: string; branch: string | null; evidence: readonly string[] }[]
  assert.equal(offered.length, 2)
  assert.deepEqual(new Set(offered.map((one) => one.at)), new Set(heads))
  assert.ok(offered.every((one) => one.branch && one.evidence.length > 0), 'each attempt includes branch and check evidence')
  const picked = offered.find((one) => one.at === heads[1])!
  const decided = await call('flow/review/decide', { run: run.id, card: personCard.id, candidate: picked.id, verdict: 'picked' }) as import('@harnessdesk/protocol').FlowExecution
  assert.equal((await board(d, run.goal)).find((one) => one.id === personCard.id)?.outcome, 'picked')

  const referee = await person(d, run.goal, 'referee', 'merged')
  assert.match(`${referee.title}\n${referee.detail ?? ''}`, new RegExp(heads[1]!))
  const done = await settled(d, run.id)
  assert.equal(decided.state, 'running')
  assert.ok(done.rounds.find((one) => one.role === 'referee')?.evidence.length)
})

for (const [findingOn, dirtyLoser] of [['loser', false], ['loser', true], ['picked', false]] as const) {
  test(`comparison: a P1 on the ${findingOn} attempt ${findingOn === 'loser' ? 'does not block' : 'still blocks'} the person step${dirtyLoser ? ' after the losing checkout changes' : ''}`, E2E, async (t) => {
    const d = await desk(t)
    const run = await start(d, await comparison(d, 2), TASK)
    const competitors = await claimed(d, run.goal, 'competitor', 2)
    const heads: string[] = []
    for (const [index, card] of competitors.entries()) heads.push(await write(d, card, `attempt ${index + 1}`))
    const [judge] = await claimed(d, run.goal, 'judge', 1)
    const scope = scopeOf(judge!)
    const candidates = await d.host.teamPlane.reviewCandidates(judge!.id, scope)
    const candidate = candidates.find((one) => one.at === heads[findingOn === 'loser' ? 0 : 1])!
    const raised = await d.host.teamPlane.raiseFinding({
      intent: judge!.id, candidate: candidate.id, request: 'p1', title: 'P1: the retry never stops',
      body: 'A failed request retries forever.', blocking: true, category: 'ordinary',
    }, scope)
    await d.host.teamPlane.recordReview({ intent: judge!.id, candidate: candidates.find((one) => one.at === heads[0])!.id, verdict: 'neither' }, scope)
    if (dirtyLoser) await writeFile(`${cwdOf(d, competitors[0]!)}/losing-local.txt`, 'A local change on the unselected attempt.\n')
    await review(d, judge!, 'picked', heads[1]!)
    if (findingOn === 'loser') {
      await whenChanged(d, async () => {
        const now = await execution(d, run.id)
        return now.rounds.at(-1)?.state === 'waiting-evidence' || (await board(d, run.goal)).some((one) => one.role === 'referee') ? true : null
      }, 'the rule to select the person step or report its blocker')
      assert.ok((await board(d, run.goal)).some((one) => one.role === 'referee'), (await execution(d, run.id)).reason ?? 'no referee')
      const referee = await person(d, run.goal, 'referee', 'merged')
      assert.match(referee.detail ?? '', new RegExp(heads[1]!))
      await settled(d, run.id)
      const page = await d.host.call('finding/list', { goal: run.goal })
      const finding = page.rows.find((one) => one.id === raised.id)!
      assert.equal(finding.activeBlocking, false)
      assert.match(finding.inactiveReason ?? '', /The review selected revision/)
      assert.match(finding.inactiveReason ?? '', new RegExp(heads[1]!.slice(0, 12)))
      assert.equal(finding.lifecycle.state, 'open')
      assert.equal(page.totals?.blocking, 0)
      assert.equal((await d.host.call('finding/list', { goal: run.goal, filter: 'blocking' })).rows.length, 0)
      const detail = await d.host.call('finding/read', { goal: run.goal, finding: raised.id })
      assert.equal(detail.finding.inactiveReason, finding.inactiveReason)
    } else {
      const stalled = await whenChanged(d, async () => {
        const now = await execution(d, run.id)
        return now.rounds.at(-1)?.state === 'waiting-evidence' ? now : null
      }, 'picked attempt blocker to hold the rule')
      assert.match(stalled.reason ?? '', /1 open blocking finding/)
      assert.equal((await board(d, run.goal)).some((one) => one.role === 'referee'), false)
    }
    assert.equal(raised.lifecycle.state, 'open', 'selection never pretends the finding was repaired')
  })
}

test('an ordinary write and review flow with review evidence still holds its person step on an admitted blocker', E2E, async (t) => {
  const d = await desk(t)
  const source = (await shipped(d, 'independent-review')).replace('when: { every: [approve] }', 'when: { every: [approve], evidence: [{ review: approve }] }')
  const run = await start(d, source, TASK)
  await write(d, (await claimed(d, run.goal, 'build', 1))[0]!, 'built')
  const reviewers = await claimed(d, run.goal, 'specialists', 3)
  const first = reviewers[0]!
  const [candidate] = await d.host.teamPlane.reviewCandidates(first.id, scopeOf(first))
  await d.host.teamPlane.raiseFinding({
    intent: first.id, candidate: candidate!.id, request: 'ordinary-p1', title: 'P1: the retry never stops',
    body: 'A failed request retries forever.', category: 'ordinary', blocking: true,
  }, scopeOf(first))
  for (const card of reviewers) await review(d, card, 'approve')
  const waiting = await whenChanged(d, async () => {
    const now = await execution(d, run.id)
    return now.rounds.at(-1)?.state === 'waiting-evidence' ? now : null
  }, 'ordinary review blocker to hold the person step')
  assert.match(waiting.reason ?? '', /1 open blocking finding/)
  assert.equal((await board(d, run.goal)).some((one) => one.role === 'ship'), false)
})
