import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostClockController } from './host-clock'
import { hostLimits } from '../lib/limits'
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
describe('HostClockController', () => {
  it.each(['connect', 'resume', 'reconnect'].flatMap(phase => [-1000, 1000].map(shift => ({ phase, shift }))))(
    'contains a first-probe $shift ms in-flight wall step after $phase', async ({ phase, shift }) => {
      vi.useFakeTimers(); vi.setSystemTime(100_000)
      const replies: ((sample: unknown) => void)[] = []
      const request = vi.fn(() => new Promise(resolve => replies.push(resolve)))
      const clock = new HostClockController(request, () => {})
      clock.connect(true)
      if (phase !== 'connect') {
        replies[0]!({ hostNowMs: 100_000, clockEpoch: 'one' })
        await Promise.resolve(); await Promise.resolve()
        expect(clock.read()).not.toBeNull()
        if (phase === 'resume') clock.resume()
        else { clock.disconnect(); clock.connect(true) }
      }
      await vi.advanceTimersByTimeAsync(10)
      vi.setSystemTime(100_010 + shift)
      replies.at(-1)!({ hostNowMs: 100_000, clockEpoch: 'one' })
      await Promise.resolve(); await Promise.resolve()
      const interval = clock.read()
      expect(interval).not.toBeNull()
      for (const hostNow of [100_010, 100_010 + shift]) {
        expect(interval!.lowerMs).toBeLessThanOrEqual(hostNow)
        expect(interval!.upperMs).toBeGreaterThanOrEqual(hostNow)
      }
      expect(request).toHaveBeenCalledTimes(phase === 'connect' ? 1 : 2)
      clock.disconnect()
    },
  )
  it.each([
    { boundary: 'reset', shift: 1000 },
    { boundary: 'expiry', shift: 1000 },
    { boundary: 'observation', shift: -1000 },
  ])('does not qualify limits across an in-flight $boundary boundary', async ({ boundary, shift }) => {
    vi.useFakeTimers(); vi.setSystemTime(100_000)
    let settle!: (value: unknown) => void
    const clock = new HostClockController(() => new Promise(resolve => { settle = resolve }), () => {})
    clock.connect(true)
    await vi.advanceTimersByTimeAsync(10)
    vi.setSystemTime(100_010 + shift)
    settle({ hostNowMs: 100_000, clockEpoch: 'one' })
    await Promise.resolve(); await Promise.resolve()
    const interval = clock.read()
    expect(interval).not.toBeNull()
    expect(hostLimits({ fetchedAt: boundary === 'observation' ? 99_500 : 99_000,
      staleAfterMs: boundary === 'expiry' ? 1500 : 10_000,
      lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 99, windowMinutes: 10080,
        resetsAt: boundary === 'reset' ? 100_500 : 200_000 }] }, interval)).toBeNull()
    clock.disconnect()
  })
  it.each([-2001, 2001])('leaves the first probe unverified after an in-flight %i ms discontinuity', async shift => {
    vi.useFakeTimers(); vi.setSystemTime(100_000)
    let settle!: (value: unknown) => void
    const request = vi.fn(() => new Promise(resolve => { settle = resolve }))
    const clock = new HostClockController(request, () => {})
    clock.connect(true)
    await vi.advanceTimersByTimeAsync(10)
    vi.setSystemTime(100_010 + shift)
    settle({ hostNowMs: 100_000, clockEpoch: 'one' })
    await Promise.resolve(); await Promise.resolve()
    expect(clock.read()).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
    clock.disconnect()
  })
  it('does not issue a second request when capability negotiation repeats on one connection', () => {
    vi.useFakeTimers()
    const request = vi.fn(() => new Promise(() => {}))
    const clock = new HostClockController(request, () => {})
    clock.connect(true)
    clock.connect(true)
    expect(request).toHaveBeenCalledTimes(1)
    clock.disconnect()
  })
  it('does not overlap a pending probe after a capability drop and restoration', async () => {
    vi.useFakeTimers()
    let settle!: (value: unknown) => void
    const request = vi.fn(() => new Promise(resolve => { settle = resolve }))
    const clock = new HostClockController(request, () => {})
    clock.connect(true)
    clock.connect(false)
    clock.connect(true)
    expect(request).toHaveBeenCalledTimes(1)
    settle({ hostNowMs: 100_000, clockEpoch: 'old' })
    await Promise.resolve(); await Promise.resolve()
    expect(clock.read()).toBeNull()
    expect(request).toHaveBeenCalledTimes(2)
    clock.disconnect()
  })
  it('samples and refreshes 30 seconds after settlement', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000)
    const request = vi.fn().mockResolvedValue({ hostNowMs: 100_000, clockEpoch: 'one' })
    const clock = new HostClockController(request, () => {})
    clock.connect(true); await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
    expect(clock.read()).toEqual({ lowerMs: 100_000, upperMs: 100_001 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(request).toHaveBeenCalledTimes(2)
    clock.disconnect()
  })
  it('fences late replies after timeout and reconnect without multiplying requests', async () => {
    vi.useFakeTimers()
    const resolvers: ((sample: unknown) => void)[] = []
    const request = vi.fn(() => new Promise(resolve => resolvers.push(resolve)))
    const clock = new HostClockController(request, () => {})
    clock.connect(true); await vi.advanceTimersByTimeAsync(65_000)
    expect(request).toHaveBeenCalledTimes(1)
    expect(clock.read()).toBeNull()
    clock.disconnect(); clock.connect(true)
    expect(request).toHaveBeenCalledTimes(2)
    resolvers[0]!({ hostNowMs: 100_000, clockEpoch: 'old' }); await Promise.resolve()
    expect(clock.read()).toBeNull()
    resolvers[1]!({ hostNowMs: 200_000, clockEpoch: 'new' }); await Promise.resolve()
    expect(clock.read()?.lowerMs).toBe(200_000)
    clock.disconnect()
  })
  it('does not probe unsupported hosts and fences a pending reply on resume', async () => {
    vi.useFakeTimers()
    const resolvers: ((sample: unknown) => void)[] = []
    const request = vi.fn(() => new Promise(resolve => resolvers.push(resolve)))
    const clock = new HostClockController(request, () => {})
    clock.connect(false); expect(request).not.toHaveBeenCalled()
    clock.connect(true); clock.resume()
    expect(request).toHaveBeenCalledTimes(1)
    resolvers[0]!({ hostNowMs: 100_000, clockEpoch: 'one' }); await Promise.resolve(); await Promise.resolve()
    expect(clock.read()).toBeNull()
    expect(request).toHaveBeenCalledTimes(2)
    clock.disconnect()
  })
  it('fences an in-flight reply if a read detects a wall jump', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000)
    const resolvers: ((sample: unknown) => void)[] = []
    const request = vi.fn(() => new Promise(resolve => resolvers.push(resolve)))
    const clock = new HostClockController(request, () => {})
    clock.connect(true)
    resolvers[0]!({ hostNowMs: 100_000, clockEpoch: 'one' }); await Promise.resolve(); await Promise.resolve()
    expect(clock.read()).not.toBeNull()
    await vi.advanceTimersByTimeAsync(30_000)
    vi.setSystemTime(2_000_000)
    expect(clock.read()).toBeNull()
    resolvers[1]!({ hostNowMs: 130_000, clockEpoch: 'one' }); await Promise.resolve(); await Promise.resolve()
    expect(clock.read()).toBeNull()
    clock.disconnect()
  })
  it('fences an in-flight reply after cumulative small wall steps exceed the sample limit', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000)
    const resolvers: ((sample: unknown) => void)[] = []
    const request = vi.fn(() => new Promise(resolve => resolvers.push(resolve)))
    const clock = new HostClockController(request, () => {})
    clock.connect(true)
    resolvers[0]!({ hostNowMs: 1_000_000, clockEpoch: 'one' }); await Promise.resolve(); await Promise.resolve()
    await vi.advanceTimersByTimeAsync(30_000)
    for (const step of [750, 1500]) {
      vi.setSystemTime(1_030_000 + step)
      expect(clock.read()).not.toBeNull()
    }
    vi.setSystemTime(1_032_250)
    expect(clock.read()).toBeNull()
    expect(request).toHaveBeenCalledTimes(2)
    resolvers[1]!({ hostNowMs: 1_030_000, clockEpoch: 'one' }); await Promise.resolve(); await Promise.resolve()
    expect(clock.read()).toBeNull()
    clock.disconnect()
  })

})
