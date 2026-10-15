import { beforeEach, expect, it, vi } from 'vitest'
import { runtimeId, sessionId, sessionKey, type HostMethodName, type Session, type WorkspaceEntry } from '@harnessdesk/protocol'
import { AppStore } from './store'
import { emptyWorkbench } from './workbench'
import { focusedPane, only } from './layout'
import { destinationOf, visitDestination } from './destinations'

const AGENT = runtimeId('sample-agent')
const OLD: WorkspaceEntry = { path: '/work/old', name: 'old', lastOpenedAt: 1 }
const TREE: WorkspaceEntry = { path: '/worktrees/storefront/fix', name: 'fix', lastOpenedAt: 2, repo: { root: '/work/storefront', origin: 'example.com/acme/storefront', worktree: true } }
const conversation = (id: string, cwd = TREE.path): Session => ({ id: sessionId(id), runtime: AGENT, cwd, title: id, status: { type: 'idle' }, turns: [], itemsLoaded: true, createdAt: 1, updatedAt: 1 })
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
let store: AppStore
let read: (id: string) => Session | Promise<Session>
let resume: (id: string) => Session | Promise<Session>
let open: (path: string) => WorkspaceEntry | Promise<WorkspaceEntry>
let pick: () => WorkspaceEntry | null | Promise<WorkspaceEntry | null>
const calls = (method: string) => vi.mocked(store.transport.request).mock.calls.filter(([name]) => name === method)
beforeEach(async () => {
  store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { workspace: OLD, workspaces: [OLD] })
  read = id => conversation(id)
  resume = id => conversation(id)
  open = path => ({ ...TREE, path })
  pick = () => open('/work/third')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: { sessionId: string; path: string }) => {
    if (method === 'session/read') return read(params.sessionId)
    if (method === 'session/resume') return resume(params.sessionId)
    if (method === 'workspace/open') return open(params.path)
    if (method === 'workspace/pick') return pick()
    if (method === 'workspace/recent') return [OLD, TREE]
    if (method === 'worktree/list') return []
    if (method === 'session/remove') return { undoUntil: null, warning: null }
    if (method === 'app/state/get') {
      const saved = emptyWorkbench()
      const view = { kind: 'conversation' as const, session: sessionKey(AGENT, 'saved-in-target') }
      return { layouts: { [OLD.path]: saved, [TREE.path]: { ...saved, main: only(saved.main, view), navigation: visitDestination(saved.navigation, destinationOf(view)) } } }
    }
    return null
  }) as never)
  await store.loadPreferences()
})

it('opens the worktree itself when its repository is closed, without restoring or resuming another conversation', async () => {
  const shown: string[] = []
  store.subscribe(() => { const key = store.getSnapshot().activeSessionKey; if (key) shown.push(key) })
  await store.openSession(sessionId('chosen'), { runtime: AGENT })
  expect(store.getSnapshot().workspace).toMatchObject(TREE)
  expect(store.getSnapshot().activeSessionKey).toBe(sessionKey(AGENT, 'chosen'))
  expect(calls('workspace/open').map(([, params]) => params)).toEqual([{ path: TREE.path }])
  expect(calls('session/read').map(([, params]) => params)).toEqual([{ runtime: AGENT, sessionId: 'chosen' }])
  expect(calls('session/resume')).toHaveLength(1)
  await vi.waitFor(() => expect(new Set(shown)).toEqual(new Set([sessionKey(AGENT, 'chosen')])))
})

it('does not reopen the folder on another conversation in the same workspace', async () => {
  await store.openSession(sessionId('first'), { runtime: AGENT })
  await store.openSession(sessionId('second'), { runtime: AGENT })
  expect(store.getSnapshot().activeSessionKey).toBe(sessionKey(AGENT, 'second'))
  expect(calls('workspace/open')).toHaveLength(1)
})

