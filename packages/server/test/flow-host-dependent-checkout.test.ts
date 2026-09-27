import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  answer, board, claimed, cwdOf, desk, type Desk, E2E, execution, git, review, start, TASK, whenChanged, write,
} from './fixtures/flow-host-evidence.js'

/*
 * Issue #1053. A card handed an isolated predecessor's finished work was
 * seated in a checkout that did not contain it: UC1's tester, not isolated,
 * ran the tests in the Goal's own checkout, still at the commit the run
 * started from, and answered request-changes about code it never had. Sibling
 * analysts in a debate were told nothing of where the other's position was.
 * A card whose work is one predecessor's commit now opens in a lane cut at
 * that commit; a card handed several is told, in its order, the exact commit,
 * branch and folder of each; and a predecessor whose work cannot be reached
 * stops the round before the card opens, naming it.
 */

const RELAY = `
version: 2
name: Relay
inputs:
  task:
    label: Task
roles:
  dev: { kind: agent, uses: implementer, isolate: true, grant: edit, independentOf: [] }
  tester: { kind: agent, uses: test-reviewer, grant: read, independentOf: [] }
seed: { role: dev, title: "{{task}}" }
rules:
  - { id: to-test, on: dev, then: { role: tester, title: "Test it" } }
messaging: board-only
`

const DEBATE = `
version: 2
name: Debate
inputs:
  task:
    label: Task
roles:
  analyst: { kind: agent, uses: requirements-analyst, count: 2, isolate: true, grant: edit, blind: true, independentOf: [] }
seed: { role: analyst, title: "Position {{n}} of {{count}}" }
rules:
  - { id: debate, on: analyst, when: { any: [disagree] }, then: { role: analyst, title: "Debate round {{round}}" } }
messaging: board-only
`

/**
 * Every message a Seat was sent, by its session id. Each Seat ends the turn
 * its brief started as soon as it has read it, as an agent with nothing to
 * ask does, so the card order the desk left for the end of that turn is sent.
 */
const ordersOf = (d: Desk): Map<string, string[]> => {
  const sent = new Map<string, string[]>()
  for (const runtime of d.runtimes) {
    runtime.onSend = (session, text, opts) => {
      sent.set(String(session.id), [...(sent.get(String(session.id)) ?? []), text])
      if (opts?.recordAs === 'notice' && text.startsWith('Do the ')) setImmediate(() => session.finish())
    }
  }
  return sent
}

test('a tester after an isolated dev opens in a checkout that holds the dev’s commit', E2E, async (t) => {
  const d = await desk(t)
  const run = await start(d, RELAY, TASK)
  const [dev] = await claimed(d, run.goal, 'dev', 1)
  const devLane = cwdOf(d, dev!)
  assert.notEqual(devLane, d.root, 'the dev works in a lane of its own')
  const head = await write(d, dev!, 'the dev’s change')

  const [tester] = await claimed(d, run.goal, 'tester', 1)
  const where = cwdOf(d, tester!)
  assert.equal(await git(where, 'rev-parse', 'HEAD'), head, 'the tester’s own checkout is at the dev’s commit')
  assert.equal(await readFile(join(where, 'attempt.txt'), 'utf8'), 'the dev’s change\n', 'and holds the dev’s file')
  assert.notEqual(where, devLane, 'never the dev’s own lane')
  assert.notEqual(await git(d.root, 'rev-parse', 'HEAD'), head, 'the person’s own checkout was not moved')
  await review(d, tester!, 'approve', head)
})

test('debate siblings in isolated lanes: each next-round card is told where both positions are, and reaches both', E2E, async (t) => {
  const d = await desk(t)
  const sent = ordersOf(d)
  const run = await start(d, DEBATE, TASK)
  const first = await claimed(d, run.goal, 'analyst', 2)
  const positions: string[] = []
  for (const [index, card] of first.entries()) positions.push(await write(d, card, `position ${index + 1}`, 'disagree'))
  assert.notEqual(positions[0], positions[1])

  const second = await whenChanged(d, async () => {
    const cards = (await board(d, run.goal)).filter((one) => one.role === 'analyst' && !first.some((prior) => prior.id === one.id))
    return cards.length === 2 && cards.every((one) => one.claim) ? cards : null
  }, 'the debate round')
  await claimed(d, run.goal, 'analyst', 2)
  for (const card of second) {
    const where = cwdOf(d, card)
    const order = await whenChanged(d, () => (sent.get(card.claim!.sessionId) ?? []).find((one) => one.includes(`Card #${card.id} `)) ?? null,
      `card #${card.id}'s order`)
    for (const [index, at] of positions.entries()) {
      assert.match(order, new RegExp(`#${first[index]!.id}\\b[^\\n]*${at}`), `card #${card.id} is told position ${index + 1}'s commit`)
      assert.match(order, new RegExp(cwdOf(d, first[index]!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'and where that lane is')
      await git(where, 'cat-file', '-e', `${at}^{commit}`)
      assert.equal(await git(where, 'show', `${at}:attempt.txt`), `position ${index + 1}`, 'and reaches it from its own checkout')
    }
  }
  for (const card of second) await answer(d, card, 'agreed')
})

test('a predecessor whose lane is gone stops the round before its dependent opens, naming both cards', E2E, async (t) => {
  const d = await desk(t)
  const run = await start(d, RELAY, TASK)
  const [dev] = await claimed(d, run.goal, 'dev', 1)
  const lane = cwdOf(d, dev!)
  await git(lane, 'commit', '-q', '--allow-empty', '-m', 'work')
  await rm(lane, { recursive: true, force: true })
  await d.host.teamPlane.complete(dev!.id, {}, { runtime: dev!.claim!.runtime, sessionId: dev!.claim!.sessionId })

  const stalled = await whenChanged(d, async () => {
    const now = await execution(d, run.id)
    return now.state === 'stalled' ? now : null
  }, 'the run to stop before the tester opens')
  const tester = (await board(d, run.goal)).find((one) => one.role === 'tester')
  assert.ok(tester, 'the tester card exists, so the stop can name it')
  assert.equal(tester.state, 'open', 'no Seat took it')
  assert.match(stalled.reason ?? '', new RegExp(`Card #${tester.id}\\b`))
  assert.match(stalled.reason ?? '', new RegExp(`card #${dev!.id}\\b`))
  assert.match(stalled.reason ?? '', /no commit/)
})
