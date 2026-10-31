import { expect, it } from 'vitest'
import { leadNextSlot, leadRepeatTaskFor } from './lead-repeat'
import type { LeadScheduledTask } from '@harnessdesk/protocol'
import { leadRepeatingContract } from '../preview/lead-fixture'

const task: LeadScheduledTask = { id: 'repeat-one', title: 'Update acme-web', goal: 'Update dependencies', every: 'mondays', at: '09:00', enabled: true, lastRunAt: null }
it('shows the next local slot and moves a passed weekly slot to next week', () => {
  const monday = new Date(2026, 9, 26, 8, 0)
  expect(leadNextSlot(task, monday)).toEqual(new Date(2026, 9, 26, 9, 0))
  expect(leadNextSlot(task, new Date(2026, 9, 26, 10, 0))).toEqual(new Date(2026, 10, 2, 9, 0))
})
it('shows no upcoming slot for paused or stopped repeats and skips weekends', () => {
  const fridayNight = new Date(2026, 9, 30, 18, 0)
  expect(leadNextSlot({ ...task, paused: true }, fridayNight)).toBeNull()
  expect(leadNextSlot({ ...task, enabled: false }, fridayNight)).toBeNull()
  expect(leadNextSlot({ ...task, every: 'weekdays' }, fridayNight)).toEqual(new Date(2026, 10, 2, 9, 0))
})
it('opens the clicked historical repeat even when the current repeat is earlier in the list', () => {
  const old = { ...task, id: 'repeat-a', project: leadRepeatingContract.project.path, goal: leadRepeatingContract.goal, approved: { contract: leadRepeatingContract, contractDigest: leadRepeatingContract.digest } }
  const currentContract = { ...leadRepeatingContract, digest: 'b'.repeat(64), goal: 'Review acme-web notes' }
  const current = { ...old, id: 'repeat-b', goal: currentContract.goal, approved: { contract: currentContract, contractDigest: currentContract.digest } }
  const schedule = { version: 1 as const, tasks: [current, old], quiet: null }
  const origin = { source: 'schedule' as const, event: 'schedule-repeat-b-1', subject: '1', url: null }
  expect(leadRepeatTaskFor(schedule, leadRepeatingContract, currentContract.digest, origin)?.id).toBe('repeat-a')
  expect(leadRepeatTaskFor(schedule, { ...leadRepeatingContract, digest: 'd'.repeat(64) }, currentContract.digest, origin)?.id).toBe('repeat-a')
})
