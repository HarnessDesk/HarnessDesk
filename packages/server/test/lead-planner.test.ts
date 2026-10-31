import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LeadSchedule } from '@harnessdesk/protocol'
import { LeadPlanner, leadDueTask, leadQuietAt } from '../src/lead/planner.js'

const task = (over: Partial<LeadSchedule['tasks'][number]> = {}): LeadSchedule['tasks'][number] =>
  ({ id: 'task-1', title: 'Morning tidy', goal: 'Close stale branches', every: 'day', at: '09:00', enabled: true, lastRunAt: null, ...over })
const at = (day: number, clock: string) => { const date = new Date(2026, 9, day); date.setHours(Number(clock.slice(0, 2)), Number(clock.slice(3)), 0, 0); return date }

test('a task is due once its time today has come, and once per slot', () => {
  const schedule: LeadSchedule = { version: 1, tasks: [task()], quiet: null }
  assert.equal(leadDueTask(schedule, at(21, '08:59')), null)
  const due = leadDueTask(schedule, at(21, '09:05'))!
  assert.equal(due.task.id, 'task-1')
  assert.equal(leadDueTask({ ...schedule, tasks: [task({ lastRunAt: due.slot + 1 })] }, at(21, '10:00')), null, 'ran since the slot')
  assert.equal(leadDueTask({ ...schedule, tasks: [task({ enabled: false })] }, at(21, '10:00')), null)
})

test('days of the week and quiet hours hold a task', () => {
  // 2026-10-24 is a Saturday, 10-26 a Monday.
  assert.equal(leadDueTask({ version: 1, tasks: [task({ every: 'weekdays' })], quiet: null }, at(24, '10:00')), null)
  assert.ok(leadDueTask({ version: 1, tasks: [task({ every: 'mondays' })], quiet: null }, at(26, '10:00')))
  const night: LeadSchedule = { version: 1, tasks: [task({ at: '00:30' })], quiet: { from: '22:00', to: '07:00' } }
  assert.equal(leadQuietAt(night, at(21, '23:00')), true)
  assert.equal(leadQuietAt(night, at(21, '06:59')), true)
  assert.equal(leadQuietAt(night, at(21, '07:00')), false)
  assert.equal(leadDueTask(night, at(21, '03:00')), null, 'held through quiet hours')
  assert.ok(leadDueTask(night, at(21, '07:01')), 'runs when they end')
})

test('the files keep the run time across an edit, and offered lines wait for Keep', async () => {
  const home = await mkdtemp(join(tmpdir(), 'lead-planner-'))
  const planner = new LeadPlanner(home)
  assert.deepEqual(await planner.readSchedule(), { version: 1, tasks: [], quiet: null })
  await planner.writeSchedule({ version: 1, tasks: [task()], quiet: null })
  await planner.markRan('task-1', 1234)
  const edited = await planner.writeSchedule({ version: 1, tasks: [task({ title: 'Renamed', lastRunAt: null })], quiet: { from: '22:00', to: '07:00' } })
  assert.equal(edited.tasks[0]!.lastRunAt, 1234)
  assert.equal((await stat(join(home, 'lead', 'schedule.json'))).mode & 0o777, 0o600)

  await planner.suggest('Prefer small pull requests', 'memory-1', 1)
  await planner.suggest('prefer small   pull requests', 'memory-2', 2)
  let memory = await planner.readMemory()
  assert.deepEqual(memory.items.map(item => [item.id, item.state]), [['memory-1', 'suggested']], 'offered once')
  assert.deepEqual(await planner.kept(), [])
  memory = await planner.writeMemory({ version: 1, items: memory.items.map(item => ({ ...item, state: 'kept' as const })) })
  assert.deepEqual(await planner.kept(), ['Prefer small pull requests'])
  assert.match(await readFile(join(home, 'lead', 'memory.json'), 'utf8'), /"kept"/)
})

test('seed choices and project-bound accepted tasks survive a new planner', async () => {
  const home = await mkdtemp(join(tmpdir(), 'lead-seeds-'))
  const accepted = { version: 1 as const, quiet: { from: '22:00', to: '07:00' }, seedChoices: ['ci:/workspace/widgets', 'ci:/workspace/docs'],
    tasks: [{ ...task(), project: '/workspace/widgets' }] }
  await new LeadPlanner(home).writeSchedule(accepted)
  const saved = await new LeadPlanner(home).readSchedule()
  assert.ok(saved.tasks[0]!.createdAt! > 0)
  const { createdAt: _created, ...savedTask } = saved.tasks[0]!
  assert.deepEqual({ ...saved, tasks: [savedTask] }, accepted)
  const schedule = await new LeadPlanner(home).readSchedule()
  assert.equal(leadDueTask(schedule, at(21, '23:00')), null)
})
