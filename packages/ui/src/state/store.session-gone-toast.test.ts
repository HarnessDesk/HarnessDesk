import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, type HostMethodName, type Session } from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * A conversation the agent will not reopen for a reason that is not a gone
 * folder — measured on a flow's freshly seated Antigravity, still inside its
 * first turn: "Antigravity does not list conversation …, so the folder it
 * worked in is not known." Unlike a gone folder, this is not recorded as a
 * durable fact anywhere (the folder is fine; the agent's own listing just has
 * not caught up yet), so every repeated open used to toast again — three
 * identical toasts for one still-unresolved refusal, the same failure mode
 * #127 fixed for a gone folder but not for this one.
 */

const RUNTIME = runtimeId('antigravity-acp')
const ID = sessionId('s-1')
const SAID = 'Antigravity does not list conversation s-1, so the folder it worked in is not known.'

const sessionGone = (message = SAID): Error => Object.assign(new Error(message), { code: 'sessionGone' })

const session = (id: string): Session =>
  ({
    id: sessionId(id),
    runtime: RUNTIME,
    cwd: '/w/checkout-api',
    status: { type: 'idle' },
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    itemsLoaded: true,
  }) as Session

let store: AppStore
let answers: Partial<Record<HostMethodName, unknown>>
let refusals: Partial<Record<HostMethodName, Error>>

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  answers = {}
  refusals = {}
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    const refusal = refusals[method]
    if (refusal) throw refusal
    return answers[method] ?? null
  }) as never)
})

describe('reopening a conversation the agent still does not list', () => {
  beforeEach(() => {
    answers['session/read'] = session('s-1')
    refusals['session/resume'] = sessionGone()
  })

  it('toasts once for the first attempt', async () => {
    await store.openSession(ID, { runtime: RUNTIME })
    expect(store.getSnapshot().notices.map((notice) => notice.message)).toEqual([SAID])
  })

  it('does not stack a second identical toast for the same still-unresolved refusal', async () => {
    // The measured case: a room's rail keeps trying to open a Seat's
    // conversation as it works, and each try met the same "does not list
    // conversation" refusal — three toasts before, one now.
    await store.openSession(ID, { runtime: RUNTIME })
    await store.openSession(ID, { runtime: RUNTIME })
    await store.openSession(ID, { runtime: RUNTIME })
    expect(store.getSnapshot().notices.map((notice) => notice.message)).toEqual([SAID])
  })

  it('still toasts a genuinely different refusal', async () => {
    await store.openSession(ID, { runtime: RUNTIME })
    refusals['session/resume'] = sessionGone('Antigravity is not running.')
    await store.openSession(ID, { runtime: RUNTIME })
    expect(store.getSnapshot().notices.map((notice) => notice.message)).toEqual([
      SAID,
      'Antigravity is not running.',
    ])
  })

  it('toasts again once the conversation opens and then fails the same way a second time', async () => {
    // Time moves on between the two toasts — `notice()`'s own five-second
    // window for a merely fast repeat is a different rule from this one,
    // which is about a refusal that never resolved in between.
    await store.openSession(ID, { runtime: RUNTIME })
    delete refusals['session/resume']
    answers['session/resume'] = session('s-1')
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
    await store.openSession(ID, { runtime: RUNTIME })
    refusals['session/resume'] = sessionGone()
    await store.openSession(ID, { runtime: RUNTIME })
    later.mockRestore()
    expect(store.getSnapshot().notices.map((notice) => notice.message)).toEqual([SAID, SAID])
  })
})
