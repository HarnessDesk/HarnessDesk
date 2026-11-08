import { expect, it } from 'vitest'
import * as opening from './lead-opening'
import { leadContract } from '../preview/lead-fixture'

it('offers no invented job for an empty desk', () => {
  expect(opening.leadOpeningJobs({ flowExecutions: new Map(), goals: new Map() }, leadContract.project.path)).toEqual([])
})
it('takes at most two concrete jobs in the current project and skips reviewed or wrapped work', () => {
  const goal = { goal: { id: 'team-1', root: '/workspace/demo', state: 'open', sentence: 'Keyboard focus' } }
  const run = (id: string, state: string, review = false) => ({ id, goal: 'team-1', state, rounds: review ? [{ role: 'review', state: 'closed' }] : [] })
  const desk = { goals: new Map([['team-1', goal]]), flowExecutions: new Map([
    ['1', run('1', 'stalled')], ['2', run('2', 'settled')], ['3', run('3', 'settled', true)], ['4', run('4', 'settled')],
  ]) } as never
  expect(opening.leadOpeningJobs(desk, '/workspace/demo').map(job => job.id)).toEqual(['run-1', 'run-2'])
  expect(opening.leadOpeningJobs(desk, '/workspace/elsewhere')).toEqual([])
})
