import { expect, it } from 'vitest'
import { overviewTeamStore } from './team-overview-fixture'

it.each(['running', 'findings-and-posting'] as const)('seeds the %s Team ledger with the three blocking findings its Run reports', async scene => {
  const store = overviewTeamStore(scene)
  for (const filter of ['all', 'open', 'blocking'] as const) {
    await store.loadFindings('overview-team', filter)
    const ledger = store.getSnapshot().findings.get('overview-team')!
    const run = store.getSnapshot().findingRuns.get('overview-run')!
    expect(ledger.rows).toHaveLength(3)
    expect(ledger.rows.every(one => one.blocking && one.lifecycle.state === 'open' && one.ownerGoal === 'overview-team')).toBe(true)
    expect(ledger.totals).toEqual({ all: 3, open: run.open, blocking: run.blocking })
    expect(ledger.filter).toBe(filter)
  }
})
