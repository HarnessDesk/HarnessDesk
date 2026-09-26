import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runtimeId, type GoalView, type Session } from '@harnessdesk/protocol'

import { board, claimed, desk, E2E, execution, scopeOf, start, whenChanged } from './fixtures/flow-host-evidence.js'

/*
 * The real Host, not the engine's rig: the claim an opening flow Seat is
 * given is the host's own, and it is held to the board's file rule (#1015).
 * The contract agrees a split; one part of it overlaps a card somebody else
 * already holds; that part's Seat is refused by name, and the sibling Seat
 * the round already opened is let go, so the two are never both seated.
 */
const PAIR = `
version: 2
name: Pair build
roles:
  contract: { kind: agent, uses: implementer, grant: edit }
  dev: { kind: agent, uses: implementer, count: 2, isolate: true, grant: edit }
seed: { role: contract, title: Agree the split }
rules:
  - { id: build, on: contract, then: { role: dev, title: "Build part {{n}}", split: contract } }
`

test('a flow Seat whose part overlaps a live claim is refused by the host by name, and its sibling is let go', E2E, async (t) => {
  const d = await desk(t)
  const run = await start(d, PAIR, {})
  const [contract] = await claimed(d, run.goal, 'contract', 1)

  // Somebody else holds a file inside the second part.
  const held = await d.host.call('team/add', { room: run.goal, title: 'The guide', files: ['docs/guide.md'] }) as { id: number }
  const other = await d.host.call('session/create', { runtime: runtimeId('fake'), options: { cwd: d.root } }) as Session
  await d.host.call('goal/assign', { goal: run.goal, card: held.id, session: { runtime: 'fake', sessionId: other.id } })

  const said = await d.host.teamPlane.complete(contract!.id, { split: [['src/**'], ['docs/**']] }, scopeOf(contract!))
  assert.doesNotMatch(said, /^Refused/, said)
  const stalled = await whenChanged(d, async () => {
    const now = await execution(d, run.id)
    return now.state === 'stalled' ? now : null
  }, 'the dev round to stop')

  const dev = (await board(d, run.goal)).filter((card) => card.role === 'dev')
  const second = dev.find((card) => card.files.includes('docs/**'))!
  assert.match(stalled.reason ?? '', new RegExp(`Refused: the files of card #${second.id} overlap a live claim — docs/guide\\.md is held by #${held.id}`))
  assert.deepEqual(dev.map((card) => card.state), ['open', 'open'], 'neither dev card is left claimed')
  const members = (await d.host.call('goal/read', { goal: run.goal }) as GoalView).members
  // Dev Seats are isolated, so any left open would stand in a lane of its own.
  assert.deepEqual(members.filter((seat) => seat.closed === null && seat.checkout.cwd !== d.root).map((seat) => seat.id), [], 'no dev Seat is left seated')
  assert.ok(stalled.rounds.at(-1)!.seats.length >= 1, 'the sibling was opened before the refusal, so it was let go, not never tried')
})
