import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { Intent, SeatRecord, TeamState } from '@harnessdesk/protocol'

import { Flows, type FlowPort } from '../src/flows.js'
import type { Team } from '../src/team.js'
import { intent, seat } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

const source = `
name: Work and review
roles:
  worker:
    kind: agent
    seat: fake
    count: 2
    permission: read
    outcomes: [done]
    order: Finish the assigned card.
seed:
  role: worker
  title: Finish the change
rules: []
`

const rig = (t: TestContext) => {
  const directory = tempDir('hd-goal-flow-')
  const events: string[] = []
  const records: SeatRecord[] = []
  const cards: Intent[] = []
  let failOpening = false
  let failOrder = false
  const state = (): TeamState => ({
    id: 'legacy-room', root: '/work/repo', name: 'Finish', updatedAt: 1,
    members: [], intents: cards, channel: [], messaging: true,
  })
  const team = {
    hasRoom: (id: string) => id === 'legacy-room',
    stateFor: state,
    peersFor: async () => [],
    addIntentForFlow: (_goal: string, input: Partial<Intent>) => {
      const card = intent(cards.length + 1, input)
      cards.push(card)
      return card
    },
  } as unknown as Team
  const port: FlowPort = {
    openLegacySeat: async (input) => {
      if (failOpening && records.length === 1) throw new Error('durable opening refused')
      const record = seat(`seat-${records.length + 1}`, {
        board: input.goal, role: input.role, seat: input.spec,
        standing: { kind: 'permission', permission: input.permission },
      })
      records.push(record)
      events.push(`record:${record.id}`)
      return record
    },
    releaseGoalSeat: async (goal, id) => {
      assert.equal(goal, 'legacy-room')
      events.push(`release:${id}`)
    },
    order: async (_runtime, id) => {
      assert.equal(records.length, 2, 'every opening is durable before any order')
      events.push(`order:${id}`)
      if (failOrder) throw new Error('order refused')
    },
    retire: async (_runtime, id) => { events.push(`retire:${id}`) },
    reseat: async () => 'Fake Runtime',
    confine: async () => {},
    run: async () => ({ status: 0 }),
    changed: () => {},
    log: () => {},
    recovery: { goal: () => ({ exists: true, writable: true }), seats: () => records },
  }
  const flows = new Flows(join(directory, 'flows'), team, port)
  t.after(async () => { await flows.flush() })
  return {
    flows, events, records,
    failOpening: () => { failOpening = true },
    failOrder: () => { failOrder = true },
  }
}

test('legacy flow openings are all durable before their orders and retain the room key', async (t) => {
  const proof = rig(t)
  const run = await proof.flows.start({ room: 'legacy-room', source })
  assert.deepEqual(proof.events, ['record:seat-1', 'record:seat-2', 'order:seat-1', 'order:seat-2'])
  assert.equal(proof.records.every((record) => record.board === 'legacy-room'), true)
  assert.equal(run.seats.length, 2)
  assert.equal(run.seats[0]?.permission, 'read')
  assert.equal(run.seats[0]?.spec?.runtime, 'fake')
})

test('a later failed opening retires and releases only the already-opened Seat, sending no order', async (t) => {
  const proof = rig(t)
  proof.failOpening()
  await assert.rejects(proof.flows.start({ room: 'legacy-room', source }), /durable opening refused/)
  assert.deepEqual(proof.events, ['record:seat-1', 'retire:seat-1', 'release:seat-1'])
})

test('a failed order stops every opened conversation before releasing its exact Goal Seat', async (t) => {
  const proof = rig(t)
  proof.failOrder()
  await assert.rejects(proof.flows.start({ room: 'legacy-room', source }), /order refused/)
  assert.deepEqual(proof.events, [
    'record:seat-1', 'record:seat-2', 'order:seat-1',
    'retire:seat-1', 'release:seat-1', 'retire:seat-2', 'release:seat-2',
  ])
})
