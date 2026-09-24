import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { test } from 'node:test'

import { builtinFlowRoot } from '../src/host.js'
import { answer, claimed, desk, E2E, person, review, settled, shipped, start, TASK, write } from './fixtures/flow-host-evidence.js'

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
  const run = await start(d, await shipped(d, 'mechanical-contest'), TASK)
  const competitors = await claimed(d, run.goal, 'competitor', 2)
  for (const [index, card] of competitors.entries()) await write(d, card, `attempt ${index + 1}`)
  await person(d, run.goal, 'referee', 'merged')
  await settled(d, run.id)
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

test('every flow that ships is one the flow-host-evidence files run to its end', async () => {
  const ids = (await readdir(builtinFlowRoot())).filter((one) => one.endsWith('.yml')).map((one) => one.slice(0, -4)).sort()
  assert.deepEqual(ids, ['alignment', 'comparison', 'fan-out', 'independent-review', 'investigation', 'mechanical-contest', 'staged-relay'])
})
