import { isFinishedTask, type BackgroundTask } from '@harnessdesk/protocol'

import { elapsedSince } from './clock'

/**
 * How the background-task panel reads a list. Pure, so the awkward cases —
 * a task with no start time, one that ended before it started, a summary
 * that is the whole of a command — are tested without a DOM.
 */

export interface TaskSplit {
  readonly running: readonly BackgroundTask[]
  readonly finished: readonly BackgroundTask[]
}

export const splitTasks = (tasks: readonly BackgroundTask[]): TaskSplit => ({
  running: tasks.filter((task) => !isFinishedTask(task)),
  finished: tasks.filter(isFinishedTask),
})

/**
 * The panel's count line: "1 running · 2 finished". Only the halves that are
 * non-zero, so an idle panel does not read "0 running" about nothing.
 */
export const tasksCount = (split: TaskSplit): string => {
  const parts: string[] = []
  if (split.running.length > 0) parts.push(`${split.running.length} running`)
  if (split.finished.length > 0) parts.push(`${split.finished.length} finished`)
  return parts.join(' · ')
}

/**
 * What the header chip says. A running count while anything is live, the
 * plain count once nothing is: the spinner beside it says which.
 */
export const tasksChipLabel = (split: TaskSplit): string => {
  const total = split.running.length + split.finished.length
  if (total === 0) return ''
  if (split.running.length > 0) {
    return `${split.running.length} running in the background`
  }
  return `${total} background task${total === 1 ? '' : 's'}`
}

/** The state, as a word a person would use. */
export const taskStateWord = (task: BackgroundTask): string => {
  switch (task.state) {
    case 'running':
      return 'Running'
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'stopped':
      return 'Stopped'
  }
}

/**
 * The kind, as a noun and never as a wire name. Claude Code's panel says
 * "Bash"; this app's rule is that a tool's wire name appears only where a
 * rule is written against it, so a shell is a shell.
 */
export const taskKindWord = (task: BackgroundTask): string => {
  switch (task.kind) {
    case 'command':
      return 'Shell'
    case 'agent':
      return 'Agent'
    default:
      return 'Task'
  }
}

/**
 * A duration, in the shortest form that is still exact enough to watch:
 * seconds under a minute, minutes and seconds under an hour, hours and
 * minutes above. Empty when the runtime never said when the task started,
 * because "0s" would be a claim about a task that has been running for a day.
 */
export const formatSpan = (ms: number | null): string => {
  if (ms === null) return ''
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * How long a task has been going, or how long it took.
 *
 * A finished task is measured to its own end rather than to now, which is the
 * difference between "took four minutes" and a number that keeps climbing
 * after the work stopped.
 */
export const taskElapsed = (task: BackgroundTask, now: number): string => {
  const end = isFinishedTask(task) ? (task.endedAt ?? null) : now
  if (end === null) return ''
  return formatSpan(elapsedSince(task.startedAt, end))
}

/** What the second line says, when there is one worth saying. */
export const taskDetail = (task: BackgroundTask): string | null => {
  const detail = task.command ?? task.summary ?? null
  if (!detail) return null
  // A label that is already the command needs no echo of it underneath.
  return detail.trim() === task.label.trim() ? null : detail
}

/** Everything known about a task, for the row's tooltip. */
export const taskTooltip = (task: BackgroundTask): string =>
  [
    task.label,
    task.command,
    task.cwd,
    task.summary && task.summary !== task.label ? task.summary : null,
    task.osPid ? `pid ${task.osPid}` : null,
    typeof task.cpuPercent === 'number' ? `${task.cpuPercent.toFixed(0)}% cpu` : null,
    typeof task.rssKb === 'number' ? `${Math.round(task.rssKb / 1024)} MB` : null,
    typeof task.exitCode === 'number' ? `exit ${task.exitCode}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
