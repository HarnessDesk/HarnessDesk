import {
  itemId,
  peelUserContent,
  type AgentItem,
  type CommandAction,
  type FileChange,
  type ItemStatus,
  type PeelOptions,
  type ToolResultContent,
  type UserContent,
} from '@harnessdesk/protocol'
import type { CodexProtocol } from '@harnessdesk/codex'

/**
 * `ThreadItem` → `AgentItem`.
 *
 * The single most important function in this package: everything the UI renders
 * comes through here. Unknown item types degrade to a readable placeholder
 * rather than vanishing, because a Codex upgrade that adds an item kind should
 * show *something* instead of a silently shorter transcript.
 */

type ThreadItem = CodexProtocol.v2.ThreadItem
type FileUpdateChange = CodexProtocol.v2.FileUpdateChange
type CodexCommandAction = CodexProtocol.v2.CommandAction
type UserInput = CodexProtocol.v2.UserInput

/**
 * Whether a field arrived at all.
 *
 * `null` and a missing field are the wire's absence; **nothing else is**. Read
 * with truthiness instead, `0`, `false` and `''` are answered as "nothing came"
 * — the one reading reserved for a field that did not arrive — when in fact the
 * field arrived and could not be read (comment on #272).
 */
const arrived = <T>(value: T): value is NonNullable<T> => value !== null && value !== undefined

const mapStatus = (status: string): ItemStatus => {
  switch (status) {
    case 'inProgress':
    case 'completed':
    case 'failed':
    case 'declined':
      return status
    default:
      return 'completed'
  }
}

/**
 * What the Codex app wraps around a prompt before sending it.
 *
 * The desktop app composes its ambient UI state into the message — which
 * browser tabs are open, what URL is showing — and stores the composed text
 * as the user's turn, in the item its own UI renders as well as the one the
 * model saw. Its client hides the wrapper; ours would show it, so it comes
 * off here and is folded beside the sentence instead.
 *
 * The tag is matched by name rather than by its `source="ambient-ui-state"`
 * attribute: the attribute is the app's own label for the block and could be
 * renamed without the block changing shape.
 *
 * Most of what that app composes is *not* a tag, though. Comment on a region
 * of a page or on a line of a diff — its own annotating, the same gesture as
 * drawing on a screenshot elsewhere — and the comment, its coordinates, its
 * marker screenshot and the files it named are stacked as `# Heading:`
 * sections above a `## My request:` line, with the typed sentence under it.
 * The marker and its two spellings are copied from the app's own composer,
 * which reads its messages back by splitting on the last one; the sections
 * are every heading seen in a real rollout, plus the rest of that composer's
 * list. An unknown one still folds, under `other` — a heading we have not
 * met is a version we have not met, never a reason to show plumbing or to
 * eat a sentence.
 */
const CODEX_ENVELOPE: PeelOptions = {
  tags: {
    'in-app-browser-context': 'In-app browser',
    'response-annotations': 'Annotations',
    // The placeholder standing where a picture rides beside the text as its
    // own part. Empty, so it leaves nothing behind but the picture itself.
    image: 'Attached image',
  },
  notes: [
    {
      // The caveat the app writes over an image it attached to a comment.
      // Its own composer carries seven spellings of this sentence, every one
      // of them opening `The next image …`; anchoring there covers the list
      // and the eighth spelling too, and a fold is what a mistake costs.
      label: 'Image note',
      pattern: /The next image (?:is untrusted page evidence|shows|was attached)[^\n]*/g,
    },
  ],
  request: {
    marker: /## My request(?: for Codex)?:/g,
    sections: {
      'Diff comments': 'Comments',
      'Browser comments': 'Browser comments',
      'Selected text': 'Selected text',
      'Review findings': 'Review findings',
      'Response annotations': 'Annotations',
      'Failing PR checks': 'PR checks',
      'Files mentioned by the user': 'Files mentioned',
      'Files pasted by the user': 'Files pasted',
      'Applications mentioned by the user': 'Apps mentioned',
      'Context from my IDE setup': 'IDE context',
      'In app browser': 'In-app browser',
    },
    other: 'App context',
  },
}

