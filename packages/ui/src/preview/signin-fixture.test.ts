import { describe, expect, it } from 'vitest'
import { keptReading, reachedLaneOf, runtimeId, usageStandingOf } from '@harnessdesk/protocol'

import { credentialHome } from '../lib/accounts'
import { accountPoolSeed, runtimesSeed } from './signin-fixture'

it('shows the primary Codex credential home used by a default host', () => {
  const primary = (runtimesSeed().runtimes ?? []).find(row => row.id === runtimeId('codex'))
  expect(primary).toBeDefined()
  expect(credentialHome(primary!)).toBe('~/.codex')
})

it('gives every Codex row the gateway fact a real host sets', () => {
  // The host attaches `gateways: true` to every Codex slot (bootstrap.ts's
  // `slotOf`, spread through host.ts). A Codex row is the primary runtime or an
  // account `slot.agent` names it. The primary row must have a slot too.
  const codex = runtimeId('codex')
  const rows = (runtimesSeed().runtimes ?? []).filter(row => row.id === codex || row.slot?.agent === codex)
  expect(rows.length).toBeGreaterThan(1)
  for (const row of rows) expect(row.slot?.gateways).toBe(true)
})

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
