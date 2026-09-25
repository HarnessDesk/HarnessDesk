import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  answer, board, claimed, cwdOf, desk, E2E, git, person, review, scopeOf, settled, shipped, start, TASK, type Behaviour, whenChanged, workInsideTheBrief, write,
} from './fixtures/flow-host-evidence.js'

/*
 * Review shapes: the shipped `review`, `independent-review`, `fan-out` and `review-pr` flows, and
 * a hand-written flow whose `to-ship` rule waits on three evidence guards
 * at once (a check, green CI, an open pull request). Split out of
 * `flow-host-evidence.test.ts` (see that file's sibling `-comparison`,
 * `-investigation` and `-flows` files) so no single file's cases add up to
 * the suite's `--test-timeout`; the rig they all share lives in
 * `test/fixtures/flow-host-evidence.ts`.
 */

test('independent review with every Seat working inside its brief: each completion persists and the specialists open', E2E, async (t) => {
  const d = await desk(t, undefined, { refusesWhileBusy: true })
  // A reviewer asks for what it may judge until it is offered something, as an agent working its card does.
  const reviewInside: Behaviour = async (desk, card) => {
    await whenChanged(desk, async () => ((await desk.host.teamPlane.reviewCandidates(card.id, scopeOf(card))).length > 0 ? true : null), 'something to review')
    await review(desk, card, 'approve')
  }
  workInsideTheBrief(d, {
    build: async (desk, card) => { await write(desk, card, 'built') },
    specialists: reviewInside,
  })
  const run = await start(d, await shipped(d, 'independent-review'), TASK)
  await person(d, run.goal, 'ship', 'shipped')
  const done = await settled(d, run.id)
  assert.deepEqual(done.rounds.map((one) => one.role), ['build', 'specialists', 'ship'])
  const cards = await board(d, run.goal)
  assert.deepEqual(
    cards.map((one) => [one.role, one.state]),
    [['build', 'done'], ['specialists', 'done'], ['specialists', 'done'], ['specialists', 'done'], ['ship', 'done']],
  )
  // Nothing re-opened a finished card: no card was handed a second order after it was done.
  const reordered = done.operations.filter((one) => one.kind === 'turn' && one.state !== 'finished' && one.state !== 'prepared')
  assert.deepEqual(reordered, [])
})

test('the independent review flow reaches its end', E2E, async (t) => {
  const d = await desk(t)
  const run = await start(d, await shipped(d, 'independent-review'), TASK)
  await write(d, (await claimed(d, run.goal, 'build', 1))[0]!, 'built')
  for (const card of await claimed(d, run.goal, 'specialists', 3)) await review(d, card, 'approve')
  await person(d, run.goal, 'ship', 'shipped')
  await settled(d, run.id)
})

test('the review flow reaches its end: three read-only specialists, then the person', E2E, async (t) => {
  const d = await desk(t)
  // Started from the project, its bound inputs take their written defaults; a front-door start fills them from the target.
  const run = await start(d, await shipped(d, 'review'), {})
  // A seed round has no predecessor subject to be offered as a candidate, so its verdict is its card's own answer.
  for (const card of await claimed(d, run.goal, 'specialists', 3)) await answer(d, card, 'approve')
  await person(d, run.goal, 'decide', 'done')
  await settled(d, run.id)
})

test('the fan-out review flow reaches its end', E2E, async (t) => {
  const d = await desk(t)
  const run = await start(d, await shipped(d, 'fan-out'), TASK)
  await write(d, (await claimed(d, run.goal, 'build', 1))[0]!, 'built')
  for (const card of await claimed(d, run.goal, 'review', 3)) await review(d, card, 'approve')
  await person(d, run.goal, 'ship', 'shipped')
  await settled(d, run.id)
})

