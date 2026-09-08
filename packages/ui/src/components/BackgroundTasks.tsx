import { useEffect, useMemo, useState } from 'react'

import { isFinishedTask, type BackgroundTask } from '@harnessdesk/protocol'

import { Button, EmptyState } from '../design/ui'
import { cn } from '../lib/utils'
import { splitTasks, taskElapsed, taskKindWord, tasksCount, taskStateWord, taskTooltip } from '../lib/tasks'
import { useActiveSession, useRuntime, useSessionKey, useSnapshot, useStore } from '../state/context'
import { AlertIcon, BackgroundIcon, CheckIcon, StopIcon } from './Icons'
import { panel } from './Panel'

/**
 * What the agent has running in the background — as a panel.
 *
 * A background task outlives the turn whose row started it; by the time it
 * matters, that row has scrolled away. So it is kept beside the conversation
 * rather than inside it — Claude Code and Codex both reached that conclusion
 * and both keep a registry there. The first build of this put the registry
 * in a strip above the composer, where it could say a label, a clock and a
 * stop button and nothing more, and then spent a whole design note making
 * that strip distinguishable from the two beside it. What it could never
 * show was the one thing a person opens it for: what the task printed.
 *
 * A panel has the room. Each task is a card: the sentence the agent named it
 * with, the kind and the state in words, a clock, a stop while it runs — and
 * then the command under a prompt mark and the output beneath, scrollable,
 * staying there after the turn. It is the fifth inspector, summoned from the
 * ⋯ menu and ⌘K like the other four, and it follows the focused conversation
 * the way they do. The header wears a chip while anything is listed, so the
 * panel does not have to be open for the work to be noticed.
 *
 * Nothing here is derived: the host relays the runtime's own list, every
 * control is a request, and the rows redraw from the event that answers —
 * which is what keeps two windows on one conversation from disagreeing about
 * what is alive.
 */

const EMPTY: readonly BackgroundTask[] = []

