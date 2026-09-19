import { beforeEach, expect, it, vi } from 'vitest'

import {
  runtimeId,
  sessionId,
  sessionKey,
  type AgentEntry,
  type HostMethodName,
  type SeatPlan,
  type Session,
  type WorkspaceEntry,
} from '@harnessdesk/protocol'

import { seatAgentKey } from '../lib/agents'
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

/**
 * `store.startAsAgent`: a fresh dry run for the one Agent (a sign-in since
 * the menu was drawn changes the answer), seated in the open folder when it
 * allows one, or the refusal sheet raised — never opening anything — when it
 * does not. A refusal only an open seat could find arrives from the host's
 * own `seatRefused` list instead.
 */

const SEATED: Session = {
  id: sessionId('s1'),
  runtime: runtimeId('claude-code'),
  cwd: WORKSPACE.path,
  title: 'Code reviewer',
  status: { type: 'idle' },
  createdAt: 0,
  updatedAt: 0,
  turns: [],
  itemsLoaded: true,
}

const seatPlan = (winner: number | null): SeatPlan => ({
  id: 'code-reviewer',
  from: 'prefer',
  winner,
  blocked: null,
  candidates: [
    {
      seat: { runtime: 'cursor' },
      label: 'Cursor',
      runtimeName: 'Cursor',
      state: winner === null ? 'passed' : 'taken',
      reason: winner === null ? { kind: 'signedOut' } : null,
      fix: winner === null ? { kind: 'signIn', runtime: 'cursor' } : null,
    },
  ],
})

const answering = (answers: Partial<Record<HostMethodName, (params: unknown) => unknown>>) =>
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    asked.push({ method, params })
    if (method === 'workspace/open') return WORKSPACE
    if (method === 'workspace/recent') return [WORKSPACE]
    const answer = answers[method]
    return answer ? answer(params) : null
  }) as never)

it('a start the plan already refuses opens nothing, and raises the sheet with every candidate', async () => {
  answering({ 'agent/seat/dry': () => [seatPlan(null)] })
  await store.openWorkspace(WORKSPACE.path)
  expect(await store.startAsAgent('code-reviewer')).toBeNull()
  expect(asked.some((one) => one.method === 'agent/seat')).toBe(false)
  expect(store.getSnapshot().seatRefusal?.candidates.map((one) => one.reason)).toEqual([{ kind: 'signedOut' }])
  // The dry run alone never opens anything.
  expect(store.getSnapshot().seatRefusal?.opened).toBe(false)
  store.dismissSeatRefusal()
  expect(store.getSnapshot().seatRefusal).toBeNull()
})

it('a start the plan allows is seated in the open folder, and shown', async () => {
  answering({ 'agent/seat/dry': () => [seatPlan(0)], 'agent/seat': () => SEATED })
  await store.openWorkspace(WORKSPACE.path)
  const key = await store.startAsAgent('code-reviewer')
  expect(key).toBe(sessionKey(runtimeId('claude-code'), SEATED.id))
  expect(asked.find((one) => one.method === 'agent/seat')?.params).toEqual({
    id: 'code-reviewer',
    cwd: WORKSPACE.path,
    project: WORKSPACE.path,
  })
  expect(store.getSnapshot().sessions.has(key!)).toBe(true)
  expect(store.getSnapshot().seatRefusal).toBeNull()
})

it('a fix asked for from deep inside is held until the shell takes it where it is fixed', () => {
  store.askSeatFix({ kind: 'signIn', runtime: 'cursor' }, 'code-reviewer')
  expect(store.getSnapshot().seatFix).toEqual({ fix: { kind: 'signIn', runtime: 'cursor' }, agent: 'code-reviewer' })
  store.askSeatFix(null)
  expect(store.getSnapshot().seatFix).toBeNull()
})

it('a refusal only an open seat could find raises the same sheet, from the host’s own list — and says a seat was tried', async () => {
  answering({
    'agent/seat/dry': () => [seatPlan(0)],
    'agent/seat': () => {
      throw Object.assign(new Error('No seat could be opened for this Agent'), {
        code: 'seatRefused',
        data: {
          candidates: [
            {
              ...seatPlan(null).candidates[0],
              reason: { kind: 'openedOtherwise', differences: [{ field: 'effort', asked: 'high', running: 'low' }] },
              fix: { kind: 'seats' },
            },
          ],
        },
      })
    },
  })
  await store.openWorkspace(WORKSPACE.path)
  expect(await store.startAsAgent('code-reviewer')).toBeNull()
  expect(store.getSnapshot().seatRefusal?.candidates[0]?.reason).toEqual({
    kind: 'openedOtherwise',
    differences: [{ field: 'effort', asked: 'high', running: 'low' }],
  })
  // It tried a seat before this failed — "Nothing was opened" would be false.
  expect(store.getSnapshot().seatRefusal?.opened).toBe(true)
})

