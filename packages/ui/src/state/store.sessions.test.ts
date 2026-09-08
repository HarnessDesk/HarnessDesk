import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  itemId,
  runtimeId,
  sessionId,
  sessionKey,
  turnId,
  type HostMethodName,
  type RuntimeId,
  type Session,
} from '@harnessdesk/protocol'

import type { PaneId } from './layout'
import { panes } from './layout'
import { AppStore } from './store'

/**
 * Reopening a conversation.
 *
 * The store shows a conversation by reading it and resuming it, every time —
 * including the switch back to one that is working. Neither answer may be
 * mistaken for the whole truth: a resume carries no transcript, and a read
 * taken while a turn is running knows less about that turn than this window,
 * which watched it stream.
 */

const RUNTIME = runtimeId('codex')
const ID = sessionId('s-1')
const KEY = sessionKey(RUNTIME, ID)

const session = (overrides: Partial<Session> = {}): Session => ({
  id: ID,
  runtime: RUNTIME,
  cwd: '/w',
  status: { type: 'idle' },
  createdAt: 0,
  updatedAt: 0,
  turns: [],
  itemsLoaded: true,
  ...overrides,
})

const working = session({
  status: { type: 'active' },
  turns: [
    {
      id: turnId('t-1'),
      status: 'inProgress',
      items: [{ id: itemId('i-1'), type: 'assistantMessage', text: 'half a thought' }],
    },
  ],
})

let store: AppStore
/** What the host answers, per method, for this test. */
let answers: Partial<Record<HostMethodName, unknown>>

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  answers = {}
  vi.spyOn(store.transport, 'request').mockImplementation(
    (async (method: HostMethodName) => answers[method] ?? null) as never,
  )
})

const panesOf = () => panes(store.getSnapshot().layout.root)

describe('opening a conversation', () => {
  it('keeps the turn in flight when the read has not caught up with it', async () => {
    answers['session/read'] = working
    answers['session/resume'] = working
    await store.openSession(ID, { runtime: RUNTIME })
    expect(store.getSnapshot().sessions.get(KEY)?.turns).toHaveLength(1)

    // Leaving and coming back: the agent's store still has nothing to say
    // about the running turn, and the resume carries metadata only.
    answers['session/read'] = session({ status: { type: 'active' } })
    answers['session/resume'] = session({ status: { type: 'active' }, itemsLoaded: false })
    await store.openSession(ID, { runtime: RUNTIME })

    const shown = store.getSnapshot().sessions.get(KEY)
    expect(shown?.turns).toHaveLength(1)
    expect(shown?.turns[0]?.status).toBe('inProgress')
    expect(shown?.turns[0]?.items).toHaveLength(1)
  })

  it('takes the read’s word for turns that have ended', async () => {
    answers['session/read'] = session({
      turns: [{ id: turnId('t-1'), status: 'completed', items: [] }],
    })
    answers['session/resume'] = answers['session/read']
    await store.openSession(ID, { runtime: RUNTIME })

    // The conversation was rolled back elsewhere; the read no longer lists it.
    answers['session/read'] = session()
    answers['session/resume'] = session()
    await store.openSession(ID, { runtime: RUNTIME })
    expect(store.getSnapshot().sessions.get(KEY)?.turns).toHaveLength(0)
  })
})

/**
 * Opening a second conversation.
 *
 * The middle holds one conversation at a time, so opening another replaces
 * what was there. Replacing is not closing. `session/close` detaches the
 * conversation from its agent, and a detached conversation is not a member of
 * the Room, has its queued messages pushed back, and reports nothing further —
 * so a middle that closed what it displaced made a room of three agents
 * impossible to assemble, because only the last one opened was ever live.
 */
describe('opening a second conversation', () => {
  const SECOND = sessionId('s-2')

  it('leaves the one it replaced attached to its agent', async () => {
    answers['session/read'] = session()
    answers['session/resume'] = session()
    await store.openSession(ID, { runtime: RUNTIME })

    answers['session/read'] = session({ id: SECOND })
    answers['session/resume'] = session({ id: SECOND })
    await store.openSession(SECOND, { runtime: RUNTIME })

    // The second one has the middle to itself...
    expect(store.getSnapshot().layout.root).toMatchObject({ kind: 'pane' })
    // ...and the first was never told to let go of its agent.
    const closed = vi
      .mocked(store.transport.request)
      .mock.calls.filter(([method]) => method === 'session/close')
    expect(closed).toHaveLength(0)
  })

  it('still closes a conversation when the pane is closed outright', async () => {
    answers['session/read'] = session()
    answers['session/resume'] = session()
    await store.openSession(ID, { runtime: RUNTIME })

    const pane = store.getSnapshot().layout.root
    store.closePane((pane as { id: PaneId }).id)

    const closed = vi
      .mocked(store.transport.request)
      .mock.calls.filter(([method]) => method === 'session/close')
    expect(closed).toHaveLength(1)
  })
})

/**
 * Which agent a conversation is read from.
 *
 * An id on its own does not name a conversation. ACP agents number their
 * sessions from one, so "1" exists under several of them at once, and reading
 * one id through the wrong agent is either a refusal — Codex answers
 * `invalid thread id` to a `claude-code…` string — or, worse, another
 * conversation returned with no sign that it is the wrong one. So the runtime
 * is an argument, never a default.
 */