const mapUserContent = (input: UserInput): UserContent => {
  /* A part that is not an object at all. Measured on the built mapper before
     this: `null` took the whole item down, and a bare string fell through to
     the default below, so a sentence that arrived unwrapped was replaced by
     "[unknown]" — the quietest failure of the six in #272. What a person said
     is the one thing in a transcript that exists nowhere else, so a string is
     read as the sentence; anything else is named, the way an input kind we do
     not know already is. */
  const raw: unknown = input
  if (typeof raw === 'string') return { type: 'text', text: raw }
  if (typeof raw !== 'object' || raw === null) {
    return { type: 'text', text: `[${raw === null ? 'null' : typeof raw}]` }
  }
  switch (input.type) {
    case 'text':
      return { type: 'text', text: input.text }
    case 'image':
      return { type: 'image', url: input.url, detail: input.detail as UserContent extends never ? never : 'low' | 'high' | 'auto' | undefined }
    case 'localImage':
      return { type: 'localImage', path: input.path }
    case 'skill':
      return { type: 'skill', name: input.name, path: input.path }
    case 'mention':
      return { type: 'mention', name: input.name, path: input.path }

    default: {
      // A Codex upgrade that adds an input kind — 0.149.0 added audio — should
      // degrade visibly, not drop part of what the user said.
      const unknown = input as { type?: string }
      return { type: 'text', text: `[${unknown.type ?? 'unknown'}]` }
    }
  }
}

/**
 * The parts of a user message.
 *
 * `content: []` is spoken for — a message that carried no parts, which is also
 * what the peel leaves behind when a message was nothing but envelope — so a
 * container that cannot be read must not answer with it: a bubble that shows
 * nothing is indistinguishable from a message that said nothing. It keeps what
 * came instead, and a message that arrived as one part, or as a bare sentence,
 * reads as that (#272, on the model of #245).
 *
 * The parameter is `unknown` rather than the generated type: that type is what
 * Codex promises, and this function exists because of what arrives.
 */
const mapUserInputs = (content: unknown): UserContent[] =>
  Array.isArray(content)
    ? content.map((part) => mapUserContent(part as UserInput))
    : [mapUserContent(content as UserInput)]

const mapCommandAction = (action: CodexCommandAction): CommandAction => {
  /* Measured: a null element threw, and — worse, because it is silent — a kind
     this switch does not know returned `undefined` from a switch with no
     default, putting a hole in the list the row's title is drawn from. Codex
     has added command kinds before. `unknown` is the protocol's own word for
     "this command was not classified", and the row already knows what to do
     with it: show the command itself. */
  const raw: unknown = action
  if (typeof raw !== 'object' || raw === null) {
    return { type: 'unknown', command: typeof raw === 'string' ? raw : '' }
  }
  switch (action.type) {
    case 'read':
      return { type: 'read', command: action.command, name: action.name, path: action.path }
    case 'listFiles':
      return { type: 'listFiles', command: action.command, path: action.path ?? undefined }
    case 'search':
      return {
        type: 'search',
        command: action.command,
        query: action.query ?? undefined,
        path: action.path ?? undefined,
      }
    default: {
      const command = (raw as { command?: unknown }).command
      return { type: 'unknown', command: typeof command === 'string' ? command : '' }
    }
  }
}

/**
 * A command's parsed actions.
 *
 * The one container of the six that answers `[]`, and the one where `[]` claims
 * nothing: this list is a *label* over `command`, never content. Nothing draws
 * it — only its first entry, and only to title the row — and the command itself
 * is on the item beside it, which is exactly what the row falls back to showing
 * when there is no parse. So a container we cannot read costs the reader
 * nothing, and inventing an action to stand in its place would say the parser
 * ran when it did not (#272).
 */
