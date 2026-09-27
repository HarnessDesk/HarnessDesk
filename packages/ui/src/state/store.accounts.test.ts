import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('an account read that fails (#1021)', () => {
  const OTHER = runtimeId('claude-2b4c6d')
  const handlers = (): { onNotification: (n: unknown) => void } =>
    (store.transport as unknown as { handlers: { onNotification: (n: unknown) => void } }).handlers
  /** Puts agents in the roster the way the app gets them: over the wire. */
  const roster = (...ids: string[]): void => {
    handlers().onNotification({
      method: 'sync',
      params: { sessions: [], runtimes: ids.map((id) => ({ id, name: id, presentation: { name: id } })) },
    })
  }
  /** Answers per agent: a status, or `'fail'` to refuse, or a held promise's resolver slot. */
  let per: Record<string, unknown>
  const readsOf = (id: string): number => reads.filter((one) => one === id).length
  let reads: string[]

  beforeEach(() => {
    // Every test here runs on fake timers, so no retry outlives its store.
    vi.useFakeTimers()
    per = {}
    reads = []
    vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: { runtime?: string }) => {
      if (method !== 'runtime/account') return null
      const id = String(params?.runtime)
      reads.push(id)
      const answer = per[id]
      if (answer === 'fail') throw new Error('The agent is not running.')
      if (typeof answer === 'function') return (answer as () => Promise<unknown>)()
      return answer ?? null
    }) as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the last answer rather than forgetting who was signed in', async () => {
    roster(ADDED)
    per[ADDED] = { accounts: [{ kind: 'chatgpt', label: 'ada@example.com' }], signInMethods: [] }
    await store.loadAccounts()
    expect(store.getSnapshot().accountsByRuntime[ADDED]?.accounts).toHaveLength(1)

    per[ADDED] = 'fail'
    await store.loadAccounts()
    expect(store.getSnapshot().accountsByRuntime[ADDED]?.accounts).toHaveLength(1)
  })

  it('asks again on its own, less often each time, and stops once it is answered', async () => {
    roster(ADDED)
    per[ADDED] = 'fail'
    await store.loadAccounts()
    expect(store.getSnapshot().accountsByRuntime[ADDED]).toBeUndefined()
    const first = readsOf(ADDED)

    // Nothing else happens on the desk; the store asks again by itself.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(readsOf(ADDED)).toBe(first + 1)
    // Still failing: the next ask waits twice as long.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(readsOf(ADDED)).toBe(first + 1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(readsOf(ADDED)).toBe(first + 2)

    // The agent answers; the status arrives and the asking stops.
    per[ADDED] = { accounts: [], signInMethods: [] }
    await vi.advanceTimersByTimeAsync(8_000)
    expect(readsOf(ADDED)).toBe(first + 3)
    expect(store.getSnapshot().accountsByRuntime[ADDED]).toEqual({ accounts: [], signInMethods: [] })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(readsOf(ADDED)).toBe(first + 3)
  })

  it('lets an account read time out so a host that never answers can be re-asked', async () => {
    roster(ADDED)
    let reads = 0
    let readSignal: AbortSignal | undefined
    vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, _params: unknown, options?: { signal?: AbortSignal }) => {
      if (method !== 'runtime/account') return null
      reads += 1
      readSignal = options?.signal
      return new Promise(() => {})
    }) as never)

    const loading = store.loadAccounts()
    await vi.advanceTimersByTimeAsync(10_000)
    await loading
    expect(store.getSnapshot().accountsByRuntime[ADDED]).toBeUndefined()
    expect(readSignal?.aborted).toBe(true)

    // The timed-out read enters the ordinary retry path instead of holding
    // the account pass forever.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(reads).toBe(2)
  })

  it('reports a timed-out account read during sign-in discovery', async () => {
    let reads = 0
    vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
      if (method !== 'runtime/account') return null
      reads += 1
      return new Promise(() => {})
    }) as never)

    const signing = store.signInAgent(ADDED)
    await vi.advanceTimersByTimeAsync(10_000)
    await signing

    expect(reads).toBe(1)
    expect(store.getSnapshot().notices.at(-1)?.message).toContain('timed out after 10000ms')
    expect(asked).not.toContain('runtime/login')
  })

  it('asks again only the agent that failed, and keeps the others as they answered', async () => {
    roster(ADDED, OTHER)
    per[ADDED] = 'fail'
    per[OTHER] = { accounts: [{ kind: 'chatgpt', label: 'grace@example.com' }], signInMethods: [] }
    await store.loadAccounts()
    const others = readsOf(OTHER)

    // An hour of an agent that never answers costs its siblings nothing.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(readsOf(ADDED)).toBeGreaterThan(10)
    expect(readsOf(OTHER)).toBe(others)
    expect(store.getSnapshot().accountsByRuntime[OTHER]?.accounts).toHaveLength(1)
  })

  it('does not ask an agent that could not start; its coming back up does', async () => {
    roster(ADDED)
    handlers().onNotification({
      method: 'runtime/healthChanged',
      params: { runtime: ADDED, health: { state: 'unavailable', reason: 'crashed', message: 'It exited.' } },
    })
    per[ADDED] = 'fail'
    await store.loadAccounts()
    const first = readsOf(ADDED)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(readsOf(ADDED)).toBe(first)
    // Up again: that is what asks, and the answer lands.
    per[ADDED] = { accounts: [], signInMethods: [] }
    handlers().onNotification({ method: 'runtime/healthChanged', params: { runtime: ADDED, health: { state: 'ready' } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(readsOf(ADDED)).toBeGreaterThan(first)
    expect(store.getSnapshot().accountsByRuntime[ADDED]).toEqual({ accounts: [], signInMethods: [] })
  })

  /** Holds every read of `id` until released, in the order they were asked. */
  const hold = (id: string): Array<(value: unknown) => void> => {
    const waiting: Array<(value: unknown) => void> = []
    per[id] = () => new Promise((resolve) => waiting.push(resolve))
    return waiting
  }

  it('a failure a newer pass found is still asked again when an older retry lands after it', async () => {
    roster(ADDED, OTHER)
    per[ADDED] = 'fail'
    per[OTHER] = { accounts: [], signInMethods: [] }
    await store.loadAccounts()
    // The retry for ADDED goes out first and is held.
    const added = hold(ADDED)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(added).toHaveLength(1)
    // A whole pass starts after it and lands before it: ADDED answers, OTHER now fails.
    const other = hold(OTHER)
    const pass = store.loadAccounts()
    await vi.advanceTimersByTimeAsync(0)
    added[1]!({ accounts: [{ kind: 'chatgpt', label: 'ada@example.com' }], signInMethods: [] })
    other[0]!(Promise.reject(new Error('The agent is not running.')))
    await pass
    // The older retry lands last. It is not the news, and it must not take
    // OTHER's re-ask with it.
    added[0]!({ accounts: [], signInMethods: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot().accountsByRuntime[ADDED]?.accounts).toHaveLength(1)
    per[OTHER] = { accounts: [], signInMethods: [] }
    const before = readsOf(OTHER)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(readsOf(OTHER)).toBeGreaterThan(before)
  })

  it('stops asking an agent that goes down after its re-ask was set', async () => {
    roster(ADDED)
    per[ADDED] = 'fail'
    await store.loadAccounts()
    const first = readsOf(ADDED)
    handlers().onNotification({
      method: 'runtime/healthChanged',
      params: { runtime: ADDED, health: { state: 'unavailable', reason: 'crashed', message: 'It exited.' } },
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(readsOf(ADDED)).toBe(first)
  })

  it('an agent removed while its re-ask is out does not come back when the answer lands', async () => {
    roster(ADDED, OTHER)
    per[ADDED] = 'fail'
    per[OTHER] = { accounts: [], signInMethods: [] }
    await store.loadAccounts()
    const added = hold(ADDED)
    await vi.advanceTimersByTimeAsync(2_000)
    handlers().onNotification({ method: 'runtime/removed', params: { runtime: ADDED } })
    added[0]!({ accounts: [{ kind: 'chatgpt', label: 'ada@example.com' }], signInMethods: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot().accountsByRuntime[ADDED]).toBeUndefined()
    expect(store.getSnapshot().accountsByRuntime[OTHER]).toBeDefined()
  })

  it("a re-ask that lands after the agent's own refresh answered does not overwrite it", async () => {
    roster(ADDED)
    per[ADDED] = 'fail'
    await store.loadAccounts()
    const added = hold(ADDED)
    await vi.advanceTimersByTimeAsync(2_000)
    // The active agent refreshes, and its read answers first.
    per[ADDED] = { accounts: [{ kind: 'chatgpt', label: 'ada@example.com' }], signInMethods: [] }
    await store.refreshRuntime()
    expect(store.getSnapshot().accountsByRuntime[ADDED]?.accounts).toHaveLength(1)
    added[0]!({ accounts: [], signInMethods: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot().accountsByRuntime[ADDED]?.accounts).toHaveLength(1)
  })

  it('does not ask again beside a newer read of its own that is already out', async () => {
    roster(ADDED)
    per[ADDED] = 'fail'
    await store.loadAccounts()
    const first = readsOf(ADDED)
    // The active agent refreshes before the re-ask is due; its read is out.
    const added = hold(ADDED)
    const refresh = store.refreshRuntime()
    await vi.advanceTimersByTimeAsync(2_000)
    // The re-ask fell due while that read was out: it asked nothing beside it.
    expect(readsOf(ADDED)).toBe(first + 1)
    added[0]!({ accounts: [], signInMethods: [] })
    await refresh
    await vi.advanceTimersByTimeAsync(120_000)
    expect(readsOf(ADDED)).toBe(first + 1)
    expect(store.getSnapshot().accountsByRuntime[ADDED]).toEqual({ accounts: [], signInMethods: [] })
  })

  it("keeps the doubled wait when a newer failing read skips the timer's re-ask", async () => {
    roster(ADDED)
    per[ADDED] = 'fail'
    await store.loadAccounts()
    const first = readsOf(ADDED)

    const added = hold(ADDED)
    const refresh = store.refreshRuntime()
    await vi.advanceTimersByTimeAsync(2_000)
    // The retry timer fired, but the newer read was already out, so it did not
    // issue a redundant account request.
    expect(readsOf(ADDED)).toBe(first + 1)

    added[0]!(Promise.reject(new Error('The agent is not running.')))
    await refresh
    await vi.advanceTimersByTimeAsync(3_999)
    expect(readsOf(ADDED)).toBe(first + 1)
    await vi.advanceTimersByTimeAsync(1)
    expect(readsOf(ADDED)).toBe(first + 2)
  })

  it('does not consume a retry wait when a stale pass clears its timer before it fires', async () => {
    roster(ADDED, OTHER)
    const stale: Array<(value: unknown) => void> = []
    per[ADDED] = () => new Promise((resolve) => stale.push(resolve))
    per[OTHER] = { accounts: [], signInMethods: [] }
    const oldPass = store.loadAccounts()

    per[ADDED] = 'fail'
    await store.loadAccounts()
    const afterFailure = readsOf(ADDED)

    const newer: Array<(value: unknown) => void> = []
    per[ADDED] = () => new Promise((resolve) => newer.push(resolve))
    const newPass = store.loadAccounts()
    stale[0]!({ accounts: [], signInMethods: [] })
    await oldPass
    // The stale pass cannot answer for this agent, but applying its sibling's
    // answer clears the now-obsolete timer while the newer read is still out.
    expect(readsOf(ADDED)).toBe(afterFailure + 1)

    newer[0]!(Promise.reject(new Error('The agent is not running.')))
    await newPass
    await vi.advanceTimersByTimeAsync(1_999)
    expect(readsOf(ADDED)).toBe(afterFailure + 1)
    await vi.advanceTimersByTimeAsync(1)
    expect(readsOf(ADDED)).toBe(afterFailure + 2)
  })

  it('starts the wait over once everything has answered', async () => {
    roster(ADDED)
    per[ADDED] = 'fail'
    await store.loadAccounts()
    await vi.advanceTimersByTimeAsync(2_000) // fails again: next wait 4 s
    per[ADDED] = { accounts: [], signInMethods: [] }
    await vi.advanceTimersByTimeAsync(4_000) // answers
    per[ADDED] = 'fail'
    await store.loadAccounts()
    const before = readsOf(ADDED)
    // A fresh failure waits 2 s again, not the 8 s the old run had reached.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(readsOf(ADDED)).toBe(before + 1)
  })

  it('a failure landing while a re-ask is set does not push it later', async () => {
    roster(ADDED, OTHER)
    per[ADDED] = 'fail'
    per[OTHER] = { accounts: [], signInMethods: [] }
    await store.loadAccounts()
    const first = readsOf(ADDED)
    await vi.advanceTimersByTimeAsync(1_500)
    await store.loadAccounts() // fails ADDED again, half a second before the re-ask
    await vi.advanceTimersByTimeAsync(500)
    expect(readsOf(ADDED)).toBe(first + 2)
  })

  it('an agent gone from the roster goes from the map at the next read', async () => {
    roster(ADDED, OTHER)
    per[ADDED] = { accounts: [], signInMethods: [] }
    per[OTHER] = { accounts: [], signInMethods: [] }
    await store.loadAccounts()
    expect(store.getSnapshot().accountsByRuntime[OTHER]).toBeDefined()
    roster(ADDED)
    await store.loadAccounts()
    expect(store.getSnapshot().accountsByRuntime[OTHER]).toBeUndefined()
  })

  it('a retry that lands after a newer pass gives way to it', async () => {
    roster(ADDED)
    per[ADDED] = 'fail'
    await store.loadAccounts()
    // The retry's read is held; a whole pass starts and answers meanwhile.
    let release: (value: unknown) => void = () => {}
    per[ADDED] = () => new Promise((resolve) => { release = resolve })
    await vi.advanceTimersByTimeAsync(2_000)
    per[ADDED] = { accounts: [{ kind: 'chatgpt', label: 'ada@example.com' }], signInMethods: [] }
    await store.loadAccounts()
    expect(store.getSnapshot().accountsByRuntime[ADDED]?.accounts).toHaveLength(1)
    // The older retry lands last, with an older answer. It is not the news.
    release({ accounts: [], signInMethods: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot().accountsByRuntime[ADDED]?.accounts).toHaveLength(1)
  })
})
