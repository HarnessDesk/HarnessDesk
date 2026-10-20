import { ToolBodyControls } from '../design'
import { useEffect, useMemo, useState } from 'react'

import { isFinishedTask, type BackgroundTask } from '@harnessdesk/protocol'

import { ActionError, Button, CodeBlock, EmptyState, SectionBody, Spinner, Text, ToolSection } from '../design'
import { splitTasks, taskElapsed, taskKindWord, tasksCount, taskStateWord, taskTooltip } from '../lib/tasks'
import { useActiveSession, useRuntime, useSessionKey, useSnapshot, useStore } from '../state/context'
import { AlertIcon, BackgroundIcon, CheckIcon, StopIcon } from './Icons'
import { PanelBody, PanelFrame, PanelRow } from './Panel'

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
 * staying there after the turn. The conversation's rail keeps its own tasks;
 * older Background tasks routes retain the standalone panel.
 *
 * Nothing here is derived: the host relays the runtime's own list, every
 * control is a request, and the rows redraw from the event that answers —
 * which is what keeps two windows on one conversation from disagreeing about
 * what is alive.
 */

const EMPTY: readonly BackgroundTask[] = []

export const BackgroundTasksView = ({ card = false }: { card?: boolean }) => {
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
  const [read, setRead] = useState<{ key: typeof key; state: 'reading' | 'loaded' | 'unsupported' | 'failed' }>({ key, state: 'reading' })
  const [readAgain, setReadAgain] = useState(0)

  const split = useMemo(() => splitTasks(tasks), [tasks])
  const { running, finished } = split

  // Opening the panel is the moment the held list is most likely to be out
  // of date: a job running since before this window opened has had no reason
  // to be announced, because nothing about it has changed.
  useEffect(() => {
    let held = true
    if (!key || !runtime.capabilities.backgroundTasks) {
      setRead({ key, state: 'unsupported' })
      return
    }
    setRead({ key, state: 'reading' })
    void Promise.resolve(store.refreshTasks(key)).then(result => {
      if (held) setRead({ key, state: result ?? 'failed' })
    }, () => { if (held) setRead({ key, state: 'failed' }) })
    return () => { held = false }
  }, [key, store, runtime.capabilities.backgroundTasks, readAgain])

  // Only tick while something is actually running — the reason an idle app
  // has no timer at all.
  useEffect(() => {
    if (running.length === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running.length])

  const agent = runtime.presentation.name

  const clear = finished.length > 0 ? (
    <Button variant="ghost" size="xs"
      title="Forget the finished tasks. Anything still running keeps running."
      onClick={() => void store.clearTasks(key ?? undefined)}>
      Clear
    </Button>
  ) : null
  const body = <>
    {tasks.length === 0 ? (
      !session ? (
            <EmptyState
              tight
              icon={<BackgroundIcon />}
              title="No conversation"
              description="Open a conversation to see what its runtime is running in the background."
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
          <div className="flex flex-col gap-3">
            {running.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                now={now}
                card={card}
                onStop={() => void store.stopTask(task.id, key ?? undefined)}
              />
            ))}
            {finished.map((task) => (
              <TaskCard key={task.id} task={task} now={now} card={card} />
            ))}
          </div>
    )}
  </>
  const readState = read.key === key ? read.state : 'reading'
  if (card && tasks.length === 0 && (readState === 'loaded' || readState === 'unsupported')) return null
  const cardBody = tasks.length > 0 ? body : readState === 'reading' ? <Text role="meta">Reading background tasks…</Text>
    : <ActionError>Background tasks could not be read. <Button variant="link" size="inline-link" onClick={() => setReadAgain(value => value + 1)}>Try again</Button></ActionError>
  return card ? <ToolSection label="Background tasks" value={tasks.length > 0 ? tasksCount(split) : undefined} action={clear}>{cardBody}</ToolSection>
    : <PanelFrame testId="background-tasks-panel"><ToolBodyControls>
      <Text role="meta" truncate className="min-w-0 flex-1">{tasks.length > 0 ? tasksCount(split) : 'Background tasks'}</Text>{clear}
    </ToolBodyControls><PanelBody>{body}</PanelBody></PanelFrame>
}

/** The mark that says how a task is going: turning, done, or news. */
const StateMark = ({ task }: { task: BackgroundTask }) => {
  if (!isFinishedTask(task)) return <Spinner size="sm" tone="success" aria-hidden />
  // Done is the row's own quiet ink; the inspector row's mark slot owns it.
  if (task.state === 'completed') return <CheckIcon size={13} />
  // Amber, not red: a task that failed or was stopped is news, not an error
  // in the app.
  return (
    <Text role="meta" tone="warning">
      <AlertIcon size={13} />
    </Text>
  )
}

/**
 * One task: what it was called, how it is going, what it ran, what it said.
 *
 * The inspector's row, then the command plate the transcript draws for a
 * command and what it printed — the same object in the same two parts it has
 * in a turn, so a task that outlived its turn reads as that turn's command.
 *
 * The plate draws only when there is something to put in it — a command, or
 * output — so a task the runtime knows only by name is a row and nothing
 * else, rather than a row over an empty box. What is known about output that
 * has not arrived is said in the plate, a step quieter than output.
 */
const TaskCard = ({
  task,
  now,
  onStop,
  card = false,
}: {
  task: BackgroundTask
  now: number
  onStop?: () => void
  /** In a Details card, the plate takes the card's row edge, as its rows do. */
  card?: boolean
}) => {
  const elapsed = taskElapsed(task, now)
  const done = isFinishedTask(task)
  const meta = [taskKindWord(task), taskStateWord(task), elapsed].filter(Boolean).join(' · ')
  const hasBlock = Boolean(task.command) || task.output !== undefined || !done

  const plate = hasBlock ? (
    <CodeBlock
      {...(task.command ? { command: task.command, copyLabel: `Copy the command for ${task.label}` } : {})}
      {...(task.output !== undefined ? { output: task.output.length > 0 ? task.output : '(no output)' } : {})}
    >
      {task.output === undefined && (
        /* Three things "no output" can mean, and the plate says which:
           still running, so nothing yet; over, and the runtime is still
           fetching what it printed; over, and the runtime looked and the
           file was never there. The middle one used to read like the
           last, which left a person unable to tell a race from a loss. */
        <Text role="meta">
          {!done
            ? 'Nothing printed yet.'
            : task.outputMissing
              ? 'Its output was never found.'
              : 'Fetching what it printed…'}
        </Text>
      )}
      {task.outputTruncated && (
        <Text role="meta" className="mt-2 block">Showing the end of a longer log.</Text>
      )}
    </CodeBlock>
  ) : null

  return (
    <article data-slot="task-card" data-state={task.state} className="flex flex-col gap-1">
      <PanelRow
        mark={<StateMark task={task} />}
        title={done ? <Text role="row" ink="secondary">{task.label}</Text> : task.label}
        meta={meta}
        tooltip={taskTooltip(task)}
        trail={
          onStop && task.stoppable ? (
            <Button
              variant="destructive"
              size="xs"
              aria-label={`Stop ${task.label}`}
              title="Stop this task"
              onClick={onStop}
            >
              <StopIcon size={11} />
            </Button>
          ) : undefined
        }
      />
      {plate && (card ? <SectionBody spacing="inline">{plate}</SectionBody> : plate)}
    </article>
  )
}
