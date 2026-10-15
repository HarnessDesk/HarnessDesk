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
const calls = (method: string) => vi.mocked(store.transport.request).mock.calls.filter(([name]) => name === method)
beforeEach(async () => {
  store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { workspace: OLD, workspaces: [OLD] })
  read = id => conversation(id)
  resume = id => conversation(id)
  open = path => ({ ...TREE, path })
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: { sessionId: string; path: string }) => {
    if (method === 'session/read') return read(params.sessionId)
    if (method === 'session/resume') return resume(params.sessionId)
    if (method === 'workspace/open') return open(params.path)
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