const mapCommandActions = (actions: unknown): CommandAction[] =>
  Array.isArray(actions) ? actions.map((action) => mapCommandAction(action as CodexCommandAction)) : []

/**
 * A change's kind, where it can be read.
 *
 * `update` for one that cannot, because it is the kind of the three that
 * claims the least: the export writes it "Edited", where "Created" and
 * "Deleted" are each a statement about a file on the person's disk.
 */
const mapFileChangeKind = (kind: unknown): FileChange['kind'] => {
  const type = (kind as { type?: unknown } | null | undefined)?.type
  if (type === 'add' || type === 'delete') return { type }
  const move = (kind as { move_path?: unknown } | null | undefined)?.move_path
  return { type: 'update', movePath: typeof move === 'string' ? move : null }
}

export const mapFileChange = (change: FileUpdateChange): FileChange => {
  /* Measured: `null`, a bare string, a change with no `kind` — each threw, and
     took the patch, the turn and the session load with it. A bare string is
     read as a path, because a list of paths is the shape this degrades into in
     practice and the path is what a reader navigates by; anything else keeps
     what came where a patch goes, under no path, rather than claiming a file by
     that name. A path is always a string here even when none came: the renderer
     splits it on `/` (#272). */
  const raw: unknown = change
  if (typeof raw === 'string') return { path: raw, kind: { type: 'update', movePath: null }, diff: '' }
  if (typeof raw !== 'object' || raw === null) {
    return { path: '', kind: { type: 'update', movePath: null }, diff: String(JSON.stringify(raw)) }
  }
  const record = raw as { path?: unknown; kind?: unknown; diff?: unknown }
  const path = typeof record.path === 'string' ? record.path : ''
  const diff = typeof record.diff === 'string' ? record.diff : ''
  return {
    path,
    kind: mapFileChangeKind(record.kind),
    /* Neither field readable — a change whose field names drifted — shows as
       what came. An empty row would say a file changed by nothing, and say it
       exactly as a real empty diff does. */
    diff: path === '' && diff === '' ? JSON.stringify(raw, null, 1) : diff,
  }
}

/**
 * The edits a patch carried.
 *
 * `changes: []` is spoken for: a patch that named no file, which the grouping
 * counts as a change of its own rather than dropping. The diffs are this item's
 * whole payload, so a container we cannot read keeps what came — and a patch
 * that arrived as one change, unwrapped, reads as that one change (#272, #245).
 */
const mapFileChanges = (changes: unknown): FileChange[] =>
  Array.isArray(changes)
    ? changes.map((change) => mapFileChange(change as FileUpdateChange))
    : [mapFileChange(changes as FileUpdateChange)]

/**
 * MCP content blocks are loosely typed `JsonValue`s. Narrow the shapes we can
 * render and keep the rest as structured JSON rather than dropping them.
 */
const mapToolContent = (value: unknown): ToolResultContent => {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      return { type: 'text', text: record['text'] }
    }
    if (record['type'] === 'image') {
      const url =
        typeof record['data'] === 'string'
          ? `data:${String(record['mimeType'] ?? 'image/png')};base64,${record['data']}`
          : typeof record['url'] === 'string'
            ? record['url']
            : ''
      if (url) return { type: 'image', url, mimeType: String(record['mimeType'] ?? '') }
    }
  }
  if (typeof value === 'string') return { type: 'text', text: value }
  return { type: 'json', value }
}

/**
 * An MCP result's content blocks.
 *
 * `result: null` on the item already means "no result came" — the item is then
 * mapped without a `result` at all — and `[]` means "the server answered with
 * no blocks". A content container we cannot read is neither of those, so it
 * keeps what came, the way a dynamic call's does (#245). A result object whose
 * `content` is missing keeps the result itself, so a server that answers with
 * plain text still says it rather than taking the item down.
 */
