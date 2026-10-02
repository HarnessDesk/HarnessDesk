import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assessCheckRuns } from '../src/check-runs.js'

const run = (name: string, id: number, started_at: string | null, status: string, conclusion: string | null) => ({
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

test('assessCheckRuns treats a rerun that has not started as the newest run', () => {
  const queued = assessCheckRuns([
    run('build', 1, '2026-09-30T10:00:00Z', 'completed', 'success'),
    run('build', 2, null, 'queued', null),
  ])
  assert.equal(queued.green, false, 'a queued rerun hides the older success')
  assert.match(queued.reason, /“build” is queued/)

  assert.equal(assessCheckRuns([
    run('build', 2, null, 'queued', null),
    run('build', 1, '2026-09-30T10:00:00Z', 'completed', 'success'),
  ]).green, false, 'the order the runs arrive in does not matter')
})

test('assessCheckRuns keeps a queued required-check rerun ahead of its older success', () => {
  const required = [{ context: 'build', integrationId: 15368 }]
  for (const runs of [
    [
      { ...run('build', 1, '2026-09-30T10:00:00Z', 'completed', 'success'), app: { id: 15368 } },
      { ...run('build', 2, null, 'queued', null), app: { id: 15368 } },
    ],
    [
      { ...run('build', 2, null, 'queued', null), app: { id: 15368 } },
      { ...run('build', 1, '2026-09-30T10:00:00Z', 'completed', 'success'), app: { id: 15368 } },
    ],
  ]) {
    const assessment = assessCheckRuns(runs, required)
    assert.equal(assessment.green, false)
    assert.match(assessment.reason, /“build” is queued/)
  }
})

test('assessCheckRuns reads an empty start time as not started, never as a very old one', () => {
  for (const runs of [
    [run('build', 1, '2026-09-30T10:00:00Z', 'completed', 'success'), run('build', 2, '', 'queued', null)],
    [run('build', 2, '', 'queued', null), run('build', 1, '2026-09-30T10:00:00Z', 'completed', 'success')],
  ]) {
    assert.equal(assessCheckRuns(runs).green, false)
  }
})

test('assessCheckRuns lets the higher id win between two runs that have not started', () => {
  assert.equal(assessCheckRuns([
    run('build', 3, null, 'queued', null),
    run('build', 4, null, 'completed', 'success'),
  ]).green, true, 'the later attempt passed')
  assert.equal(assessCheckRuns([
    run('build', 3, null, 'completed', 'success'),
    run('build', 4, null, 'queued', null),
  ]).green, false, 'the later attempt is still queued')
})

test('assessCheckRuns refuses every other state that is not a finished pass', () => {
  for (const [status, conclusion] of [
    ['queued', null],
    ['in_progress', null],
    ['waiting', null],
    ['pending', null],
    ['requested', null],
    ['completed', 'failure'],
    ['completed', 'cancelled'],
    ['completed', 'timed_out'],
    ['completed', 'action_required'],
    ['completed', 'stale'],
    ['completed', 'startup_failure'],
    ['completed', null],
  ] as const) {
    assert.equal(
      assessCheckRuns([run('build', 1, '2026-09-30T10:00:00Z', status, conclusion)]).green,
      false,
      `${status}/${conclusion ?? 'none'} is not a pass`,
    )
  }
})