test('a check, green CI and an open pull request, each observed at the build revision, open the ship card together', E2E, async (t) => {
  const d = await desk(t)
  const source = [
    'version: 2',
    'name: Guarded ship',
    'inputs:',
    '  task:',
    '    label: Task',
    'roles:',
    '  build: { kind: agent, uses: implementer, grant: edit, isolate: true }',
    '  verify: { kind: check, run: "test -s attempt.txt", exits: { "0": pass }, otherwise: fail, timeout: 60 }',
    '  ship: { kind: person, outcomes: [shipped] }',
    'seed: { role: build, title: "{{task}}" }',
    'rules:',
    '  - { id: to-verify, on: build, then: { role: verify, title: Check it } }',
    '  - id: to-ship',
    '    on: verify',
    '    when: { every: [pass], evidence: [{ check: "test -s attempt.txt" }, { ci: green }, { pr: open }] }',
    '    then: { role: ship, title: "Ship pull request {{evidence.pr.number}} at {{evidence.check.at}}" }',
    'messaging: board-only',
    'wait: 240',
    '',
  ].join('\n')
  const run = await start(d, source, TASK)
  const [build] = await claimed(d, run.goal, 'build', 1)
  d.forge.open.add(await git(cwdOf(d, build!), 'symbolic-ref', '--short', 'HEAD'))
  const head = await write(d, build!, 'the build')
  const ship = await person(d, run.goal, 'ship', 'shipped')
  assert.equal(ship.title, `Ship pull request 41 at ${head}`)
  const done = await settled(d, run.id)
  assert.equal(done.rounds.find((one) => one.role === 'ship')!.evidence.length, 3, 'one fact for each guard')
})

test('the review-pr flow reaches its end', E2E, async (t) => {
  const d = await desk(t)
  const run = await start(d, await shipped(d, 'review-pr'), TASK)
  const [fixer] = await claimed(d, run.goal, 'fixer', 1)
  d.forge.open.add(await git(cwdOf(d, fixer!), 'symbolic-ref', '--short', 'HEAD'))
  await write(d, fixer!, 'fixed')
  for (const card of await claimed(d, run.goal, 'reviewer', 2)) await review(d, card, 'approve')
  // The mechanical check runs by itself, the way mechanical-contest's `decide` does; no card to drive.
  await person(d, run.goal, 'referee', 'merged')
  await settled(d, run.id)
})

/* The loop review-pr exists for: reviewers ask for changes, the fixer
   repairs — twice — they approve, the check runs, and the person referee
   still gets the card: the shipped budget has to reach that far. */
test('the review-pr flow reaches its person referee through two repairs', E2E, async (t) => {
  const d = await desk(t)
  /* Both fake runtimes mint `fake-session-<n>` from their own counters, so a
     third Seat on the first can be answered with an id the second already
     used, which the desk refuses as a conversation it holds. Real runtimes
     mint unique ids; this puts the first's counter out of the second's way. */
  for (let n = 0; n < 50; n += 1) await d.runtimes[0]!.createSession({ cwd: d.root })
  const run = await start(d, await shipped(d, 'review-pr'), TASK)
  const [fixer] = await claimed(d, run.goal, 'fixer', 1)
  d.forge.open.add(await git(cwdOf(d, fixer!), 'symbolic-ref', '--short', 'HEAD'))
  await write(d, fixer!, 'fixed')
  for (const attempt of ['repaired once', 'repaired twice']) {
    for (const card of await claimed(d, run.goal, 'reviewer', 2)) await review(d, card, 'request-changes')
    const [repair] = await claimed(d, run.goal, 'fixer', 1)
    // Each repair is its own Seat's checkout: the pull request the forge reports is the one on its branch.
    d.forge.open.add(await git(cwdOf(d, repair!), 'symbolic-ref', '--short', 'HEAD'))
    await write(d, repair!, attempt)
  }
  for (const card of await claimed(d, run.goal, 'reviewer', 2)) await review(d, card, 'approve')
  const referee = await person(d, run.goal, 'referee', 'merged')
  assert.equal(referee.role, 'referee', 'the person referee was reached, not a stop for the budget')
  const done = await settled(d, run.id)
  assert.equal(done.findings?.stopped ?? null, null)
})