it('a seat opened and its brief could not be handed over says so in a sentence naming the Agent, never the host’s', async () => {
  answering({
    'agent/list': () => [ENTRY],
    'agent/seat/dry': () => [seatPlan(0)],
    'agent/seat': () => {
      throw Object.assign(new Error('Code reviewer was seated on Claude · Opus 5 · High, and its brief could not be handed over, so the conversation was closed: disk full'), {
        code: 'briefNotHandedOver',
      })
    },
  })
  await store.openWorkspace(WORKSPACE.path)
  await store.loadAgents()
  expect(await store.startAsAgent('code-reviewer')).toBeNull()
  // No refusal sheet: this is not a list of candidates, and nothing about a seat spec reaches the UI.
  expect(store.getSnapshot().seatRefusal).toBeNull()
  const notice = store.getSnapshot().notices.at(-1)
  expect(notice?.message).toContain('Code reviewer')
  expect(notice?.message).not.toContain('Opus 5 · High')
})

/**
 * `readSeatAgent`: the Agent a seated conversation was seated as, read once
 * per folder and id, and again once the roster moves. A conversation with no
 * `agent` setting — the plain path — never asks: `useSeatAgent` reads nothing
 * for it (its own tests, per surface), and this store method itself is
 * simply never called for one.
 */
it('reads the Agent a seated conversation was seated as once, for its folder, and again when the roster moves', async () => {
  answering({ 'agent/read': () => ENTRY })
  store.readSeatAgent('/w/storefront', 'code-reviewer')
  store.readSeatAgent('/w/storefront', 'code-reviewer')
  await vi.waitFor(() =>
    expect(store.getSnapshot().seatAgents.get(seatAgentKey('/w/storefront', 'code-reviewer'))).toEqual(ENTRY),
  )
  expect(asked.filter((one) => one.method === 'agent/read').map((one) => one.params)).toEqual([
    { id: 'code-reviewer', project: '/w/storefront' },
  ])
  handlers().onNotification({ method: 'agent/changed', params: { project: null } })
  await vi.waitFor(() => expect(asked.filter((one) => one.method === 'agent/read')).toHaveLength(2))
})

it('a read that fails leaves the Agent unread, rather than saying it is gone', async () => {
  answering({
    'agent/read': () => {
      throw new Error('offline')
    },
  })
  store.readSeatAgent('/w/storefront', 'code-reviewer')
  await vi.waitFor(() => expect(asked.some((one) => one.method === 'agent/read')).toBe(true))
  // Still unread — not `null`, which would say the Agent is gone.
  expect(store.getSnapshot().seatAgents.has(seatAgentKey('/w/storefront', 'code-reviewer'))).toBe(false)
})

it('customizing and removing read the roster again, and say why when the host refuses', async () => {
  const copy = { ...ENTRY, origin: 'user' as const, path: '/u/.harnessdesk/agents/code-reviewer/AGENT.md' }
  answering({
    'agent/list': () => [copy],
    // loadAgents() below draws a dry run too; this test cares about neither its shape nor its content.
    'agent/seat/dry': () => [],
    'agent/copy': () => copy,
    'agent/remove': () => {
      throw new Error('Moving an Agent to the Trash needs the desktop app.')
    },
  })
  await store.openWorkspace(WORKSPACE.path)
  await store.loadAgents()
  asked.length = 0
  expect(await store.customizeAgent('code-reviewer', 'builtin', 'user')).toEqual(copy)
  expect(asked.find((one) => one.method === 'agent/copy')?.params).toEqual({
    id: 'code-reviewer',
    from: 'builtin',
    to: 'user',
    project: WORKSPACE.path,
  })
  await vi.waitFor(() => expect(asked.some((one) => one.method === 'agent/list')).toBe(true))
  await expect(store.trashAgent('code-reviewer', 'user')).rejects.toThrow('needs the desktop app')
})
