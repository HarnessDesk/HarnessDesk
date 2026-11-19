import { describe, expect, it } from 'vitest'
import { HostClockEstimator } from './host-clock'

const sample = (hostNowMs = 100_000, clockEpoch = 'epoch') => ({ hostNowMs, clockEpoch })
const timing = (sentMonoMs = 10, receivedMonoMs = 110, receivedWallMs = 1_000_000, generation = 1) => ({ generation, sentMonoMs, receivedMonoMs, receivedWallMs })
const read = (monoMs = 110, wallMs = 1_000_000, generation = 1) => ({ generation, monoMs, wallMs })
const estimator = () => { const clock = new HostClockEstimator(); clock.reset(1); return clock }

describe('HostClockEstimator', () => {
  it('bounds Host time and advances by monotonic time regardless of client wall offset', () => {
    for (const offset of [-1_800_000, 1_800_000]) {
      const clock = estimator()
      expect(clock.accept(sample(), timing(10, 110, 100_000 + offset))).toBe(true)
      expect(clock.read(read(160, 100_050 + offset))).toEqual({ lowerMs: 100_050, upperMs: 100_151 })
    }
  })
  it('includes timestamp quantization and accepts bounded fractional RTT', () => {
    for (const rtt of [0, 0.5, 5000]) {
      const clock = estimator()
      expect(clock.accept(sample(), timing(10, 10 + rtt))).toBe(true)
      expect(clock.read(read(10 + rtt))).toEqual({ lowerMs: 100_000, upperMs: 100_001 + rtt })
    }
  })
  it('rejects Host timestamps outside the representable wall-clock range', () => {
    const clock = estimator()
    expect(clock.accept(sample(8_640_000_000_000_001), timing())).toBe(false)
    expect(clock.read(read())).toBeNull()
  })
  it('rejects a round trip over five seconds', () => {
    const clock = estimator()
    expect(clock.accept(sample(), timing(10, 5011))).toBe(false)
    expect(clock.read(read(5011))).toBeNull()
  })
  it('rejects invalid samples and timing, invalidating an existing estimate', () => {
    for (const [value, t] of [
      [sample(), timing(10, 5011)], [sample(), timing(11, 10)],
      [sample(NaN), timing()], [sample(-1), timing()], [sample(1.5), timing()],
      [sample(100, ''), timing()], [null, timing()], [{ hostNowMs: 100, clockEpoch: 1 }, timing()],
      [sample(), timing(NaN)], [sample(), timing(0, 1, Infinity)],
    ] as const) {
      const clock = estimator()
      expect(clock.accept(sample(), timing())).toBe(true)
      expect(clock.accept(value, t)).toBe(false)
      expect(clock.read(read())).toBeNull()
    }
  })
  it('expires after 60 seconds and rejects monotonic regression', () => {
    const clock = estimator()
    expect(clock.accept(sample(), timing())).toBe(true)
    expect(clock.read(read(60_110, 1_060_000))).not.toBeNull()
    expect(clock.read(read(60_111, 1_060_001))).toBeNull()
    expect(clock.accept(sample(), timing())).toBe(true)
    expect(clock.read(read(109, 999_999))).toBeNull()
  })
  it('fences generations and preserves a new estimate against a stale reply', () => {
    const clock = estimator()
    clock.reset(2)
    expect(clock.accept(sample(), timing(10, 110, 1_000_000, 2))).toBe(true)
    expect(clock.accept(sample(), timing())).toBe(false)
    expect(clock.read(read(110, 1_000_000, 2))).not.toBeNull()
    expect(clock.read(read())).toBeNull()
    expect(clock.read(read(110, 1_000_000, 2))).not.toBeNull()
    clock.reset(3)
    expect(clock.read(read(110, 1_000_000, 3))).toBeNull()
  })
  it('rejects epoch changes, incompatible host jumps, and older responses', () => {
    for (const [value, t] of [
      [sample(100_100, 'other'), timing(110, 210, 1_000_100)],
      [sample(200_000), timing(110, 210, 1_000_100)],
      [sample(100_000), timing(0, 100, 999_990)],
    ] as const) {
      const clock = estimator()
      expect(clock.accept(sample(), timing())).toBe(true)
      expect(clock.accept(value, t)).toBe(false)
      expect(clock.read(read(210, 1_000_100))).toBeNull()
    }
  })
  it('accepts compatible subsequent intervals including queued asymmetric delay', () => {
    const clock = estimator()
    expect(clock.accept(sample(), timing())).toBe(true)
    expect(clock.read(read(210, 1_000_100))).not.toBeNull()
    expect(clock.accept(sample(100_150), timing(110, 310, 1_000_200))).toBe(true)
    expect(clock.read(read(310, 1_000_200))).toEqual({ lowerMs: 100_150, upperMs: 100_351 })
  })
  it('invalidates on wall versus monotonic discontinuities on reads and samples', () => {
    for (const delta of [-2001, 2001]) {
      const clock = estimator()
      expect(clock.accept(sample(), timing())).toBe(true)
      expect(clock.read(read(210, 1_000_100 + delta))).toBeNull()
      expect(clock.accept(sample(), timing())).toBe(true)
      expect(clock.accept(sample(100_100), timing(110, 210, 1_000_100 + delta))).toBe(false)
    }
    const clock = estimator()
    expect(clock.accept(sample(), timing())).toBe(true)
    expect(clock.read(read(110, 1_002_001))).toBeNull()
  })
  it('explicit invalidation removes the estimate without retaining history', () => {
    const clock = estimator()
    for (let i = 0; i < 100; i++) {
      clock.reset(1)
      expect(clock.accept(sample(), timing())).toBe(true)
    }
    expect(JSON.stringify(clock).length).toBeLessThan(500)
    clock.invalidate()
    expect(clock.read(read())).toBeNull()
  })
})
