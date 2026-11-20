import { describe, expect, it } from 'vitest'
import { HostClockEstimator } from './host-clock'
import { hostLimits } from './limits'

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
  it.each([-1000, 1000])('contains same-OS and remote Host time after a %i ms wall step', shift => {
    const clock = estimator()
    expect(clock.accept(sample(), timing(10, 10, 100_000))).toBe(true)
    for (const elapsed of [2000, 2100]) {
      const remoteHostNow = 100_000 + elapsed
      const localHostNow = remoteHostNow + shift
      const interval = clock.read(read(10 + elapsed, localHostNow))
      expect(interval).not.toBeNull()
      for (const hostNow of [localHostNow, remoteHostNow]) {
        expect(interval!.lowerMs).toBeLessThanOrEqual(hostNow)
        expect(interval!.upperMs).toBeGreaterThanOrEqual(hostNow)
      }
    }
  })
  it.each([-750, 750])('invalidates cumulative %i ms wall steps beyond the sample anchor limit', step => {
    const clock = estimator()
    expect(clock.accept(sample(), timing(10, 10, 100_000))).toBe(true)
    for (let i = 1; i <= 2; i++) {
      const remoteHostNow = 100_000 + i * 1000
      const localHostNow = remoteHostNow + i * step
      const interval = clock.read(read(10 + i * 1000, localHostNow))
      expect(interval).not.toBeNull()
    }
    expect(clock.read(read(3010, 103_000 + 3 * step))).toBeNull()
    expect(clock.read(read(4010, 104_000 + 3 * step))).toBeNull()
    expect(clock.accept(sample(104_000), timing(4010, 4010, 104_000 + 3 * step))).toBe(true)
    expect(clock.read(read(4010, 104_000 + 3 * step))).not.toBeNull()
  })
  it.each([-2000, 2000])('still contains Host time at the bounded %i ms discrepancy limit', shift => {
    const clock = estimator()
    expect(clock.accept(sample(), timing(10, 10, 100_000))).toBe(true)
    const interval = clock.read(read(3010, 103_000 + shift))
    expect(interval).not.toBeNull()
    for (const hostNow of [103_000, 103_000 + shift]) {
      expect(interval!.lowerMs).toBeLessThanOrEqual(hostNow)
      expect(interval!.upperMs).toBeGreaterThanOrEqual(hostNow)
    }
  })
  it.each(['reset', 'expiry', 'observation'] as const)('does not qualify limits when a small wall step straddles their %s', boundary => {
    const clock = estimator()
    const limits = {
      fetchedAt: boundary === 'observation' ? 100_500 : 100_000,
      staleAfterMs: boundary === 'expiry' ? 1500 : 10_000,
      lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 99, windowMinutes: 10080,
        resetsAt: boundary === 'reset' ? 101_500 : 200_000 }],
    }
    expect(clock.accept(sample(), timing(10, 10, 100_000))).toBe(true)
    // With no step, both endpoints support the current allowance.
    expect(hostLimits(limits, clock.read(read(1010, 101_000)))).not.toBeNull()
    const localHostNow = boundary === 'observation' ? 100_000 : 102_000
    const interval = clock.read(read(1010, localHostNow))
    expect(interval).not.toBeNull()
    expect(hostLimits(limits, interval)).toBeNull()
  })
  it.each([-1000, 1000])('resets accumulated %i ms wall uncertainty on a compatible fresh sample', shift => {
    const clock = estimator()
    expect(clock.accept(sample(), timing(10, 10, 100_000))).toBe(true)
    expect(clock.read(read(2010, 102_000 + shift))).not.toBeNull()
    expect(clock.accept(sample(102_000), timing(2010, 2010, 102_000 + shift))).toBe(true)
    expect(clock.read(read(2010, 102_000 + shift))).toEqual({ lowerMs: 102_000, upperMs: 102_001 })
    const interval = clock.read(read(4010, 104_000 + 2 * shift))
    expect(interval).not.toBeNull()
    for (const hostNow of [104_000, 104_000 + shift]) {
      expect(interval!.lowerMs).toBeLessThanOrEqual(hostNow)
      expect(interval!.upperMs).toBeGreaterThanOrEqual(hostNow)
    }
  })
  it('fails closed when wall uncertainty would exceed representable Host dates', () => {
    const clock = estimator()
    expect(clock.accept(sample(8_640_000_000_000_000 - 501), timing(10, 10, 100_000))).toBe(true)
    expect(clock.read(read(10, 101_000))).toBeNull()
  })
  it('does not return a negative lower bound when wall uncertainty reaches before zero', () => {
    const clock = estimator()
    expect(clock.accept(sample(0), timing(10, 10, 100_000))).toBe(true)
    const interval = clock.read(read(10, 99_000))
    expect(interval === null || interval.lowerMs === 0).toBe(true)
  })
  it('invalidates non-finite read timing and overflowing clock differences', () => {
    for (const [monoMs, wallMs] of [[NaN, 100_000], [Infinity, 100_000], [10, NaN], [10, Infinity], [10, -Number.MAX_VALUE]]) {
      const clock = estimator()
      expect(clock.accept(sample(), timing(10, 10, Number.MAX_VALUE))).toBe(true)
      expect(clock.read(read(monoMs, wallMs))).toBeNull()
      expect(clock.read(read(10, Number.MAX_VALUE))).toBeNull()
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
