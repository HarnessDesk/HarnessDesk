import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  board, claimed, cwdOf, desk, E2E, git, person, review, scopeOf, settled, shipped, start, TASK, type Behaviour, whenChanged, workInsideTheBrief, write,
} from './fixtures/flow-host-evidence.js'

/*
 * Review shapes: the shipped `independent-review` and `fan-out` flows, and
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
  assert.deepEqual(cards.map((one) => [one.role, one.state]), [['build', 'done'], ['specialists', 'done'], ['specialists', 'done'], ['ship', 'done']])
  // Nothing re-opened a finished card: no card was handed a second order after it was done.
  const reordered = done.operations.filter((one) => one.kind === 'turn' && one.state !== 'finished' && one.state !== 'prepared')
  assert.deepEqual(reordered, [])
})

test('the independent review flow reaches its end', E2E, async (t) => {
  const d = await desk(t)
  const run = await start(d, await shipped(d, 'independent-review'), TASK)
  await write(d, (await claimed(d, run.goal, 'build', 1))[0]!, 'built')
  for (const card of await claimed(d, run.goal, 'specialists', 2)) await review(d, card, 'approve')
  await person(d, run.goal, 'ship', 'shipped')
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
