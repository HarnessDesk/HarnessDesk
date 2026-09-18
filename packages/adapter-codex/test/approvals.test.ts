import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CodexProtocol, ServerRequestResponder } from '@harnessdesk/codex'
import { sessionId, type AgentEvent } from '@harnessdesk/protocol'

import { ApprovalRouter } from '../src/approvals.js'
import { mapCommandApproval, mapPermissionApproval, stdinInputOf } from '../src/mapping/approvals.js'

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

test('mapPermissionApproval and ApprovalRouter handle Codex v2 permission requests and responses (#410)', () => {
  const permParams: CodexProtocol.v2.PermissionsRequestApprovalParams = {
    threadId: 't1',
    turnId: 'turn-1',
    itemId: 'item-1',
    environmentId: null,
    startedAtMs: 1,
    cwd: '/w',
    reason: 'Need write access to /w and network access',
    permissions: {
      fileSystem: { read: ['/w/read'], write: ['/w/write'] },
      network: { enabled: true },
    },
  }

  const { approval } = mapPermissionApproval('req-perm-1', permParams)
  assert.equal(approval.type, 'permission')
  if (approval.type !== 'permission') return
  assert.deepEqual(approval.filesystem, ['/w/read', '/w/write'])
  assert.deepEqual(approval.network, ['Network access'])

  const events: AgentEvent[] = []
  const router = new ApprovalRouter((event) => events.push(event))

  let respondedResult: unknown = null
  const responder: ServerRequestResponder = {
    respond: (result) => {
      respondedResult = result
    },
    fail: () => {},
  }

  router.handle(
    {
      id: 1,
      method: 'item/permissions/requestApproval',
      params: permParams,
    } as unknown as CodexProtocol.ServerRequest,
    responder,
    () => undefined,
  )

  const reqEvent = events.find((e): e is Extract<AgentEvent, { type: 'approval/requested' }> => e.type === 'approval/requested')
  assert.ok(reqEvent)
  const approvalId = reqEvent.approval.id

  // Grant for this turn
  router.respond(approvalId, { type: 'option', optionId: 'opt-grant-turn' })
  assert.deepEqual(respondedResult, {
    permissions: {
      fileSystem: { read: ['/w/read'], write: ['/w/write'] },
      network: { enabled: true },
    },
    scope: 'turn',
  })

  // Deny path returns empty permissions profile and turn scope
  let denyResult: unknown = null
  const denyResponder: ServerRequestResponder = {
    respond: (result) => {
      denyResult = result
    },
    fail: () => {},
  }
  router.handle(
    {
      id: 2,
      method: 'item/permissions/requestApproval',
      params: permParams,
    } as unknown as CodexProtocol.ServerRequest,
    denyResponder,
    () => undefined,
  )
  const denyEvent = events.filter((e): e is Extract<AgentEvent, { type: 'approval/requested' }> => e.type === 'approval/requested')[1]
  assert.ok(denyEvent)
  router.respond(denyEvent.approval.id, { type: 'option', optionId: 'opt-deny' })
  assert.deepEqual(denyResult, {
    permissions: {},
    scope: 'turn',
  })
})

test('a user-verification elicitation (0.155.0) is cancelled and said, never drawn as a form', () => {
  const events: AgentEvent[] = []
  const router = new ApprovalRouter((event) => events.push(event))
  const answers: unknown[] = []
  const responder: ServerRequestResponder = {
    respond: (result) => answers.push(result),
    fail: () => assert.fail('a verification is answered, not refused'),
  }
  const from = { threadId: 't1', turnId: 'turn-1', serverName: 'payments' }
  const handled = router.handle(
    {
      id: 7,
      method: 'mcpServer/elicitation/request',
      params: {
        ...from,
        mode: 'openai/userVerification',
        title: 'Confirm the transfer',
        description: 'Approve it with the key on this device.',
        challenge: 'c2lnbi1tZQ',
      },
    } satisfies CodexProtocol.ServerRequest,
    responder,
    () => undefined,
  )
  assert.equal(handled, true)
  // What Codex answers itself on a connection it has not enabled
  // verification for; the challenge is never signed or echoed.
  assert.deepEqual(answers, [{ action: 'cancel', content: null, _meta: null }])
  // Nobody is asked for what nobody here can give, and the person is told
  // why the tool call that asked is about to fail.
  assert.equal(router.size, 0)
  assert.deepEqual(events, [
    {
      type: 'notice',
      sessionId: 't1',
      level: 'warning',
      message:
        'payments asked to verify it is you ("Confirm the transfer"). HarnessDesk cannot do that, so the request was cancelled.',
    },
  ])

  // The control: a form is still a question for the person.
  const schema = { type: 'object', properties: {} } as const
  router.handle(
    {
      id: 8,
      method: 'mcpServer/elicitation/request',
      params: { ...from, mode: 'form', _meta: null, message: 'Which account?', requestedSchema: schema },
    } satisfies CodexProtocol.ServerRequest,
    responder,
    () => undefined,
  )
  assert.equal(router.size, 1)
  const asked = events.flatMap((event) => (event.type === 'approval/requested' ? [event.approval] : []))
  assert.equal(asked.length, 1)
  assert.equal(asked[0]?.type, 'elicitation')
  if (asked[0]?.type !== 'elicitation') return
  assert.equal(asked[0].message, 'Which account?')
  assert.deepEqual(asked[0].schema, schema)
  assert.equal(answers.length, 1, 'a form waits for the person')
})
