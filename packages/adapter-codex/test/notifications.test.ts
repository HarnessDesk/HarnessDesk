import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentEvent } from '@harnessdesk/protocol'
import { reduceAll, runtimeId, sessionId, type Session } from '@harnessdesk/protocol'
import type { CodexProtocol } from '@harnessdesk/codex'

import { mapNotification } from '../src/mapping/notifications.js'
import * as items from './fixtures/items.js'

type Notification = CodexProtocol.ServerNotification

const THREAD = 'thread-abc'
const TURN = 'turn-1'

const n = (method: string, params: unknown): Notification =>
  ({ method, params }) as unknown as Notification

const emptySession = (): Session => ({
  id: sessionId(THREAD),
  runtime: runtimeId('codex'),
  cwd: '/w',
  status: { type: 'idle' },
  createdAt: 0,
  updatedAt: 0,
  turns: [],
  itemsLoaded: true,
})

test('thread status maps onto session status', () => {
  const events = mapNotification(
    n('thread/status/changed', { threadId: THREAD, status: { type: 'active', activeFlags: [] } }),
  )
  assert.deepEqual(events, [
    { type: 'session/status', sessionId: sessionId(THREAD), status: { type: 'active' } },
  ])
})

test('a failed turn emits both turn/completed and a classified error', () => {
  const events = mapNotification(
    n('turn/completed', {
      threadId: THREAD,
      turn: {
        id: TURN,
        items: [],
        itemsView: 'full',
        status: 'failed',
        error: { message: 'Your workspace is out of credits. Add credits to continue.' },
        startedAt: 1,
        completedAt: 2,
        durationMs: 1000,
      },
    }),
  )
  assert.equal(events.length, 2)
  assert.equal(events[0]?.type, 'turn/completed')
  assert.equal(events[1]?.type, 'error')
  assert.equal(events[1]?.type === 'error' && events[1].error.code, 'credits')
})

test('the version-gate error is recognised from message text', () => {
  const events = mapNotification(
    n('error', {
      threadId: THREAD,
      turnId: TURN,
      willRetry: false,
      error: {
        message:
          '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.6-sol\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}',
        codexErrorInfo: 'other',
      },
    }),
  )
  const event = events[0]
  assert.equal(event?.type, 'error')
  if (event?.type !== 'error') return
  assert.equal(event.error.code, 'versionGate')
  // The raw JSON body must not reach the UI.
  assert.match(event.error.message, /^The 'gpt-5\.6-sol' model requires a newer version/)
})

test('usageLimitExceeded is classified from the discriminant, not the text', () => {
  const events = mapNotification(
    n('error', {
      threadId: THREAD,
      turnId: TURN,
      willRetry: false,
      error: { message: 'Something opaque', codexErrorInfo: 'usageLimitExceeded' },
    }),
  )
  assert.equal(events[0]?.type === 'error' && events[0].error.code, 'credits')
})

test('rate limits are lifted to a runtime-level event', () => {
  const events = mapNotification(
    n('account/rateLimits/updated', {
      rateLimits: {
        limitId: 'premium',
        limitName: null,
        primary: null,
        secondary: null,
        credits: { hasCredits: false, unlimited: false, balance: null },
        planType: 'team',
        rateLimitReachedType: null,
      },
    }),
  )
  const event = events[0]
  assert.equal(event?.type, 'limits/updated')
  assert.equal(event?.type === 'limits/updated' && event.limits.hasCredits, false)
  assert.equal(event?.type === 'limits/updated' && event.limits.planType, 'team')
})

test('a balance that is there is read, a zero included, and one that is not is none (#184)', () => {
  const balance = (value: unknown) => {
    const event = mapNotification(
      n('account/rateLimits/updated', {
        rateLimits: {
          limitId: 'premium',
          limitName: null,
          primary: null,
          secondary: null,
          credits: { hasCredits: true, unlimited: false, balance: value as string | null },
          planType: 'team',
          rateLimitReachedType: null,
        },
      }),
    )[0]
    return event?.type === 'limits/updated' ? event.limits.balance : 'no event'
  }
  assert.equal(balance('0'), 0)
  // Read by truthiness, only a string zero came through (#85, one layer down).
  assert.equal(balance(0), 0, 'a numeric zero is a balance, not none')
  assert.equal(balance('12.5'), 12.5)
  assert.equal(balance(null), null)
  assert.equal(balance(''), null, 'an empty string is no balance, not a zero')
  assert.ok(Number.isNaN(balance('plenty')), 'what is not a number is left for describeLimits to refuse')
})

test('unmodelled notifications produce nothing rather than noise', () => {
  assert.deepEqual(mapNotification(n('mcpServer/startupStatus/updated', { name: 'figma' })), [])
  assert.deepEqual(mapNotification(n('remoteControl/status/changed', { status: 'disabled' })), [])
})