it.each([{ reveal: false }, { restoring: true }, { restoring: true, reveal: false }])('background/layout reads keep the workspace (%j)', async options => {
  await store.openSession(sessionId('background'), { runtime: AGENT, ...options })
  expect(store.getSnapshot().workspace).toBe(OLD)
  expect(calls('workspace/open')).toHaveLength(0)
})

it.each(['read', 'open'] as const)('a delayed %s cannot select an older conversation or workspace', async stage => {
  const pendingRead = deferred<Session>()
  const pendingOpen = deferred<WorkspaceEntry>()
  if (stage === 'read') read = id => id === 'older' ? pendingRead.promise : conversation(id, OLD.path)
  else {
    read = id => conversation(id, id === 'older' ? TREE.path : OLD.path)
    open = path => path === TREE.path ? pendingOpen.promise : OLD
  }
  resume = id => conversation(id, id === 'older' ? TREE.path : OLD.path)
  const pending = store.openSession(sessionId('older'), { runtime: AGENT })
  if (stage === 'open') await vi.waitFor(() => expect(calls('workspace/open')).toHaveLength(1))
  await store.openSession(sessionId('newer'), { runtime: AGENT })
  pendingRead.resolve(conversation('older'))
  pendingOpen.resolve(TREE)
  await pending
  expect(store.getSnapshot().workspace).toBe(OLD)
  expect(store.getSnapshot().activeSessionKey).toBe(sessionKey(AGENT, 'newer'))
})

it('uses the resumed folder when worktree recovery moves the conversation', async () => {
  resume = id => conversation(id, '/work/storefront')
  await store.openSession(sessionId('recovered'), { runtime: AGENT })
  expect(store.getSnapshot().workspace?.path).toBe('/work/storefront')
  expect(focusedPane(store.getSnapshot().layout).view).toEqual({ kind: 'conversation', session: sessionKey(AGENT, 'recovered') })
})

it('follows a worktree recreated at the same path during resume', async () => {
  let recovered = false
  open = path => {
    if (!recovered) throw new Error('The worktree has been removed.')
    return { ...TREE, path }
  }
  resume = id => { recovered = true; return conversation(id) }
  await store.openSession(sessionId('restored-tree'), { runtime: AGENT })
  expect(store.getSnapshot().workspace?.path).toBe(TREE.path)
  expect(store.getSnapshot().activeSessionKey).toBe(sessionKey(AGENT, 'restored-tree'))
  expect(store.getSnapshot().notices).toEqual([])
})

it('leaves a deleted conversation folder to the inline resume refusal', async () => {
  open = path => { throw new Error(`ENOENT: no such file or directory, stat '${path}'`) }
  const message = `Agent cannot open this conversation: its folder no longer exists (${TREE.path}).`
  resume = () => { throw Object.assign(new Error(message), { code: 'sessionFolderGone' }) }
  await store.openSession(sessionId('gone'), { runtime: AGENT })
  expect(store.getSnapshot().foldersGone.get(TREE.path)).toBe(message)
  expect(store.getSnapshot().activeSessionKey).toBe(sessionKey(AGENT, 'gone'))
  expect(store.getSnapshot().notices).toEqual([])
})

it('still reports an explicit folder-open failure', async () => {
  open = () => { throw new Error('The folder is unavailable.') }
  expect(await store.openWorkspace(TREE.path)).toBe(false)
  expect(store.getSnapshot().notices).toEqual([expect.objectContaining({ message: 'The folder is unavailable.' })])
})

it('reports a folder-follow failure if resume succeeds but its workspace still cannot open', async () => {
  open = () => { throw new Error('The folder is unreadable.') }
  await store.openSession(sessionId('unreadable'), { runtime: AGENT })
  expect(store.getSnapshot().notices).toEqual([expect.objectContaining({ message: 'The folder is unreadable.' })])
})

