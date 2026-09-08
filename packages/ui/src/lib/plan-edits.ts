import type { Todo } from './todos'

/**
 * A task the user reworded.
 *
 * The Tasks panel is a *read* of the conversation — that is what makes it one
 * plan per session, replaced by whatever the agent last wrote, and carried
 * whole into a hand-off. Letting a person edit a task therefore has to answer
 * a question the panel had never had to: where does text the transcript does
 * not contain live, and what happens to it when the agent writes its plan
 * again?
 *
 * No agent offers a way to set its plan — there is no `plan/set` on the wire,
 * for any of them — so the answer cannot be "we write it back". It is this:
 * the desk keeps the edit, shows it, and *tells the agent* on the next turn.
 * The edit is a correction the agent is free to adopt, and the moment it does,
 * the edit stops existing. What the panel shows is then the transcript again.
 *
 * Keyed on `from` — the label the transcript carries — rather than on a
 * position, because a plan is rewritten whole and a step inserted at the top
 * would otherwise move every edit onto the wrong task. `at` disambiguates the
 * one case a label cannot: a plan that repeats itself.
 */
export interface PlanEdit {
  /** The label as the agent wrote it. The edit attaches to this. */
  readonly from: string
  /** The label as the person wants it read. */
  readonly to: string
  /**
   * Which occurrence of `from`, for a plan that lists the same label twice —
   * "run the tests" after each of two changes is a real plan, and keyed on the
   * label alone one edit reworded both rows and the second was unreachable.
   * Absent means the first, so an edit written before this existed still means
   * what it said.
   */
  readonly at?: number
}

/** A task as the panel shows it, and what it was before anyone touched it. */
export interface ShownTodo extends Todo {
  /**
   * The label the transcript carries. Every edit is keyed on this, so editing
   * an already-edited task replaces its edit rather than stacking a second one
   * whose `from` nothing will ever match.
   */
  readonly source: string
  /** Which occurrence of `source` this row is, counting from zero. */
  readonly at: number
  readonly edited: boolean
}

/** How many edits one conversation keeps. */
const MAX_EDITS = 50

const sameTask = (edit: PlanEdit, label: string, at: number): boolean =>
  edit.from === label && (edit.at ?? 0) === at

export const applyPlanEdits = (
  todos: readonly Todo[],
  edits: readonly PlanEdit[],
): ShownTodo[] => {
  const seen = new Map<string, number>()
  return todos.map((todo) => {
    const at = seen.get(todo.label) ?? 0
    seen.set(todo.label, at + 1)
    const edit = edits.find((entry) => sameTask(entry, todo.label, at))
    return edit === undefined
      ? { ...todo, source: todo.label, at, edited: false }
      : { ...todo, label: edit.to, source: todo.label, at, edited: true }
  })
}

/**
 * The edits still worth keeping, once the agent's latest plan is in.
 *
 * An edit lives exactly as long as the task it was made on. While the plan
 * still carries `from`, the person's wording is what the panel should show
 * and what the agent should be told. Once the plan no longer carries it —
 * because the agent took the wording up, or reworded the step itself, or
 * dropped it — there is nothing left for the edit to attach to, and keeping it
 * would only risk rewriting some future task that reused the old label.
 *
 * Two narrower rules came before this one and both were wrong. Retiring on
 * `to` appearing read a *collision* as adoption: reword one task to match
 * another the plan already contained and the edit was dropped on the spot.
 * Retiring on nothing at all — keeping an edit that matched neither — left a
 * zombie the moment an agent adopted a paraphrase rather than the exact
 * words, which is what agents actually do.
 *
 * The empty plan is the one exception, and it is why this is not simply a
 * membership test. A plan is often cleared and rewritten inside one turn, and
 * retiring on the empty moment in between would throw away a correction the
 * person made seconds earlier.
 */
export const livePlanEdits = (
  todos: readonly Todo[],
  edits: readonly PlanEdit[],
): PlanEdit[] => {
  if (todos.length === 0) return edits.slice(-MAX_EDITS)
  const labels = new Set(todos.map((todo) => todo.label))
  return edits.filter((edit) => labels.has(edit.from)).slice(-MAX_EDITS)
}

/** Records one edit, replacing any the same task already had. */
export const withPlanEdit = (
  edits: readonly PlanEdit[],
  from: string,
  to: string,
  at = 0,
): PlanEdit[] => {
  const others = edits.filter((edit) => !sameTask(edit, from, at))
  // Typing the original wording back is not an edit; it is undoing one.
  if (to.trim() === '' || to === from) return others
  return [...others, at === 0 ? { from, to } : { from, to, at }].slice(-MAX_EDITS)
}

/**
 * What the agent is told, on the next turn, about the plan it is working to.
 *
 * Only edits that are still standing against the current plan — an edit the
 * agent has already adopted is not news, and one whose task is gone is not
 * either. `null` when there is nothing to say, so a message carries no
 * envelope rather than an empty one.
 */
export const planEditNote = (
  todos: readonly Todo[],
  edits: readonly PlanEdit[],
): string | null => {
  const labels = new Set(todos.map((todo) => todo.label))
  const standing = livePlanEdits(todos, edits).filter((edit) => labels.has(edit.from))
  if (standing.length === 0) return null
  const lines = standing.map((edit) => `- “${edit.from}” → “${edit.to}”`)
  return [
    standing.length === 1
      ? 'I reworded one task in the plan you are working to:'
      : `I reworded ${standing.length} tasks in the plan you are working to:`,
    '',
    ...lines,
    '',
    'Use my wording the next time you write the plan. Nothing else about the plan has changed — the statuses are still yours.',
  ].join('\n')
}

/** The label an edit is keyed on, for the panel's own bookkeeping. */
export const PLAN_EDIT_SOURCE = 'Task list edited by the user'