export const BackgroundTasksView = () => {
  const store = useStore()
  const key = useSessionKey()
  const session = useActiveSession()
  const active = useRuntime()
  const snapshot = useSnapshot()
  // The conversation's own agent, not the composer's pick: the panel is about
  // what *this* conversation runs, and the two can differ while a new session
  // is being drafted for another agent.
  const runtime = snapshot.runtimes.find((entry) => entry.id === session?.runtime) ?? active
  const tasks = key ? (snapshot.tasks.get(key) ?? EMPTY) : EMPTY
  const [now, setNow] = useState(() => Date.now())

  const split = useMemo(() => splitTasks(tasks), [tasks])
  const { running, finished } = split

  // Opening the panel is the moment the held list is most likely to be out
  // of date: a job running since before this window opened has had no reason
  // to be announced, because nothing about it has changed.
  useEffect(() => {
    if (key) void store.refreshTasks(key)
  }, [key, store])

  // Only tick while something is actually running — the reason an idle app
  // has no timer at all.
  useEffect(() => {
    if (running.length === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running.length])

  const agent = runtime.presentation.name

  return (
    <div className={panel.panel} data-testid="background-tasks-panel">
      <div className={panel.tools}>
        <span className="min-w-0 flex-1 truncate text-xs text-(--hd-muted-foreground)">
          {tasks.length > 0 ? tasksCount(split) : 'Background tasks'}
        </span>
        {finished.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            title="Forget the finished tasks. Anything still running keeps running."
            onClick={() => void store.clearTasks(key ?? undefined)}
          >
            Clear
          </Button>
        )}
      </div>

      <div className={panel.body}>
        {tasks.length === 0 ? (
          !session ? (
            <EmptyState
              tight
              icon={<BackgroundIcon />}
              title="No conversation"
              description="Open a conversation to see what its agent is running in the background."
            />
          ) : !runtime.capabilities.backgroundTasks ? (
            // An agent without the concept, said plainly: an empty list would
            // suggest the work was lost, and it was never kept.
            <EmptyState
              tight
              icon={<BackgroundIcon />}
              title="Nothing to list"
              description={`${agent} keeps no list of work that outlives a turn.`}
            />
          ) : (
            <EmptyState
              tight
              icon={<BackgroundIcon />}
              title="Nothing in the background"
              description={`When ${agent} starts work that keeps going after a turn — a watcher, a long test run — it is listed here with its output.`}
            />
          )
        ) : (
          <div className="flex flex-col gap-2">
            {running.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                now={now}
                onStop={() => void store.stopTask(task.id, key ?? undefined)}
              />
            ))}
            {finished.map((task) => (
              <TaskCard key={task.id} task={task} now={now} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** The mark that says how a task is going: turning, done, or news. */
const StateMark = ({ task }: { task: BackgroundTask }) => {
  if (!isFinishedTask(task)) {
    return (
      <span
        aria-hidden
        data-slot="task-spinner"
        className="mt-0.5 inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-(--hd-border-strong) border-t-(--hd-success)"
      />
    )
  }
  if (task.state === 'completed') {
    return <CheckIcon size={13} className="mt-0.5 shrink-0 text-(--hd-muted-foreground)" />
  }
  // Amber, not red: a task that failed or was stopped is news, not an error
  // in the app.
  return <AlertIcon size={13} className="mt-0.5 shrink-0 text-(--hd-warning-ink)" />
}

/**
 * One task: what it was called, how it is going, what it ran, what it said.
 *
 * The output block draws only when there is something to put in it — a
 * command, or output — so a task the runtime knows only by name is a header
 * and nothing else, rather than a header over an empty box.
 */
const TaskCard = ({
  task,
  now,
  onStop,
}: {
  task: BackgroundTask
  now: number
  onStop?: () => void
}) => {
  const elapsed = taskElapsed(task, now)
  const done = isFinishedTask(task)
  const meta = [taskKindWord(task), taskStateWord(task), elapsed].filter(Boolean).join(' · ')
  const hasBlock = Boolean(task.command) || task.output !== undefined || !done

  return (
    <article
      data-slot="task-card"
      data-state={task.state}
      className="overflow-hidden rounded-(--hd-radius) border border-(--hd-border) bg-(--hd-card)"
      title={taskTooltip(task)}
    >
      <header className="flex items-start gap-2 px-3 py-2">
        <StateMark task={task} />
        <div className="min-w-0 flex-1">
          <div className={cn('truncate text-sm font-medium', done && 'text-(--hd-secondary-foreground)')}>
            {task.label}
          </div>
          <div className="text-xs text-(--hd-muted-foreground) tabular-nums">{meta}</div>
        </div>
        {onStop && task.stoppable && (
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Stop ${task.label}`}
            title="Stop this task"
            onClick={onStop}
          >
            <StopIcon size={11} />
          </Button>
        )}
      </header>
      {hasBlock && (
        <div className="max-h-[360px] overflow-auto border-t border-(--hd-border) bg-(--hd-muted) font-mono text-xs leading-[19px]">
          {task.command && (
            <div className="flex gap-2 px-3 pt-2 text-(--hd-foreground)">
              <span aria-hidden className="shrink-0 text-(--hd-muted-foreground)">
                $
              </span>
              <code className="min-w-0 whitespace-pre-wrap break-all">{task.command}</code>
            </div>
          )}
          {task.output !== undefined ? (
            <pre
              data-slot="task-output"
              className="m-0 whitespace-pre-wrap break-words px-3 py-2 text-(--hd-secondary-foreground)"
            >
              {task.output.length > 0 ? task.output : '(no output)'}
            </pre>
          ) : (
            /* Three things "no output" can mean, and the card says which:
               still running, so nothing yet; over, and the runtime is still
               fetching what it printed; over, and the runtime looked and the
               file was never there. The middle one used to read like the
               last, which left a person unable to tell a race from a loss. */
            <div className="px-3 py-2 text-(--hd-muted-foreground)" data-slot="task-output-note">
              {!done
                ? 'Nothing printed yet.'
                : task.outputMissing
                  ? 'Its output was never found.'
                  : 'Fetching what it printed…'}
            </div>
          )}
          {task.outputTruncated && (
            <div className="px-3 pb-2 text-(--hd-muted-foreground)">Showing the end of a longer log.</div>
          )}
        </div>
      )}
    </article>
  )
}