it('a late resume with a changed folder cannot take the workspace from a newer conversation', async () => {
  const pendingResume = deferred<Session>()
  read = id => conversation(id, id === 'older' ? TREE.path : OLD.path)
  resume = id => id === 'older' ? pendingResume.promise : conversation(id, OLD.path)
  open = path => path === OLD.path ? OLD : TREE
  const pending = store.openSession(sessionId('older'), { runtime: AGENT })
  await vi.waitFor(() => expect(calls('session/resume')).toHaveLength(1))
  await store.openSession(sessionId('newer'), { runtime: AGENT })
  pendingResume.resolve(conversation('older', '/work/storefront'))
  await pending
  expect(store.getSnapshot().workspace).toBe(OLD)
  expect(store.getSnapshot().activeSessionKey).toBe(sessionKey(AGENT, 'newer'))
})


it('a folder reply cannot select a conversation removed while it was opening', async () => {
  const pendingOpen = deferred<WorkspaceEntry>()
  open = () => pendingOpen.promise
  const pending = store.openSession(sessionId('removed'), { runtime: AGENT })
  await vi.waitFor(() => expect(calls('workspace/open')).toHaveLength(1))
  await store.removeSession(sessionId('removed'), AGENT)
  pendingOpen.resolve(TREE)
  await pending
  expect(store.getSnapshot().workspace).toBe(OLD)
  expect(store.getSnapshot().activeSessionKey).toBeNull()
  expect(calls('session/resume')).toHaveLength(0)
})

it('keeps the source workspace layout when the loading conversation moves to its folder', async () => {
  await store.openSession(sessionId('chosen'), { runtime: AGENT })
  open = () => OLD
  await store.openWorkspace(OLD.path)
  expect(store.getSnapshot().activeSessionKey).toBeNull()
})

it.each(['read', 'open'] as const)('keeps the original source layout across overlapping %s requests', async stage => {
  // A real source conversation, not an empty pane: returning must recover it.
  read = resume = id => conversation(id, id === 'source' ? OLD.path : TREE.path)
  await store.openSession(sessionId('source'), { runtime: AGENT })
  const source = store.getSnapshot().workbench
  const pendingRead = deferred<Session>()
  const pendingOpen = deferred<WorkspaceEntry>()
  read = id => stage === 'read' && id === 'abandoned' ? pendingRead.promise : conversation(id)
  let firstOpen = true
  open = () => {
    if (stage === 'open' && firstOpen) { firstOpen = false; return pendingOpen.promise }
    return TREE
  }
  const pending = store.openSession(sessionId('abandoned'), { runtime: AGENT })
  if (stage === 'open') await vi.waitFor(() => expect(calls('workspace/open')).toHaveLength(1))
  await store.openSession(sessionId('chosen'), { runtime: AGENT })
  pendingRead.resolve(conversation('abandoned'))
  pendingOpen.resolve(TREE)
  await pending
  open = () => OLD
  await store.openWorkspace(OLD.path)
  expect(store.getSnapshot().activeSessionKey).toBe(sessionKey(AGENT, 'source'))
  expect(store.getSnapshot().workbench.main).toEqual(source.main)
  expect(store.getSnapshot().workbench.navigation).toEqual(source.navigation)
})

it.each([
  { stage: 'read', picker: false }, { stage: 'open', picker: false },
  { stage: 'read', picker: true }, { stage: 'open', picker: true },
])('an explicit folder open preserves the source layout during a pending $stage (picker: $picker)', async ({ stage, picker }) => {
  read = resume = id => conversation(id, id === 'source' ? OLD.path : TREE.path)
  await store.openSession(sessionId('source'), { runtime: AGENT })
  const source = store.getSnapshot().workbench
  const pendingRead = deferred<Session>()
  const pendingOpen = deferred<WorkspaceEntry>()
  read = id => id === 'abandoned' && stage === 'read' ? pendingRead.promise : conversation(id)
  open = path => path === TREE.path && stage === 'open' ? pendingOpen.promise : { ...OLD, path }
  const pending = store.openSession(sessionId('abandoned'), { runtime: AGENT })
  if (stage === 'open') await vi.waitFor(() => expect(calls('workspace/open')).toHaveLength(1))
  if (picker) await store.pickWorkspace()
  else await store.openWorkspace('/work/third')
  pendingRead.resolve(conversation('abandoned'))
  pendingOpen.resolve(TREE)
  await pending
  await store.openWorkspace(OLD.path)
  expect(store.getSnapshot().activeSessionKey).toBe(sessionKey(AGENT, 'source'))
  expect(store.getSnapshot().workbench.main).toEqual(source.main)
  expect(store.getSnapshot().workbench.navigation).toEqual(source.navigation)
})

