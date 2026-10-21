import { expect, it, vi } from 'vitest'
import { NO_CAPABILITIES, runtimeId, sessionId, sessionKey, type HostMethodName, type Session } from '@harnessdesk/protocol'
import { AppStore } from './store'
import { only } from './layout'
import { dock, dockViews, emptyWorkbench } from './workbench'
import '../panels/builtins'

it('starts without a project and leaves the new cwd to the host', async () => {
  const store = new AppStore('ws://localhost:0/')
  const runtime = runtimeId('demo')
  Object.assign(store.getSnapshot(), { activeRuntime: runtime, workspace: null })
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'runtime/sessionDefaults') return []
    if (method === 'session/create') return { runtime, id: sessionId('chat'), cwd: '/data/chats/2026-10-16-abc', turns: [], status: { type: 'idle' }, createdAt: 0, updatedAt: 0 }
    return {}
  }) as never)
  expect(await store.newSession()).toBe(sessionKey(runtime, sessionId('chat')))
  const creation = request.mock.calls.find(([method]) => method === 'session/create')!
  expect(creation).toBeTruthy()
  expect(creation[1]).toEqual({ runtime, options: {} })
})

it('clears the chosen folder and worktree without losing the draft or starting a runtime', async () => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { workspace: { path: '/project', name: 'project', git: { branch: 'main' } },
    draftPlace: { kind: 'worktree', root: '/project', name: 'task' }, worktrees: [{ path: '/project/task' }] })
  const request = vi.spyOn(store.transport, 'request').mockResolvedValue({} as never)
  store.clearDraftFolder()
  expect(store.getSnapshot().workspace).toBeNull()
  expect(store.getSnapshot().draftPlace).toEqual({ kind: 'chats' })
  expect(store.getSnapshot().worktrees).toEqual([])
  expect(request.mock.calls.some(([method]) => method === 'session/create')).toBe(false)
})

it('reads the host-resolved chats location and applies settings without changing an existing cwd', async () => {
  const store = new AppStore('ws://localhost:0/')
  const runtime = runtimeId('demo')
  Object.assign(store.getSnapshot(), { activeRuntime: runtime, runtimes: [{ id: runtime, presentation: { name: 'Demo' }, capabilities: NO_CAPABILITIES }] })
  let chatsFolder = '/data/chats'
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { patch?: { chatsFolder?: string | null } }) => {
    if (method === 'app/state/set') chatsFolder = params.patch?.chatsFolder ?? '/data/chats'
    return { chatsFolder, chatsFolderRoots: [] }
  }) as never)
  await store.loadPreferences()
  expect(store.getSnapshot().chatsFolder).toBe('/data/chats')
  await store.setChatsFolder('/custom')
  expect(store.getSnapshot().chatsFolder).toBe('/custom')
  await store.setChatsFolder(null)
  expect(store.getSnapshot().chatsFolder).toBe('/data/chats')
  expect(request).toHaveBeenCalledWith('app/state/set', { patch: { chatsFolder: null } })
})

it('retains an explicit No folder choice when recent projects refresh, including an in-flight read', async () => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { workspace: { path: '/project', name: 'project' } })
  let finish!: (value: unknown) => void
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'workspace/recent') return new Promise(resolve => { finish = resolve })
    return []
  }) as never)
  const pending = store.loadWorkspaces()
  store.clearDraftFolder()
  finish([{ path: '/project', name: 'project', lastOpenedAt: 1 }])
  await pending
  expect(store.getSnapshot().workspace).toBeNull()
  store.newDraft()
  const refresh = store.loadWorkspaces()
  finish([{ path: '/project', name: 'project', lastOpenedAt: 1 }])
  await refresh
  expect(store.getSnapshot().workspace).toBeNull()
})

it('returns to No folder for a new draft opened from an existing managed chat', () => {
  const store = new AppStore('ws://localhost:0/')
  const path = '/data/chats/2026-10-16-first'
  Object.assign(store.getSnapshot(), { workspace: { path, name: '2026-10-16-first' }, chatsFolderRoots: [path] })
  vi.spyOn(store.transport, 'request').mockResolvedValue([] as never)
  store.newDraft()
  expect(store.getSnapshot().workspace).toBeNull()
})

