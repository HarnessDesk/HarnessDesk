/**
 * What a plan entry is, in one place.
 *
 * Every agent has a plan tool and each spells an entry differently: Claude
 * Code's TodoWrite sends `{content, status:"completed"}`, Cursor's CreatePlan
 * sends `{content, status:"TODO_STATUS_IN_PROGRESS"}`, HarnessDesk's own
 * `todo_write` sends `{task, status:"done"}`. The renderer read one vocabulary
 * and the plugin read another, so a task the sidebar drew with a line through
 * it was still `[ ] pending` in the text handed back to the model — the same
 * two-sources-disagreeing bug the Tasks panel was rebuilt to end, one layer
 * down. There is one reading now, and both ends import it.
 */

export type PlanStatus = 'pending' | 'inProgress' | 'done' | 'cancelled'

/**
 * The keys a plan entry puts its text under, most specific first. Order only
 * decides an entry carrying more than one of them, which no agent sends —
 * but the two readers must break that tie the same way or they are back to
 * disagreeing.
 */
export const PLAN_LABEL_KEYS = ['task', 'content', 'title', 'step'] as const

/**
 * The keys an agent puts its plan array under. Measured from real transcripts
 * rather than guessed: Cursor's `CreatePlan` and `UpdateTodos` both use
 * `todos`, Claude Code's TodoWrite uses `todos`, ours uses `tasks`.
 *
 * This is the difference between "a plan" and "an array that happens to have
 * labels and statuses in it" — a tool listing GitHub issues or pipeline steps
 * returns exactly that shape, and without a key to anchor on it was read as
 * the conversation's plan and replaced it.
 *
 * `steps` was here and is not: it is what a CI or workflow tool calls its own
 * list, `[{title, status}]` to the letter, and no agent puts a plan under it.
 * A key earns its place by being one an agent actually uses.
 */
export const PLAN_ARRAY_KEYS = ['todos', 'tasks', 'plan'] as const

/** A plan entry's text, or null when the value carries none. */
export const planLabel = (record: Record<string, unknown>): string | null => {
  for (const key of PLAN_LABEL_KEYS) {
    const value = record[key]
    // A non-string is not a label: `String({})` is `"[object Object]"`, which
    // is a task nobody wrote and every reader would then show.
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

const DONE = new Set(['done', 'complete', 'completed', 'finished', 'closed'])
const RUNNING = new Set(['progress', 'active', 'running', 'started', 'working', 'doing'])
/* A negation spelled as one word never meets the check for `not` below:
   `incomplete`, `unfinished` and `undone` read as nothing at all (#62), and
   so did their past tenses (review, round 3). */
const OPEN = new Set([
  'pending',
  'todo',
  'open',
  'queued',
  'waiting',
  'new',
  'blocked',
  'incomplete',
  'incompleted',
  'uncompleted',
  'unfinished',
  'undone',
])
const DROPPED = new Set(['cancelled', 'canceled', 'abandoned', 'skipped', 'dropped'])
const NEGATIONS = new Set(['not', 'un', 'no', 'never'])

/**
 * A plan entry's status.
 *
 * `null` means the entry did not say — no status field, or a word none of the
 * three vocabularies recognise. A caller holding a previous list keeps what it
 * had for that task; one that is not treats it as pending. The distinction is
 * what stops a rewrite-to-append from silently reopening finished work.
 *
 * Matched on whole words, because every spelling of the same states is a
 * decoration of them: `completed`, `TODO_STATUS_COMPLETED` and `done` are one
 * state, and so are `in_progress`, `inProgress` and `active`. Whole words and
 * not substrings — `incomplete` contains `complete` and means the opposite.
 *
 * `cancelled` is the fourth state and is not a plan entry at all: a task the
 * agent abandoned is off the list, not an open one. Measured across every
 * transcript on this machine it has never once been sent — but reading it as
 * pending is the harmful direction, because that is what puts abandoned work
 * in front of the next agent.
 */
export const planStatus = (value: unknown): PlanStatus | null => {
  if (typeof value !== 'string') return null
  // Whole words, not substrings. Matching `complete` anywhere in the string
  // read `incomplete` as finished and `not_done` as done — the exact
  // inversion of what they say — and `TODO_STATUS_CANCELLED` came back
  // `pending`, which is how an abandoned task reached the next agent's
  // hand-off as work still to do.
  // camelCase is a word boundary too, and losing it is not hypothetical:
  // `inProgress` is `PlanStepStatus`'s own spelling and what `todo_write`'s
  // schema declares, and lowercasing it first turns it into one word.
  const words = value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
  if (words.some((word) => DROPPED.has(word))) return 'cancelled'
  // `in` negates only the `complete` after it: split by case or a separator,
  // `inComplete` is two words, and `in` alone is `in_progress`'s (review, round 1).
  const negated = (word: string, at: number): boolean =>
    NEGATIONS.has(word) || (word === 'in' && (words[at + 1] ?? '').startsWith('complete'))
  if (words.some(negated)) return 'pending'
  if (words.some((word) => DONE.has(word))) return 'done'
  if (words.some((word) => RUNNING.has(word))) return 'inProgress'
  if (words.some((word) => OPEN.has(word))) return 'pending'
  return null
}
