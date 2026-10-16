import { beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, type HostMethodName, type Session } from '@harnessdesk/protocol'

import { AppStore } from './store'
import { dockViews, terminals as terminalsIn } from './workbench'
import type { TransportEvents } from '../lib/transport'

const RUNTIME = runtimeId('codex')
const ID = sessionId('terminal-folder')
const PROJECT = '/repo'
const WORKTREE = '/repo/.harnessdesk/worktrees/feature'
const conversation = (): Session => ({
  id: ID,
  runtime: RUNTIME,
  cwd: WORKTREE,
  status: { type: 'idle' },
  createdAt: 0,
  updatedAt: 0,
  turns: [],
  itemsLoaded: true,
}) as Session

let store: AppStore

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'runtime/sessionDefaults') return []
    if (method === 'workspace/open') return { path: PROJECT, name: 'repo', lastOpenedAt: 1 }
    if (method === 'session/read' || method === 'session/resume') return conversation()
    if (method === 'terminal/open') return { terminalId: 'fixture-pty', runtime: RUNTIME }
    if (method === 'workspace/recent') return []
    return null
  }) as never)
})

it('opens a conversation terminal in that conversation’s worktree', async () => {
  await store.selectRuntime(RUNTIME)
  await store.openWorkspace(PROJECT)
  await store.openSession(ID, { runtime: RUNTIME })
  store.setWindowSize(1280, 800)

  await store.openTerminal()

  expect(store.transport.request).toHaveBeenCalledWith('terminal/open', expect.objectContaining({ cwd: WORKTREE, sessionId: ID }))
  const subject = store.workSubject()!
  expect(store.getSnapshot().workbench.frameTools[subject]).toMatchObject({ tool: 'terminal', open: true })
  store.chooseWorkTool('terminal', 'terminal', true)
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(false)
  expect(terminalsIn(store.getSnapshot().workbench)).toHaveLength(1)
  store.chooseWorkTool('terminal', 'terminal', true)
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(true)
  expect(vi.mocked(store.transport.request).mock.calls.filter(([method]) => method === 'terminal/open')).toHaveLength(1)
  store.closeTerminal('fixture-pty')
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(false)
})

it('new default terminals use the chosen project without the retained conversation context on pages', async () => {
  await store.selectRuntime(RUNTIME)
  await store.openWorkspace(PROJECT)
  await store.openSession(ID, { runtime: RUNTIME })
  store.setWindowSize(1280, 800)
  store.openDestination({ kind: 'settings', route: { kind: 'section', section: 'general', focus: null } })
  await store.openTerminal()
  expect(store.transport.request).toHaveBeenCalledWith('terminal/open', expect.objectContaining({ cwd: PROJECT }))
  const opened = vi.mocked(store.transport.request).mock.calls.find(([method]) => method === 'terminal/open')!
  expect(opened[1]).not.toHaveProperty('sessionId')
  await store.openTerminal({ cwd: '/synthetic/retained-shell' })
  expect(store.transport.request).toHaveBeenCalledWith('terminal/open', expect.objectContaining({ cwd: '/synthetic/retained-shell' }))
})

it('keeps a late terminal with the subject that opened it', async () => {
  await store.selectRuntime(RUNTIME)
  await store.openWorkspace(PROJECT)
  await store.openSession(ID, { runtime: RUNTIME })
  const owner = store.workSubject()!
  let finish!: (value: unknown) => void
  vi.mocked(store.transport.request).mockImplementation((async (method: HostMethodName) => method === 'terminal/open'
    ? new Promise(resolve => { finish = resolve }) : null) as never)
  const opening = store.openTerminal()
  store.openDefaultView({ kind: 'room', room: 'another-team' })
  const other = store.workSubject()!
  finish({ terminalId: 'late-pty', runtime: RUNTIME })
  await opening
  const workbench = store.getSnapshot().workbench
  const held = workbench.bottom.root.kind === 'stack' ? workbench.bottom.root.views[0]! : null
  expect(held).not.toBeNull()
  expect(workbench.toolOwners[held!.id]).toBe(owner)
  expect(workbench.frameTools[other]).toBeUndefined()
})

