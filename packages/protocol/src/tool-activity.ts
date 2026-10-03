import type { AgentItem, FileChange } from './items.js'
import type { Session } from './session.js'
import { currentTurn } from './reduce.js'
import { bareToolName, toolSentence } from './tool-names.js'

export const PATH_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'notebook_path', 'file']
const EDIT_KEYS = [
  'content',
  'new_string',
  'new_str',
  'edits',
  'code_edit',
  'diff',
  'patch',
  'new_source',
  // Cursor's own name for the text it wrote, captured from the CLI's
  // stream-json: without it every Cursor hand-off says nothing was touched.
  'streamContent',
]

/**
 * An edit hiding in a tool call. Codex reports edits as fileChange items;
 * ACP agents report them as the tool they used — Write, Edit, MultiEdit —
 * with the path and the new text in the arguments. Both count.
 */
export const editOf = (item: AgentItem): FileChange | null => {
  if (item.type !== 'toolCall' || typeof item.args !== 'object' || item.args === null) return null
  const args = item.args as Record<string, unknown>
  const path = PATH_KEYS.map((key) => args[key]).find((value): value is string => typeof value === 'string')
  if (!path || !EDIT_KEYS.some((key) => key in args)) return null
  const fresh =
    (typeof args['content'] === 'string' || typeof args['streamContent'] === 'string') &&
    !('old_string' in args) &&
    !('old_str' in args)
  const body = [
    args['content'],
    args['new_string'],
    args['new_str'],
    args['code_edit'],
    args['diff'],
    args['patch'],
    args['new_source'],
    args['streamContent'],
  ]
    .find((value): value is string => typeof value === 'string') ?? ''
  const removed = [args['old_string'], args['old_str']].find((value): value is string => typeof value === 'string') ?? ''
  const replacement = (before: string, after: string): string =>
    [...before.split('\n').filter(Boolean).map((line) => `-${line}`), ...after.split('\n').map((line) => `+${line}`)].join('\n')
  const editPayloads = Array.isArray(args['edits'])
    ? args['edits'].map((entry): string | null => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
        const edit = entry as Record<string, unknown>
        const before = [edit['old_string'], edit['old_str']].find((value): value is string => typeof value === 'string')
        const after = [edit['new_string'], edit['new_str']].find((value): value is string => typeof value === 'string')
        return before === undefined || after === undefined ? null : replacement(before, after)
      })
    : null
  if (editPayloads && (editPayloads.length === 0 || editPayloads.some((entry) => entry === null))) return null
  const edits = editPayloads?.filter((entry): entry is string => entry !== null) ?? []
  const diff = fresh
    ? body
    : body.includes('\n@@') || body.startsWith('---')
      ? body
      : edits.length > 0
        ? edits.join('\n')
        : replacement(removed, body)
  return { path, kind: { type: fresh ? 'add' : 'update' }, diff }
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
  /* An agent that reports an edit by its kind rather than its contents sends
     a title that says so and the file it touched — "Edit src/retry.ts" with
     a `path` — and nothing to diff. That is still an edit, read the way a
     title opening with "Read" is read. */
  if (/^(edit|write|update|create)(?:[^a-z]|file|$)/.test(title) && args && PATH_KEYS.some((key) => typeof args[key] === 'string' && (args[key] as string).trim().length > 0)) {
    return 'fileChange'
  }
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

/**
 * Generic tool names colliding with action names, or starting with
 * `activity_tool_`, gain that prefix once; `doingSentence` removes it for lookup.
 * This reversible escape keeps generic tools distinct from derived actions.
 */
export type SeatDoing =
  | { readonly kind: 'tool'; readonly tool: string; readonly target?: string }
  | { readonly kind: 'thinking' }

export type SeatActivityState = 'working' | 'waiting' | 'idle'

/** The latest in-flight action in the session's current live turn. */
export function inFlightItem(session: Session): AgentItem | undefined {
  const turn = currentTurn(session)
  return turn?.status === 'inProgress' ? [...turn.items].reverse().find((item) =>
    'status' in item && item.status === 'inProgress' && ['command', 'toolCall', 'fileChange', 'webSearch'].includes(item.type)) : undefined
}

