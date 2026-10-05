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

beforeEach(async () => {
  store = new AppStore('ws://localhost:0/')
  answers = {}
  refusals = {}
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    const refusal = refusals[method]
    if (refusal) throw refusal
    return method === 'app/state/get' ? {} : answers[method] ?? null
  }) as never)
  await store.loadPreferences()
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

  it('keeps an automatic retry failure once in the Inbox without a toast', async () => {
    // The measured case: a room's rail keeps trying to open a Seat's
    // conversation as it works (`reveal: false` — nobody asked), and each try
    // met the same "does not list conversation" refusal — three toasts
    // before; now one quiet Inbox entry.
    await store.openSession(ID, { runtime: RUNTIME, reveal: false })
    await store.openSession(ID, { runtime: RUNTIME, reveal: false })
    await store.openSession(ID, { runtime: RUNTIME, reveal: false })
    expect(store.getSnapshot().notices).toEqual([])
    expect(store.getSnapshot().inbox.map(entry => entry.title)).toEqual([SAID])
    expect(store.getSnapshot().inbox[0]?.count).toBe(1)
  })

  it('stays quiet on an automatic retry after a person already saw the refusal', async () => {
    await store.openSession(ID, { runtime: RUNTIME })
    await store.openSession(ID, { runtime: RUNTIME, reveal: false })
    expect(store.getSnapshot().notices.map((notice) => notice.message)).toEqual([SAID])
  })

  it('answers a deliberate second click after the first toast was dismissed', async () => {
    // A person clicking the same failing row again must hear back: the first
    // toast is gone, and an empty pane that says nothing reads as a hang.
    await store.openSession(ID, { runtime: RUNTIME })
    const [first] = store.getSnapshot().notices
    store.dismissNotice(first!.id)
    await store.openSession(ID, { runtime: RUNTIME })
    expect(store.getSnapshot().notices.map((notice) => notice.message)).toEqual([SAID])
  })

  it('refreshes the toast still on screen on a deliberate second click, rather than stacking or dropping it', async () => {
    await store.openSession(ID, { runtime: RUNTIME })
    const [first] = store.getSnapshot().notices
    await store.openSession(ID, { runtime: RUNTIME })
    const notices = store.getSnapshot().notices
    expect(notices.map((notice) => notice.message)).toEqual([SAID])
    expect(notices[0]!.id).not.toBe(first!.id)
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

  it('counts the same automatic failure again after the conversation successfully opens', async () => {
    // A successful reopen resolves the first refusal. A later automatic
    // failure increments its quiet Inbox entry instead of creating a toast.
    await store.openSession(ID, { runtime: RUNTIME, reveal: false })
    delete refusals['session/resume']
    answers['session/resume'] = session('s-1')
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
    await store.openSession(ID, { runtime: RUNTIME, reveal: false })
    refusals['session/resume'] = sessionGone()
    await store.openSession(ID, { runtime: RUNTIME, reveal: false })
    later.mockRestore()
    expect(store.getSnapshot().notices).toEqual([])
    expect(store.getSnapshot().inbox.map(entry => entry.title)).toEqual([SAID])
    expect(store.getSnapshot().inbox[0]?.count).toBe(2)
  })
})