it('closing a terminal door during allocation retains the late process without reopening or duplicating it', async () => {
  await store.selectRuntime(RUNTIME)
  await store.openWorkspace(PROJECT)
  await store.openSession(ID, { runtime: RUNTIME })
  let finish!: (value: unknown) => void
  const request = vi.mocked(store.transport.request)
  request.mockImplementation((async (method: HostMethodName) => method === 'terminal/open'
    ? new Promise(resolve => { finish = resolve }) : null) as never)
  store.chooseWorkTool('terminal', 'terminal', true)
  store.chooseWorkTool('terminal', 'terminal', true)
  expect(request.mock.calls.filter(([method]) => method === 'terminal/open')).toHaveLength(1)
  finish({ terminalId: 'pending-pty', runtime: RUNTIME })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(store.getSnapshot().workbench.frameTools[store.workSubject()!]?.open).toBe(false)
  expect(terminalsIn(store.getSnapshot().workbench)).toHaveLength(1)
})

it('a pending draft terminal follows that same pane when it becomes a session', async () => {
  await store.selectRuntime(RUNTIME)
  await store.openWorkspace(PROJECT)
  const draft = store.workSubject()!, paneId = store.getSnapshot().layout.focused
  let finish!: (value: unknown) => void
  const previous = vi.mocked(store.transport.request).getMockImplementation()!
  vi.mocked(store.transport.request).mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'terminal/open') return new Promise(resolve => { finish = resolve })
    if (method === 'session/create') return { ...conversation(), cwd: PROJECT }
    return previous(method, params as never)
  }) as never)
  store.chooseWorkTool('terminal', 'terminal', true)
  const key = await store.newSession()
  expect(key).not.toBeNull()
  const subject = store.workSubject()!
  expect(subject).not.toBe(draft)
  expect(store.getSnapshot().layout.focused).toBe(paneId)
  finish({ terminalId: 'promoted-pty', runtime: RUNTIME })
  await new Promise(resolve => setTimeout(resolve, 0))
  const workbench = store.getSnapshot().workbench
  const held = workbench.bottom.root.kind === 'stack' ? workbench.bottom.root.views[0]! : null
  expect(workbench.toolOwners[held!.id]).toBe(subject)
  expect(workbench.frameTools[draft]).toBeUndefined()
  store.chooseWorkTool('terminal', 'terminal', true)
  store.chooseWorkTool('terminal', 'terminal', true)
  expect(vi.mocked(store.transport.request).mock.calls.filter(([method]) => method === 'terminal/open')).toHaveLength(1)
})

it('a promoted request cannot clear a newer pending door after its draft subject is reused', async () => {
  await store.selectRuntime(RUNTIME)
  await store.openWorkspace(PROJECT)
  const draft = store.workSubject()!
  const pending: ((value: unknown) => void)[] = []
  const previous = vi.mocked(store.transport.request).getMockImplementation()!
  vi.mocked(store.transport.request).mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'terminal/open') return new Promise(resolve => pending.push(resolve))
    if (method === 'session/create') return { ...conversation(), cwd: PROJECT }
    return previous(method, params as never)
  }) as never)
  store.chooseWorkTool('terminal', 'terminal', true)
  await store.newSession()
  const promoted = store.workSubject()!
  store.newDraft()
  expect(store.workSubject()).toBe(draft)
  store.chooseWorkTool('terminal', 'terminal', true)
  expect(pending).toHaveLength(2)
  pending[0]!({ terminalId: 'first-promoted-pty', runtime: RUNTIME })
  await new Promise(resolve => setTimeout(resolve, 0))
  store.chooseWorkTool('terminal', 'terminal', true)
  store.chooseWorkTool('terminal', 'terminal', true)
  expect(pending).toHaveLength(2)
  pending[1]!({ terminalId: 'new-draft-pty', runtime: RUNTIME })
  await new Promise(resolve => setTimeout(resolve, 0))
  const workbench = store.getSnapshot().workbench
  const entries = workbench.bottom.root.kind === 'stack' ? workbench.bottom.root.views : []
  expect(entries.map(entry => workbench.toolOwners[entry.id])).toEqual([promoted, draft])
})

it('an early refused allocation releases its own pending-door guard', async () => {
  await store.selectRuntime(RUNTIME)
  await store.openWorkspace(PROJECT)
  store.setWindowSize(1200, 100)
  store.chooseWorkTool('terminal', 'terminal', true)
  await new Promise(resolve => setTimeout(resolve, 0))
  store.setWindowSize(1200, 900)
  store.chooseWorkTool('terminal', 'terminal', true)
  store.chooseWorkTool('terminal', 'terminal', true)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(terminalsIn(store.getSnapshot().workbench)).toHaveLength(1)
})

