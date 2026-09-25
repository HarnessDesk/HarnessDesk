import type { FlowExecution, GoalView } from '@harnessdesk/protocol'

/**
 * Which of a Goal's flow runs a surface shows by default — one rule
 * (`goalRunOf`), read by the room's header and, unless a person picked an
 * earlier run of their own to read as history, by its Findings pane too.
 *
 * A Goal can hold more than one run: a new one starts after an earlier one
 * stopped or was dropped, and a Goal's id is reused across incarnations, so
 * the first cached run merely sharing the Goal's id can be an old one (#890).
 * In order: the run reserved on the Goal, the run going on now (running, or
 * stalled on a person), the run whose flow opened the Goal, and — only for a
 * Goal that names no run of its own — the last one this window heard of.
 * A named run not cached yet reads as none, never as a stand-in: the caller
 * asks for `namedGoalRun` instead.
 */

/** The run a Goal names for itself: its reservation, else the flow that opened it. */
export const namedGoalRun = (view: GoalView | null | undefined): string | null =>
  view?.reservation?.run ?? (view?.goal.origin.kind === 'flow' ? view.goal.origin.run : null)

/**
 * Every run of this Goal that keeps findings, oldest first as this window
 * heard of them — the history a Findings pane offers beside its default
 * (`goalRunOf`), each said as "Run 2 of 3 · stopped".
 */
export const goalRunsOf = (goal: string, executions: ReadonlyMap<string, FlowExecution>): readonly FlowExecution[] =>
  [...executions.values()].filter((one) => one.goal === goal && Boolean(one.findings))

const RUN_STATE_WORDS: Readonly<Record<FlowExecution['state'], string>> = {
  running: 'going on',
  stalled: 'waiting on you',
  stopped: 'stopped',
  settled: 'finished',
}

export const goalRunLabel = (run: FlowExecution, index: number, total: number): string =>
  `Run ${index + 1} of ${total} · ${RUN_STATE_WORDS[run.state]}`

export const goalRunOf = (
  goal: string,
  view: GoalView | null | undefined,
  executions: ReadonlyMap<string, FlowExecution>,
  accept: (run: FlowExecution) => boolean = () => true,
): FlowExecution | null => {
  const mine = [...executions.values()].filter((one) => one.goal === goal && accept(one))
  const byId = (id: string | null | undefined): FlowExecution | undefined => (id ? mine.find((one) => one.id === id) : undefined)
  const origin = view?.goal.origin.kind === 'flow' ? view.goal.origin.run : null
  return byId(view?.reservation?.run)
    ?? mine.find((one) => one.state === 'running' || one.state === 'stalled')
    ?? byId(origin)
    ?? (namedGoalRun(view) === null ? mine.at(-1) : undefined)
    ?? null
}
