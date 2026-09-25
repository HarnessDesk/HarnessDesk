import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, sessionKey, type HostMethodName, type Session, type SessionId } from '@harnessdesk/protocol'

import { panes, sessionOf } from './layout'
import { AppStore } from './store'

/**
 * "Review uncommitted changes" — a review on a side thread, leaving this
 * conversation as it is. The host answers such a review with the
 * conversation it runs in, and the window opens it the way it opens a fork:
 * it takes the screen, and the conversation it was asked from waits in the
 * sidebar exactly as it was.
 */

const RUNTIME = runtimeId('codex')
const HERE = sessionId('01a0b3a1-0001')
const SIDE = sessionId('01a0b3a1-0002')

const session = (id: SessionId, overrides: Partial<Session> = {}): Session => ({
  id,
  runtime: RUNTIME,
  cwd: '/w',
  status: { type: 'idle' },
  createdAt: 0,
  updatedAt: 0,
  turns: [],
  itemsLoaded: true,
  ...overrides,
})

let store: AppStore
let answers: Partial<Record<HostMethodName, unknown>>
let refusals: Partial<Record<HostMethodName, Error>>
let asked: { method: HostMethodName; params: unknown }[]

/** The conversations on screen, by key. */
const onScreen = () => panes(store.getSnapshot().layout.root).map(sessionOf).filter((key) => key !== null)

beforeEach(async () => {
  store = new AppStore('ws://localhost:0/')
  answers = { 'session/list': { data: [], nextCursor: null } }
  refusals = {}
  asked = []
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    asked.push({ method, params })
    const refusal = refusals[method]
    if (refusal) throw refusal
    return answers[method] ?? null
  }) as never)
  answers['session/read'] = session(HERE)
  answers['session/resume'] = session(HERE)
  await store.openSession(HERE, { runtime: RUNTIME })
})

describe('a review on a side thread', () => {
  it('opens the conversation it runs in, and leaves this one as it was', async () => {
    const before = store.getSnapshot().sessions.get(sessionKey(RUNTIME, HERE))
    answers['session/review'] = session(SIDE, { title: 'Review of uncommitted changes' })

    await store.review({ type: 'uncommitted', delivery: 'detached' }, sessionKey(RUNTIME, HERE))

    expect(onScreen()).toEqual([sessionKey(RUNTIME, SIDE)])
    expect(store.getSnapshot().sessions.get(sessionKey(RUNTIME, SIDE))?.title).toBe('Review of uncommitted changes')
    expect(store.getSnapshot().sessions.get(sessionKey(RUNTIME, HERE))).toBe(before)
  })

  it('asks about the conversation it was given, whichever one has the focus', async () => {
    const other = sessionId('01a0b3a1-0003')
    await store.review({ type: 'uncommitted', delivery: 'detached' }, sessionKey(RUNTIME, other))

    expect(asked.filter((call) => call.method === 'session/review').map((call) => call.params)).toEqual([
      { runtime: RUNTIME, sessionId: other, target: { type: 'uncommitted', delivery: 'detached' } },
    ])
  })
})

describe('a review that runs here', () => {
  it('stays on this conversation', async () => {
    answers['session/review'] = null

    await store.review({ type: 'uncommitted' }, sessionKey(RUNTIME, HERE))

    expect(onScreen()).toEqual([sessionKey(RUNTIME, HERE)])
  })
})

describe('a review the agent refuses', () => {
  it('says why, and stays where it was', async () => {
    refusals['session/review'] = new Error('Codex refused the review: branch must not be empty')

    await store.review({ type: 'baseBranch', branch: ' ', delivery: 'detached' }, sessionKey(RUNTIME, HERE))

    expect(store.getSnapshot().notices.at(-1)?.message).toContain('branch must not be empty')
    expect(onScreen()).toEqual([sessionKey(RUNTIME, HERE)])
  })
})
