import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assessCheckRuns } from '../src/check-runs.js'

const run = (name: string, id: number, started_at: string, status: string, conclusion: string | null) => ({
  name,
  id,
  started_at,
  status,
  conclusion,
})

test('assessCheckRuns considers only the newest run of each name by start time then id', () => {
  assert.equal(assessCheckRuns([
    run('build', 1, '2026-09-30T10:00:00Z', 'completed', 'failure'),
    run('build', 2, '2026-09-30T11:00:00Z', 'completed', 'success'),
  ]).green, true, 'a newer success replaces an older failure')

  assert.equal(assessCheckRuns([
    run('build', 2, '2026-09-30T11:00:00Z', 'completed', 'success'),
    run('build', 3, '2026-09-30T12:00:00Z', 'completed', 'failure'),
  ]).green, false, 'a newer failure replaces an older success')

  assert.equal(assessCheckRuns([
    run('build', 1, '2026-09-30T11:00:00Z', 'completed', 'failure'),
    run('build', 2, '2026-09-30T11:00:00Z', 'completed', 'success'),
  ]).green, true, 'higher id wins when start times tie')
})

test('assessCheckRuns accepts only completed success, skipped and neutral conclusions', () => {
  assert.equal(assessCheckRuns([
    run('build', 1, '2026-09-30T10:00:00Z', 'completed', 'success'),
    run('lint', 2, '2026-09-30T10:00:00Z', 'completed', 'skipped'),
    run('test', 3, '2026-09-30T10:00:00Z', 'completed', 'neutral'),
  ]).green, true)
  assert.equal(assessCheckRuns([]).green, false)
})
