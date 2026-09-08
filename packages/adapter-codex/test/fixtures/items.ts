import type { CodexProtocol } from '@harnessdesk/codex'

/**
 * Item fixtures.
 *
 * Shapes mirror what a real `codex app-server` emits — verified against
 * `codex app-server generate-ts` output and against live traffic on
 * codex-cli 0.149.0 — but the content is synthetic. Recording a user's actual
 * sessions into the repo would commit their source code.
 */

type ThreadItem = CodexProtocol.v2.ThreadItem

export const userMessage: ThreadItem = {
  type: 'userMessage',
  id: 'item-1',
  clientId: null,
  content: [
    { type: 'text', text: 'List the files here, then summarise.', text_elements: [] },
    { type: 'mention', name: 'README.md', path: '/w/README.md' },
  ],
}

export const agentCommentary: ThreadItem = {
  type: 'agentMessage',
  id: 'item-2',
  text: 'I will start by listing the directory.',
  phase: 'commentary',
  memoryCitation: null,
  delivery: null,
  questions: null,
}

export const agentFinal: ThreadItem = {
  type: 'agentMessage',
  id: 'item-3',
  text: 'The directory holds a README and a source folder.',
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
}

export const reasoning: ThreadItem = {
  type: 'reasoning',
  id: 'item-4',
  summary: ['Deciding how to inspect the directory'],
  content: ['`ls` is enough here; no need to read files yet.'],
}

export const commandRunning: ThreadItem = {
  type: 'commandExecution',
  id: 'call-cmd-1',
  pluginId: null,
  scriptPath: null,
  command: 'ls -la',
  cwd: '/w',
  processId: 'pty-9',
  source: 'agent',
  status: 'inProgress',
  commandActions: [{ type: 'listFiles', command: 'ls -la', path: '/w' }],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
}

export const commandDone: ThreadItem = {
  ...(commandRunning as Extract<ThreadItem, { type: 'commandExecution' }>),
  status: 'completed',
  aggregatedOutput: 'README.md\nsrc\n',
  exitCode: 0,
  durationMs: 42,
}

export const userShellCommand: ThreadItem = {
  ...(commandDone as Extract<ThreadItem, { type: 'commandExecution' }>),
  id: 'call-cmd-2',
  source: 'userShell',
}

export const fileChange: ThreadItem = {
  type: 'fileChange',
  id: 'call-patch-1',
  status: 'completed',
  changes: [
    { path: '/w/src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' },
    { path: '/w/src/new.ts', kind: { type: 'add' }, diff: 'export const x = 1\n' },
    { path: '/w/src/old.ts', kind: { type: 'delete' }, diff: '' },
    {
      path: '/w/src/moved.ts',
      kind: { type: 'update', move_path: '/w/src/renamed.ts' },
      diff: '@@ -1 +1 @@\n',
    },
  ],
}

export const mcpToolCall: ThreadItem = {
  type: 'mcpToolCall',
  id: 'call-mcp-1',
  server: 'xcodebuildmcp',
  tool: 'session_show_defaults',
  status: 'completed',
  arguments: { scope: 'default' },
  appContext: null,
  pluginId: 'build-ios-apps@openai-curated-remote',
  readOnlyHint: null,
  result: {
    content: [{ type: 'text', text: 'projectPath: (not set)' }],
    structuredContent: null,
    _meta: null,
  },
  error: null,
  durationMs: 120,
}

export const mcpToolCallFailed: ThreadItem = {
  type: 'mcpToolCall',
  id: 'call-mcp-2',
  server: 'github',
  tool: 'list_issues',
  status: 'failed',
  arguments: {},
  appContext: null,
  pluginId: null,
  readOnlyHint: null,
  result: null,
  error: { message: 'GITHUB_PAT_TOKEN is not set' } as CodexProtocol.v2.McpToolCallError,
  durationMs: 8,
}

export const dynamicToolCall: ThreadItem = {
  type: 'dynamicToolCall',
  id: 'call-dyn-1',
  namespace: 'local',
  tool: 'format',
  arguments: { path: '/w/src/a.ts' },
  status: 'completed',
  contentItems: [{ type: 'text', text: 'formatted 1 file' }] as never,
  success: true,
  durationMs: 15,
}

export const webSearch: ThreadItem = {
  type: 'webSearch',
  id: 'item-ws-1',
  query: 'codex app-server protocol',
  action: null,
  results: null,
}

export const imageView: ThreadItem = {
  type: 'imageView',
  id: 'item-img-1',
  path: '/w/shot.png',
}

export const compaction: ThreadItem = { type: 'contextCompaction', id: 'item-compact-1' }

export const enteredReview: ThreadItem = {
  type: 'enteredReviewMode',
  id: 'item-rev-1',
  review: 'Reviewing the diff for correctness',
}

export const plan: ThreadItem = {
  type: 'plan',
  id: 'item-plan-1',
  text: '1. Inspect the tree\n2. Summarise',
}

/** A shape from a hypothetical newer Codex, to prove forward tolerance. */
export const unknownFuture = {
  type: 'somethingCodexAddedLater',
  id: 'item-future-1',
  payload: { note: 'from a newer runtime' },
} as unknown as ThreadItem

export const allItems: readonly ThreadItem[] = [
  userMessage,
  agentCommentary,
  agentFinal,
  reasoning,
  commandRunning,
  commandDone,
  userShellCommand,
  fileChange,
  mcpToolCall,
  mcpToolCallFailed,
  dynamicToolCall,
  webSearch,
  imageView,
  compaction,
  enteredReview,
  plan,
  unknownFuture,
]
