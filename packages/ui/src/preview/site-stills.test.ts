import { describe, expect, it } from 'vitest'
import { runTimeline } from '../lib/run-timeline'
import { SITE_NOW, siteHistory, siteLedger, siteRun, siteUsage, siteStartPreview } from './site-stills-data'

describe('compact website fixtures', () => {
  it('includes every agent role in the start summary with its held ceiling', () => {
    const preview = siteStartPreview()
    expect(preview.compiled.document.format).toBe('agents')
    const roles = preview.compiled.document.flow.roles.filter(role => role.kind === 'agent')
    expect(preview.seats.map(seat => seat.role)).toEqual(roles.map(role => role.id))
    expect(preview.seats.map(seat => seat.plan.ceiling)).toEqual([
      { level: 'edit', hold: 'held' }, { level: 'read', hold: 'held' }, { level: 'edit', hold: 'held' },
    ])
  })
  it('records a complete write, review, fix, review, person Flow with one accepted finding', () => {
    const input = siteRun('review')
    expect(input.execution.rounds.map(round => round.role)).toEqual(['write', 'review', 'fix', 'review', 'person'])
    expect(input.execution.document.flow.roles.some(role => role.kind === 'check')).toBe(false)
    expect(input.execution.operations.some(operation => operation.kind === 'check')).toBe(false)
    const rows = runTimeline(input).rows
    expect(rows.filter(row => row.kind === 'check')).toHaveLength(0)
    expect(rows.some(row => row.status === 'Request changes')).toBe(true)
    expect(rows.some(row => row.status === 'Approve')).toBe(true)
    expect(input.findings).toHaveLength(1)
    expect(input.findings![0]!.origin).toMatchObject({ round: 2, card: 2 })
    expect(input.findings![0]!.lifecycle).toMatchObject({ state: 'repaired', confirmed: true })
    expect(rows.find(row => row.kind === 'person')?.title).toContain('Decide whether the change ships')
  })

  it('records only attempts, judge and person in the comparison Flow and keeps the pick evidence', () => {
    const input = siteRun('race')
    expect(input.execution.rounds.map(round => round.role)).toEqual(['competitor', 'judge', 'person'])
    expect(input.execution.document.flow.roles.map(role => role.id)).toEqual(['competitor', 'judge', 'person'])
    expect(input.execution.document.flow.roles[0]).toMatchObject({ kind: 'agent', count: 2 })
    const rows = runTimeline(input).rows
    expect(rows.filter(row => row.kind === 'check')).toHaveLength(0)
    expect(rows.filter(row => row.keep).map(row => row.keep)).toEqual(['kept', 'not-kept'])
    for (const fact of input.evidence!.cards.flatMap(card => card.facts)) {
      expect(input.execution.rounds.find(round => round.n === fact.record.round)?.cards).toContain(fact.record.card!.id)
    }
  })

  it('derives year, range, agent totals and local-hour data from the same multi-account history', () => {
    const history = siteHistory()
    expect(new Set(history.map(row => row.account)).size).toBeGreaterThanOrEqual(5)
    expect(new Set(history.map(row => row.runtime)).size).toBe(3)
    const year = siteLedger({ days: 365, groupBy: 'runtime' })
    expect(year.coverage.daysCovered).toBe(365)
    expect(new Set(year.daily.map(row => row.day)).size).toBe(365)
    expect(year.totalCost).toBeGreaterThan(5000)
    expect(year.totalCost).toBeCloseTo(year.rows.reduce((sum, row) => sum + row.cost!, 0))
    expect(year.totalTokens).toBe(year.hourly!.reduce((sum, row) => sum + row.tokens, 0))
    expect(year.daily.some(row => new Date(row.day).getDay() === 0 && row.tokens === 0)).toBe(true)
    expect(year.daily.filter(row => row.tokens === 0).length).toBeGreaterThan(90)
    const month = siteLedger({ days: 30, groupBy: 'runtime' })
    expect(month.totalCost).toBeLessThan(year.totalCost!)
    expect(month.coverage.daysCovered).toBe(30)
    expect(month.totalCost).toBeCloseTo(month.daily.reduce((sum, row) => sum + row.cost!, 0))
    const reports = siteUsage()
    expect(reports.every(report => report.account?.endsWith('example.com'))).toBe(true)
    expect(reports.some(report => report.lanes.some(lane => lane.usedPercent >= 90 && lane.resetsAt! > SITE_NOW))).toBe(true)
  })
})
