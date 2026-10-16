import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { builtinAgentRoot, builtinFlowRoot } from '../src/host.js'
import { answer, board, claimed, cwdOf, desk, E2E, git, person, review, settled, shipped, start, TASK, whenChanged, write } from './fixtures/flow-host-evidence.js'

/*
 * The remaining shipped flows — `alignment`, `mechanical-contest` and
 * `staged-relay` — each run once to their end, plus the census that every
 * flow this repository ships is one the `flow-host-evidence-*.test.ts`
 * files run. Split out of `flow-host-evidence.test.ts` (see that file's
 * sibling `-comparison`, `-investigation` and `-review` files) so no single
 * file's cases add up to the suite's `--test-timeout`; the rig they all
 * share lives in `test/fixtures/flow-host-evidence.ts`.
 */

test('the alignment flow reaches its end', E2E, async (t) => {
  const d = await desk(t)
  const run = await start(d, await shipped(d, 'alignment'), TASK)
  await answer(d, (await claimed(d, run.goal, 'propose', 1))[0]!, 'agreed')
  await person(d, run.goal, 'align', 'agreed')
  await write(d, (await claimed(d, run.goal, 'build', 1))[0]!, 'built')
  await settled(d, run.id)
})

test('the mechanical contest flow reaches its end', E2E, async (t) => {
  const d = await desk(t)
  await assert.rejects(readFile(join(d.root, 'script', 'flow-contest.sh')), { code: 'ENOENT' })
  const run = await start(d, await shipped(d, 'mechanical-contest'), TASK)
  const competitors = await claimed(d, run.goal, 'competitor', 2)
  for (const [index, card] of competitors.entries()) await write(d, card, `attempt ${index + 1}`)
  await person(d, run.goal, 'referee', 'merged')
  const done = await settled(d, run.id)
  assert.deepEqual(done.rounds.map(one => one.role), ['competitor', 'referee'])
  assert.equal(done.operations.some(one => one.kind === 'check'), false)
})

test('the staged relay flow reaches its end', E2E, async (t) => {
  const d = await desk(t)
  const run = await start(d, await shipped(d, 'staged-relay'), TASK)
  await answer(d, (await claimed(d, run.goal, 'analyze', 1))[0]!, 'agreed')
  await write(d, (await claimed(d, run.goal, 'build', 1))[0]!, 'built')
  await review(d, (await claimed(d, run.goal, 'test_review', 1))[0]!, 'approve')
  await person(d, run.goal, 'ship', 'shipped')
  await settled(d, run.id)
})

test('Write and review reaches its person referee after an independent review', E2E, async (t) => {
  const d = await desk(t)
  // Keep the shipped writer's answers and maximum; the Flow narrows it to
  // edit and routes on committed work without a pull request.
  const implementer = await readFile(join(builtinAgentRoot(), 'implementer', 'AGENT.md'), 'utf8')
  await writeFile(join(d.stateDir, 'agents', 'implementer', 'AGENT.md'), implementer.replace(/^prefer:.*$/m, 'prefer: [fake]'))
  const run = await start(d, await shipped(d, 'fix-and-review'), { work: TASK.task })
  const [fixer] = await claimed(d, run.goal, 'fixer', 1)
  const branch = await git(cwdOf(d, fixer!), 'symbolic-ref', '--short', 'HEAD')
  const head = await write(d, fixer!, 'written', 'committed')
  assert.equal(d.host.registry.get(fixer!.claim!.runtime as never, fixer!.claim!.sessionId as never)?.seatedAs?.ceiling?.level, 'edit')
  const [reviewer] = await claimed(d, run.goal, 'reviewer', 1)
  assert.notEqual(reviewer!.claim!.runtime, fixer!.claim!.runtime, 'the reviewer is independent of the writer')
  await review(d, reviewer!, 'approve')
  const handoff = await whenChanged(d, async () => (await board(d, run.goal)).find(card => card.role === 'referee' && card.state === 'open') ?? null, 'publication approval')
  assert.equal(handoff.title, 'Approve publishing the reviewed change')
  assert.ok(handoff.detail?.includes(head), 'the person sees the revision independently reviewed')
  assert.match(handoff.detail!, /branch named in the writer/)
  assert.equal(await git(d.root, 'symbolic-ref', '--short', 'HEAD'), branch)
  assert.equal(d.forge.open.size, 0, 'no pull request exists before the person approves publishing')
  assert.equal(d.forge.pullRequests.size, 0)
  await person(d, run.goal, 'referee', 'dropped')
  const done = await settled(d, run.id)
  assert.deepEqual(done.rounds.map((one) => one.role), ['fixer', 'reviewer', 'referee'])
})

test('every flow that ships is one the flow-host-evidence files run to its end', async () => {
  const ids = (await readdir(builtinFlowRoot())).filter((one) => one.endsWith('.yml')).map((one) => one.slice(0, -4)).sort()
  assert.deepEqual(ids, ['alignment', 'comparison', 'fan-out', 'fix-and-review', 'independent-review', 'investigation', 'mechanical-contest', 'review', 'review-pr', 'staged-relay'])
})
