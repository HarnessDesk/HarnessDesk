import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'

import { HANDOFF_PREFIX, type CarryOnIncidentView } from '@harnessdesk/protocol'

import { claimed, desk, execution, scopeOf, start, whenChanged, type Desk } from './fixtures/flow-host-evidence.js'

/*
 * A Flow seat out of its usage limit, through the real host (design §9,
 * §11.4): the question waits on the person without the seat's own recovery
 * handing its card back underneath it; a stop gives the seat back to that
 * recovery; a switch seats a replacement for the same card and hands it the
 * work so far as its first work message.
 */

const FLOW = `
version: 2
name: Write it
roles:
  author: { kind: agent, uses: implementer }
  person: { kind: person, outcomes: [done] }
seed: { role: author, title: Write it }
rules:
  - { id: decide, on: author, then: { role: person, title: Decide } }
`

interface Seated {
  readonly d: Desk
  readonly run: string
  readonly sent: { readonly runtime: string; readonly session: string; readonly text: string }[]
  readonly seat: { readonly runtime: string; readonly sessionId: string }
  readonly incident: CarryOnIncidentView
}

const incidents = async (d: Desk): Promise<readonly CarryOnIncidentView[]> =>
  ((await d.host.call('carryOn/list', {})) as { incidents: readonly CarryOnIncidentView[] }).incidents

/** A one-step Flow whose author seat hits its usage limit while the desk is set to ask. */
const stuckSeat = async (t: TestContext): Promise<Seated> => {
  const d = await desk(t)
  await d.host.call('app/state/set', { patch: { carryOn: { onLimit: 'ask', otherAgents: true } } })
  const sent: Seated['sent'] = []
  for (const runtime of d.runtimes) runtime.onSend = (session, text) => { sent.push({ runtime: String(runtime.info.id), session: String(session.id), text }) }
  const run = await start(d, FLOW, {})
  const [card] = await claimed(d, run.goal, 'author', 1)
  const seat = scopeOf(card!)
  const session = await whenChanged(d, () => {
    const one = d.runtimes[0]!.sessions.get(seat.sessionId as never)
    return one && sent.some((s) => s.session === seat.sessionId) ? one : null
  }, 'the seat in a turn')
  session.fail('You have hit your usage limit.', 'credits')
  const incident = await whenChanged(d, async () => (await incidents(d)).find((one) => one.owner === 'seat' && one.state === 'asked') ?? null, 'the seat asking')
  return { d, run: run.id, sent, seat, incident }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

test('a seat asking about its limit is not handed its card again until the person answers; a stop gives it back to its own recovery', { timeout: 120_000 }, async (t) => {
  const { d, sent, seat, incident } = await stuckSeat(t)
  assert.equal(incident.sessionId, seat.sessionId)
  const before = sent.filter((one) => one.session === seat.sessionId).length
  await settle()
  assert.equal(sent.filter((one) => one.session === seat.sessionId).length, before, 'no re-arm while the question is open')

  await d.host.call('carryOn/decide', { incidentId: incident.incidentId, choice: 'stop', always: false })
  await whenChanged(d, () => sent.filter((one) => one.session === seat.sessionId).length > before ? true : null, 'the card handed back to the stopped seat')
  assert.equal((await incidents(d)).length, 0, 'nothing is left to answer')
})

test('a switch seats a replacement for the same card, hands it the work so far, and the run lists both seats', { timeout: 120_000 }, async (t) => {
  const { d, run, sent, seat, incident } = await stuckSeat(t)
  const target = incident.choices.target
  assert.ok(target, 'another agent is offered')
  assert.equal(target.mode, 'handoff')
  await d.host.call('carryOn/decide', { incidentId: incident.incidentId, choice: 'switch', always: false })

  const round = await whenChanged(d, async () => {
    const now = await execution(d, run)
    return now.rounds[0]!.seats.length === 2 ? now.rounds[0]! : null
  }, 'the replacement seat in the round')
  const replacement = d.runtimes.find((one) => String(one.info.id) === target.runtime)!
  const brief = await whenChanged(d, () => sent.find((one) => one.runtime === target.runtime) ?? null, 'the replacement briefed')
  assert.ok(!brief.text.includes(HANDOFF_PREFIX), 'the replacement is briefed for its role first')
  // The brief's turn ends; the packet is the first work message after it.
  replacement.sessions.get(brief.session as never)!.finish('Ready.')
  const packet = await whenChanged(d, () => sent.find((one) => one.runtime === target.runtime && one.text.includes(HANDOFF_PREFIX)) ?? null, 'the handoff packet')
  assert.equal(packet.session, brief.session)
  const order = await whenChanged(d, () => sent.find((one) => one.runtime === target.runtime && one.text.startsWith('Card #')) ?? null, 'the card handed to the replacement')
  assert.ok(sent.indexOf(packet) < sent.indexOf(order), 'the work so far arrives before the card')
  const goal = (await execution(d, run)).goal
  const board = (await d.host.call('goal/read', { goal })) as { board: { intents: readonly { role?: string; claim?: { runtime: string; sessionId: string } | null }[] } }
  const card = board.board.intents.find((one) => one.role === 'author')!
  assert.deepEqual([card.claim?.runtime, card.claim?.sessionId], [target.runtime, packet.session], 'the card is claimed by the replacement')
  assert.equal(round.seats.length, 2, 'the round lists the stopped seat, then its replacement')
  assert.equal((await execution(d, run)).state, 'running')
})