it.each(['settings', 'changes-review'] as const)('admits the selected %s folder before opening its terminal without switching workspaces', async kind => {
  const admitted = new Set([WORKTREE])
  const request = vi.mocked(store.transport.request)
  request.mockImplementation((async (method: HostMethodName, params: { path?: string; cwd?: string }) => {
    if (method === 'workspace/open') {
      admitted.add(params.path!)
      return { path: params.path, name: 'repo', lastOpenedAt: 1 }
    }
    if (method === 'terminal/open') {
      if (!admitted.has(params.cwd!)) throw new Error('outside every open workspace')
      return { terminalId: 'project-pty', runtime: RUNTIME }
    }
    return null
  }) as never)
  await store.selectRuntime(RUNTIME)
  await store.openWorkspace(WORKTREE)
  store.setWindowSize(1280, 800)
  store.openDestination(kind === 'settings'
    ? { kind, route: { kind: 'project', root: PROJECT } }
    : { kind, root: PROJECT, returnTo: { kind: 'conversation', session: null } })
  const before = store.getSnapshot()
  request.mockClear()

  await store.openTerminal()

  expect(terminalsIn(store.getSnapshot().workbench)).toEqual([expect.objectContaining({ cwd: PROJECT, terminalId: 'project-pty' })])
  expect(store.getSnapshot().workspace).toBe(before.workspace)
  expect(store.getSnapshot().workbench.navigation).toBe(before.workbench.navigation)
  expect(request.mock.calls.filter(([method]) => method === 'workspace/open').map(([, params]) => params)).toEqual([{ path: PROJECT }, { path: WORKTREE }])
  expect(request).toHaveBeenCalledWith('terminal/open', expect.not.objectContaining({ sessionId: expect.anything() }))
})

it('does not allocate a terminal if admitting the selected folder fails', async () => {
  await store.selectRuntime(RUNTIME)
  await store.openWorkspace(WORKTREE)
  store.setWindowSize(1280, 800)
  store.openDestination({ kind: 'settings', route: { kind: 'project', root: '/synthetic/missing' } })
  const request = vi.mocked(store.transport.request)
  request.mockClear()
  request.mockImplementation((async (method: HostMethodName, params: { path?: string }) => {
    if (method === 'workspace/open' && params.path === '/synthetic/missing') throw new Error('Folder is missing')
    return null
  }) as never)

  await store.openTerminal()

  expect(request.mock.calls.some(([method]) => method === 'terminal/open')).toBe(false)
  expect(store.getSnapshot().notices.at(-1)?.message).toBe('Folder is missing')
})

it('closing the dock during folder admission prevents a late terminal allocation', async () => {
  await store.selectRuntime(RUNTIME)
  await store.openWorkspace(PROJECT)
  store.setWindowSize(1280, 800)
  const selected = '/synthetic/selected'
  store.openDestination({ kind: 'settings', route: { kind: 'project', root: selected } })
  let admit!: (value: unknown) => void
  const request = vi.mocked(store.transport.request)
  request.mockClear()
  request.mockImplementation((async (method: HostMethodName, params: { path?: string }) => {
    if (method === 'workspace/open' && params.path === selected) return new Promise(resolve => { admit = resolve })
    return null
  }) as never)

  const opening = store.openTerminal()
  store.closeTerminalDock()
  expect(admit).toBeTypeOf('function')
  admit({ path: selected, name: 'selected', lastOpenedAt: 1 })
  await opening

  expect(request.mock.calls.some(([method]) => method === 'terminal/open')).toBe(false)
})


it('closing one subject terminal preserves other subjects and fences only its pending New shell', async () => {
  await store.selectRuntime(RUNTIME)
  await store.openWorkspace(PROJECT)
  await store.openSession(ID, { runtime: RUNTIME })
  const request = vi.mocked(store.transport.request), previous = request.getMockImplementation()!
  let serial = 0
  const pending = new Map<string, (value: unknown) => void>()
  request.mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'terminal/open') {
      const id = `scoped-pty-${++serial}`
      if (serial > 2) return new Promise(resolve => pending.set(id, resolve))
      return { terminalId: id, runtime: RUNTIME }
    }
    return previous(method, params as never)
  }) as never)
  const subjectA = store.workSubject()!
  await store.openTerminal()
  store.openDefaultView({ kind: 'room', room: 'terminal-b' })
  const subjectB = store.workSubject()!
  await store.openTerminal()
  const openingB = store.openTerminal()
  await store.openSession(ID, { runtime: RUNTIME })
  const openingA = store.openTerminal()
  store.openDefaultView({ kind: 'room', room: 'terminal-b' })
  store.closeTerminalDock(subjectB)
  expect(terminalsIn(store.getSnapshot().workbench).map(one => one.terminalId)).toEqual(['scoped-pty-1'])
  pending.get('scoped-pty-3')!({ terminalId: 'scoped-pty-3', runtime: RUNTIME })
  pending.get('scoped-pty-4')!({ terminalId: 'scoped-pty-4', runtime: RUNTIME })
  await Promise.all([openingB, openingA])
  const workbench = store.getSnapshot().workbench
  expect(terminalsIn(workbench).map(one => one.terminalId)).toEqual(['scoped-pty-1', 'scoped-pty-4'])
  expect(workbench.frameTools[subjectA]).toMatchObject({ tool: 'terminal', open: true })
  expect(workbench.frameTools[subjectB]).toMatchObject({ tool: 'terminal', open: false })
  expect(request.mock.calls.filter(([method]) => method === 'terminal/close').map(([, params]) => params))
    .toEqual([{ terminalId: 'scoped-pty-2' }, { terminalId: 'scoped-pty-3' }])
})