it.each(['conversation', 'folder'] as const)('reconciles host activation after a stale folder open is overtaken by a %s', async selection => {
  const pendingOpen = deferred<WorkspaceEntry>()
  let hostWorkspace = OLD.path
  read = resume = id => conversation(id, id === 'older' ? TREE.path : OLD.path)
  open = async path => {
    const workspace = path === TREE.path ? await pendingOpen.promise : { ...OLD, path }
    // The real endpoint activates shell and plugin scope before returning.
    hostWorkspace = workspace.path
    return workspace
  }
  const pending = store.openSession(sessionId('older'), { runtime: AGENT })
  await vi.waitFor(() => expect(calls('workspace/open')).toHaveLength(1))
  if (selection === 'conversation') await store.openSession(sessionId('newer'), { runtime: AGENT })
  else await store.openWorkspace('/work/third')
  const selected = store.getSnapshot().workbench
  pendingOpen.resolve(TREE)
  await pending
  expect(hostWorkspace).toBe(store.getSnapshot().workspace?.path)
  expect(store.getSnapshot().workbench).toBe(selected)
  if (selection === 'conversation') expect(store.getSnapshot().activeSessionKey).toBe(sessionKey(AGENT, 'newer'))
})

it('a newer folder choice also supersedes an in-flight host reconciliation', async () => {
  const pendingOpen = deferred<WorkspaceEntry>()
  const pendingCorrection = deferred<WorkspaceEntry>()
  let hostWorkspace = OLD.path
  read = resume = id => conversation(id, id === 'older' ? TREE.path : OLD.path)
  open = async path => {
    const workspace = path === TREE.path ? await pendingOpen.promise
      : path === OLD.path ? await pendingCorrection.promise : { ...OLD, path }
    hostWorkspace = workspace.path
    return workspace
  }
  const pending = store.openSession(sessionId('older'), { runtime: AGENT })
  await vi.waitFor(() => expect(calls('workspace/open')).toHaveLength(1))
  await store.openSession(sessionId('newer'), { runtime: AGENT })
  pendingOpen.resolve(TREE)
  await vi.waitFor(() => expect(calls('workspace/open')).toHaveLength(2))
  await store.openWorkspace('/work/latest')
  const selected = store.getSnapshot().workbench
  pendingCorrection.resolve(OLD)
  await pending
  expect(hostWorkspace).toBe('/work/latest')
  expect(store.getSnapshot().workspace?.path).toBe('/work/latest')
  expect(store.getSnapshot().workbench).toBe(selected)
})

it('reconciles host activation when a folder picker overlaps an automatic folder open', async () => {
  const third = { ...OLD, path: '/work/third' }
  const pendingPick = deferred<WorkspaceEntry>()
  const pendingOpen = deferred<WorkspaceEntry>()
  let hostWorkspace = OLD.path
  pick = () => { hostWorkspace = third.path; return pendingPick.promise }
  open = async path => {
    const workspace = path === TREE.path ? await pendingOpen.promise : { ...OLD, path }
    hostWorkspace = workspace.path
    return workspace
  }
  const picking = store.pickWorkspace()
  const pending = store.openSession(sessionId('older'), { runtime: AGENT })
  await vi.waitFor(() => expect(calls('workspace/open')).toHaveLength(1))
  pendingOpen.resolve(TREE)
  await pending
  pendingPick.resolve(third)
  await picking
  expect(hostWorkspace).toBe(third.path)
  expect(store.getSnapshot().workspace?.path).toBe(third.path)
})