const mapMcpContent = (result: unknown): ToolResultContent[] => {
  const content = (result as { content?: unknown } | null | undefined)?.content
  if (Array.isArray(content)) return content.map(mapToolContent)
  return [mapToolContent(content === undefined ? result : content)]
}

/**
 * The content items a `functionCallOutput` carries are the Responses API's
 * own input parts — `input_text`, `input_image`, `input_audio`,
 * `encrypted_content` — not MCP content, so they get their own narrowing.
 */
const mapFunctionCallOutputContent = (
  part: CodexProtocol.FunctionCallOutputContentItem,
): ToolResultContent => {
  /* Measured: a null part threw on `part.type`, the same way a dynamic part
     did before #242. The MCP reading keeps it as what it is instead. */
  const raw: unknown = part
  if (typeof raw !== 'object' || raw === null) return mapToolContent(raw)
  switch (part.type) {
    case 'input_text':
      return { type: 'text', text: part.text }
    case 'input_image':
      return { type: 'image', url: part.image_url, mimeType: '' }
    default:
      return { type: 'json', value: part }
  }
}

/**
 * What a kept output carried.
 *
 * This item *is* its output: the mapper always gives it a `result`, so there is
 * no "nothing came" reading to fall back on here, and `[]` means the output
 * arrived with no parts. A container we cannot read is read as one part — an
 * output that came unwrapped is exactly that — and a plain string keeps the
 * branch the wire's own type asks for (#272).
 */
const mapFunctionCallOutput = (output: unknown): ToolResultContent[] => {
  if (typeof output === 'string') return [{ type: 'text', text: output }]
  if (!Array.isArray(output)) {
    return [mapFunctionCallOutputContent(output as CodexProtocol.FunctionCallOutputContentItem)]
  }
  return output.map((part) => mapFunctionCallOutputContent(part as CodexProtocol.FunctionCallOutputContentItem))
}

/**
 * The conversations a delegation addressed.
 *
 * Alone among these containers, these are not content: each id is a *handle*
 * the interface opens a conversation with, and this transcript already refuses
 * to offer a link that fails after the press (`openable`). So an id that is not
 * a string is dropped rather than kept — measured, a null one reached the
 * renderer, where `nickname ?? sessionId.slice(0, 8)` throws on it — and a
 * container we cannot read answers `[]`: no links, with what was asked, the
 * model it ran on and the status of the call all untouched beside it. One id
 * that came unwrapped is still a usable handle, so that one is kept (#272).
 */
const threadIdsOf = (ids: unknown): string[] => {
  if (typeof ids === 'string') return ids === '' ? [] : [ids]
  if (!Array.isArray(ids)) return []
  // An empty id is not a handle either: it opens nothing.
  return ids.filter((id): id is string => typeof id === 'string' && id !== '')
}

/**
 * A dynamic tool's result, as Codex hands it back: the v2 protocol's own
 * parts, `inputText`, `inputImage` and `inputAudio`, not MCP content. Read as
 * MCP content, every part missed `text` and `image` and was drawn as its JSON
 * (#205). A part in neither shape still gets the MCP reading, which keeps
 * what it can't narrow as JSON.
 */
const mapDynamicPart = (part: CodexProtocol.v2.DynamicToolCallOutputContentItem): ToolResultContent => {
  /* The union says every part is an object with a type. One that isn't would
     throw here, and on the live path a listener's throw is caught and logged,
     so the whole item would leave the transcript without a word (review of
     #210). The MCP reading keeps it as what it is instead. */
  const raw: unknown = part
  if (typeof raw !== 'object' || raw === null) return mapToolContent(raw)
  switch (part.type) {
    case 'inputText':
      return { type: 'text', text: part.text }
    case 'inputImage':
      return { type: 'image', url: part.imageUrl, mimeType: '' }
    default:
      return mapToolContent(part)
  }
}

