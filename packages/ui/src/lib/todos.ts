import {
  PLAN_ARRAY_KEYS,
  planLabel,
  planStatus,
  type AgentItem,
  type Session,
} from '@harnessdesk/protocol'

export interface Todo {
  readonly label: string
  readonly done: boolean
  readonly active: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** One entry of a plan, in whichever shape an agent wrote it. */
const todoOf = (entry: unknown): Todo | null => {
  // A bare string is a task with nothing said about its state, which is what
  // `todo_write` documents and what a model sends when it is only listing.
  if (typeof entry === 'string') {
    const label = entry.trim()
    return label ? { label, done: false, active: false } : null
  }
  if (!isRecord(entry)) return null
  const label = planLabel(entry)
  if (label === null) return null
  const status = planStatus(entry['status'])
  // A task the agent abandoned is off the plan, not an open one.
  if (status === 'cancelled') return null
  return { label, done: status === 'done', active: status === 'inProgress' }
}

/**
 * A to-do list hiding in tool arguments, whatever the agent calls it.
 *
 * Claude Code's TodoWrite, Cursor's CreatePlan and Codex's plan all send an
 * array of entries with a label and a status; HarnessDesk's own `todo_write`
 * sends the same shape under its own noun. The reading of an entry — which
 * key is the label, which word is which state — is `@harnessdesk/protocol`'s
 * `planLabel` / `planStatus`, shared with the plugin so the two cannot drift.
 *
 * Found anywhere in the value, it is a checklist the user should read as one
 * rather than JSON with the meaning escaped. Every entry must carry a status
 * for the array to count, because this is asked of *arbitrary* arguments and
 * a list of labelled things with no states is not a checklist. Deciding the
 * **conversation's** plan is a different question — anchored on the key, and
 * therefore free to be permissive about the entries — and asks `planOf`.
 */
export const findTodos = (value: unknown): Todo[] | null => {
  if (Array.isArray(value)) {
    if (
      value.length > 0 &&
      value.every((entry) => isRecord(entry) && planLabel(entry) !== null && 'status' in entry)
    ) {
      return value.map(todoOf).filter((todo): todo is Todo => todo !== null)
    }
    for (const entry of value) {
      const found = findTodos(entry)
      if (found) return found
    }
    return null
  }
  if (!isRecord(value)) return null
  for (const entry of Object.values(value)) {
    const found = findTodos(entry)
    if (found) return found
  }
  return null
}

/** Every array a value carries under a plan-naming key, at any depth. */
const planArrays = (value: unknown, found: unknown[][] = []): unknown[][] => {
  if (Array.isArray(value)) {
    for (const entry of value) planArrays(entry, found)
    return found
  }
  if (!isRecord(value)) return found
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry) && (PLAN_ARRAY_KEYS as readonly string[]).includes(key)) {
      found.push(entry)
    }
    planArrays(entry, found)
  }
  return found
}

/**
 * The plan a tool call is *setting*, as opposed to a list it happens to be
 * carrying.
 *
 * Two things `findTodos` alone gets wrong about a conversation's plan, both
 * found by review and both reproduced:
 *
 *   - **A clear cannot clear.** An agent that finishes its work sends the
 *     plan tool an empty list. `findTodos` answers "no todos here", which is
 *     indistinguishable from a tool call that was never about a plan — so the
 *     finished plan stayed on screen and in every hand-off, permanently.
 *   - **Anything list-shaped could take the plan over.** A tool returning
 *     GitHub issues or pipeline steps sends exactly `[{title, status}]`, and
 *     that replaced whatever the agent had actually planned.
 *
 * Both are answered by anchoring on the *key*: a plan is what an agent put
 * under `todos`, `tasks` or `plan`, and nothing else is. Returning
 * `[]` says the agent cleared it, where `null` says this call said nothing
 * about the plan at all.
 *
 * A call can carry more than one such key — Cursor's `CreatePlan` sends its
 * `todos` beside an empty `phases`, and until this was measured against real
 * transcripts a plainer reading of "an empty plan array means cleared" would
 * have blanked the panel on the very call that set the plan. A list with
 * entries wins; only when every plan key it carries is empty is it a clear.
 */
export const planOf = (args: unknown): Todo[] | null => {
  const arrays = planArrays(args)
  if (arrays.length === 0) return null
  for (const array of arrays) {
    if (array.length === 0) continue
    // Inside a plan key the reading is permissive, where `findTodos` — asked
    // of arbitrary arguments — has to stay strict. A status is optional here
    // and a bare string is a task, because both are what `todo_write`
    // documents and accepts; requiring one meant an agent writing
    // `{tasks: [{task: "design"}]}` updated its own list and the turn's
    // context while the panel and every hand-off kept showing the plan
    // before it.
    const todos = array.map(todoOf).filter((todo): todo is Todo => todo !== null)
    if (todos.length > 0) return todos
  }
  return arrays.every((array) => array.length === 0) ? [] : null
}

/**
 * The plan a conversation is working to: the last one it set, and nothing
 * older. `[]` is a plan the agent cleared; `null` is a conversation that
 * never had one. Neither draws a panel, and neither reaches a hand-off.
 *
 * Read from the conversation's own record rather than held beside it, which
 * settles three questions at once. Each session has its own, because each
 * session has its own transcript. A new plan replaces the old one, because
 * only the last write is returned. And a hand-off carries it, because the
 * packet is built from the same function — the sidebar and the packet cannot
 * disagree about what is still to do.
 *
 * Every agent's spelling counts: `turn.plan` is what ACP plan updates and
 * Codex's `update_plan` become, and the tool-argument form is Claude Code's
 * TodoWrite, Cursor's CreatePlan, and HarnessDesk's own `todo_write`.
 *
 * Walked from the end and stopped at the first plan found, which is the same
 * answer as walking forward and keeping the last — a marathon conversation is
 * hundreds of turns of several tool calls each, and this runs on every event
 * the session sees. A turn's own `plan` is later than its items, because
 * `turn/plan` arrives after them, so it is asked first.
 */
export const sessionPlan = (session: Session | null | undefined): Todo[] | null => {
  if (!session) return null
  for (let turnIndex = session.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = session.turns[turnIndex]
    if (!turn) continue
    if (turn.plan) {
      return turn.plan.map((step) => ({
        label: step.step,
        done: step.status === 'completed',
        active: step.status === 'inProgress',
      }))
    }
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex]
      if (item?.type !== 'toolCall') continue
      const found = planOf((item as Extract<AgentItem, { type: 'toolCall' }>).args)
      if (found) return found
    }
  }
  return null
}
