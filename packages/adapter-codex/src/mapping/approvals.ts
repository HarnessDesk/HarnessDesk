import {
  approvalId as makeApprovalId,
  itemId,
  sessionId,
  turnId,
  type Approval,
  type ApprovalOption,
  type QuestionOption,
} from '@harnessdesk/protocol'
import type { CodexProtocol } from '@harnessdesk/codex'

import { mapFileChange } from './items.js'

/**
 * Approval translation.
 *
 * Codex sends approvals as server-initiated JSON-RPC requests whose available
 * choices vary per prompt — a command that wants network access offers different
 * buttons than one that merely wants to run. Rather than flatten those to a
 * fixed accept/deny pair, the adapter keeps the raw decisions in a side table and
 * exposes them as opaque option ids. The UI renders labels; only this file knows
 * what the ids mean.
 */

type CommandDecision = CodexProtocol.v2.CommandExecutionApprovalDecision
type FileDecision = CodexProtocol.v2.FileChangeApprovalDecision

/** What the adapter must remember to answer an approval later. */
export interface PendingApproval {
  readonly approval: Approval
  /** Raw runtime decisions, indexed by the option ids handed to the UI. */
  readonly rawDecisions: ReadonlyMap<string, unknown>
  readonly kind: 'command' | 'fileChange' | 'permission' | 'userInput' | 'elicitation'
  respond(result: unknown): void
  fail(code: number, message: string): void
}

const DEFAULT_COMMAND_DECISIONS: readonly CommandDecision[] = [
  'accept',
  'acceptForSession',
  'decline',
]

const describeCommandDecision = (
  decision: CommandDecision,
): { label: string; description?: string; intent: ApprovalOption['intent'] } => {
  if (typeof decision === 'object') {
    if ('acceptWithExecpolicyAmendment' in decision) {
      return {
        label: 'Always allow commands like this',
        description: 'Adds a rule so similar commands run without asking again.',
        intent: 'approveAlways',
      }
    }
    return {
      label: 'Allow this host',
      description: 'Permits network access to this host for future requests.',
      intent: 'approveAlways',
    }
  }
  switch (decision) {
    case 'accept':
      return { label: 'Allow', intent: 'approve' }
    case 'acceptForSession':
      return {
        label: 'Allow for this session',
        description: 'Runs without asking again until this session ends.',
        intent: 'approveAlways',
      }
    case 'decline':
      return { label: 'Deny', intent: 'deny' }
    case 'cancel':
      return { label: 'Cancel turn', intent: 'cancel' }
  }
}

const describeFileDecision = (
  decision: FileDecision,
): { label: string; description?: string; intent: ApprovalOption['intent'] } => {
  switch (decision) {
    case 'accept':
      return { label: 'Apply', intent: 'approve' }
    case 'acceptForSession':
      return {
        label: 'Apply and allow for this session',
        intent: 'approveAlways',
      }
    case 'decline':
      return { label: 'Reject', intent: 'deny' }
    case 'cancel':
      return { label: 'Cancel turn', intent: 'cancel' }
  }
}

const buildOptions = <T>(
  decisions: readonly T[],
  describe: (decision: T) => { label: string; description?: string; intent: ApprovalOption['intent'] },
): { options: ApprovalOption[]; raw: Map<string, unknown> } => {
  const options: ApprovalOption[] = []
  const raw = new Map<string, unknown>()
  decisions.forEach((decision, index) => {
    const id = `opt-${index}`
    const described = describe(decision)
    options.push({
      id,
      label: described.label,
      ...(described.description ? { description: described.description } : {}),
      intent: described.intent,
    })
    raw.set(id, decision)
  })
  return { options, raw }
}

const base = (params: {
  threadId: string
  turnId?: string | null
  itemId?: string
  startedAtMs?: number
  reason?: string | null
}, id: string) => ({
  id: makeApprovalId(id),
  sessionId: sessionId(params.threadId),
  ...(params.turnId ? { turnId: turnId(params.turnId) } : {}),
  ...(params.itemId ? { itemId: itemId(params.itemId) } : {}),
  requestedAt: params.startedAtMs ?? Date.now(),
  reason: params.reason ?? null,
})

