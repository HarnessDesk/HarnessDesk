import { beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, type HostMethodName, type Session } from '@harnessdesk/protocol'

import { AppStore } from './store'
import { terminals as terminalsIn } from './workbench'

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
