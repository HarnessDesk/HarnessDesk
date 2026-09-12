import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  runtimeId,
  sessionId,
  sessionKey,
  type HostMethodName,
  type RuntimeInfo,
  type Session,
  type SessionSummary,
  type WireNotification,
} from '@harnessdesk/protocol'

import { panes } from './layout'
import { AppStore } from './store'

/**
 * Choosing the agent new sessions run as.
 *
 * A preference, not a navigation. `selectRuntime` used to blank the session
 * list and replace whatever conversation was on screen with an empty draft,
 * so the whole window blinked for a pick that changes what ⌘N does next.
 * Pinned here: the conversation stays, the list stays and keeps paging along
 * the agent it was paged from, what the window already knows about the new
 * agent lands in the same frame, and the pick is remembered.
 */

const CODEX = runtimeId('codex')
const CLAUDE = runtimeId('claude-code')
const ID = sessionId('s-1')
const KEY = sessionKey(CODEX, ID)

const info = (id: string, name: string): RuntimeInfo =>
  ({
    id,
    name,
    capabilities: { listHistory: true },
    presentation: { name },
  }) as unknown as RuntimeInfo

const conversation = (): Session => ({
  id: ID,
  runtime: CODEX,
  cwd: '/w',
  status: { type: 'idle' },
  createdAt: 0,
  updatedAt: 0,
  turns: [],
  itemsLoaded: true,
})

const summary = (id: string, runtime: string): SessionSummary =>
  ({
    id,
    runtime,
    title: id,
    preview: '',
    cwd: '/w',
    status: { type: 'notLoaded' },
    createdAt: 1,
    updatedAt: 2,
  }) as unknown as SessionSummary

let store: AppStore
/**
 * What the host answers, per method, for this test. A function answers by
 * params — `session/list` has to give each agent its own rows, or a reset
 * that lists every agent merges one row once per agent.
 */
let answers: Partial<Record<HostMethodName, unknown | ((params: unknown) => unknown)>>
/** Every request the store made, in order. */
let calls: { method: HostMethodName; params: unknown }[]

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  answers = {}
  calls = []
  vi.spyOn(store.transport, 'request').mockImplementation((async (
    method: HostMethodName,
    params: unknown,
  ) => {
    calls.push({ method, params })
    const answer = answers[method]
    return (typeof answer === 'function' ? answer(params) : answer) ?? null
  }) as never)
})

/** One agent's page: its own rows, and a next page only for the agent asked to continue. */
const page =
  (rows: readonly SessionSummary[], nextCursor: string | null = null) =>
  (params: unknown) => {
    const { runtime } = params as { runtime: string }
    return { data: rows.filter((row) => row.runtime === runtime), nextCursor }
  }

/** A notification, as the host pushes it. Never connected; nothing reaches a wire. */
const push = (notification: WireNotification): void => {
  const transport = store.transport as unknown as {
    handlers: { onNotification(notification: WireNotification): void }
  }
  transport.handlers.onNotification(notification)
}

/**
 * Two agents on the desk, each with its health and its account, and Codex
 * chosen. Both are ready on the wire, so a refresh after the switch has every
 * reason it ever had to re-page the list — which is what makes the "list
 * stays" assertion worth anything.
 */
const seat = async (): Promise<void> => {
  answers['runtime/account'] = {
    accounts: [{ kind: 'chatgpt', label: 'olivia@acme.dev' }],
    signInMethods: [],
  }
  answers['runtime/health'] = { state: 'ready' }
  answers['runtime/models'] = []
  answers['runtime/options'] = []
  answers['runtime/skills'] = []
  answers['runtime/sessionDefaults'] = []
  answers['routes/list'] = []
  push({ method: 'runtime/added', params: { info: info(CODEX, 'Codex') } })
  push({ method: 'runtime/added', params: { info: info(CLAUDE, 'Claude Code') } })
  push({ method: 'runtime/healthChanged', params: { runtime: CODEX, health: { state: 'ready' } } })
  push({
    method: 'runtime/healthChanged',
    params: { runtime: CLAUDE, health: { state: 'starting' } },
  })
  await store.loadAccounts()
  await store.selectRuntime(CODEX)
}

const listed = (): string[] => store.getSnapshot().history.map((entry) => entry.id)