/**
 * The text a stdin approval is asking to send, out of the line Codex
 * composes for it: `write_stdin --session-id <id> <text>`.
 *
 * Read tolerantly rather than by one exact shape. The argv is Codex's to
 * change — another flag, a different order — and a strict pattern that stops
 * matching would put `write_stdin --session-id 42 y` in front of a person as
 * the thing they are approving. So the tool's own name goes, then any
 * leading `--flag value` pairs, and what remains is the text. A line that
 * does not begin with the tool's name is passed through untouched: it is
 * some shape this code has not met, and showing it whole is better than
 * showing a piece of it.
 */
export const stdinInputOf = (composed: string): string => {
  const parts = composed.split(/\s+/)
  if (parts[0] !== 'write_stdin') return composed
  let at = 1
  while (at < parts.length && parts[at]?.startsWith('--')) {
    // `--flag=value` carries its value; `--flag value` takes the next word.
    at += parts[at]?.includes('=') ? 1 : 2
  }
  // Rejoined from the original rather than from the split, so the text keeps
  // the whitespace it was typed with — a heredoc, a trailing newline.
  const consumed = parts.slice(0, at).join(' ')
  const rest = composed.slice(composed.indexOf(consumed) + consumed.length)
  return rest.replace(/^[ \t]/, '')
}

export const mapCommandApproval = (
  requestId: string,
  params: CodexProtocol.v2.CommandExecutionRequestApprovalParams,
  /**
   * The command the approval's item started, for a stdin approval. Codex does
   * not repeat it — the request names the item, and the item was announced
   * when the command began — so the caller looks it up.
   */
  runningCommand?: string,
): { approval: Approval; raw: Map<string, unknown> } => {
  const { options, raw } = buildOptions(
    params.availableDecisions ?? DEFAULT_COMMAND_DECISIONS,
    describeCommandDecision,
  )
  // 0.153.0 added `kind`. A stdin approval is input to a command that is
  // already running: its `command` is the `write_stdin --session-id <id>
  // <text>` line Codex composed, and `cwd` is where that command was
  // launched. Read as an ordinary command it asked the person to approve
  // "(unknown command)" — or worse, a line that looked like a command to
  // run — so the kind decides the shape.
  if (params.kind === 'writeStdin') {
    const composed = params.command ?? ''
    const input = stdinInputOf(composed)
    return {
      approval: {
        ...base(params, requestId),
        type: 'command',
        kind: 'stdin',
        command: runningCommand ?? '(a running command)',
        cwd: params.cwd ?? '',
        input,
        actions: [],
        options,
      },
      raw,
    }
  }
  return {
    approval: {
      ...base(params, requestId),
      type: 'command',
      command: params.command ?? '(unknown command)',
      cwd: params.cwd ?? '',
      actions: (params.commandActions ?? []).map((action) =>
        action.type === 'read'
          ? { type: 'read', command: action.command, name: action.name, path: action.path }
          : action.type === 'listFiles'
            ? { type: 'listFiles', command: action.command, path: action.path ?? undefined }
            : action.type === 'search'
              ? {
                  type: 'search',
                  command: action.command,
                  query: action.query ?? undefined,
                  path: action.path ?? undefined,
                }
              : { type: 'unknown', command: action.command },
      ),
      options,
    },
    raw,
  }
}

export const mapFileChangeApproval = (
  requestId: string,
  params: CodexProtocol.v2.FileChangeRequestApprovalParams,
  /**
   * Codex does not repeat the diff in the approval request — it arrives on the
   * `fileChange` item that the approval refers to, which the caller has already
   * seen.
   */
  changes: readonly CodexProtocol.v2.FileUpdateChange[] = [],
): { approval: Approval; raw: Map<string, unknown> } => {
  const { options, raw } = buildOptions<FileDecision>(
    ['accept', 'acceptForSession', 'decline'],
    describeFileDecision,
  )
  return {
    approval: {
      ...base(params, requestId),
      type: 'fileChange',
      changes: changes.map(mapFileChange),
      grantRoot: params.grantRoot ?? null,
      options,
    },
    raw,
  }
}