describe('which agent a conversation is read from', () => {
  const OTHER = runtimeId('claude-code')

  /** Answers as the runtime it was asked, and records who was asked. */
  const recording = (): { readonly reads: RuntimeId[] } => {
    const reads: RuntimeId[] = []
    vi.spyOn(store.transport, 'request').mockImplementation((async (
      method: HostMethodName,
      params: { readonly runtime: RuntimeId },
    ) => {
      if (method === 'session/read') reads.push(params.runtime)
      return session({ runtime: params.runtime })
    }) as never)
    return { reads }
  }

  it('reads the id under the runtime it was given, not whichever agent is active', async () => {
    const { reads } = recording()

    await store.openSession(ID, { runtime: RUNTIME })
    await store.openSession(ID, { runtime: OTHER })

    expect(reads).toEqual([RUNTIME, OTHER])
    // One id, two agents, two conversations — both held, neither overwriting
    // the other.
    expect([...store.getSnapshot().sessions.keys()]).toEqual([KEY, sessionKey(OTHER, ID)])
  })

  it('will not compile a call that leaves the agent to be guessed', () => {
    // The guard is the type, not a branch: this is the whole fix. If either
    // argument goes back to being optional — or defaulted to the active
    // runtime — the suppression below stops suppressing anything and tsc
    // fails here, which is where the five callers that used to omit it went
    // wrong. Neither call runs.
    expect(() => {
      // @ts-expect-error openSession requires the runtime that holds the id
      if (false as boolean) void store.openSession(ID)
      // @ts-expect-error summariseSession requires it too
      if (false as boolean) void store.summariseSession(ID)
    }).not.toThrow()
  })

  it('summarises the conversation under the agent it was told', async () => {
    const { reads } = recording()

    await store.summariseSession(ID, OTHER)

    expect(reads).toEqual([OTHER])
  })
})

/**
 * What a new session carries.
 *
 * Draft picks live per agent. The snapshot's open draft follows the active
 * agent, so a session started on another runtime — a race, a hand-off — must
 * reach past it to that runtime's own picks: sending Codex's model to Claude
 * gets "not one of the values Model offers" and the session never opens.
 */
describe('what a new session starts with', () => {
  it('sends the target runtime’s own picks, never another agent’s', async () => {
    answers['runtime/sessionDefaults'] = []
    const other = runtimeId('claude-code')
    await store.setNewSessionDefault(RUNTIME, 'model', 'gpt-5.6-luna')
    await store.setNewSessionDefault(other, 'model', 'sonnet')

    answers['session/create'] = session({ runtime: other })
    await store.newSession({ cwd: '/w', runtime: other })

    const create = vi
      .mocked(store.transport.request)
      .mock.calls.find(([method]) => method === 'session/create')
    expect(create?.[1]).toMatchObject({
      runtime: other,
      options: { cwd: '/w', options: { model: 'sonnet' } },
    })
  })

  /**
   * The break this covers: Cursor's model families do not share a set of
   * controls. Turning thinking on under Claude Opus and then choosing Gemini
   * — which has no thinking mode — left `thinking: true` stored against a
   * model with no such control, and every later question re-sent it. The
   * runtime answered "Cursor has no session option named "thinking"", the
   * whole call failed, and the model change failed with it: choosing a model
   * became impossible until the picks were cleared.
   */
  it('forgets a pick the newly chosen model has no control for', async () => {
    answers['runtime/sessionDefaults'] = [
      { type: 'select', id: 'model', label: 'Model', currentValue: 'opus', choices: [
        { value: 'opus', label: 'Opus' },
        { value: 'gemini', label: 'Gemini' },
      ] },
      { type: 'boolean', id: 'thinking', label: 'Thinking', currentValue: true },
    ]
    await store.setNewSessionDefault(RUNTIME, 'model', 'opus')
    await store.setNewSessionDefault(RUNTIME, 'thinking', true)
    const asked = (): unknown => {
      const last = vi
        .mocked(store.transport.request)
        .mock.calls.filter(([method]) => method === 'runtime/sessionDefaults')
        .at(-1)?.[1] as { values?: unknown } | undefined
      return last?.values
    }
    expect(asked()).toEqual({ model: 'opus', thinking: true })

    // Gemini declares the switch — greyed, and off, because it cannot think.
    answers['runtime/sessionDefaults'] = [
      { type: 'select', id: 'model', label: 'Model', currentValue: 'gemini', choices: [
        { value: 'opus', label: 'Opus' },
        { value: 'gemini', label: 'Gemini' },
      ] },
      {
        type: 'boolean',
        id: 'thinking',
        label: 'Thinking',
        currentValue: false,
        disabled: 'Gemini has no thinking mode.',
      },
    ]
    await store.setNewSessionDefault(RUNTIME, 'model', 'gemini')

    expect(store.getSnapshot().notices.map((notice) => notice.message)).toContain(
      'Gemini has no thinking mode.',
    )
    // And the pick is gone, so the next question does not raise it again.
    await store.setNewSessionDefault(RUNTIME, 'model', 'gemini')
    expect(asked()).toEqual({ model: 'gemini' })
  })
})

/**
 * "New session" while the middle holds a room.
 *
 * `newDraft` replaces the focused conversation, and when there was none it
 * split beside whatever was there. That predates main being a slot: with a
 * room in the middle, a project's own "New session" opened a second pane to
 * the right of it instead of a draft, and the room stayed put.
 */
it('takes the middle rather than splitting beside a room', () => {
  store.openTeamRoom('/repo')
  expect(panesOf().map((pane) => pane.view.kind)).toEqual(['room'])

  store.newDraft()

  const after = panesOf()
  expect(after).toHaveLength(1)
  expect(after[0]?.view).toEqual({ kind: 'conversation', session: null })
})
