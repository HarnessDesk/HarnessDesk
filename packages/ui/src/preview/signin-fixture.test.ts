import { keptReading, reachedLaneOf, usageStandingOf } from '@harnessdesk/protocol'
import { describe, expect, it } from 'vitest'

import { accountPoolSeed, runtimesSeed } from './signin-fixture'

// The Runtimes preview's reports reach the same usage cards a host's do, so they carry every field a host's report
// carries. One built behind a cast without `credits` or `error` read as a kept reading and blanked `?runtime-cost`.
describe('the Runtimes preview usage reports', () => {
  for (const [name, seed] of [['runtimesSeed', runtimesSeed()], ['accountPoolSeed', accountPoolSeed()]] as const) {
    it(`${name} gives every report the fields a host report carries`, () => {
      expect(seed.usage?.length).toBeGreaterThan(0)
      for (const report of seed.usage ?? []) {
        for (const field of ['credits', 'spend', 'reached', 'source', 'fetchedAt', 'staleAfterMs', 'error'] as const) {
          expect(report[field], `${report.runtime} ${field}`).not.toBeUndefined()
        }
        expect(keptReading(report)).toBe(false)
        expect(() => usageStandingOf(report, Date.now())).not.toThrow()
        if (report.reached !== null) expect(reachedLaneOf(report)?.id).toBe(report.reached)
      }
    })
  }

  it('keeps the spent Codex account reading as out', () => {
    const codex = runtimesSeed().usage!.find((report) => report.runtime === 'codex')!
    expect(usageStandingOf(codex, Date.now()).status).toBe('out')
  })
})
