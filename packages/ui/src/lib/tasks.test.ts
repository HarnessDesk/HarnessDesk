import { describe, expect, it } from 'vitest'

import { orderTasks, type BackgroundTask } from '@harnessdesk/protocol'

import {
  formatSpan,
  splitTasks,
  taskDetail,
  taskElapsed,
  taskKindWord,
  tasksChipLabel,
  tasksCount,
  taskStateWord,
  taskTooltip,
} from './tasks'

const task = (patch: Partial<BackgroundTask> & { id: string }): BackgroundTask => ({
  label: patch.id,
  kind: 'command',
  state: 'running',
  stoppable: true,
  ...patch,
})

describe('formatSpan', () => {
  it('says nothing rather than zero when there is no stamp to trust', () => {
    // "0s" is a claim; a job that has been running all day would be making a
    // false one. Nothing is the honest rendering of an unknown start.
    expect(formatSpan(null)).toBe('')
  })

  it('grows a unit at a time, and pads so the column does not jitter', () => {
    expect(formatSpan(9_000)).toBe('9s')
    expect(formatSpan(65_000)).toBe('1m 05s')
    expect(formatSpan(3_600_000 + 120_000)).toBe('1h 02m')
  })
})

describe('tasksCount', () => {
  it('counts only the halves that exist', () => {
    expect(tasksCount(splitTasks([task({ id: 'a' })]))).toBe('1 running')
    expect(tasksCount(splitTasks([task({ id: 'a' }), task({ id: 'b', state: 'completed' })]))).toBe('1 running · 1 finished')
    expect(tasksCount(splitTasks([task({ id: 'b', state: 'completed' })]))).toBe('1 finished')
  })
})

describe('tasksChipLabel', () => {
  it('leads with what is running, and counts the rest once nothing is', () => {
    // The spinner beside the chip says "live"; the words say how many. Once
    // everything has ended the chip is a plain count, not a promise.
    expect(tasksChipLabel(splitTasks([task({ id: 'a' }), task({ id: 'b', state: 'failed' })]))).toBe(
      '1 running in the background',
    )
    expect(tasksChipLabel(splitTasks([task({ id: 'a', state: 'completed' })]))).toBe('1 background task')
    expect(
      tasksChipLabel(splitTasks([task({ id: 'a', state: 'completed' }), task({ id: 'b', state: 'stopped' })])),
    ).toBe('2 background tasks')
    // The chip never mounts on an empty list, but the function must not say
    // "0 background tasks" to anything that asks.
    expect(tasksChipLabel(splitTasks([]))).toBe('')
  })
})

describe('the words on a card', () => {
  it('names the state as a person would', () => {
    expect(taskStateWord(task({ id: 'a' }))).toBe('Running')
    expect(taskStateWord(task({ id: 'a', state: 'completed' }))).toBe('Completed')
    expect(taskStateWord(task({ id: 'a', state: 'failed' }))).toBe('Failed')
    expect(taskStateWord(task({ id: 'a', state: 'stopped' }))).toBe('Stopped')
  })

  it('names the kind as a noun, never as a wire name', () => {
    // Claude's own panel says "Bash". This app's rule is that a tool's wire
    // name appears only where a rule is written against it.
    expect(taskKindWord(task({ id: 'a', kind: 'command' }))).toBe('Shell')
    expect(taskKindWord(task({ id: 'a', kind: 'agent' }))).toBe('Agent')
    expect(taskKindWord(task({ id: 'a', kind: 'other' }))).toBe('Task')
  })
})

describe('taskElapsed', () => {
  const now = 1_800_000_000_000

  it('measures running work to now', () => {
    expect(taskElapsed(task({ id: 'a', startedAt: now - 30_000 }), now)).toBe('30s')
  })

  it('measures finished work to when it ended', () => {
    const finished = task({ id: 'a', state: 'completed', startedAt: now - 300_000, endedAt: now - 240_000 })
    expect(taskElapsed(finished, now)).toBe('1m 00s')
  })

  it('says nothing for a finished task the runtime never dated', () => {
    expect(taskElapsed(task({ id: 'a', state: 'completed', startedAt: now - 1000 }), now)).toBe('')
  })

  it('says nothing when the stamp cannot be a wall-clock reading', () => {
    // A runtime that stamps in seconds hands us the number 1787765873; taken
    // on faith that reads as decades.
    expect(taskElapsed(task({ id: 'a', startedAt: 1 }), now)).toBe('')
  })
})

describe('taskDetail', () => {
  it('shows the command under the description', () => {
    expect(taskDetail(task({ id: 'a', label: 'Watch the tests', command: 'pnpm test -w' }))).toBe('pnpm test -w')
  })

  it('does not echo a label that is already the command', () => {
    expect(taskDetail(task({ id: 'a', label: 'pnpm test -w', command: 'pnpm test -w' }))).toBe(null)
  })

  it('falls back to the summary when there is no command', () => {
    expect(taskDetail(task({ id: 'a', label: 'Build', summary: 'exit 0, 4 warnings' }))).toBe('exit 0, 4 warnings')
  })
})

describe('splitTasks and orderTasks', () => {
  it('puts running work first, oldest first, and finished work newest first', () => {
    const ordered = orderTasks([
      task({ id: 'oldDone', state: 'completed', endedAt: 10 }),
      task({ id: 'newRun', startedAt: 200 }),
      task({ id: 'newDone', state: 'failed', endedAt: 90 }),
      task({ id: 'oldRun', startedAt: 100 }),
    ])
    expect(ordered.map((entry) => entry.id)).toEqual(['oldRun', 'newRun', 'newDone', 'oldDone'])
    const { running, finished } = splitTasks(ordered)
    expect(running.map((entry) => entry.id)).toEqual(['oldRun', 'newRun'])
    expect(finished.map((entry) => entry.id)).toEqual(['newDone', 'oldDone'])
  })
})

describe('taskTooltip', () => {
  it('gathers what one runtime knows without inventing what the other would have said', () => {
    const tip = taskTooltip(
      task({ id: 'a', label: 'Watch', command: 'pnpm test', cwd: '/w', osPid: 4321, cpuPercent: 12.4, rssKb: 204800 }),
    )
    expect(tip.split('\n')).toEqual(['Watch', 'pnpm test', '/w', 'pid 4321', '12% cpu', '200 MB'])
  })

  it('is just the label when the runtime said nothing else', () => {
    expect(taskTooltip(task({ id: 'a', label: 'Watch' }))).toBe('Watch')
  })
})
