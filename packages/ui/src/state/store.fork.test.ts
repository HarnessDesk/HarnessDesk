import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  runtimeId,
  sessionId,
  sessionKey,
  turnId,
  type HostMethodName,
  type Session,
  type Turn,
} from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * A branch whose history the agent could not read arrives unloaded, and the
 * Codex adapter says to choose it in the sidebar to load it. Choosing a
 * conversation there is `openSession`, and nothing else reads a branch again:
 * `forkSession` shows it and reloads only the list. So choosing the branch
 * must ask the host for it even though it is the conversation on screen, and
 * fold in what comes back.
 */

const CODEX = runtimeId('codex')
const SOURCE = sessionId('source')
const BRANCH = sessionId('branch')

const turn = (id: string): Turn => ({
  id: turnId(id),
  items: [{ id: `${id}-ask`, type: 'userMessage', content: [{ type: 'text', text: 'Run the tests.' }] }] as never,
  status: 'completed',
  error: null,
})

const conversation = (id: typeof SOURCE, turns: readonly Turn[], itemsLoaded: boolean): Session => ({
  id,
  runtime: CODEX,
  cwd: '/w',
  status: { type: 'idle' },
  createdAt: 0,
  updatedAt: 0,
  turns,
  itemsLoaded,
})

let store: AppStore
let answers: Partial<Record<HostMethodName, unknown | ((params: unknown) => unknown)>>
let calls: { method: HostMethodName; params: unknown }[]

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  answers = {}
  calls = []
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    calls.push({ method, params })
    const answer = answers[method]
    return (typeof answer === 'function' ? answer(params) : answer) ?? null
  }) as never)
})

describe('a branch that arrived without its history', () => {
  it('is read again when it is chosen in the sidebar, though it is the one on screen', async () => {
    const whole = [turn('t1'), turn('t2')]
    answers['session/list'] = { data: [], nextCursor: null }
    answers['session/read'] = (params: unknown) =>
      conversation((params as { sessionId: typeof SOURCE }).sessionId, whole, true)
    answers['session/resume'] = (params: unknown) =>
      conversation((params as { sessionId: typeof SOURCE }).sessionId, whole, true)
    await store.openSession(SOURCE, { runtime: CODEX })

    answers['session/fork'] = conversation(BRANCH, [], false)
    await store.forkSession()
    const key = sessionKey(CODEX, BRANCH)
    expect(store.getSnapshot().activeSessionKey).toBe(key)
    expect(store.getSnapshot().sessions.get(key)?.turns).toEqual([])

    calls = []
    // What pressing the branch's row does (`SessionTree`).
    await store.openSession(BRANCH, { runtime: CODEX })
    expect(calls.filter((call) => call.method === 'session/read').map((call) => call.params)).toEqual([
      { runtime: CODEX, sessionId: BRANCH },
    ])
    expect(store.getSnapshot().sessions.get(key)?.turns.map((entry) => String(entry.id))).toEqual(['t1', 't2'])
  })
})
