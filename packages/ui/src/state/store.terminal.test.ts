import { beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, type HostMethodName, type Session } from '@harnessdesk/protocol'

import { AppStore } from './store'

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

it('new default terminals do not borrow the retained conversation scope on pages', async () => {
  await store.selectRuntime(RUNTIME)
  await store.openWorkspace(PROJECT)
  await store.openSession(ID, { runtime: RUNTIME })
  store.setWindowSize(1280, 800)
  store.openDestination({ kind: 'settings', route: { kind: 'section', section: 'general', focus: null } })
  await store.openTerminal()
  expect(store.transport.request).not.toHaveBeenCalledWith('terminal/open', expect.anything())
  await store.openTerminal({ cwd: '/synthetic/retained-shell' })
  expect(store.transport.request).toHaveBeenCalledWith('terminal/open', expect.objectContaining({ cwd: '/synthetic/retained-shell' }))
})
