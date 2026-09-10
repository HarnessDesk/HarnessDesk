import type { AgentItem, FileChange, Turn } from '@harnessdesk/protocol'

import { elapsedSince, instant } from './clock'
import { countDrawn } from './diff'
import { describedTitle, editedPathOf, isDescribed, isSilentReasoning, toolCallVerb } from './group-items'

/**
 * A turn, as the transcript lays it out: the prompt, the work, the answer.
 *
 * Agents narrate while they work and then answer; rendered as one flat list
 * the answer is the last thing in a column of steps. Codex's desktop app
 * folds the work under "Worked for 1m 14s" and leaves the answer standing,
 * which is the shape a person reading back actually wants. This is the split
 * — pure, so it can be tested without a DOM.
 */

export interface TurnView {
  /** What the person sent: the user message(s) that opened the turn. */
  readonly prompt: readonly AgentItem[]
  /** Narration, reasoning and steps, in order. Empty for a plain answer. */
  readonly work: readonly AgentItem[]
  /** The assistant's final-phase messages, in order. */
  readonly answer: readonly AgentItem[]
  /** Errors and other things that belong after the answer. */
  readonly trailing: readonly AgentItem[]
  /** Every file change the turn reported, in order. */
  readonly changes: readonly FileChange[]
}

const isAnswer = (item: AgentItem): boolean =>
  item.type === 'assistantMessage' && item.phase !== 'commentary'

/**
 * What opens a turn: the person's message, or a notice standing in for one —
 * the command echo or background-task report the turn actually began with.
 * A notice belongs beside the prompt rather than inside the work fold, where
 * a turn that is nothing but a notice would fold away to nothing.
 */
const opensTurn = (item: AgentItem): boolean => item.type === 'userMessage' || item.type === 'notice'

export const splitTurn = (turn: Turn): TurnView => {
  const prompt: AgentItem[] = []
  const work: AgentItem[] = []
  const answer: AgentItem[] = []
  const trailing: AgentItem[] = []
  const changes: FileChange[] = []
  // The answer is the run of final-phase messages the turn ends on — not
  // every final-phase message in it. An agent that narrates between tool
  // calls without marking the narration as commentary (Claude Code does not)
  // would otherwise have all its prose pooled below the fold and all its
  // steps pooled inside it, the two halves of the same story torn apart.
  // Errors and empty reasoning may sit among the closing messages without
  // ending the run.
  let boundary = turn.items.length
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index] as AgentItem
    if (item.type === 'error' || isSilentReasoning(item)) continue
    if (!isAnswer(item)) break
    boundary = index
  }
  turn.items.forEach((item, index) => {
    if (opensTurn(item) && work.length === 0 && answer.length === 0) {
      prompt.push(item)
      return
    }
    if (item.type === 'fileChange') changes.push(...item.changes)
    if (index >= boundary && isAnswer(item)) {
      answer.push(item)
      return
    }
    if (item.type === 'error') {
      trailing.push(item)
      return
    }
    work.push(item)
  })
  return { prompt, work, answer, trailing, changes }
}

/** The per-file totals of a turn, one row per path, last change wins the kind. */
export interface FileTotal {
  readonly path: string
  readonly kind: FileChange['kind']['type']
  readonly added: number
  readonly removed: number
}

export const totalsByFile = (changes: readonly FileChange[]): FileTotal[] => {
  const byPath = new Map<string, FileTotal & { readonly first: FileChange['kind']['type'] }>()
  for (const change of changes) {
    /* By the rule the file view draws with, so these totals and the badge on
       the change itself agree. This counted an added or deleted file's
       non-empty lines, so a blank line in one was drawn and not counted
       (review, round 2). A deletion's whole-file content is its removals. */
    const drawn = countDrawn(change.diff, change.kind.type !== 'update')
    const added = change.kind.type === 'delete' ? 0 : drawn.added
    const removed = change.kind.type === 'delete' ? drawn.added + drawn.removed : drawn.removed
    const previous = byPath.get(change.path)
    byPath.set(change.path, {
      path: change.path,
      kind: change.kind.type,
      first: previous?.first ?? change.kind.type,
      added: (previous?.added ?? 0) + added,
      removed: (previous?.removed ?? 0) + removed,
    })
  }
  // A scratch file made and removed in the same turn left nothing behind.
  return [...byPath.values()]
    .filter((file) => !(file.first === 'add' && file.kind === 'delete'))
    .map(({ first: _first, ...file }) => file)
}

