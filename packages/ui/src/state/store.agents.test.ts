import { beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, type AgentEntry, type HostMethodName, type SeatPlan, type WorkspaceEntry } from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * The roster, in the window: read for the folder that is open, a dry run of it
 * beside it, and read again when the host says it changed — but only by a
 * window that had read it, so a window that never shows an Agent reads no file.
 *
 * Also: a slow answer is never drawn over a newer one. `loadAgents` and
 * `loadAgentPlans` can overlap — a workspace switch, an `agent/changed`, a
 * sign-in — and an older request answering last must never draw the previous
 * project's roster, or plans keyed by id for the wrong project, over what a
 * newer request already put on screen.
 */

const ENTRY: AgentEntry = {
  id: 'code-reviewer',
  origin: 'builtin',
  path: '/app/agents/code-reviewer/AGENT.md',
  digest: 'd',
  shadows: [],
  problems: [],
  definition: {
    id: 'code-reviewer',
    name: 'Code reviewer',
    description: null,
    permission: 'read',
    answers: [],
    produces: [],
    skills: [],
    prefer: [{ runtime: 'claude-code' }],
    brief: 'Review.',
  },
}
const PLAN: SeatPlan = { id: 'code-reviewer', from: 'prefer', winner: null, blocked: null, candidates: [] }
const WORKSPACE = { path: '/work/storefront/pkg', name: 'pkg', lastOpenedAt: 1 }

let store: AppStore
let asked: { method: HostMethodName; params: unknown }[]

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  asked = []
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    asked.push({ method, params })
    if (method === 'agent/list') return [ENTRY]
    if (method === 'agent/seat/dry') return [PLAN]
    if (method === 'workspace/open') return WORKSPACE
    if (method === 'workspace/recent') return [WORKSPACE]
    return null
  }) as never)
})

const handlers = () =>
  (store.transport as unknown as {
    handlers: {
      onNotification(notification: unknown): void
      onEvent(runtime: unknown, event: unknown): void
    }
  }).handlers

it('reads the roster for the open folder, then which seat each Agent would take', async () => {
  await store.openWorkspace(WORKSPACE.path)
  asked.length = 0
  await store.loadAgents()
  // Only the roster's own verbs: opening a folder sets off other reads of its own.
  expect(asked.filter((one) => one.method.startsWith('agent/')).map((one) => [one.method, one.params])).toEqual([
    ['agent/list', { project: WORKSPACE.path }],
    ['agent/seat/dry', { project: WORKSPACE.path }],
  ])
  expect(store.getSnapshot().agents).toEqual([ENTRY])
  expect(store.getSnapshot().agentsProject).toBe(WORKSPACE.path)
  expect(store.getSnapshot().agentPlans.get('code-reviewer')).toEqual(PLAN)
})

it('reads again when the host says the roster changed — once this window has read it', async () => {
  handlers().onNotification({ method: 'agent/changed', params: { project: null } })
  await Promise.resolve()
  expect(asked.some((one) => one.method === 'agent/list')).toBe(false)

  await store.loadAgents()
  asked.length = 0
  handlers().onNotification({ method: 'agent/changed', params: { project: null } })
  await vi.waitFor(() =>
    expect(asked.filter((one) => one.method.startsWith('agent/')).map((one) => one.method)).toEqual([
      'agent/list',
      'agent/seat/dry',
    ]),
  )
})

it('weighs the seats again when a sign-in changes what can be seated', async () => {
  await store.loadAgents()
  asked.length = 0
  handlers().onEvent(runtimeId('cursor'), { type: 'account/changed', runtime: runtimeId('cursor') })
  await vi.waitFor(() => expect(asked.some((one) => one.method === 'agent/seat/dry')).toBe(true))
})

/**
 * A notice names the project it is about (`{ project }`): `null` is this
 * machine's roster or `seating.json`, and either touches every open project;
 * a named one matters only when it is the one this window shows. The dry run
 * asks every runtime a question, so a notice for a project nobody here is
 * looking at is not worth that.
 */