const mapDynamicContent = (
  items: readonly CodexProtocol.v2.DynamicToolCallOutputContentItem[] | null,
): ToolResultContent[] | undefined => {
  /* `null` is the wire's own "no content came", and `undefined` is that same
     absence. Every *other* falsy value is a container that arrived and could
     not be read, which is the case below, not this one: `!items` collapsed
     `0`, `false` and `''` into "nothing came" (comment on #272). */
  if (!arrived(items)) return undefined
  /* The guard above defends a malformed *part*. A malformed *container* —
     `contentItems` as a string or an object — reached `.map` and threw, which
     the live path swallows in the app-server's listener catch (dropping the
     whole item) and the load path does not (taking the turn, and with it the
     session). Neither `undefined` nor `[]` is an honest answer here: those
     already mean "no content came" and "the call returned no parts", and a
     container we cannot read is neither. So it keeps what came, exactly as a
     malformed part does — and a container that is a bare string still reads as
     its text, so a failed call's reason survives (review of #245). */
  if (!Array.isArray(items)) return [mapToolContent(items)]
  return items.map(mapDynamicPart)
}

/**
 * What a failed dynamic call said, from its text parts, or nothing. The desk
 * writes a plugin tool's failure as one text part (`toCodexToolResponse`): a
 * hook's refusal, "no tool named …", a plugin reloaded mid-session.
 */
const failureOf = (content: readonly ToolResultContent[] | undefined): string =>
  (content ?? [])
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    .trim()

