import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  runtimeId,
  sessionId,
  SessionGoneError,
  type AgentRuntime,
  type AgentSession,
  type RuntimeInfo,
  type Session,
  type SessionId,
} from '@harnessdesk/protocol'

import type { HostContext } from '../src/methods/context.js'
import { sessionMethods } from '../src/methods/sessions.js'

/**
 * `session/resume`'s fallback to a flow Seat's own durable record.
 *
 * Measured on the real, signed-in Google Antigravity: opening a flow's
 * freshly seated conversation was refused — "Antigravity does not list
 * conversation …, so the folder it worked in is not known" — because the
 * agent's own `session/list` had not caught up with a Seat still inside its
 * first turn. This desk already knew that folder: it opened the conversation
 * there and kept its own record of it in `evidence.seats`. The handler now
 * retries once on that record alone, never on anything the agent itself
 * reports (`packages/server/src/methods/sessions.ts`).
 *
 * A unit test against the handler directly, in `provenance-methods.test.ts`'s
 * own style: a hand-built `HostContext` stub, no socket and no real runtime,
 * so the branching is verified in isolation from the ACP adapter's own
 * `#cwdOf` fallback (covered separately in `adapter-acp`'s `acp.test.ts`).
 */

const RUNTIME = runtimeId('antigravity-acp')
const SESSION = sessionId('seat-1')
const KNOWN_CWD = '/work/checkout-api'

const doesNotList = (): SessionGoneError =>
  new SessionGoneError('Antigravity does not list conversation seat-1, so the folder it worked in is not known.')

const fakeSession = (cwd: string): AgentSession =>
  ({
    id: SESSION,
    runtime: RUNTIME,
    settings: () => ({ cwd }),
    options: () => [],
  }) as unknown as AgentSession

const fakeTranscript = (cwd: string): Session =>
  ({
    id: SESSION,
    runtime: RUNTIME,
    cwd,
    status: { type: 'idle' },
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    itemsLoaded: true,
  }) as Session

/** A context whose runtime resumes only when handed the known cwd directly. */
const contextFor = (options: {
  readonly seatCwd: string | null
  readonly resumeSession: (id: SessionId, opts: Record<string, unknown>) => Promise<AgentSession>
}): HostContext => {
  const runtime = {
    info: { id: RUNTIME, presentation: { name: 'Antigravity' } } as unknown as RuntimeInfo,
    resumeSession: options.resumeSession,
  } as unknown as AgentRuntime

  return {
    runtimes: { resolve: () => runtime },
    registry: { get: () => undefined, upsert: (session: Session, live: AgentSession) => ({ session, live }) },
    laneEnvironment: { forSession: async () => undefined },
    evidence: {
      seats: {
        latestOf: (_runtime: string, _id: string) =>
          options.seatCwd ? { checkout: { cwd: options.seatCwd } } : null,
      },
    },
    sessions: {
      // A full read always follows a successful resume, into the same folder
      // the live handle just opened — the fixed KNOWN_CWD in every test here.
      read: async () => fakeTranscript(KNOWN_CWD),
      cannotReopen: (_runtime: unknown, error: unknown) => `Antigravity could not reopen this conversation: ${(error as Error).message}`,
    },
  } as unknown as HostContext
}

test("a flow Seat's own recorded folder resumes a conversation its agent does not list yet", async () => {
  const calls: Array<Record<string, unknown>> = []
  const ctx = contextFor({
    seatCwd: KNOWN_CWD,
    resumeSession: async (_id, opts) => {
      calls.push(opts)
      if (opts.cwd === KNOWN_CWD) return fakeSession(KNOWN_CWD)
      throw doesNotList()
    },
  })

  const result = await sessionMethods['session/resume'](ctx, { runtime: RUNTIME, sessionId: SESSION })

  assert.equal(result.cwd, KNOWN_CWD)
  // Asked twice: once plain (refused), once with the Seat's own known folder.
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.cwd, undefined)
  assert.equal(calls[1]!.cwd, KNOWN_CWD)
})

test('with no Seat record, the same refusal is thrown — never a folder invented for it', async () => {
  let calls = 0
  const ctx = contextFor({
    seatCwd: null,
    resumeSession: async () => {
      calls += 1
      throw doesNotList()
    },
  })

  await assert.rejects(
    sessionMethods['session/resume'](ctx, { runtime: RUNTIME, sessionId: SESSION }),
    (error: Error & { wireCode?: string }) => {
      assert.equal(error.wireCode, 'sessionGone')
      assert.match(error.message, /does not list conversation/)
      return true
    },
  )
  // Never retried without something new to tell the agent.
  assert.equal(calls, 1)
})

test('a second, different refusal from the Seat-cwd retry falls through to the original sentence', async () => {
  const ctx = contextFor({
    seatCwd: KNOWN_CWD,
    resumeSession: async (_id, opts) => {
      if (opts.cwd === KNOWN_CWD) throw new Error('the folder no longer exists')
      throw doesNotList()
    },
  })

  await assert.rejects(
    sessionMethods['session/resume'](ctx, { runtime: RUNTIME, sessionId: SESSION }),
    (error: Error & { wireCode?: string }) => {
      // The first refusal's own sentence and code, not the retry's — inventing
      // a third message here is exactly what the fix does not do.
      assert.equal(error.wireCode, 'sessionGone')
      assert.match(error.message, /does not list conversation/)
      return true
    },
  )
})