it('does not automatically select a managed chat directory from recent folders at startup', async () => {
  const store = new AppStore('ws://localhost:0/')
  const path = '/data/chats/2026-10-16-first'
  Object.assign(store.getSnapshot(), { chatsFolderRoots: [path] })
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) =>
    method === 'workspace/recent' ? [{ path, name: '2026-10-16-first', lastOpenedAt: 1 }] : []) as never)
  await store.loadWorkspaces()
  expect(store.getSnapshot().workspace).toBeNull()
})

it.each([true, false])('leaves an unsaved recent chat unselected (preferences first: %s)', async preferencesFirst => {
  const store = new AppStore('ws://localhost:0/')
  const path = '/data/chats/2026-10-16-first'
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'app/state/get') return { chatsFolderRoots: [path] }
    if (method === 'workspace/recent') return [{ path, name: 'chat', lastOpenedAt: 1 }]
    return []
  }) as never)
  if (preferencesFirst) { await store.loadPreferences(); await store.loadWorkspaces() }
  else { await store.loadWorkspaces(); await store.loadPreferences() }
  expect(store.getSnapshot().workspace).toBeNull()
})

it('keeps an explicit selection made before late preferences arrive', async () => {
  const store = new AppStore('ws://localhost:0/')
  const path = '/data/chats/2026-10-16-first'
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'app/state/get') return { chatsFolderRoots: [path] }
    if (method === 'workspace/recent') return [{ path, name: 'chat', lastOpenedAt: 1 }]
    if (method === 'workspace/open') return { path, name: 'chat', lastOpenedAt: 2 }
    return []
  }) as never)
  await store.loadWorkspaces()
  await store.openWorkspace(path)
  await store.loadPreferences()
  expect(store.getSnapshot().workspace?.path).toBe(path)
})

const runtime = runtimeId('demo')
const chat = (cwd = '/data/chats/2026-10-16-first'): Session => ({
  runtime, id: sessionId('saved-chat'), cwd, turns: [], status: { type: 'idle' },
  itemsLoaded: true, createdAt: 0, updatedAt: 0,
})

it('keeps a newer project selection when a managed chat workspace opens late', async () => {
  const store = new AppStore('ws://localhost:0/')
  const created = chat()
  const project = { path: '/project', name: 'project', lastOpenedAt: 1 }
  let finish!: () => void
  let hostWorkspace: string | null = null
  Object.assign(store.getSnapshot(), { activeRuntime: runtime })
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: { path?: string }) => {
    if (method === 'runtime/sessionDefaults' || method === 'worktree/list' || method === 'workspace/recent') return []
    if (method === 'session/create') return created
    if (method === 'workspace/open') {
      if (params.path === created.cwd) await new Promise<void>(resolve => { finish = resolve })
      hostWorkspace = params.path!
      return params.path === project.path ? project : { path: created.cwd, name: 'chat', lastOpenedAt: 2 }
    }
    return null
  }) as never)
  const starting = store.newSession()
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  await store.openWorkspace(project.path)
  const selected = store.getSnapshot().workbench
  finish()
  const key = await starting
  expect(store.getSnapshot().workspace).toEqual(project)
  expect(store.getSnapshot().workbench).toBe(selected)
  expect(hostWorkspace).toBe(project.path)
  expect(store.getSnapshot().sessions.get(key!)?.cwd).toBe(created.cwd)
  expect(request.mock.calls.filter(([method]) => method === 'workspace/open').map(([, params]) => params))
    .toEqual([{ path: created.cwd }, { path: project.path }, { path: project.path }])
})

it('persists a folderless conversation under its host-created workspace, preserving the draft pane', async () => {
  const store = new AppStore('ws://localhost:0/')
  const created = chat()
  let preferences: Record<string, unknown> = { chatsFolderRoots: [] }
  const workspace = { path: created.cwd, name: 'first chat', lastOpenedAt: 1 }
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: { patch?: object }) => {
    if (method === 'runtime/sessionDefaults' || method === 'worktree/list') return []
    if (method === 'app/state/get') return preferences
    if (method === 'app/state/set') { preferences = { ...preferences, ...params.patch }; return preferences }
    if (method === 'workspace/open') return workspace
    if (method === 'session/create') return created
    return null
  }) as never)
  await store.loadPreferences()
  Object.assign(store.getSnapshot(), { activeRuntime: runtime })
  const pane = store.getSnapshot().layout.focused
  const key = await store.newSession()
  await vi.waitFor(() => expect(preferences['layouts']).toHaveProperty(created.cwd))
  expect(request).toHaveBeenCalledWith('workspace/open', { path: created.cwd })
  expect(store.getSnapshot().workspace).toEqual(workspace)
  expect(store.getSnapshot().layout.focused).toBe(pane)
  expect(preferences['layouts']).toEqual({ [created.cwd]: store.getSnapshot().workbench })
  expect(store.getSnapshot().activeSessionKey).toBe(key)
  store.newDraft()
  expect(store.getSnapshot().workspace).toBeNull()
  await vi.waitFor(() => expect(preferences['layouts']).toEqual({ [created.cwd]: expect.objectContaining({
    main: expect.objectContaining({ root: expect.objectContaining({ view: { kind: 'conversation', session: key } }) }),
  }) }))
})

