import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { tempDir } from './scratch.js'

import { knownMethods, runtimeId, sessionId, type AgentRuntime } from '@harnessdesk/protocol'

import { dispatch, hostMethods, methodDomains, type HostContext } from '../src/methods/index.js'

/**
 * The method table is what turns "every wire method is answered" from a
 * habit into a property. The compiler holds the type-level half — a method
 * declared in `wire.ts` and not handled does not build. These hold the half
 * the compiler cannot see, and show what the seam buys: a handler exercised
 * against a hand-built context, with no host, socket or runtime behind it.
 */

test('every method the wire validates is answered, and none is answered twice', () => {
  const handled = new Set(Object.keys(hostMethods))
  assert.deepEqual([...handled].sort(), [...knownMethods].sort())
  const declaredAcrossDomains = methodDomains.reduce((sum, domain) => sum + Object.keys(domain).length, 0)
  assert.equal(declaredAcrossDomains, handled.size, 'a method appears in two domain modules')
})

test('a name that is not a method is refused, even one the prototype would answer', async () => {
  const ctx = {} as HostContext
  await assert.rejects(dispatch(ctx, 'constructor' as never, {} as never), /Unknown method "constructor"/)
  await assert.rejects(dispatch(ctx, 'git/statsu' as never, {} as never), /Unknown method/)
})

const fakeRuntime = (id: string, options: { processes?: boolean; ready?: boolean } = {}): AgentRuntime =>
  ({
    info: { id: runtimeId(id), presentation: { name: `Agent ${id}` } },
    health: () => ({ state: options.ready === false ? 'starting' : 'ready' }),
    ...(options.processes ? { processes: { tag: id } } : {}),
  }) as unknown as AgentRuntime

const contextWith = (overrides: object): HostContext => overrides as unknown as HostContext

test('a terminal for a runtime that runs no processes is hosted by one that does, and says so', async () => {
  const root = tempDir('hd-methods-')
  const acp = fakeRuntime('acp')
  const asleep = fakeRuntime('asleep', { processes: true, ready: false })
  const codex = fakeRuntime('codex', { processes: true })
  const opened: unknown[] = []
  const ctx = contextWith({
    runtimes: { resolve: () => acp, all: () => [acp, asleep, codex] },
    workspaces: { openRoots: () => [root] },
    terminals: {
      open: async (request: unknown) => {
        opened.push(request)
        return 'term-1'
      },
    },
  })
  const result = await dispatch(ctx, 'terminal/open', {
    runtime: acp.info.id,
    cwd: root,
    size: { cols: 80, rows: 24 },
    sessionId: sessionId('s1'),
  })
  assert.deepEqual(result, { terminalId: 'term-1', runtime: codex.info.id })
  // The sandbox that actually hosts the shell, not the one that was asked —
  // and no conversation is attached, because the shell is not its runtime's.
  assert.equal(opened.length, 1)
  const request = opened[0] as { runtime: string; processes: unknown; sessionId?: unknown }
  assert.equal(request.runtime, codex.info.id)
  assert.deepEqual(request.processes, { tag: 'codex' })
  assert.equal('sessionId' in request, false)
})

test('a terminal with nowhere to run is refused in the name of the runtime that was asked', async () => {
  const acp = fakeRuntime('acp')
  const ctx = contextWith({
    runtimes: { resolve: () => acp, all: () => [acp] },
    workspaces: { openRoots: () => [] },
  })
  await assert.rejects(
    dispatch(ctx, 'terminal/open', { runtime: acp.info.id, cwd: '/tmp', size: { cols: 80, rows: 24 } }),
    /Agent acp does not run commands for the interface/,
  )
})

test('a worktree is only created under an open workspace, and the service is not asked otherwise', async () => {
  const open = tempDir('hd-methods-open-')
  const elsewhere = tempDir('hd-methods-elsewhere-')
  let created = 0
  const ctx = contextWith({
    workspaces: { openRoots: () => [open] },
    worktrees: {
      create: async () => {
        created += 1
        return { path: join(open, 'wt'), branch: 'wt' }
      },
    },
  })
  await assert.rejects(dispatch(ctx, 'worktree/create', { root: elsewhere, name: 'wt' }))
  assert.equal(created, 0)
  await dispatch(ctx, 'worktree/create', { root: open, name: 'wt' })
  assert.equal(created, 1)
})

test('deleting a route forgets its credential only when no other route still refers to it', async () => {
  const routes = [
    { id: 'a', name: 'A', endpoint: 'https://a', wireProtocol: 'responses', credentialRef: 'cred-shared' },
    { id: 'b', name: 'B', endpoint: 'https://b', wireProtocol: 'responses', credentialRef: 'cred-shared' },
    { id: 'c', name: 'C', endpoint: 'https://c', wireProtocol: 'responses', credentialRef: 'cred-alone' },
  ]
  const deleted: string[] = []
  const stopped: string[] = []
  let stored: unknown = null
  const ctx = contextWith({
    routes: { list: () => routes },
    state: {
      setPreferences: async (patch: { modelRoutes: unknown }) => {
        stored = patch.modelRoutes
      },
    },
    gateways: { stop: (id: string) => stopped.push(id) },
    credentials: { delete: async (ref: string) => deleted.push(ref) },
  })
  await dispatch(ctx, 'routes/delete', { id: 'a' })
  assert.deepEqual(deleted, [], 'a credential another route uses is kept')
  assert.deepEqual(stopped, ['a'])
  assert.deepEqual((stored as { id: string }[]).map((route) => route.id), ['b', 'c'])

  await dispatch(ctx, 'routes/delete', { id: 'c' })
  assert.deepEqual(deleted, ['cred-alone'], 'an orphaned credential goes with its route')
})

test('a message on an idle conversation is sent; on a working one it is queued and announced', async () => {
  const sent: unknown[] = []
  const announced: unknown[] = []
  const queued: unknown[] = []
  // Busy is read off the last turn, the way the reducer reads it.
  const record = (busy: boolean) => ({
    session: {
      status: busy ? { type: 'running' } : { type: 'idle' },
      turns: busy ? [{ id: 't1', status: 'inProgress', items: [] }] : [],
    },
    queue: { messages: [] },
  })
  const make = (busy: boolean) =>
    contextWith({
      sessions: { record: () => record(busy) },
      registry: {
        enqueue: (_record: unknown, id: string, input: unknown) => {
          queued.push(input)
          return { id, input }
        },
      },
      queue: {
        nextId: () => 'q-1',
        push: (entry: unknown) => announced.push(entry),
        busy: (entry: { session: { status: { type: string } } }) => entry.session.status.type !== 'idle',
        sendNow: async (_entry: unknown, input: unknown) => {
          sent.push(input)
        },
      },
    })
  const input = [{ type: 'text', text: 'next' }] as const
  const address = { runtime: runtimeId('codex'), sessionId: sessionId('s1') }

  assert.deepEqual(await dispatch(make(false), 'turn/queue', { ...address, input }), { queuedId: null, sent: true })
  assert.equal(sent.length, 1)
  assert.equal(queued.length, 0)

  assert.deepEqual(await dispatch(make(true), 'turn/queue', { ...address, input }), { queuedId: 'q-1', sent: false })
  assert.equal(sent.length, 1, 'nothing more was sent')
  assert.equal(queued.length, 1)
  assert.equal(announced.length, 1)
})