export const mapItem = (item: ThreadItem): AgentItem => {
  const id = itemId(item.id)

  switch (item.type) {
    case 'userMessage': {
      // The image-note pattern is a bare sentence anyone could type. The app
      // writes it over a picture it attached, so the picture riding in this
      // same message is the corroboration the peel asks for.
      const parts = mapUserInputs(item.content)
      const image = parts.some((part) => part.type === 'image' || part.type === 'localImage')
      const { content, context } = peelUserContent(parts, CODEX_ENVELOPE, { image })
      return {
        id,
        type: 'userMessage',
        content,
        ...(context.length > 0 ? { context } : {}),
      }
    }

    case 'agentMessage':
      return {
        id,
        type: 'assistantMessage',
        text: item.text,
        phase: item.phase === 'commentary' ? 'commentary' : 'final',
        ...(item.memoryCitation
          ? { citation: { label: describeCitation(item.memoryCitation) } }
          : {}),
      }

    case 'reasoning':
      return { id, type: 'reasoning', summary: item.summary, content: item.content }

    case 'plan':
      return { id, type: 'plan', text: item.text }

    case 'commandExecution':
      return {
        id,
        type: 'command',
        command: item.command,
        cwd: item.cwd,
        // `userShell` means the human typed it in an embedded terminal; the
        // three unified-exec sources are all agent-driven.
        origin: item.source === 'userShell' ? 'user' : 'agent',
        status: mapStatus(item.status),
        actions: mapCommandActions(item.commandActions),
        ...(item.aggregatedOutput !== null ? { output: item.aggregatedOutput } : {}),
        exitCode: item.exitCode,
        processId: item.processId,
        ...(item.durationMs !== null ? { durationMs: item.durationMs } : {}),
      }

    case 'fileChange':
      return {
        id,
        type: 'fileChange',
        changes: mapFileChanges(item.changes),
        status: mapStatus(item.status),
      }

    case 'mcpToolCall':
      return {
        id,
        type: 'toolCall',
        tool: item.tool,
        source: { kind: 'mcp', server: item.server, pluginId: item.pluginId },
        status: mapStatus(item.status),
        args: item.arguments,
        /* Both were read with truthiness, which made a result of `0` or `''`
           into "the call returned nothing" and an error of `0` into a call that
           failed for no stated reason — the same collapse as the container
           below, one field up. */
        ...(arrived(item.result) ? { result: mapMcpContent(item.result) } : {}),
        ...(arrived(item.error) ? { error: describeToolError(item.error) } : {}),
        ...(item.durationMs !== null ? { durationMs: item.durationMs } : {}),
      }

    case 'dynamicToolCall': {
      const content = mapDynamicContent(item.contentItems)
      return {
        id,
        type: 'toolCall',
        tool: item.tool,
        source: { kind: 'dynamic', namespace: item.namespace },
        status: mapStatus(item.status),
        args: item.arguments,
        ...(content ? { result: content } : {}),
        /* The reason it came with, where there is one. The transcript draws
           a call's error in place of its result, so the constant alone hid
           the one thing the person needed (#241). */
        ...(item.success === false ? { error: failureOf(content) || 'Tool reported failure' } : {}),
        ...(item.durationMs !== null ? { durationMs: item.durationMs } : {}),
      }
    }

    case 'webSearch':
      return {
        id,
        type: 'webSearch',
        query: item.query,
        status: item.action ? 'completed' : 'inProgress',
      }

    case 'imageView':
      return { id, type: 'image', path: item.path }

    case 'imageGeneration':
      return {
        id,
        type: 'image',
        path: item.savedPath ?? item.result,
        generated: { prompt: item.revisedPrompt, status: item.status },
      }

    case 'contextCompaction':
      return { id, type: 'compaction' }

    case 'enteredReviewMode':
      return { id, type: 'review', phase: 'entered', review: item.review }

    case 'exitedReviewMode':
      return { id, type: 'review', phase: 'exited', review: item.review }

    case 'collabAgentToolCall':
      return {
        id,
        type: 'subagent',
        action: String(item.tool),
        status: mapStatus(String(item.status)),
        prompt: item.prompt,
        model: item.model,
        members: threadIdsOf(item.receiverThreadIds).map((threadId) => {
          /* Measured: `agentsStates` missing or null threw here, on the same
             line and for the same reason as the container above — the states
             are "when available" on the wire, and a reading that needs them
             loses the members it was about to list. */
          const states: unknown = item.agentsStates
          const state = (typeof states === 'object' && states !== null
            ? (states as Record<string, unknown>)[threadId]
            : undefined) as { nickname?: string; role?: string; status?: string } | undefined
          return {
            sessionId: threadId,
            nickname: state?.nickname ?? null,
            role: state?.role ?? null,
            state: state?.status ?? null,
          }
        }),
      }

    case 'hookPrompt':
      return {
        id,
        type: 'toolCall',
        tool: 'hook',
        source: { kind: 'builtin' },
        status: 'completed',
        args: { fragments: item.fragments },
      }

    case 'functionCallOutput':
      // 0.153.0: the output of a tool the history kept without its call —
      // a plain string or content items. Rendered as a finished tool row
      // named for the tool, rather than through the placeholder below with
      // the raw item as its arguments.
      return {
        id,
        type: 'toolCall',
        tool: item.name,
        source: item.namespace ? { kind: 'dynamic', namespace: item.namespace } : { kind: 'builtin' },
        status: 'completed',
        args: {},
        result: mapFunctionCallOutput(item.output),
      }

    default: {
      // A Codex upgrade that adds an item kind should degrade visibly, not
      // silently shorten the transcript.
      const unknown = item as { type?: string; id?: string }
      return {
        id: itemId(unknown.id ?? 'unknown'),
        type: 'toolCall',
        tool: unknown.type ?? 'unknown',
        source: { kind: 'builtin' },
        status: 'completed',
        args: item,
      }
    }
  }
}

const describeCitation = (citation: CodexProtocol.v2.MemoryCitation): string => {
  const record = citation as unknown as { entries?: { label?: string }[] }
  const first = record.entries?.[0]?.label
  return first ?? 'memory'
}

const describeToolError = (error: CodexProtocol.v2.McpToolCallError): string => {
  const record = error as unknown as { message?: string }
  return record.message ?? 'Tool call failed'
}
