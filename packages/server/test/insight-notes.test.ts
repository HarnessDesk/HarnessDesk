import assert from 'node:assert/strict'
import test from 'node:test'

import { INSIGHT_ROW_NOTES } from '@harnessdesk/protocol'

import { InsightPlane } from '../src/insight/plane.js'

test('host attribution uses the shared presentation notes, including missing brief exceptions', async () => {
  const seat = (id: string, briefDigest: string | null) => ({
    id, agent: { id: 'reviewer', name: 'Reviewer', origin: 'project' }, briefDigest,
    seat: { runtime: 'runtime' }, seatLabel: id, checkout: { project: '/work/project' },
    board: 'goal', session: { runtime: 'runtime', sessionId: id }, openedAt: 0, closed: null,
  })
  const plane = new InsightPlane({
    ledger: () => ({ readInsight: async () => ({ samples: [], sources: [], gaps: ['No recorded amounts.'], complete: false }) }) as never,
    goals: { store: { list: () => [{ goal: { id: 'goal', root: '/work/project', sentence: 'Review', state: 'wrapped' } }] } } as never,
    seats: () => [seat('recorded', 'digest'), seat('missing', null)] as never,
    seating: {} as never, now: () => 20,
  })
  const report = await plane.usage({ root: '/work/project', from: 0, to: 10 })
  const notes = (dimension: string) => report.breakdowns.find(part => part.dimension === dimension)!.rows.map(row => row.note)
  assert.deepEqual(notes('seat'), [INSIGHT_ROW_NOTES.cohort, INSIGHT_ROW_NOTES.missingCohort])
  assert.deepEqual(notes('goal'), [INSIGHT_ROW_NOTES.goal])
  assert.deepEqual(notes('agent'), [INSIGHT_ROW_NOTES.agent])
})