test('config warnings join summary and details into one message', () => {
  const events = mapNotification(
    n('configWarning', { summary: 'Unknown key', details: 'features.bogus', path: null }),
  )
  assert.equal(events[0]?.type === 'notice' && events[0].message, 'Unknown key — features.bogus')
})

test('a full turn stream folds into a coherent session', () => {
  const stream: Notification[] = [
    n('turn/started', {
      threadId: THREAD,
      turn: { id: TURN, items: [], itemsView: 'full', status: 'inProgress', error: null },
    }),
    n('item/started', { threadId: THREAD, turnId: TURN, item: items.userMessage, startedAtMs: 1 }),
    n('item/completed', {
      threadId: THREAD,
      turnId: TURN,
      item: items.userMessage,
      completedAtMs: 1,
    }),
    n('item/started', {
      threadId: THREAD,
      turnId: TURN,
      item: { ...items.agentCommentary, text: '' },
      startedAtMs: 2,
    }),
    n('item/agentMessage/delta', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'item-2',
      delta: 'I will ',
    }),
    n('item/agentMessage/delta', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'item-2',
      delta: 'start by listing.',
    }),
    n('item/started', { threadId: THREAD, turnId: TURN, item: items.commandRunning, startedAtMs: 3 }),
    n('item/commandExecution/outputDelta', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'call-cmd-1',
      delta: 'README.md\n',
    }),
    n('item/commandExecution/outputDelta', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'call-cmd-1',
      delta: 'src\n',
    }),
    n('item/completed', { threadId: THREAD, turnId: TURN, item: items.commandDone, completedAtMs: 4 }),
    n('turn/diff/updated', { threadId: THREAD, turnId: TURN, diff: '@@ -1 +1 @@\n' }),
    n('thread/tokenUsage/updated', {
      threadId: THREAD,
      turnId: TURN,
      tokenUsage: {
        total: {
          totalTokens: 100,
          inputTokens: 60,
          cachedInputTokens: 10,
          cacheWriteInputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 10,
        },
        last: {
          totalTokens: 100,
          inputTokens: 60,
          cachedInputTokens: 10,
          cacheWriteInputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 10,
        },
        modelContextWindow: 272000,
      },
    }),
    n('turn/completed', {
      threadId: THREAD,
      turn: {
        id: TURN,
        items: [],
        itemsView: 'summary',
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 5,
        durationMs: 4000,
      },
    }),
  ]

  const events: AgentEvent[] = stream.flatMap((notification) => mapNotification(notification))
  const session = reduceAll(emptySession(), events)

  assert.equal(session.turns.length, 1)
  const turn = session.turns[0]
  assert.equal(turn?.status, 'completed')
  assert.equal(turn?.diff, '@@ -1 +1 @@\n')
  assert.equal(session.usage?.contextWindow, 272000)
  // Codex's own arithmetic: the last response minus its reasoning is what
  // the next call will carry.
  assert.equal(session.usage?.contextUsed, 90)
  // Codex has always reported the miss half; it was carried in under a name
  // the app never read, so the cache chip divided hits by input and called
  // that cache health. Both halves land now, under the protocol's names.
  assert.equal(session.usage?.last.cachedInputTokens, 10)
  assert.equal(session.usage?.last.cacheWriteTokens, 20)
  assert.equal(session.usage?.total.cacheWriteTokens, 20)

  const transcript = turn?.items ?? []
  assert.deepEqual(
    transcript.map((item) => item.type),
    ['userMessage', 'assistantMessage', 'command'],
  )

  const assistant = transcript[1]
  assert.equal(
    assistant?.type === 'assistantMessage' && assistant.text,
    'I will start by listing.',
    'streamed deltas accumulated onto the started item',
  )

  const command = transcript[2]
  assert.equal(command?.type === 'command' && command.status, 'completed')
  assert.equal(
    command?.type === 'command' && command.output,
    'README.md\nsrc\n',
    'the completed item replaced the streamed one with authoritative output',
  )
})

test('the failed turn itself carries the classification, not only the error beside it', () => {
  // Both events are read: the `error` event is what the transcript shows, and
  // `turn.error` is what the queue's pause reason and the room's notice key
  // off. The turn's own error used to be built by hand — message and nothing
  // else — so a workspace spend cap and a dropped socket arrived identical to
  // everything downstream of the turn.
  const events = mapNotification(
    n('turn/completed', {
      threadId: THREAD,
      turn: {
        id: TURN,
        items: [],
        itemsView: 'full',
        status: 'failed',
        error: {
          message:
            'You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.',
        },
        startedAt: 1,
        completedAt: 2,
        durationMs: 1000,
      },
    }),
  )
  const completed = events[0]
  assert.equal(completed?.type, 'turn/completed')
  assert.equal(completed?.type === 'turn/completed' && completed.turn.error?.code, 'credits')
})
