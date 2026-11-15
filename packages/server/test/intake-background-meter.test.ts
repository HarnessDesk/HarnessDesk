import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BackgroundMeter } from '../src/intake/background-meter.js'

const sweep = (meter: BackgroundMeter, held: readonly string[], now: number): string[] => {
  const selected: string[] = []
  for (let goal = meter.take(held, now); goal !== null; goal = meter.take(held, now)) selected.push(goal)
  return selected
}

test('background reads share a rolling quota and rotate through held Goals', () => {
  const meter = new BackgroundMeter(), goals = Array.from({ length: 10 }, (_, i) => `g${i}`)
  assert.deepEqual(sweep(meter, goals, 0), goals.slice(0, 8))
  assert.deepEqual(sweep(meter, goals, 0), [])
  assert.deepEqual(sweep(meter, goals, 29_999), [])
  assert.deepEqual(sweep(meter, goals, 30_000), [...goals.slice(8), ...goals.slice(0, 6)])
})

test('attempts consume opportunities regardless of outcome, back off and recover on restart', () => {
  const meter = new BackgroundMeter()
  for (const now of [0, 30_000, 60_000, 90_000]) assert.equal(meter.take(['a'], now), 'a')
  assert.equal(meter.take(['a'], 120_000), null)
  assert.equal(meter.take(['a'], 150_000), 'a')
  assert.equal(meter.take(['a'], 210_000), null)
  assert.equal(meter.take(['a'], 270_000), 'a')
  assert.equal(new BackgroundMeter().take(['a'], 0), 'a')
})

test('clock regression cannot reopen quota; removing a held key prunes its retry state', () => {
  const meter = new BackgroundMeter()
  assert.equal(meter.take(['a'], 100_000), 'a')
  assert.equal(meter.take(['a'], 1), null)
  assert.equal(meter.take([], 100_000), null)
  assert.equal(meter.take(['a'], 100_000), 'a')
})