export const mapPermissionApproval = (
  requestId: string,
  params: CodexProtocol.v2.PermissionsRequestApprovalParams,
): { approval: Approval; raw: Map<string, unknown> } => {
  const requested = params.permissions as unknown as {
    filesystem?: { paths?: { path?: string }[] }
    network?: { domains?: { domain?: string }[] }
  }
  const filesystem = (requested.filesystem?.paths ?? [])
    .map((entry) => entry.path)
    .filter((path): path is string => typeof path === 'string')
  const network = (requested.network?.domains ?? [])
    .map((entry) => entry.domain)
    .filter((domain): domain is string => typeof domain === 'string')

  const raw = new Map<string, unknown>([
    ['opt-grant-turn', { grant: true, scope: 'turn' }],
    ['opt-grant-session', { grant: true, scope: 'session' }],
    ['opt-deny', { grant: false }],
  ])

  return {
    approval: {
      ...base(params, requestId),
      type: 'permission',
      summary: params.reason ?? 'Codex is requesting additional permissions.',
      filesystem,
      network,
      options: [
        { id: 'opt-grant-turn', label: 'Grant for this turn', intent: 'approve' },
        {
          id: 'opt-grant-session',
          label: 'Grant for this session',
          intent: 'approveAlways',
        },
        { id: 'opt-deny', label: 'Deny', intent: 'deny' },
      ],
    },
    raw,
  }
}

export const mapUserInputApproval = (
  requestId: string,
  params: CodexProtocol.v2.ToolRequestUserInputParams,
): { approval: Approval; raw: Map<string, unknown> } => ({
  approval: {
    ...base(params, requestId),
    type: 'userInput',
    tool: 'request_user_input',
    questions: params.questions.map((question) => ({
      id: question.id,
      question: question.question,
      header: question.header,
      // Codex's question shape has no multi-select flag today; a free-text
      // question is signalled by `isOther` with no options.
      multiSelect: false,
      options: (question.options ?? []).map(
        (option, index): QuestionOption => ({
          id: `${question.id}:${index}`,
          label: option.label,
          description: option.description,
        }),
      ),
    })),
  },
  raw: new Map(),
})

export const mapElicitationApproval = (
  requestId: string,
  params: CodexProtocol.v2.McpServerElicitationRequestParams,
): { approval: Approval; raw: Map<string, unknown> } => ({
  approval: {
    ...base({ threadId: params.threadId, turnId: params.turnId }, requestId),
    type: 'elicitation',
    server: params.serverName,
    message: params.message,
    // 0.149.0 added an `openai/form` mode alongside `form`; both carry a
    // schema, and only `url` carries a URL, so the URL case is the exception.
    schema: params.mode === 'url' ? { url: params.url } : params.requestedSchema,
  },
  raw: new Map(),
})

/**
 * Turns a UI answer map back into the shape Codex expects for
 * `item/tool/requestUserInput`.
 */
export const toUserInputResponse = (
  approval: Extract<Approval, { type: 'userInput' }>,
  answers: Readonly<Record<string, readonly string[]>>,
): CodexProtocol.v2.ToolRequestUserInputResponse => {
  const out: Record<string, unknown> = {}
  for (const question of approval.questions) {
    const chosen = answers[question.id] ?? []
    // The UI answers with option ids; Codex wants the labels back.
    const labels = chosen.map((optionId) => {
      const option = question.options.find((candidate) => candidate.id === optionId)
      return option?.label ?? optionId
    })
    out[question.id] = { answers: labels }
  }
  return { answers: out } as CodexProtocol.v2.ToolRequestUserInputResponse
}
