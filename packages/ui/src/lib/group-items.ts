import type { AgentItem } from '@harnessdesk/protocol'

import { editOf } from './handoff'

/**
 * Grouping a turn's items for display.
 *
 * Agents work in bursts: a sentence of narration, then eight tool calls, then
 * another sentence. Rendered flat, the prose drowns. Collapsing each burst into
 * one node restores the shape of the conversation while keeping every step one
 * click away.
 *
 * Prose, plans, and errors are never grouped — those are the things a person is
 * reading. Neither is a *described* step: a call the agent titled itself, in a
 * sentence written for a person ("Find every caller of Limiter.take"). Batching
 * is what a transcript does to labels that carry nothing — "Ran a command"
 * seven times is noise — and a sentence is not that. It stands in the flow,
 * and only the templated steps around it fold into a count.
 */

/**
 * A step the agent described in its own words — Claude Code's shell tool asks
 * for a `description` on every call, and the desktop app titles the row with
 * it. Nothing on Codex's wire carries one, so its steps are never described
 * and always eligible for a batch.
 */
export const describedTitle = (item: AgentItem): string | null => {
  if (item.type !== 'toolCall') return null
  const args = item.args
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  const description = (args as Record<string, unknown>)['description']
  return typeof description === 'string' && description.trim().length > 0 ? description.trim() : null
}

export const isDescribed = (item: AgentItem): boolean => describedTitle(item) !== null

const STEP_TYPES = new Set<AgentItem['type']>([
  'command',
  'fileChange',
  'toolCall',
  'webSearch',
  'subagent',
  'image',
])

/** Below this, a group costs more than it saves. */
export const GROUP_THRESHOLD = 3

/**
 * Reasoning the backend sent nothing for — no summary, no text. It marks a
 * moment the agent spent thinking, but there is nothing in it to read, so it
 * neither breaks a burst of steps nor earns a card of its own; a run of them
 * collapses to one quiet line.
 */
/** The row's title when the agent thought but said nothing about it. */
const THINKING = 'Thinking'

/** How long a derived title may run before it is cut on a word boundary. */
const TITLE_CAP = 72

/**
 * The first sentence of a paragraph, as plain text.
 *
 * Thinking arrives as markdown and often opens with its own bold lead-in
 * (`**Analyzing the diff**`), which is the best title available and unusable
 * until the markers come off. Row titles are plain — `.rowTitlePlain` sets no
 * code face and parses nothing — so every marker goes, backticks included.
 */
/**
 * The first terminator that ends a sentence rather than an abbreviation.
 *
 * The discriminator is the WORD in front of it, not the length of the line.
 * A floor on length was the first attempt and it fails both ways: "Found it!"
 * is nine characters and a whole sentence, while "Analyzing e.g." is fourteen
 * and is not. What separates them is that `g` is one letter and `it` is two —
 * an abbreviation's last piece is a single letter, and a real word is not.
 * A word ending in a digit is out for the same reason "1.5" is.
 */
const sentenceEnd = (plain: string): string | undefined => {
  for (const match of plain.matchAll(/([^\s.!?]+)[.!?](?=\s|$)/g)) {
    const word = match[1] ?? ''
    if (word.length >= 2 && !/\d$/.test(word)) {
      return plain.slice(0, (match.index ?? 0) + word.length + 1)
    }
  }
  return undefined
}

