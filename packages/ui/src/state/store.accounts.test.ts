import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, type HostMethodName } from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * Signing in to an account that was made a second ago.
 *
 * "Add another account" makes a credential home, registers the runtime that
 * will own it, and then signs into it — three steps, and the last two ask the
 * new agent questions only a *started* agent can answer. Codex refuses both
 * while its app-server is coming up, and this store used to read the answer it
 * did not have as "this agent has no way to sign in" and return: the button
 * made a row and did nothing else, with no error and nothing on screen to say
 * why.
 */

const ADDED = runtimeId('codex-7f3a91')

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

describe('signing in to an agent the snapshot has no account status for', () => {
  it('asks the host how, rather than treating silence as “no way in”', async () => {
    answers['runtime/account'] = {
      accounts: [],
      signInMethods: [{ id: 'chatgpt', label: 'Sign in with ChatGPT', flow: 'browser' }],
    }
    answers['runtime/login'] = {
      type: 'browser',
      loginId: 'login-1',
      url: 'https://auth.example/authorize',
    }

    await store.signInAgent(ADDED)

    expect(asked).toContain('runtime/account')
    expect(asked).toContain('runtime/login')
    expect(store.getSnapshot().logins[ADDED]?.outcome.type).toBe('pending')
  })

  it('says so when the agent really has no sign-in this window can start', async () => {
    answers['runtime/account'] = { accounts: [], signInMethods: [] }

    await store.signInAgent(ADDED)

    expect(asked).not.toContain('runtime/login')
    const notice = store.getSnapshot().notices.at(-1)
    expect(notice?.level).toBe('error')
    expect(notice?.message).toContain('no sign-in')
  })

  it('says the ask failed when it failed, rather than reporting no way in', async () => {
    // A socket that blinked, a host that timed out, an agent that died on
    // boot — all of them used to arrive as "has no sign-in this window can
    // start. Open its own tool", which is advice for a different problem.
    refusals['runtime/account'] = new Error('The agent is not running.')

    await store.signInAgent(ADDED)

    expect(asked).not.toContain('runtime/login')
    const notice = store.getSnapshot().notices.at(-1)
    expect(notice?.message).toContain('could not be asked')
    expect(notice?.message).toContain('The agent is not running.')
    expect(notice?.message).not.toContain('no sign-in')
  })

  it('sends a key-only agent to its sign-in page, not to a terminal', async () => {
    // This window cannot *start* a key sign-in from a button, but the sign-in
    // page takes one — so "open its own tool" would be false.
    answers['runtime/account'] = {
      accounts: [],
      signInMethods: [{ id: 'apiKey', label: 'Use an API key', flow: 'apiKey' }],
    }

    await store.signInAgent(ADDED)

    const notice = store.getSnapshot().notices.at(-1)
    expect(notice?.message).toContain('signs in with a key')
    expect(notice?.message).not.toContain('Open its own tool')
  })
})

describe('two account reads in flight at once', () => {
  it('keeps the newer answer when the older one lands last', async () => {
    // `loadAccounts` replaces the whole map, and adding an account fires it
    // three times within a few hundred milliseconds — on `runtime/added`, on
    // that account's health going ready, and after the add resolves. Each is
    // a `Promise.all` over every runtime, so the pass that *resolves* last
    // wins: one slow sibling is enough for the earliest one — taken before
    // the new account could answer — to land last and delete its status
    // again, putting the sign-in page back in the state this whole change
    // removes, with nothing left to re-ask.
    const held: Array<(value: unknown) => void> = []
    vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
      if (method !== 'runtime/account') return null
      return new Promise((resolve) => {
        held.push(resolve)
      })
    }) as never)
    // The roster arrives the way it does in the app: over the wire.
    const handlers = (store.transport as unknown as { handlers: { onNotification: (n: unknown) => void } })
      .handlers
    handlers.onNotification({
      method: 'sync',
      params: {
        sessions: [],
        runtimes: [{ id: ADDED, name: 'Codex', presentation: { name: 'Codex' } }],
      },
    })

    // The sync makes a read of its own; let it land and clear it, so the two
    // passes below are the only ones in flight.
    await Promise.resolve()
    for (const settle of held.splice(0)) settle(null)

    const stale = store.loadAccounts()
    const fresh = store.loadAccounts()
    // The later pass answers first; the earlier one straggles in behind it.
    held[1]?.({ accounts: [{ kind: 'chatgpt', label: 'ada@example.com' }], signInMethods: [] })
    await fresh
    expect(store.getSnapshot().accountsByRuntime[ADDED]?.accounts).toHaveLength(1)

    held[0]?.(null)
    await stale

    expect(store.getSnapshot().accountsByRuntime[ADDED]?.accounts).toHaveLength(1)
  })
})
