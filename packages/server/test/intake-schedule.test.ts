import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TriggerFact } from '@harnessdesk/protocol'

import type { ArmedTrigger } from '../src/intake/consent.js'
import { ForgeSource } from '../src/intake/forge.js'
import { IntakeMonitor, intakeSources, SourceCursors } from '../src/intake/poll.js'
import { armOf, Clocks, FakeForge, FakeTimers } from './fixtures/intake-forge.js'
import { tempDir } from './scratch.js'

/*
 * A schedule fires its newest due slot and no other: arming between slots
 * fires nothing early, a desk that was off catches up once and says how many
 * slots it skipped, and neither a restart nor a clock that ran backwards
 * replays a slot already fired.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = Date.UTC(2026, 8, 1)

const monitorAt = (home: string, clocks: Clocks, arms: () => readonly ArmedTrigger[], offers: TriggerFact[]) => new IntakeMonitor({
  armed: async () => arms(),
  sources: intakeSources(new ForgeSource({ run: new FakeForge().runner, now: () => clocks.wall })),
  cursors: new SourceCursors(home),
  offer: async (_arm, fact) => { offers.push(fact) },
  wall: () => clocks.wall,
  monotonic: () => clocks.mono,
  timers: new FakeTimers(),
})

test('one latest slot survives restart and backward time', async () => {
  const home = tempDir('hd-intake-schedule-')
  const clocks = new Clocks(DAY + 10 * HOUR + 20 * MINUTE)
  const offers: TriggerFact[] = []
  let arms: ArmedTrigger[] = []
  let monitor = monitorAt(home, clocks, () => arms, offers)
  const at = (hours: number, minutes = 0): number => DAY + hours * HOUR + minutes * MINUTE
  const tickAt = async (time: number): Promise<void> => {
    clocks.mono += Math.max(MINUTE, time - clocks.wall)
    clocks.wall = time
    await monitor.tick(time)
  }

  // Unarmed: nothing, however late it gets.
  await tickAt(at(11, 5))
  assert.equal(offers.length, 0)

  // Armed at 11:10 for every hour: 11:00 is before the arm and never fires.
  const arm = armOf('hourly', { source: 'schedule', every: 60, baseline: at(11, 10) })
  arms = [arm]
  assert.equal(await monitor.baseline(arm), clocks.wall, 'a schedule arm reads no forge: its baseline is now')
  await tickAt(at(11, 30))
  assert.equal(offers.length, 0)
  await tickAt(at(12, 0))
  assert.deepEqual(offers.map((fact) => [fact.subject, fact.trigger, fact.action]), [[String(at(12)), 'hourly', 'tick']])
  assert.equal(offers[0]!.repository, null)
  assert.equal(offers[0]!.at, at(12))
  await tickAt(at(12, 30))
  assert.equal(offers.length, 1, 'a slot fires once')

  // The desk was off from 12:30 to 17:05: one catch-up slot, and the four it skipped are counted, not fired.
  await tickAt(at(17, 5))
  assert.deepEqual(offers.slice(1).map((fact) => fact.subject), [String(at(17))])
  const status = monitor.statuses().find((one) => one.source === 'schedule')
  assert.equal(status?.skipped, 4)

  // A restart reads the same watermark: 17:00 is not due again.
  await monitor.close()
  monitor = monitorAt(home, clocks, () => arms, offers)
  await tickAt(at(17, 20))
  assert.equal(offers.length, 2)

  // The clock runs backwards to 09:00: nothing fires, and nothing replays on the way forward.
  await tickAt(at(9, 0))
  await tickAt(at(16, 30))
  await tickAt(at(17, 59))
  assert.equal(offers.length, 2)
  await tickAt(at(18, 0))
  assert.deepEqual(offers.slice(2).map((fact) => fact.subject), [String(at(18))])

  // Two schedules on one project are one source read, each with its own slot identity.
  const daily = armOf('daily', { source: 'schedule', every: 1440, baseline: at(18, 1) })
  arms = [arm, daily]
  await tickAt(DAY + 24 * HOUR)
  const last = offers.slice(3)
  assert.deepEqual(last.map((fact) => fact.trigger).sort(), ['daily', 'hourly'])
  assert.notEqual(last[0]!.event, last[1]!.event)
  await monitor.close()
})