describe('choosing the agent new sessions run as', () => {
  it('leaves the conversation on screen', async () => {
    await seat()
    answers['session/read'] = conversation()
    answers['session/resume'] = conversation()
    await store.openSession(ID, { runtime: CODEX })
    expect(store.getSnapshot().activeSessionKey).toBe(KEY)

    await store.selectRuntime(CLAUDE)

    const after = store.getSnapshot()
    expect(after.activeRuntime).toBe(CLAUDE)
    expect(after.activeSessionKey).toBe(KEY)
    expect(panes(after.layout.root).map((pane) => pane.view.kind)).toEqual(['conversation'])
  })

  it('leaves the list where it was, and keeps paging it from the agent it was paged from', async () => {
    await seat()
    answers['session/list'] = page([summary('a', CODEX)], 'page-2')
    await store.loadHistory({ reset: true })
    expect(listed()).toEqual(['a'])

    calls.length = 0
    await store.selectRuntime(CLAUDE)
    expect(calls.map((call) => call.method)).not.toContain('session/list')
    expect(listed()).toEqual(['a'])
    expect(store.getSnapshot().historyCursor).toBe('page-2')

    // The next page continues Codex's list: a cursor handed to Claude names
    // nothing, and the reader three pages down stays three pages down.
    answers['session/list'] = page([summary('b', CODEX)])
    await store.loadHistory()
    const paged = calls.find(
      (call) => call.method === 'session/list' && (call.params as { cursor?: string }).cursor === 'page-2',
    )
    expect(paged?.params).toMatchObject({ runtime: CODEX, cursor: 'page-2' })
    expect(listed()).toEqual(['a', 'b'])
  })

  it('rebuilds the list around the new agent only on a real reset', async () => {
    await seat()
    answers['session/list'] = page([summary('a', CODEX)], 'page-2')
    await store.loadHistory({ reset: true })
    await store.selectRuntime(CLAUDE)

    calls.length = 0
    answers['session/list'] = page([summary('c', CLAUDE)])
    await store.loadHistory({ reset: true })
    const first = calls.find((call) => call.method === 'session/list')
    expect(first?.params).toMatchObject({ runtime: CLAUDE })
    expect(first?.params).not.toHaveProperty('cursor')
    expect(listed()).toContain('c')
  })

  it('takes what the window already knows about the agent in the same frame', async () => {
    await seat()
    // Not awaited: the assertion is about the frame the pick lands in, before
    // the agent has answered anything.
    void store.selectRuntime(CLAUDE)
    const now = store.getSnapshot()
    expect(now.activeRuntime).toBe(CLAUDE)
    expect(now.health).toEqual({ state: 'starting' })
    expect(now.account?.accounts[0]?.label).toBe('olivia@acme.dev')
  })

  it('is remembered across launches', async () => {
    await seat()
    await store.selectRuntime(CLAUDE)
    expect(calls).toContainEqual({
      method: 'app/state/set',
      params: { patch: { activeRuntime: CLAUDE } },
    })
  })

  it('forgets the list’s paging when the agent it was paged from goes away', async () => {
    await seat()
    answers['session/list'] = page([summary('a', CODEX)], 'page-2')
    await store.loadHistory({ reset: true })

    push({ method: 'runtime/removed', params: { runtime: CODEX } })

    const after = store.getSnapshot()
    expect(after.activeRuntime).toBe(CLAUDE)
    expect(listed()).toEqual([])
    expect(after.historyCursor).toBeNull()
  })
})

describe('answers that arrive after the default has moved on', () => {
  it('a slow agent’s draft defaults and skills do not land on the next agent', async () => {
    await seat()
    // Codex answers its defaults and skills only after the switch to Claude.
    let releaseCodex: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseCodex = resolve
    })
    const codexOption = { id: 'model', kind: 'select', label: 'Model', value: 'gpt', choices: [] }
    answers['runtime/sessionDefaults'] = (params: unknown) =>
      (params as { runtime: string }).runtime === CODEX ? gate.then(() => [codexOption]) : []
    answers['runtime/skills'] = (params: unknown) =>
      (params as { runtime: string }).runtime === CODEX ? gate.then(() => [{ name: 'codex-only' }]) : []

    const codexRefresh = store.refreshRuntime()
    await store.selectRuntime(CLAUDE)
    releaseCodex()
    await codexRefresh
    await new Promise((resolve) => setTimeout(resolve, 0))

    const now = store.getSnapshot()
    expect(now.activeRuntime).toBe(CLAUDE)
    expect(now.draftOptions).toBeNull()
    expect(now.skills).toEqual([])
  })
})

describe('picking the agent already picked', () => {
  it('is a no-op for an agent that is up', async () => {
    await seat()
    calls.length = 0
    await store.selectRuntime(CODEX)
    expect(calls).toEqual([])
  })

  it('restarts an agent that is down, as its own remediation promises', async () => {
    await seat()
    push({
      method: 'runtime/healthChanged',
      params: {
        runtime: CODEX,
        health: { state: 'unavailable', reason: 'crashed', message: 'Codex exited.', remediation: 'Select the runtime again to restart it.' },
      },
    })
    answers['runtime/refreshCatalog'] = { installation: null }
    calls.length = 0
    await store.selectRuntime(CODEX)
    expect(calls.map((call) => call.method)).toContain('runtime/refreshCatalog')
    expect(store.getSnapshot().activeRuntime).toBe(CODEX)
  })

  it('choosing a down agent as the default restarts it too', async () => {
    await seat()
    push({
      method: 'runtime/healthChanged',
      params: {
        runtime: CLAUDE,
        health: { state: 'unavailable', reason: 'crashed', message: 'Claude Code exited.', remediation: 'Select the runtime again to restart it.' },
      },
    })
    answers['runtime/refreshCatalog'] = { installation: null }
    calls.length = 0
    await store.selectRuntime(CLAUDE)
    expect(store.getSnapshot().activeRuntime).toBe(CLAUDE)
    expect(calls.map((call) => call.method)).toContain('runtime/refreshCatalog')
  })
})

