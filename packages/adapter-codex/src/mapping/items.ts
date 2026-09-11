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

const mapCommandAction = (action: CodexCommandAction): CommandAction => {
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
    case 'unknown':
      return { type: 'unknown', command: action.command }
  }
}

export const mapFileChange = (change: FileUpdateChange): FileChange => ({
  path: change.path,
  kind:
    change.kind.type === 'update'
      ? { type: 'update', movePath: change.kind.move_path ?? null }
      : { type: change.kind.type },
  diff: change.diff,
})

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
 * The content items a `functionCallOutput` carries are the Responses API's
 * own input parts — `input_text`, `input_image`, `input_audio`,
 * `encrypted_content` — not MCP content, so they get their own narrowing.
 */
const mapFunctionCallOutputContent = (
  part: CodexProtocol.FunctionCallOutputContentItem,
): ToolResultContent => {
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
 * A dynamic tool's result, as Codex hands it back: the v2 protocol's own
 * parts, `inputText`, `inputImage` and `inputAudio`, not MCP content. Read as
 * MCP content, every part missed `text` and `image` and was drawn as its JSON
 * (#205). A part in neither shape still gets the MCP reading, which keeps
 * what it can't narrow as JSON.
 */
const mapDynamicPart = (part: CodexProtocol.v2.DynamicToolCallOutputContentItem): ToolResultContent => {
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
  if (!items) return undefined
  return items.map(mapDynamicPart)
}

export const mapItem = (item: ThreadItem): AgentItem => {
  const id = itemId(item.id)

  switch (item.type) {
    case 'userMessage': {
      // The image-note pattern is a bare sentence anyone could type. The app
      // writes it over a picture it attached, so the picture riding in this
      // same message is the corroboration the peel asks for.
      const image = item.content.some((part) => part.type === 'image' || part.type === 'localImage')
      const { content, context } = peelUserContent(item.content.map(mapUserContent), CODEX_ENVELOPE, { image })
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
        actions: item.commandActions.map(mapCommandAction),
        ...(item.aggregatedOutput !== null ? { output: item.aggregatedOutput } : {}),
        exitCode: item.exitCode,
        processId: item.processId,
        ...(item.durationMs !== null ? { durationMs: item.durationMs } : {}),
      }

    case 'fileChange':
      return {
        id,
        type: 'fileChange',
        changes: item.changes.map(mapFileChange),
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
        ...(item.result ? { result: item.result.content.map(mapToolContent) } : {}),
        ...(item.error ? { error: describeToolError(item.error) } : {}),
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
        ...(item.success === false ? { error: 'Tool reported failure' } : {}),
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
        members: item.receiverThreadIds.map((threadId) => {
          const state = item.agentsStates[threadId] as
            | { nickname?: string; role?: string; status?: string }
            | undefined
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
        result:
          typeof item.output === 'string'
            ? [{ type: 'text', text: item.output }]
            : item.output.map(mapFunctionCallOutputContent),
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
