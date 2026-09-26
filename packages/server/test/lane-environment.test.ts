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
  laneEnvironmentFor,
  laneStandingOrder,
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

const laneRuntime = (sessionEnvironment: boolean) => ({
  info: { capabilities: { sessionEnvironment } },
})

test('a lane hands its six values only to a runtime that can take them per session, and never refuses one that cannot', () => {
  const environment = environmentForCheckout('/work/lane-a', [lane()])
  assert.deepEqual(laneEnvironmentFor(laneRuntime(true), environment), environment)
  // Measured: a comparison with a competitor on an agent whose own ACP server
  // claims nothing, or on a row running a bridge built before lane support,
  // could not start at all, because this refused. The lane is the checkout; the values are a
  // convenience its standing order carries anyway.
  assert.equal(laneEnvironmentFor(laneRuntime(false), environment), undefined)
  assert.equal(laneEnvironmentFor(laneRuntime(true), undefined), undefined)
})

test('a Seat that was not handed the values is told they are not in its environment', () => {
  const environment = environmentForCheckout('/work/lane-a', [lane()])
  const told = laneStandingOrder('Do the work.', environment, false)
  assert.match(told, /^Do the work\.\n\nThis Seat has a dedicated HarnessDesk lane\. Its reserved values are below\. They are not set in your environment, so give them to each command explicitly \(for example PORT=30000 before the command\):\n/)
  for (const [key, value] of Object.entries(environment ?? {})) {
    assert.match(told, new RegExp(`^${key}=${value}$`, 'm'))
  }
  assert.doesNotMatch(laneStandingOrder('Do the work.', environment, true), /not set in your environment/)
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
    .find((item) => item.type === 'notice')
  assert.ok(order?.type === 'notice')
  const text = order.text
  for (const [key, value] of Object.entries(handed ?? {})) {
    assert.match(text, new RegExp(`^${key}=${value}$`, 'm'))
  }
  assert.match(text, /ignore PORT.*explicit port argument.*inclusive/i)
})

test('real Goal seating opens a runtime without session environments in its lane, confined to the lane, and tells it the values', async (t) => {
  const { host, runtime, stateDir, repo } = await evidenceDesk(t)
  await writeAgent(stateDir, 'worker', 'Worker')
  ;(runtime as unknown as { info: RuntimeInfo }).info = {
    ...runtime.info,
    capabilities: { ...runtime.info.capabilities, sessionEnvironment: false },
  }
  const created = (await host.call('goal/create', {
    root: repo.dir,
    sentence: 'Prove the isolated lane without variables',
    checkout: 'isolated',
  })) as GoalView
  const seat = (await host.call('goal/seat', { goal: created.goal.id, agent: 'worker' })) as SeatRecord
  const lanes = (await host.call('lane/list', {})) as readonly Lane[]
  const mine = lanes.find((one) => one.seat === String(seat.id))
  assert.ok(mine, 'the Seat holds a lane')
  assert.notEqual(mine.cwd, repo.dir, 'never the main checkout')
  assert.equal(runtime.lastCreateOptions?.cwd, mine.cwd, 'the conversation opened in the lane')
  assert.equal(runtime.lastCreateOptions?.environment, undefined, 'no variables it cannot take')

  const session = (await host.call('session/read', {
    runtime: runtimeId(seat.session.runtime),
    sessionId: sessionId(seat.session.sessionId),
  })) as Session
  const order = session.turns.flatMap((turn) => turn.items).find((item) => item.type === 'notice')
  assert.ok(order?.type === 'notice')
  assert.match(order.text, /They are not set in your environment, so give them to each command explicitly/)
  assert.match(order.text, new RegExp(`^HARNESSDESK_LANE_ID=${mine.id}$`, 'm'))
  assert.match(order.text, new RegExp(`^PORT=${mine.ports.start}$`, 'm'))
})
