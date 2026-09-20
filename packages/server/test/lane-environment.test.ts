import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  runtimeId,
  sessionId,
  type GoalView,
  type Lane,
  type RuntimeInfo,
  type SeatRecord,
  type Session,
} from '@harnessdesk/protocol'

import {
  environmentForCheckout,
  environmentForSession,
  laneStandingOrder,
  requireLaneSupport,
} from '../src/goals/lane-environment.js'
import { evidenceDesk, writeAgent } from './fixtures/evidence-desk.js'

const lane = (state: Lane['state'] = 'active'): Lane => ({
  id: 'a',
  goal: 'g1',
  seat: 's1',
  cwd: '/work/lane-a',
  branch: 'harnessdesk/lane-a',
  ports: { start: 30_000, end: 30_019 },
  browserProfile: null,
  state,
  createdAt: 1,
})

test('a released Seat keeps retained checkout environment and released ports refuse resume', () => {
  assert.equal(environmentForCheckout('/work/lane-a', [lane('retained')])?.PORT, '30000')
  assert.throws(() => environmentForCheckout('/work/lane-a', [lane('released')]), /ports were released/)
  assert.equal(environmentForCheckout('/work/plain', [lane()]), undefined)
  assert.throws(
    () => environmentForCheckout('/work/lane-a', [lane(), { ...lane(), id: 'b' }]),
    /conflicting/,
  )
})

test('resume finds a lane from its durable Seat without reading an unknown conversation', () => {
  const seat = {
    id: 's1',
    session: { runtime: 'fake', sessionId: 'conversation-1' },
  }
  assert.equal(environmentForSession('fake', 'conversation-1', [lane('retained')], [seat])?.PORT, '30000')
  assert.equal(environmentForSession('fake', 'plain', [lane()], [seat]), undefined)
  assert.throws(
    () => environmentForSession('fake', 'conversation-1', [lane(), { ...lane(), id: 'b' }], [seat]),
    /conflicting/,
  )
})

test('unsupported isolated candidates refuse with the candidate name and a fix', () => {
  const runtime = {
    capabilities: { sessionEnvironment: false },
    presentation: { name: 'Fixture Runtime' },
  }
  const environment = environmentForCheckout('/work/lane-a', [lane()])
  assert.throws(
    () => requireLaneSupport(runtime, environment),
    /Fixture Runtime.*turn isolation off/,
  )
  assert.doesNotThrow(() => requireLaneSupport(runtime, undefined))
  assert.doesNotThrow(() =>
    requireLaneSupport(
      { ...runtime, capabilities: { sessionEnvironment: true } },
      environment,
    ),
  )
})
test('the standing order names all six values and explicit-port advice without changing plain text', () => {
  const text = 'Do the work.'
  const environment = environmentForCheckout('/work/lane-a', [lane()])
  assert.equal(laneStandingOrder(text, undefined), text)
  const order = laneStandingOrder(text, environment)
  assert.match(order, /^Do the work\.\n\nThis Seat has a dedicated HarnessDesk lane\./)
  for (const [key, value] of Object.entries(environment ?? {})) {
    assert.match(order, new RegExp(`^${key}=${value}$`, 'm'))
  }
  assert.match(order, /ignore PORT.*explicit port argument.*inclusive/i)
})

test('real Goal seating sends the durable lane map to the runtime and the first standing order', async (t) => {
  const { host, runtime, stateDir, repo } = await evidenceDesk(t)
  await writeAgent(stateDir, 'worker', 'Worker')
  ;(runtime as unknown as { info: RuntimeInfo }).info = {
    ...runtime.info,
    capabilities: { ...runtime.info.capabilities, sessionEnvironment: true },
  }
  const created = (await host.call('goal/create', {
    root: repo.dir,
    sentence: 'Prove the isolated lane',
    checkout: 'isolated',
  })) as GoalView
  const seat = (await host.call('goal/seat', {
    goal: created.goal.id,
    agent: 'worker',
  })) as SeatRecord
  const handed = runtime.lastCreateOptions?.environment
  assert.equal(handed?.HARNESSDESK_GOAL_ID, created.goal.id)
  assert.ok(handed?.HARNESSDESK_LANE_ID)
  assert.equal(handed?.PORT, handed?.HARNESSDESK_PORT_START)
  assert.equal(Object.keys(handed ?? {}).length, 6)

  const session = (await host.call('session/read', {
    runtime: runtimeId(seat.session.runtime),
    sessionId: sessionId(seat.session.sessionId),
  })) as Session
  const order = session.turns
    .flatMap((turn) => turn.items)
    .find((item) => item.type === 'userMessage')
  assert.ok(order?.type === 'userMessage')
  const text = order.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
  for (const [key, value] of Object.entries(handed ?? {})) {
    assert.match(text, new RegExp(`^${key}=${value}$`, 'm'))
  }
  assert.match(text, /ignore PORT.*explicit port argument.*inclusive/i)
})