const firstSentence = (text: string): string => {
  /* A line break ends a title before any full stop does. A thought that opens
     with its own lead-in — `**Analyzing the diff**` on one line, the prose
     under it — has no punctuation to find, and collapsing the whitespace
     first ran the two together ("Analyzing the diff The change…"). */
  const plain = (text.split('\n').find((line) => line.trim() !== '') ?? '')
    .replace(/^\s*#{1,6}\s+/, '')
    /* List markers, ordered as well as not. A thought that opens `1. Check
       each changed file.` is a numbered step, and leaving the marker on makes
       `1.` the first sentence the rule below finds. */
    .replace(/^\s*(?:[>*+-]|\d+[.)])\s+/, '')
    /* A bold pair and a code span, and nothing else. Stripping every `*`, `_`
       and backtick turned `run_tests` into `runtests`; stripping single-`*`
       pairs then turned the glob `packages/**\/*.css` into
       `packages/*\/.css`, because `*` … `*` spans the middle of it. A lone
       marker left in a title costs a character; a corrupted path costs the
       reader the one thing the title was for. */
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  /* A sentence, or the whole line when it does not end one.
     Two things disqualify a terminator. It may not follow a digit — "1." is a
     list marker and "1.5" is a number — and it may not end something too short
     to be a sentence, because "Analyzing e.g. the worktree layout" otherwise
     becomes "Analyzing e.g" and "Checking foo.ts and bar.ts" loses its second
     half. Twelve characters is the floor; below it, keep scanning. */
  const sentence = (sentenceEnd(plain) ?? plain).trim()
  // No full stop on a title; nothing else in the transcript wears one.
  const title = sentence.replace(/\.$/, '')
  if (title.length <= TITLE_CAP) return title
  const cut = title.slice(0, TITLE_CAP)
  const space = cut.lastIndexOf(' ')
  return `${(space > TITLE_CAP / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

export const isSilentReasoning = (item: AgentItem): boolean =>
  item.type === 'reasoning' &&
  item.summary.every((entry) => entry.trim() === '') &&
  item.content.every((entry) => entry.trim() === '')

/**
 * What a reasoning row is CALLED, derived rather than read off a field.
 *
 * `summary` is a line the backend wrote for exactly this purpose, and Claude
 * and Codex both send one — which is why their reasoning rows read as
 * "Finding where worktrees are listed". Gemini sends its thinking as `content`
 * and no summary at all, so every one of its rows fell through to the literal
 * fallback: measured on a live three-model room, one Gemini turn rendered as
 * NINE consecutive rows titled "Thinking", each with a chevron and nothing to
 * tell it from the one above. Same renderer, same runtime, same room. The only
 * difference was which field the model happened to fill.
 *
 * `isSilentReasoning` did not catch them either, because it asks for summary
 * AND content to be empty and these have content — the run was never
 * condensed and never titled.
 *
 * So the title is the summary when there is one and the first sentence of the
 * thinking when there is not, which is what a summary is. This is the same
 * move `describedTitle` above makes for tool calls, for the same reason: a
 * reader should not be able to tell which vendor is answering from how much
 * the interface is willing to say.
 */
export const reasoningHeadline = (item: AgentItem): string => {
  const { spoken } = reasoningParts(item)
  return spoken === undefined ? THINKING : (firstSentence(spoken) || THINKING)
}

/**
 * The paragraphs to show when the row is opened — everything except the one
 * the title was taken from.
 *
 * The title and the body have to agree about which paragraph was spent, and
 * they did not: the body was `[...summary.slice(1), ...content]`, which is
 * right while the title comes from `summary[0]` and wrong the moment it comes
 * from `content[0]` instead. A model that sends no summary then had its lead-in
 * printed twice, once as the title and once as the first line under it, with
 * the `**` still on it. Found by the three-model review of this change.
 */
export const reasoningBody = (item: AgentItem): readonly string[] => reasoningParts(item).rest

/** The first thing a reasoning item says, and everything after it. */
const reasoningParts = (
  item: AgentItem,
): { readonly spoken: string | undefined; readonly rest: readonly string[] } => {
  if (item.type !== 'reasoning') return { spoken: undefined, rest: [] }
  const all = [...item.summary, ...item.content]
  const at = all.findIndex((entry) => entry.trim() !== '')
  if (at === -1) return { spoken: undefined, rest: [] }
  return { spoken: all[at], rest: all.slice(at + 1).filter((entry) => entry.trim() !== '') }
}

/** Consecutive silent reasoning items, folded into the first of them. */
export const condenseItems = (items: readonly AgentItem[]): AgentItem[] => {
  const kept: AgentItem[] = []
  for (const item of items) {
    const previous = kept[kept.length - 1]
    if (previous && isSilentReasoning(item) && isSilentReasoning(previous)) continue
    kept.push(item)
  }
  return kept
}

export type DisplayNode =
  | { readonly kind: 'item'; readonly item: AgentItem }
  | {
      readonly kind: 'group'
      readonly id: string
      readonly items: readonly AgentItem[]
      /** True while any member is still running, so the group defaults open. */
      readonly running: boolean
    }

export const groupItems = (
  items: readonly AgentItem[],
  threshold = GROUP_THRESHOLD,
): DisplayNode[] => {
  const nodes: DisplayNode[] = []
  let run: AgentItem[] = []

  const flush = (): void => {
    if (run.length === 0) return
    // Silent reasoning rides along inside a burst but does not make one.
    const steps = run.filter((item) => !isSilentReasoning(item)).length
    if (steps >= threshold) {
      nodes.push({
        kind: 'group',
        id: `group-${String(run[0]?.id ?? nodes.length)}`,
        items: run,
        running: run.some((item) => 'status' in item && item.status === 'inProgress'),
      })
    } else {
      for (const item of run) nodes.push({ kind: 'item', item })
    }
    run = []
  }

  for (const item of condenseItems(items)) {
    // A described step breaks the burst and stands alone: the sentence is
    // the thing a reader scrolls back for, and a count would hide it.
    if (STEP_TYPES.has(item.type) && !isDescribed(item)) {
      run.push(item)
      continue
    }
    if (isSilentReasoning(item) && run.length > 0) {
      run.push(item)
      continue
    }
    flush()
    nodes.push({ kind: 'item', item })
  }
  flush()
  // A burst that ends in thought is a burst, then thought: the trailing silent
  // line belongs to whatever comes next, not inside the group.
  return nodes.flatMap((node) => {
    if (node.kind !== 'group') return [node]
    const trailing: DisplayNode[] = []
    const members = [...node.items]
    while (members.length > 0 && isSilentReasoning(members[members.length - 1] as AgentItem)) {
      trailing.unshift({ kind: 'item', item: members.pop() as AgentItem })
    }
    return [{ ...node, items: members }, ...trailing]
  })
}

/**
 * A tool *named* like a shell.
 *
 * The weaker of the two tests and the fallback: ACP's tool name is a display
 * title the agent chose, so this matches almost nothing a real agent sends —
 * `shellCommandOf` reads the arguments and decides first. It lives here, next
 * to the classifier that needs it, because the alternative was `group-items`
 * and `turn-summary` importing each other.
 */
export const SHELL_TOOLS = /^(bash|shell|run_terminal_cmd|execute_command|terminal|exec|command)\b/i

/**
 * The shell command a tool call ran, or null when it did not run one.
 *
 * Read off the arguments rather than the tool's name: ACP's name is a display
 * title the agent chose, and Claude's bridge sets it to the command itself in
 * backticks, so matching a name against `bash|shell|…` recognises nothing an
 * agent actually sends.
 */
export const shellCommandOf = (item: Extract<AgentItem, { type: 'toolCall' }>): string | null => {
  const args =
    typeof item.args === 'object' && item.args !== null && !Array.isArray(item.args)
      ? (item.args as Record<string, unknown>)
      : null
  if (!args) return null
  for (const key of ['command', 'cmd', 'script'] as const) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value
    // Codex-shaped shell tools send argv, not a line. Rejecting the array
    // sent the call to the generic bucket while `summariseTurn`, which reads
    // the same field, counted it as a command.
    if (Array.isArray(value)) {
      const line = value.filter((part): part is string => typeof part === 'string').join(' ').trim()
      if (line !== '') return line
    }
  }
  return null
}

/**
 * The file a tool call edited, or null when it edited none.
 *
 * `editOf` in `handoff.ts` has read this for every agent since long before
 * this function existed — six path spellings and eight edit keys — and
 * writing a second, narrower reader here made three of the four shipped
 * agents invisible to it: Cursor's `{path, streamContent}`, Claude's
 * MultiEdit `{file_path, edits}` and a notebook's `{notebook_path,
 * new_source}` all came back null and were counted as "called 1 tool" while
 * the summary row under them listed the file by name. One reader.
 */
export const editedPathOf = (item: Extract<AgentItem, { type: 'toolCall' }>): string | null =>
  editOf(item)?.path ?? null

/**
 * What one of an agent's tool calls actually was. ACP flattens every step to
 * `toolCall` and Claude's bridge titles it with the raw call, so the type
 * alone reads as "55 tool calls" where Codex's own app says "Read files, ran
 * a command". The title and arguments still know: a `command` argument is a
 * shell step, an `old_string` or `content` beside a path is an edit, a
 * pattern or query is a search, a title opening with "Read" is a read.
 *
 * The single answer to that question. Three summaries of a turn used to ask it
 * separately — this one, the folded turn's receipt, and the receipt row under
 * it — and only this one knew about `rawInput`, so a Claude Code turn read
 * "called 47 tools" while its own body said "ran 44 commands, read 3 files".
 * `turn-view.ts` and `turn-summary.ts` come here now.
 */
export type ToolCallVerb = 'command' | 'fileChange' | 'read' | 'search' | 'toolCall'

export const toolCallVerb = (item: Extract<AgentItem, { type: 'toolCall' }>): ToolCallVerb => {
  const args =
    typeof item.args === 'object' && item.args !== null && !Array.isArray(item.args)
      ? (item.args as Record<string, unknown>)
      : null
  const shell = shellCommandOf(item)
  if (shell !== null) return 'command'
  const title = item.tool.toLowerCase()
  if (editedPathOf(item) !== null) return 'fileChange'
  /* `\b` finds no boundary before `_`, so `read_file`, `grep_search` and
     `glob_file_search` — the names MCP servers and Cursor actually use — all
     fell through to the generic bucket. A verb ends at a separator or at the
     end of the title, and `ReadFile` is the same verb as `Read`. */
  if (/^(read|open)(?:[^a-z]|file|$)/.test(title)) return 'read'
  if (
    /^(grep|glob|search|find)(?:[^a-z]|$)/.test(title) ||
    (args && (typeof args['pattern'] === 'string' || typeof args['query'] === 'string'))
  ) {
    return 'search'
  }
  // A tool named like a shell but carrying no readable command is still a
  // command; `summariseTurn` has always counted it as one.
  if (SHELL_TOOLS.test(item.tool)) return 'command'
  return 'toolCall'
}

/** A short summary of what a group did, for its collapsed header. */
export const describeGroup = (items: readonly AgentItem[]): string => {
  const counts = new Map<string, number>()
  /* Files are counted by path, not by call — the same way the turn's own
     receipt counts them. Counting calls made the two disagree in both
     directions at once: two edits of one file read "edited 1 file" above
     "Edited 2 files", and one native change carrying three paths read
     "edited 3 files" above "Edited 1 file". */
  const paths = new Set<string>()
  for (const item of items) {
    if (isSilentReasoning(item)) continue
    if (item.type === 'fileChange') {
      // A change that names no path is still a change; counting its paths
      // would drop it to nothing.
      if (item.changes.length === 0) {
        counts.set('fileChange', (counts.get('fileChange') ?? 0) + 1)
        continue
      }
      for (const change of item.changes) paths.add(change.path)
      continue
    }
    if (item.type === 'toolCall') {
      const path = editedPathOf(item)
      if (path !== null) {
        paths.add(path)
        continue
      }
    }
    const kind = item.type === 'toolCall' ? toolCallVerb(item) : item.type
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  if (paths.size > 0) counts.set('fileChange', (counts.get('fileChange') ?? 0) + paths.size)

  const label = (type: string, count: number): string => {
    switch (type) {
      case 'command':
        return `ran ${count} command${count === 1 ? '' : 's'}`
      case 'fileChange':
        return `edited ${count} file${count === 1 ? '' : 's'}`
      case 'read':
        return `read ${count} file${count === 1 ? '' : 's'}`
      case 'toolCall':
        return `called ${count} tool${count === 1 ? '' : 's'}`
      case 'webSearch':
      case 'search':
        return `searched ${count} time${count === 1 ? '' : 's'}`
      case 'subagent':
        return `ran ${count} sub-agent${count === 1 ? '' : 's'}`
      case 'image':
        return `${count} image${count === 1 ? '' : 's'}`
      default:
        return `${count} ${type}`
    }
  }

  const sentence = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => label(type, count))
    .join(', ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}
