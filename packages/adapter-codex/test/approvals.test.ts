import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CodexProtocol, ServerRequestResponder } from '@harnessdesk/codex'
import { sessionId, type AgentEvent } from '@harnessdesk/protocol'

import { ApprovalRouter } from '../src/approvals.js'
import { mapCommandApproval, stdinInputOf } from '../src/mapping/approvals.js'

const params = (
  extra: Partial<CodexProtocol.v2.CommandExecutionRequestApprovalParams>,
): CodexProtocol.v2.CommandExecutionRequestApprovalParams => ({
  kind: 'command',
  threadId: 't1',
  turnId: 'turn-1',
  itemId: 'item-1',
  startedAtMs: 1,
  environmentId: null,
  ...extra,
})

test('an ordinary command approval reads as the command to run', () => {
  const { approval } = mapCommandApproval('r1', params({ command: 'npm test', cwd: '/w' }))
  assert.equal(approval.type, 'command')
  if (approval.type !== 'command') return
  assert.equal(approval.kind, undefined)
  assert.equal(approval.command, 'npm test')
  assert.equal(approval.cwd, '/w')
})

test('a stdin approval (0.153.0) is input to the running command, never a command to run', () => {
  const { approval } = mapCommandApproval(
    'r2',
    params({
      kind: 'writeStdin',
      approvalId: 'cb-1',
      command: 'write_stdin --session-id 42 y\n',
      cwd: '/w',
      availableDecisions: ['accept', 'cancel'],
    }),
    'npm run release',
  )
  assert.equal(approval.type, 'command')
  if (approval.type !== 'command') return
  assert.equal(approval.kind, 'stdin')
  // What is being approved is the text, and where it goes is the command
  // the item started — not the write_stdin line Codex composed.
  assert.equal(approval.input, 'y\n')
  assert.equal(approval.command, 'npm run release')
  assert.equal(approval.cwd, '/w')
  assert.deepEqual(approval.options.map((option) => option.intent), ['approve', 'cancel'])
})

test('a stdin approval whose command was never seen still says what it is', () => {
  const { approval } = mapCommandApproval('r3', params({ kind: 'writeStdin', command: null, cwd: null }))
  assert.equal(approval.type, 'command')
  if (approval.type !== 'command') return
  assert.equal(approval.kind, 'stdin')
  assert.equal(approval.command, '(a running command)')
  assert.equal(approval.input, '')
})

test('an older server that sends no kind is read as a command', () => {
  const legacy = params({ command: 'ls', cwd: '/w' }) as Record<string, unknown>
  delete legacy['kind']
  const { approval } = mapCommandApproval(
    'r4',
    legacy as unknown as CodexProtocol.v2.CommandExecutionRequestApprovalParams,
  )
  assert.equal(approval.type === 'command' && approval.kind, undefined)
})

test('the stdin text is read out of whatever argv Codex composed, not one exact shape', () => {
  // Today's shape.
  assert.equal(stdinInputOf('write_stdin --session-id 42 y\n'), 'y\n')
  // A flag Codex has not added yet, in either spelling.
  assert.equal(stdinInputOf('write_stdin --session-id 42 --eof false yes please'), 'yes please')
  assert.equal(stdinInputOf('write_stdin --session-id=42 --encoding=utf8 yes please'), 'yes please')
  // The text keeps the whitespace it was typed with.
  assert.equal(stdinInputOf('write_stdin --session-id 42   two  spaces'), '  two  spaces')
  // A shape this code has not met is shown whole rather than in pieces.
  assert.equal(stdinInputOf('something else entirely'), 'something else entirely')
  assert.equal(stdinInputOf(''), '')
})

test('arguments with irregular whitespace do not corrupt the extracted stdin (#311)', () => {
  // Control: single-spaced arguments succeed before and after.
  assert.equal(stdinInputOf('write_stdin --session-id 42 yes'), 'yes')
  // Multiple spaces between flag and value (#311 reproduction).
  assert.equal(stdinInputOf('write_stdin --session-id   42 yes'), 'yes')
  // Multiple spaces between write_stdin and flags.
  assert.equal(stdinInputOf('write_stdin   --session-id 42 yes'), 'yes')
  // Multiple spaces across multiple flags and values.
  assert.equal(stdinInputOf('write_stdin   --session-id   42   --eof   false yes please'), 'yes please')
  assert.equal(stdinInputOf('write_stdin   --session-id=42   --encoding=utf8 yes please'), 'yes please')
  // Stdin text preserving leading whitespace even when flags have irregular spacing.
  assert.equal(stdinInputOf('write_stdin   --session-id   42   two  spaces'), '  two  spaces')
})

test('quoted flag values are refused and passed through whole (#326)', () => {
  // Quoted flag value with spaces passes through rather than corrupting boundary
  assert.equal(stdinInputOf('write_stdin --session-id "42 foo" yes'), 'write_stdin --session-id "42 foo" yes')
  assert.equal(stdinInputOf("write_stdin --session-id '42 foo' yes"), "write_stdin --session-id '42 foo' yes")
  assert.equal(stdinInputOf('write_stdin --session-id="42 foo" yes'), 'write_stdin --session-id="42 foo" yes')
  assert.equal(stdinInputOf("write_stdin --session-id='42 foo' yes"), "write_stdin --session-id='42 foo' yes")
  // Control: unquoted flag value still parses correctly
  assert.equal(stdinInputOf('write_stdin --session-id 42 yes'), 'yes')
})

test('ApprovalRouter.abandonSession fails outstanding approvals for only the target session (#412)', () => {
  const events: AgentEvent[] = []
  const router = new ApprovalRouter((event) => events.push(event))

  const failed: { id: unknown; code: number; message: string }[] = []
  const responder1: ServerRequestResponder = {
    respond: () => {},
    fail: (code, message) => failed.push({ id: 1, code, message }),
  }
  const responder2: ServerRequestResponder = {
    respond: () => {},
    fail: (code, message) => failed.push({ id: 2, code, message }),
  }

  router.handle(
    {
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: params({ threadId: 'thread-target' }),
    } as unknown as CodexProtocol.ServerRequest,
    responder1,
    () => undefined,
  )

  router.handle(
    {
      id: 2,
      method: 'item/commandExecution/requestApproval',
      params: params({ threadId: 'thread-other' }),
    } as unknown as CodexProtocol.ServerRequest,
    responder2,
    () => undefined,
  )

  assert.equal(router.size, 2)
  router.abandonSession(sessionId('thread-target'), 'The conversation was deleted.')

  assert.equal(router.size, 1)
  assert.equal(failed.length, 1)
  assert.equal(failed[0]?.id, 1)
  assert.equal(failed[0]?.message, 'The conversation was deleted.')
  const resolved = events.filter((e): e is Extract<AgentEvent, { type: 'approval/resolved' }> => e.type === 'approval/resolved')
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0]?.resolution.outcome, 'abandoned')
  assert.equal(resolved[0]?.sessionId, 'thread-target')
})


