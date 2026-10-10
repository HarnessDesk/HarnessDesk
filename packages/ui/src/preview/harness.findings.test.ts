import { expect, it } from 'vitest'
import type { FindingFilter } from '../lib/findings'
import { EMPTY_FINDINGS_STATE, findingsListState } from './findings-fixture'
import { PREVIEW_GOAL } from './goal-fixture'
import { previewStore } from './harness'
import { overviewTeamStore } from './team-overview-fixture'
import { triggerRunsStore } from './team-runs-fixture'

for (const filter of ['open', 'blocking', 'all'] satisfies FindingFilter[]) {
  it(`keeps the requested ${filter} filter on an empty preview Goal without borrowing another Goal's findings`, async () => {
    const sibling = findingsListState('blocking')
    const store = previewStore({ findings: new Map([[PREVIEW_GOAL.goal.id, sibling]]) })
    const before = store.getSnapshot()
    await store.loadFindings('missing-goal', filter)
    const after = store.getSnapshot()
    expect(after.findings.get('missing-goal')).toEqual({ ...EMPTY_FINDINGS_STATE, filter })
    expect(after.findings.get(PREVIEW_GOAL.goal.id)).toBe(sibling)
    expect(before.findings.has('missing-goal')).toBe(false)
    for (const key of Object.keys(before) as (keyof typeof before)[]) {
      if (key !== 'findings') expect(after[key]).toBe(before[key])
    }
  })
}

it('retains Open and Blocking on the actual overview Team wall fixture with empty findings', async () => {
  const store = overviewTeamStore('running')
  const before = store.getSnapshot()
  await store.loadFindings('overview-team', 'open')
  expect(store.getSnapshot().findings.get('overview-team')).toEqual({ ...EMPTY_FINDINGS_STATE, filter: 'open' })
  await store.loadFindings('overview-team', 'blocking')
  expect(store.getSnapshot().findings.get('overview-team')).toEqual({ ...EMPTY_FINDINGS_STATE, filter: 'blocking' })
  expect(store.getSnapshot().goals).toBe(before.goals)
  expect(store.getSnapshot().teams).toBe(before.teams)
  expect(store.getSnapshot().flowExecutions).toBe(before.flowExecutions)
  expect(store.getSnapshot().findingRuns).toBe(before.findingRuns)
})

it('filters the trigger fixture’s original findings without changing their provenance, totals, or Run state', async () => {
  const store = triggerRunsStore()
  const before = store.getSnapshot()
  const original = before.findings.get('overview-team')!
  expect(original.rows.map(row => row.id)).toEqual(['finding-open-1', 'finding-not-kept-1'])
  expect(original.totals).toEqual({ all: 2, open: 2, blocking: 2 })
  await store.loadFindings('overview-team', 'blocking')
  const blocking = store.getSnapshot().findings.get('overview-team')!
  expect(blocking.filter).toBe('blocking')
  expect(blocking.rows).toEqual([original.rows[0]])
  expect(blocking.rows[0]).toBe(original.rows[0])
  expect(blocking.totals).toBe(original.totals)
  await store.loadFindings('overview-team', 'open')
  const open = store.getSnapshot().findings.get('overview-team')!
  expect(open.filter).toBe('open')
  expect(open.rows).toEqual(original.rows)
  expect(open.rows.every((row, n) => row === original.rows[n])).toBe(true)
  await store.loadFindings('overview-team', 'all')
  expect(store.getSnapshot().findings.get('overview-team')).toEqual(original)
  for (const key of Object.keys(before) as (keyof typeof before)[]) {
    if (key !== 'findings') expect(store.getSnapshot()[key]).toBe(before[key])
  }
})

it('delegates other Goal reads from the trigger fixture to the original typed preview loader', async () => {
  const store = triggerRunsStore()
  const original = store.getSnapshot().findings.get('overview-team')
  await store.loadFindings(PREVIEW_GOAL.goal.id, 'open')
  expect(store.getSnapshot().findings.get(PREVIEW_GOAL.goal.id)).toEqual(findingsListState('open'))
  await store.loadFindings('missing-goal', 'blocking')
  expect(store.getSnapshot().findings.get('missing-goal')).toEqual({ ...EMPTY_FINDINGS_STATE, filter: 'blocking' })
  expect(store.getSnapshot().findings.get('overview-team')).toBe(original)
})