it('reloads on a notice naming this window\'s own project, or none — and ignores one naming another', async () => {
  // No workspace is open here, so `agentsProject` is null once this resolves.
  await store.loadAgents()
  asked.length = 0

  handlers().onNotification({ method: 'agent/changed', params: { project: '/some/other/project' } })
  await Promise.resolve()
  expect(asked.some((one) => one.method === 'agent/list')).toBe(false)

  handlers().onNotification({ method: 'agent/changed', params: { project: null } })
  await vi.waitFor(() => expect(asked.some((one) => one.method === 'agent/list')).toBe(true))
})

/** A deferred promise, so a test can control exactly when a mocked request answers. */
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

it('never lets an older loadAgents answer draw its project over a newer one', async () => {
  const workspaceA: WorkspaceEntry = { path: '/work/a', name: 'a', lastOpenedAt: 1 }
  const workspaceB: WorkspaceEntry = { path: '/work/b', name: 'b', lastOpenedAt: 2 }
  const entryA: AgentEntry = { ...ENTRY, id: 'from-a' }
  const entryB: AgentEntry = { ...ENTRY, id: 'from-b' }
  const listFor = new Map<string, ReturnType<typeof deferred<readonly AgentEntry[]>>>()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    asked.push({ method, params })
    if (method === 'agent/list') {
      const project = (params as { project?: string }).project ?? ''
      const entry = listFor.get(project) ?? deferred<readonly AgentEntry[]>()
      listFor.set(project, entry)
      return entry.promise
    }
    if (method === 'agent/seat/dry') return []
    if (method === 'workspace/open') {
      return (params as { path: string }).path === workspaceA.path ? workspaceA : workspaceB
    }
    return null
  }) as never)

  await store.openWorkspace(workspaceA.path)
  const olderLoad = store.loadAgents() // agent/list(a) — pending
  await store.openWorkspace(workspaceB.path)
  const newerLoad = store.loadAgents() // agent/list(b) — pending

  // The newer request settles first — the ordinary case, not just a contrived one.
  listFor.get(workspaceB.path)!.resolve([entryB])
  await newerLoad
  expect(store.getSnapshot().agents).toEqual([entryB])
  expect(store.getSnapshot().agentsProject).toBe(workspaceB.path)

  // The older one finally answers. It must not win just because it is the one still open.
  listFor.get(workspaceA.path)!.resolve([entryA])
  await olderLoad
  expect(store.getSnapshot().agents).toEqual([entryB])
  expect(store.getSnapshot().agentsProject).toBe(workspaceB.path)
})

/**
 * A plan answered for a project this window no longer shows must not be
 * drawn, even when nothing newer has asked for plans since. `agentPlans`
 * carries no project of its own, so a generation counter alone cannot catch
 * this: `loadAgentPlans` reads the *currently open* folder at call time,
 * which can already be a new project while `agentsProject` — set only once
 * `loadAgents` finishes — still names the old one. The extra check compares
 * the request's own project against `agentsProject` when the answer lands.
 */
