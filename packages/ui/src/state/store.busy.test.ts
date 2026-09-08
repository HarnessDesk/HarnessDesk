import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  runtimeId,
  sessionId,
  sessionKey,
  type HostMethodName,
  type Session,
} from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * A conversation that is open somewhere else.
 *
 * Agents that keep their conversations on disk allow one live writer each, so
 * a conversation open in another account — or in the agent's own desktop app,
 * or a terminal — cannot be continued here. That is not a broken conversation:
 * the read succeeded, the transcript is on screen and whole, and the agent
 * will happily make a copy of it while the original is held.
 *
 * What used to happen was a toast quoting the agent about locks and writers,
 * over a transcript that looked perfectly fine, with nothing to do about it.
 */

const RUNTIME = runtimeId('codex')
const ID = sessionId('01a04ec8-90f2-70b0')
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

const busy = (message: string): Error =>
  Object.assign(new Error(message), { code: 'sessionBusy' })

let store: AppStore
let answers: Partial<Record<HostMethodName, unknown>>
let refusals: Partial<Record<HostMethodName, Error>>
let asked: HostMethodName[]

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  answers = {}
  refusals = {}
  asked = []
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    asked.push(method)
    const refusal = refusals[method]
    if (refusal) throw refusal
    return answers[method] ?? null
  }) as never)
})

describe('opening a conversation another writer holds', () => {
  beforeEach(() => {
    answers['session/read'] = session()
    refusals['session/resume'] = busy(
      'This conversation is already open in your Shane-OL account, which is the only one that can continue it.',
    )
  })

  it('keeps the transcript it already painted', async () => {
    await store.openSession(ID, { runtime: RUNTIME })
    expect(store.getSnapshot().sessions.get(KEY)).toBeDefined()
  })

  it('says which account has it, in that account’s own name', async () => {
    await store.openSession(ID, { runtime: RUNTIME })

    const notice = store.getSnapshot().notices.at(-1)
    expect(notice?.level).toBe('error')
    expect(notice?.message).toContain('Shane-OL')
  })

  it('offers the copy the agent will actually make', async () => {
    await store.openSession(ID, { runtime: RUNTIME })

    const notice = store.getSnapshot().notices.at(-1)
    expect(notice?.action?.label).toBe('Open a copy')

    answers['session/fork'] = session({ id: sessionId('01a04ee7-d069') })
    notice?.action?.run()
    await vi.waitFor(() => expect(asked).toContain('session/fork'))
  })

  it('says so on a layout restore too, rather than emptying the pane', async () => {
    // Every other reopen failure is history the backend no longer holds, and
    // nagging about it on each launch is noise. This one is not history: the
    // conversation is right there, in the other window.
    await store.openSession(ID, { runtime: RUNTIME, restoring: true })

    const notice = store.getSnapshot().notices.at(-1)
    expect(notice?.message).toContain('Shane-OL')
    expect(notice?.action?.label).toBe('Open a copy')
  })
})

describe('every other reason a conversation will not reopen', () => {
  it('is still just a message, with nothing to offer', async () => {
    answers['session/read'] = session()
    refusals['session/resume'] = new Error('Codex could not reopen this conversation: Session not found')

    await store.openSession(ID, { runtime: RUNTIME })

    const notice = store.getSnapshot().notices.at(-1)
    expect(notice?.message).toContain('Session not found')
    expect(notice?.action).toBeUndefined()
  })
})