it.each(['direct', 'door', 'promoted door'] as const)('session removal fences a pending %s terminal without reviving its owner', async mode => {
  await store.selectRuntime(RUNTIME)
  await store.openWorkspace(PROJECT)
  if (mode !== 'promoted door') await store.openSession(ID, { runtime: RUNTIME })
  store.showViewIn('right', { kind: 'file', path: '/repo/retained.md', runtime: RUNTIME })
  const file = dockViews(store.getSnapshot().workbench.right)[0]!
  let finish!: (value: unknown) => void
  const request = vi.mocked(store.transport.request), previous = request.getMockImplementation()!
  request.mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'terminal/open') return new Promise(resolve => { finish = resolve })
    if (method === 'session/create') return { ...conversation(), cwd: PROJECT }
    return previous(method, params as never)
  }) as never)
  const opening = mode === 'direct' ? store.openTerminal() : (store.chooseWorkTool('terminal', 'terminal', true), Promise.resolve())
  if (mode === 'promoted door') await store.newSession()
  const subject = store.workSubject()!
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onNotification({ method: 'session/removed', params: { runtime: RUNTIME, sessionId: ID, deleted: true } })
  expect(store.getSnapshot().workbench.frameSubjects[subject]).toBeUndefined()
  finish({ terminalId: 'removed-late-pty', runtime: RUNTIME })
  await opening
  await new Promise(resolve => setTimeout(resolve, 0))
  const workbench = store.getSnapshot().workbench
  expect(workbench.frameSubjects[subject]).toBeUndefined()
  expect(workbench.frameTools[subject]).toBeUndefined()
  expect(terminalsIn(workbench)).toEqual([])
  expect(dockViews(workbench.right)).toContainEqual(file)
  expect(workbench.toolOwners[file.id]).toBe(subject)
  expect(request).toHaveBeenCalledWith('terminal/close', { terminalId: 'removed-late-pty' })
  request.mockClear()
  store.revealView(file.id)
  expect(store.getSnapshot().workbench).toBe(workbench)
  expect(request.mock.calls.some(([method]) => method === 'session/read' || method === 'session/resume')).toBe(false)
})


it('a global close releases pending door guards so a fresh request can open immediately', async () => {
  await store.selectRuntime(RUNTIME)
  await store.openWorkspace(PROJECT)
  const pending: ((value: unknown) => void)[] = []
  const request = vi.mocked(store.transport.request), previous = request.getMockImplementation()!
  request.mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'terminal/open') return new Promise(resolve => pending.push(resolve))
    return previous(method, params as never)
  }) as never)
  store.chooseWorkTool('terminal', 'terminal', true)
  store.closeTerminalDock()
  store.chooseWorkTool('terminal', 'terminal', true)
  expect(pending).toHaveLength(2)
  pending[0]!({ terminalId: 'globally-closed-pty', runtime: RUNTIME })
  await new Promise(resolve => setTimeout(resolve, 0))
  store.chooseWorkTool('terminal', 'terminal', true)
  store.chooseWorkTool('terminal', 'terminal', true)
  expect(pending).toHaveLength(2)
  pending[1]!({ terminalId: 'fresh-pty', runtime: RUNTIME })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(terminalsIn(store.getSnapshot().workbench).map(one => one.terminalId)).toEqual(['fresh-pty'])
  expect(request).toHaveBeenCalledWith('terminal/close', { terminalId: 'globally-closed-pty' })
})