it('drops a dry run answered for a project this window has already moved off of, even as the newest one asked', async () => {
  const workspaceA: WorkspaceEntry = { path: '/work/a', name: 'a', lastOpenedAt: 1 }
  const workspaceB: WorkspaceEntry = { path: '/work/b', name: 'b', lastOpenedAt: 2 }
  const planA: SeatPlan = { ...PLAN, blocked: null }
  const planB: SeatPlan = { ...PLAN, blocked: 'from B, and must never be shown while A is on screen' }
  const listDeferredB = deferred<readonly AgentEntry[]>()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    asked.push({ method, params })
    if (method === 'workspace/open') {
      return (params as { path: string }).path === workspaceA.path ? workspaceA : workspaceB
    }
    if (method === 'agent/list') {
      const project = (params as { project?: string }).project
      // B's own listing is left pending, so `agentsProject` stays "A" for the
      // rest of this test — the exact gap the project check exists to cover.
      return project === workspaceA.path ? [ENTRY] : listDeferredB.promise
    }
    if (method === 'agent/seat/dry') {
      const project = (params as { project?: string }).project
      return [project === workspaceA.path ? planA : planB]
    }
    return null
  }) as never)

  // Baseline: the roster and its plan are up for project A.
  await store.openWorkspace(workspaceA.path)
  await store.loadAgents()
  expect(store.getSnapshot().agentsProject).toBe(workspaceA.path)
  expect(store.getSnapshot().agentPlans.get(PLAN.id)).toEqual(planA)

  // The window moves to project B. `workspace.path` is B from here on, but
  // `agentsProject` will not become B until B's own `agent/list` answers —
  // which this test deliberately never lets happen yet.
  await store.openWorkspace(workspaceB.path)
  expect(store.getSnapshot().agentsProject).toBe(workspaceA.path)

  // A sign-in (or any other trigger) asks for a fresh dry run right now. It
  // reads the folder that is open *now* — B — and answers promptly: nothing
  // newer has asked for plans since, so a generation check alone would let
  // this through.
  await store.loadAgentPlans()

  // Refused anyway: B is not the project this window's roster is showing yet.
  expect(store.getSnapshot().agentPlans.get(PLAN.id)).toEqual(planA)

  // The move to B completes once its own listing answers, and only then does
  // B's dry run apply.
  listDeferredB.resolve([ENTRY])
  await vi.waitFor(() => expect(store.getSnapshot().agentsProject).toBe(workspaceB.path))
  await vi.waitFor(() => expect(store.getSnapshot().agentPlans.get(PLAN.id)).toEqual(planB))
})

/**
 * The very first `loadAgents()` a window ever makes can still be pending —
 * `agents` stays `null` until one answers — when the folder switches under
 * it. `openWorkspace`'s own reload is gated so a window that never asked for
 * Agents never reads one, and that gate used to read `agents !== null`
 * ("has a load ever *answered*"), not "has one ever been *requested*" — so a
 * workspace switch during this still-pending first read found `agents` still
 * `null`, started no replacement load, and the first read then applied
 * unopposed once it landed: for the folder that was open when it *started*,
 * not the one on screen once it *finished*.
 */
it('a workspace switch during the still-pending first roster read starts its own load, and the stale first answer cannot win', async () => {
  const workspaceA: WorkspaceEntry = { path: '/work/a', name: 'a', lastOpenedAt: 1 }
  const workspaceB: WorkspaceEntry = { path: '/work/b', name: 'b', lastOpenedAt: 2 }
  const entryA: AgentEntry = { ...ENTRY, id: 'from-a' }
  const entryB: AgentEntry = { ...ENTRY, id: 'from-b' }
  const listFor = new Map<string, ReturnType<typeof deferred<readonly AgentEntry[]>>>()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    asked.push({ method, params })
    if (method === 'agent/list') {
      const project = (params as { project?: string }).project ?? ''
      const entry = listFor.get(project) ?? deferred<readonly AgentEntry[]>()
      listFor.set(project, entry)
      return entry.promise
    }
    if (method === 'agent/seat/dry') return []
    if (method === 'workspace/open') {
      return (params as { path: string }).path === workspaceA.path ? workspaceA : workspaceB
    }
    return null
  }) as never)

  // The window's very first roster read, for A — never answered in this test.
  await store.openWorkspace(workspaceA.path)
  const firstLoad = store.loadAgents()
  expect(store.getSnapshot().agents).toBeNull() // still pending

  // The folder switches to B while that first read is still in flight. This
  // must start B's own load — the window has, after all, already asked to
  // see Agents once — rather than waiting for the stale A read to land.
  await store.openWorkspace(workspaceB.path)
  await vi.waitFor(() =>
    expect(asked.filter((one) => one.method === 'agent/list').map((one) => one.params)).toEqual([
      { project: workspaceA.path },
      { project: workspaceB.path },
    ]),
  )

  listFor.get(workspaceB.path)!.resolve([entryB])
  await vi.waitFor(() => expect(store.getSnapshot().agents).toEqual([entryB]))
  expect(store.getSnapshot().agentsProject).toBe(workspaceB.path)

  // The stale first read for A finally answers. It must not win just because
  // it was the one already running when the window first asked.
  listFor.get(workspaceA.path)!.resolve([entryA])
  await firstLoad
  expect(store.getSnapshot().agents).toEqual([entryB])
  expect(store.getSnapshot().agentsProject).toBe(workspaceB.path)
})