describe('what round one of the review found', () => {
  it('a late failure from the previous agent does not clear the next agent’s skills', async () => {
    await seat()
    let failCodex: () => void = () => {}
    const gate = new Promise<never>((_, reject) => {
      failCodex = () => reject(new Error('codex went away'))
    })
    // Observed here so the rejection is never "unhandled" between the switch
    // and the moment `loadSkills` catches it.
    gate.catch(() => undefined)
    answers['runtime/skills'] = (params: unknown) =>
      (params as { runtime: string }).runtime === CODEX ? gate : [{ name: 'claude-only' }]

    const codexRefresh = store.refreshRuntime()
    await store.selectRuntime(CLAUDE)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getSnapshot().skills).toEqual([{ name: 'claude-only' }])
    failCodex()
    await codexRefresh
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getSnapshot().skills).toEqual([{ name: 'claude-only' }])
  })

  it('a late failure from the previous agent does not clear the next agent’s routes', async () => {
    /* `loadRoutes` guards its catch path exactly as `loadSkills` does, and
       only the skills guard had a test (#131). Written against `loadRoutes`
       directly rather than through `refreshRuntime`: `refreshRuntime` returns
       at its own guard before it ever reaches `loadRoutes`, so a switch made
       while it is in flight would leave this request unsent and the test
       green for the wrong reason. */
    await seat()
    let failCodex: () => void = () => {}
    const gate = new Promise<never>((_, reject) => {
      failCodex = () => reject(new Error('codex went away'))
    })
    // Observed here so the rejection is never “unhandled” between the switch
    // and the moment `loadRoutes` catches it.
    gate.catch(() => undefined)
    const claudeRoute = {
      id: 'r-claude',
      name: 'claude-only',
      endpoint: 'https://example.invalid',
      wireProtocol: 'openai',
      credentialRef: 'ref',
    }
    answers['routes/list'] = (params: unknown) =>
      (params as { runtime: string }).runtime === CODEX ? gate : [claudeRoute]

    const codexRoutes = store.loadRoutes()
    await store.selectRuntime(CLAUDE)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getSnapshot().routes).toEqual([claudeRoute])
    failCodex()
    await codexRoutes
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getSnapshot().routes).toEqual([claudeRoute])
  })

  it('a refresh’s health and account land in the per-runtime maps, not only the singular slots', async () => {
    await seat()
    answers['runtime/health'] = { state: 'unavailable', reason: 'crashed', message: 'Codex exited.' }
    answers['runtime/account'] = { accounts: [], signInMethods: [] }
    await store.refreshRuntime({ history: false })
    const now = store.getSnapshot()
    expect(now.healthByRuntime[CODEX]?.state).toBe('unavailable')
    expect(now.accountsByRuntime[CODEX]?.accounts).toEqual([])
    // and the seat can now restart what only the poll had seen crash
    answers['runtime/refreshCatalog'] = { installation: null }
    calls.length = 0
    await store.selectRuntime(CODEX)
    expect(calls.map((call) => call.method)).toContain('runtime/refreshCatalog')
  })

  it('only a crash is restartable: another kind of unavailable is not asked to refresh', async () => {
    await seat()
    push({
      method: 'runtime/healthChanged',
      params: { runtime: CODEX, health: { state: 'unavailable', reason: 'unknown', message: 'stopped while starting' } },
    })
    calls.length = 0
    await store.selectRuntime(CODEX)
    expect(calls).toEqual([])
  })

  it('a hand-off with a conversation open lands its chip on exactly one draft, on the target', async () => {
    await seat()
    answers['session/read'] = conversation()
    answers['session/resume'] = conversation()
    await store.openSession(ID, { runtime: CODEX })
    await store.handOff(CLAUDE)
    const now = store.getSnapshot()
    expect(now.activeRuntime).toBe(CLAUDE)
    expect(now.activeSessionKey).toBeNull()
    expect(now.draftHandoff?.runtime).toBe(CODEX)
    expect(now.draftHandoff?.sessionId).toBe(ID)
    // One pane, a conversation pane with no conversation yet: the draft.
    expect(panes(now.layout.root).map((pane) => pane.view)).toEqual([{ kind: 'conversation', session: null }])
  })
})