it.each([
  ['/data/chats/2026-10-16-first', true], ['/data/chats/2026-10-16-first', false],
  ['/project', true], ['/project', false],
] as const)('restores the saved conversation and panels in %s (preferences first: %s)', async (cwd, preferencesFirst) => {
  const store = new AppStore('ws://localhost:0/')
  const session = chat(cwd)
  const key = sessionKey(runtime, session.id)
  const empty = emptyWorkbench()
  const saved = dock({ ...empty, main: only(empty.main, { kind: 'conversation', session: key }) }, 'right', { kind: 'changes' })
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'app/state/get') return { chatsFolderRoots: cwd.startsWith('/data/chats/') ? [cwd] : [], layouts: { [cwd]: saved } }
    if (method === 'workspace/recent') return [{ path: cwd, name: 'saved workspace', lastOpenedAt: 1 }]
    if (method === 'session/read' || method === 'session/resume') return session
    if (method === 'worktree/list') return []
    return null
  }) as never)
  if (preferencesFirst) { await store.loadPreferences(); await store.loadWorkspaces() }
  else { await store.loadWorkspaces(); await store.loadPreferences() }
  expect(store.getSnapshot().workspace?.path).toBe(cwd)
  expect(store.getSnapshot().activeSessionKey).toBe(key)
  expect(dockViews(store.getSnapshot().workbench.right)).toEqual(dockViews(saved.right))
  await vi.waitFor(() => expect(store.getSnapshot().sessions.get(key)?.itemsLoaded).toBe(true))
})

it.each([true, false])('a managed sender’s suggested task gets a fresh folder (sender open: %s)', async senderOpen => {
  const store = new AppStore('ws://localhost:0/')
  const sender = chat()
  Object.assign(store.getSnapshot(), {
    activeRuntime: runtimeId('other'), chatsFolderRoots: [sender.cwd],
    workspace: { path: senderOpen ? sender.cwd : '/project', name: 'open folder' },
    history: [sender],
    inbox: [{ id: 'task', title: 'Suggested task', tone: 'info', at: 1, read: false,
      task: 'Explain a retry budget', from: { runtime, sessionId: sender.id, name: 'Source chat' } }],
  })
  const created = { ...chat('/data/chats/2026-10-16-second'), id: sessionId('new-chat') }
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: { patch?: object }) => {
    if (method === 'runtime/sessionDefaults' || method === 'worktree/list') return []
    if (method === 'session/create') return created
    if (method === 'workspace/open') return { path: created.cwd, name: 'new chat', lastOpenedAt: 2 }
    if (method === 'app/state/set') return params.patch
    return {}
  }) as never)
  await store.startSuggestedTask('task')
  expect(request).toHaveBeenCalledWith('session/create', { runtime, options: {} })
  expect(request).toHaveBeenCalledWith('turn/send', { runtime, sessionId: created.id, input: [{ type: 'text', text: 'Explain a retry budget' }] })
  expect(store.getSnapshot().inbox[0]?.read).toBe(true)
})

it('starts an unknown-folder sender’s task in the open project', async () => {
  const store = new AppStore('ws://localhost:0/')
  const sender = chat('')
  Object.assign(store.getSnapshot(), { activeRuntime: runtime, workspace: { path: '/project', name: 'project' }, history: [sender],
    inbox: [{ id: 'task', task: 'Explain retries', from: { runtime, sessionId: sender.id, name: 'Source' } }] })
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) =>
    method === 'session/create' ? { ...chat('/project'), id: sessionId('new') } : []) as never)
  await store.startSuggestedTask('task')
  expect(request).toHaveBeenCalledWith('session/create', { runtime, options: { cwd: '/project' } })
})