/**
 * `agent/changed` names the watched project root, which for a folder opened
 * inside a linked worktree is that worktree's own top — never `repo.root`,
 * which is deliberately the *main* checkout (so the session list can group a
 * worktree under the project it is a checkout of). A window whose workspace
 * carries only `repo.root` and not `checkoutRoot` would compare the notice
 * against the wrong folder and never reload.
 */
it('reloads on a notice naming a linked worktree\'s own top, opened at a subfolder of it — not the main checkout `repo.root` names', async () => {
  const worktree: WorkspaceEntry = {
    path: '/work/tree/pkg',
    name: 'pkg',
    lastOpenedAt: 1,
    repo: { root: '/work/main', worktree: true },
    checkoutRoot: '/work/tree',
  }
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    asked.push({ method, params })
    if (method === 'agent/list') return [ENTRY]
    if (method === 'agent/seat/dry') return [PLAN]
    if (method === 'workspace/open') return worktree
    if (method === 'workspace/recent') return [worktree]
    return null
  }) as never)

  await store.openWorkspace(worktree.path)
  await store.loadAgents()
  asked.length = 0

  // The main checkout: nobody is showing that folder's roster, ever, from here.
  handlers().onNotification({ method: 'agent/changed', params: { project: '/work/main' } })
  await Promise.resolve()
  expect(asked.some((one) => one.method === 'agent/list')).toBe(false)

  // The worktree's own top: exactly what this window's roster is for.
  handlers().onNotification({ method: 'agent/changed', params: { project: '/work/tree' } })
  await vi.waitFor(() => expect(asked.some((one) => one.method === 'agent/list')).toBe(true))
})

/**
 * The reviewer's own probe: two dry runs for the *same* project, the newer
 * settled first — nothing about project mismatch is at stake here, only
 * whether an older generation can still overwrite a newer one that already
 * landed. Without `loadAgentPlans`'s own generation guard this goes green for
 * the wrong reason (the project-match check alone would not catch it, since
 * both answers are for the one project this window shows).
 */
it('never lets an older dry run for the same project overwrite a newer one that already answered', async () => {
  const older = deferred<readonly SeatPlan[]>()
  const newer = deferred<readonly SeatPlan[]>()
  let call = 0
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    asked.push({ method, params })
    if (method === 'agent/seat/dry') {
      call += 1
      return call === 1 ? older.promise : newer.promise
    }
    return null
  }) as never)

  // No workspace is open, so `project` is `null` on both calls — the same
  // project this window's (never-loaded) roster is for, `null` too. Nothing
  // about a project mismatch is exercised here on purpose: only the
  // generation guard stands between the older answer and the screen.
  const olderCall = store.loadAgentPlans()
  const newerCall = store.loadAgentPlans()

  const oldPlan: SeatPlan = { ...PLAN, blocked: 'old' }
  const newPlan: SeatPlan = { ...PLAN, blocked: 'new' }
  newer.resolve([newPlan])
  await newerCall
  expect(store.getSnapshot().agentPlans.get(PLAN.id)).toEqual(newPlan)

  older.resolve([oldPlan])
  await olderCall
  expect(store.getSnapshot().agentPlans.get(PLAN.id)).toEqual(newPlan)
})