/** What the agent is doing right now, for the live line under "Working for". */
export const liveActivity = (work: readonly AgentItem[]): string | null => {
  for (let index = work.length - 1; index >= 0; index -= 1) {
    const item = work[index] as AgentItem
    if ('status' in item && item.status === 'inProgress') return activityLabel(item)
  }
  const last = work[work.length - 1]
  if (!last) return null
  if (last.type === 'reasoning') return isSilentReasoning(last) ? 'Thinking' : (last.summary[0] ?? 'Thinking')
  return null
}

export const activityLabel = (item: AgentItem): string => {
  switch (item.type) {
    case 'command': {
      const first = item.actions[0]
      if (first?.type === 'read') return `Reading ${first.name}`
      if (first?.type === 'search') return first.query ? `Searching for ${first.query}` : 'Searching'
      if (first?.type === 'listFiles') return 'Listing files'
      return `Running ${item.command.replace(/^\/bin\/\w+ -lc '?/, '').replace(/'$/, '').slice(0, 80)}`
    }
    case 'toolCall':
      return item.tool
    case 'fileChange':
      return item.changes.length === 1 ? `Editing ${item.changes[0]?.path.split('/').pop() ?? 'a file'}` : `Editing ${item.changes.length} files`
    case 'webSearch':
      return `Searching the web for ${item.query}`
    case 'subagent':
      return 'Running a sub-agent'
    case 'reasoning':
      return isSilentReasoning(item) ? 'Thinking' : (item.summary[0] ?? 'Thinking')
    default:
      return 'Working'
  }
}

/** "39s", "1m 14s", "13m 42s", "1h 3m". */
export const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/**
 * How long a turn has taken, or took: measured by the runtime when it says.
 *
 * A runtime that stamps a turn with something that is not a wall-clock instant
 * — a fixture's `1`, a timestamp still in seconds — gets no duration at all.
 * "Working…" is true; "Working for 496541h 26m" is the epoch showing through.
 */
export const elapsedOf = (turn: Turn, now: number): number | null => {
  if (turn.status === 'inProgress') return elapsedSince(turn.startedAt, now)
  // A completed turn under a second is a replay stamped with load time, or
  // a duration the runtime never kept; "Worked for 0s" over two minutes of
  // work is the stamp showing, so the line drops the time instead.
  const kept = typeof turn.durationMs === 'number' ? turn.durationMs : null
  const measured = kept ?? elapsedSince(turn.startedAt, instant(turn.completedAt) ?? now)
  return measured !== null && measured >= 1000 ? measured : null
}