/** A path is the only argument activity may repeat. Reject prose and shell syntax. */
const safePath = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value || !/^[\w./\\-]+$/.test(value) || value.startsWith('//') || value.startsWith('\\\\')) return null
  return value
}

// Generic identifiers that share a derived action's spelling retain their lookup identity.
// Escape the prefix itself too, so encoding remains reversible.
const GENERIC_TOOL_PREFIX = 'activity_tool_'
const ACTION_TOOLS = new Set(['command', 'web_search', 'read', 'edit', 'Edit', 'Write', 'search', 'tool'])

/** A tool and at most a path, without command text, queries or environment values. */
export function seatDoing(item: AgentItem): SeatDoing {
  const action = (tool: string, target?: string | null): SeatDoing =>
    target ? { kind: 'tool', tool, target } : { kind: 'tool', tool }
  if (item.type === 'command') return action('command')
  if (item.type === 'webSearch') return action('web_search')
  if (item.type === 'fileChange') return action('edit', safePath(item.changes[0]?.path))
  if (item.type !== 'toolCall') return { kind: 'thinking' }
  const bare = bareToolName(item.tool)
  const verb = toolCallVerb({ ...item, tool: bare })
  if (verb === 'command' || shellCommandOf(item) !== null ||
      /^(?:exec_command|write_stdin|execute_command|run_terminal_cmd|bash|shell|terminal|exec|command)$/.test(bare)) {
    return action('command')
  }
  const args = typeof item.args === 'object' && item.args !== null && !Array.isArray(item.args)
    ? item.args as Record<string, unknown> : null
  const phrase = /^(Read|Edit|Write|Create)\s+(.+)$/i.exec(item.tool)
  const target = safePath(args && PATH_KEYS.map((key) => args[key]).find((value) => typeof value === 'string')) ?? safePath(phrase?.[2])
  if (verb === 'read' || /^read$/i.test(bare) || phrase?.[1]?.toLowerCase() === 'read') return action('read', target)
  if (verb === 'fileChange' || (phrase && phrase[1]?.toLowerCase() !== 'read')) {
    // Preserve the native/tool distinction and the existing write-versus-edit wording.
    return action(/^(?:write|create)(?:[^a-z]|$)/i.test(phrase?.[1] ?? bare) ? 'Write' : 'Edit', target)
  }
  if (verb === 'search') return action('search')
  if (!/^[a-z][a-z0-9_-]*$/i.test(bare)) return action('tool')
  return action(ACTION_TOOLS.has(bare) || bare.startsWith(GENERIC_TOOL_PREFIX) ? GENERIC_TOOL_PREFIX + bare : bare)
}

/** The words every client shows, from the shared tool lookup. */
export function doingSentence(doing: SeatDoing, sentences: ReadonlyMap<string, string> = new Map()): string {
  if (doing.kind === 'thinking') return 'Thinking'
  const { tool, target } = doing
  const generic = tool.startsWith(GENERIC_TOOL_PREFIX)
  if (!generic) switch (tool) {
    case 'command': return 'Running a command'
    case 'web_search': return 'Searching the web'
    case 'read': return target ? toolSentence('read', sentences, { kind: 'read', target }) : 'Reading a file'
    case 'edit': return target ? toolSentence('edit', sentences, { kind: 'fileChange', target }) : 'Editing files'
    case 'Edit':
    case 'Write': return target ? toolSentence(tool, sentences, { kind: 'fileChange', target }) : 'Editing a file'
    case 'search': return 'Searching files'
    case 'tool': return 'Using a tool'
  }
  const sentence = toolSentence(generic ? tool.slice(GENERIC_TOOL_PREFIX.length) : tool, sentences)
  return /[\n\r\x00-\x1f<>`$=]|:\/\//.test(sentence) ? 'Using a tool' : sentence
}