/** The one line that stands in for a folded turn. */
export interface TurnWorkLine {
  /** "Working for 18s" · "Worked for 25s" · "Stopped after 12s". */
  readonly head: string
  /**
   * What it amounted to. The agent's own sentences where it wrote them —
   * "Read the limiter · Find every caller of take" — then a count of the
   * steps it did not describe: "read 2 files". Empty when there is nothing
   * to say.
   */
  readonly receipt: string
  /** Something went wrong: the head takes the warn tone and the work stays open. */
  readonly trouble: boolean
  /**
   * The work carries steps the agent described in its own words, so it reads
   * back standing rather than folded: the sentences are the record, and a
   * fold would hide exactly the half a reader scrolls back for. A turn of
   * templated steps — every Codex turn — still folds to its count.
   */
  readonly informative: boolean
}

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`

/**
 * What the turn amounted to, counted off the items.
 *
 * Codex folds a two-minute turn into "Worked for 2m 04s" and throws away what
 * it did — which is the half a person scrolling back is looking for. The count
 * costs nothing to keep and rides on the same line.
 *
 * A shell command is only "a command" when it was not really a read or a
 * search: `sed -n 1,80p file` classified as a read is six reads, not six
 * commands, and saying "ran 6 commands" would misdescribe a read-only pass.
 *
 * An ACP agent sends every step as a `toolCall`, so counting by item type
 * alone said "called 47 tools" for a Claude Code turn whose own body — which
 * asks `toolCallVerb` — said "ran 44 commands, read 3 files". The header and
 * the thing it heads now read the same items the same way.
 */
const tally = (work: readonly AgentItem[]): string[] => {
  const paths = new Set<string>()
  let ran = 0
  let read = 0
  let searched = 0
  let tools = 0

  for (const item of work) {
    /* A step still running is not yet a thing the turn did. `runsOf` in
       `turn-summary.ts` has always skipped one; counting it here made an
       interrupted turn read "ran 1 command" over a summary row that had
       vanished entirely, because that side had nothing left to report. */
    if ('status' in item && item.status === 'inProgress') continue
    switch (item.type) {
      case 'fileChange':
        for (const change of item.changes) paths.add(change.path)
        break
      case 'command': {
        const action = item.actions[0]?.type
        if (action === 'read') read += 1
        else if (action === 'search') searched += 1
        else ran += 1
        break
      }
      case 'webSearch':
        searched += 1
        break
      case 'toolCall':
        // ACP flattens every step to a tool call; the arguments still say
        // what it was, and "ran 3 commands, read 2 files" is the receipt
        // where "called 5 tools" is a shrug.
        switch (toolCallVerb(item)) {
          case 'command':
            ran += 1
            break
          case 'read':
            read += 1
            break
          case 'search':
            searched += 1
            break
          case 'fileChange':
            {
              // Counted as a path, like a native file change, so two edits of
              // one file are one file.
              const path = editedPathOf(item)
              if (path !== null) paths.add(path)
            }
            break
          default:
            tools += 1
        }
        break
      default:
        break
    }
  }

  const parts: string[] = []
  if (paths.size > 0) parts.push(`edited ${plural(paths.size, 'file')}`)
  if (ran > 0) parts.push(`ran ${plural(ran, 'command')}`)
  if (read > 0) parts.push(`read ${plural(read, 'file')}`)
  if (searched > 0) parts.push(`searched ${plural(searched, 'time')}`)
  if (tools > 0) parts.push(`called ${plural(tools, 'tool')}`)
  return parts
}

/** Steps that ended badly, in the words the header uses for them. */
const troubles = (work: readonly AgentItem[]): string[] => {
  let failed = 0
  let declined = 0
  /* `summariseTurn` calls a completed command with a non-zero exit a failure
     and puts it in the row's own count; this read only `status`, so the fold
     line above it stayed untinted and folded a turn whose tests had just gone
     red. The two now agree on what went wrong. */
  for (const item of work) {
    if (!('status' in item)) continue
    if (item.status === 'declined') declined += 1
    else if (item.status === 'failed') failed += 1
    else if (item.type === 'toolCall' && item.error) failed += 1
    else if (item.type === 'command' && typeof item.exitCode === 'number' && item.exitCode !== 0) {
      failed += 1
    }
  }
  const parts: string[] = []
  if (declined > 0) parts.push(`${plural(declined, 'step')} declined`)
  if (failed > 0) parts.push(`${plural(failed, 'step')} failed`)
  return parts
}

/**
 * The header of a turn's work: how long, what it amounted to, whether it hurt.
 *
 * Trouble is the reason this is not merely cosmetic. A turn that was blocked,
 * declined or interrupted folds away exactly like a clean one unless something
 * says otherwise, and a UI that hides a blocked command behind "Worked for 4s"
 * is quiet rather than reliable. So trouble tints the line, keeps its count,
 * and holds the work open.
 */
export const describeTurnWork = (
  turn: Turn,
  work: readonly AgentItem[],
  now: number,
): TurnWorkLine => {
  const elapsed = elapsedOf(turn, now)
  const running = turn.status === 'inProgress'
  const took = elapsed !== null ? formatElapsed(elapsed) : null

  const head = running
    ? took !== null
      ? `Working for ${took}`
      : 'Working…'
    : turn.status === 'interrupted'
      ? took !== null
        ? `Stopped after ${took}`
        : 'Stopped'
      : took !== null
        ? `Worked for ${took}`
        : 'Worked'

  const hurt = troubles(work)
  const trouble = !running && (hurt.length > 0 || turn.status === 'failed')
  const said = work.map(describedTitle).filter((title): title is string => title !== null)
  const informative = said.length > 0

  // While it runs the live line already says what is happening; a count that
  // changes every second under it is noise, not information.
  if (running) return { head, receipt: '', trouble: false, informative }

  // The sentences first, as the agent wrote them; then the count of what it
  // did not describe. Codex folds a two-minute turn to "Worked for 2m 04s"
  // and throws away what it did; Claude's app keeps every sentence on
  // screen. This line is the folded case's answer to both: what a person
  // scrolling back is looking for, on the one line that stands for the turn.
  const rest = work.filter((item) => !isDescribed(item))
  const counted = [...tally(rest), ...hurt]
  const parts = [...(said.length > 0 ? [said.join(' · ')] : []), ...(counted.length > 0 ? [counted.join(', ')] : [])]
  // An interrupted turn is asked one question above all others, and the items
  // answer it: nothing was written, or these files were.
  if (turn.status === 'interrupted' && parts.length === 0) {
    return { head, receipt: 'nothing was written', trouble, informative }
  }
  return { head, receipt: parts.join(' · '), trouble, informative }
}
