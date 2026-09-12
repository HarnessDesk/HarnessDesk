import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
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

/**
 * The two verbs that change a repository, and the read both of their dialogs
 * make first, answer to the boundary the rest of the git surface does: the
 * folders the window has open. A worktree lives in
 * the state directory, outside every workspace, so what is checked is its
 * repository — open as its main checkout, or as the worktree itself.
 */
test('a worktree is brought home or removed only from a repository the window has open', async () => {
  const quiet = { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }
  const repo = tempDir('hd-methods-repo-')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], quiet)
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], quiet)
  const tree = join(tempDir('hd-methods-state-'), 'wt')
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'wt', tree], quiet)
  const elsewhere = tempDir('hd-methods-elsewhere-')
  const asked: string[] = []
  const ctx = (roots: string[]): HostContext =>
    contextWith({
      workspaces: { openRoots: () => roots },
      registry: { snapshot: () => [] },
      worktrees: {
        bringHome: async (path: string) => {
          asked.push(`home ${path}`)
          return { branch: 'wt', from: 'main', root: repo }
        },
        remove: async (path: string) => {
          asked.push(`remove ${path}`)
          return { branch: 'wt' }
        },
        changes: async (path: string) => {
          asked.push(`changes ${path}`)
          return { modified: 0, untracked: 0, unpushedCommits: 0, files: [], ignored: [], ignoredCount: 0 }
        },
      },
    })

  await assert.rejects(dispatch(ctx([elsewhere]), 'worktree/bringHome', { path: tree }), /not a project opened here/)
  await assert.rejects(dispatch(ctx([elsewhere]), 'worktree/remove', { path: tree }), /not a project opened here/)
  await assert.rejects(dispatch(ctx([elsewhere]), 'worktree/changes', { path: tree }), /not a project opened here/)
  assert.deepEqual(asked, [], 'the service is not asked about a repository the window does not have open')

  const inside = join(repo, 'src')
  mkdirSync(inside)
  await dispatch(ctx([repo]), 'worktree/bringHome', { path: tree })
  await dispatch(ctx([tree]), 'worktree/remove', { path: tree })
  await dispatch(ctx([inside]), 'worktree/changes', { path: tree })
  assert.deepEqual(
    asked,
    [`home ${tree}`, `remove ${tree}`, `changes ${tree}`],
    'its main checkout open, a folder inside it, or the worktree itself, is its repository open',
  )
})

/** A repository inside an open folder is open, as it is to every other git read. */
test('a repository inside an open folder counts as open for the worktree verbs', async () => {
  const quiet = { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }
  const parent = tempDir('hd-methods-parent-')
  const app = join(parent, 'app')
  execFileSync('git', ['init', '-q', '-b', 'main', app], quiet)
  execFileSync('git', ['-C', app, 'commit', '-q', '--allow-empty', '-m', 'init'], quiet)
  const tree = join(tempDir('hd-methods-state-'), 'wt')
  execFileSync('git', ['-C', app, 'worktree', 'add', '-q', '-b', 'wt', tree], quiet)
  let asked = 0
  const ctx = contextWith({
    workspaces: { openRoots: () => [parent] },
    registry: { snapshot: () => [] },
    worktrees: {
      bringHome: async () => {
        asked += 1
        return { branch: 'wt', from: 'main', root: app }
      },
    },
  })

  await dispatch(ctx, 'worktree/bringHome', { path: tree })

  assert.equal(asked, 1)
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

/**
 * Every stored secret says what owns it, from both of the two places that
 * know.
 *
 * The credential store holds three unrelated kinds and one list shows them.
 * A key a *custom endpoint* refers to is removed here; a key an *agent* signs
 * in with is cleared from that agent's page, which also reloads the runtime's
 * secrets; a key a *gateway account* holds goes with the account. Settings
 * lists the first kind only, so anything that fails to name its owner is
 * offered for deletion as an orphan — which is exactly what happened to the
 * agent's key, and then, a round later, to the gateway account's.
 *
 * The two are found differently and that is the point: an agent's is recorded
 * on the entry when it is written, and a gateway account's is read from the
 * slot holding it, live, so no stored key has to be migrated for it to be
 * right.
 */
test('a credential names its owner — the agent that signs in with it, or the account that holds it', async () => {
  const ctx = contextWith({
    credentials: {
      describe: async () => [
        { ref: 'cred_route', name: 'Acme proxy key', createdAt: 1, agent: null },
        { ref: 'cred_agent', name: 'agent:codex:OPENAI_API_KEY', createdAt: 2, agent: 'codex' },
        // Named exactly like a route's, because that is how the host writes it.
        { ref: 'cred_gw', name: 'Acme gateway key', createdAt: 3, agent: null },
      ],
    },
    accounts: { gatewayCredentials: () => [{ ref: 'cred_gw', name: 'Acme gateway' }] },
  })

  const listed = await dispatch(ctx, 'credentials/list', {})
  const owner = (ref: string) => listed.find((one) => one.ref === ref)?.owner
  assert.equal(owner('cred_route'), null)
  assert.deepEqual(owner('cred_agent'), { kind: 'agent', of: 'codex' })
  assert.deepEqual(owner('cred_gw'), { kind: 'gateway', of: 'Acme gateway' })

  // And no value rides along with any of it.
  assert.equal(JSON.stringify(listed).includes('sk-'), false)
})

/**
 * The dialog holds the move while a conversation in the worktree is working,
 * but a turn can start between the dialog and the request. The host has the
 * facts — every live session and its state — so it holds the move as well.
 */
test('a worktree is not brought home while a conversation in it is working', async () => {
  const quiet = { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }
  const repo = tempDir('hd-methods-busy-')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], quiet)
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], quiet)
  const tree = join(tempDir('hd-methods-state-'), 'wt')
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'wt', tree], quiet)
  const working = { id: 's-1', runtime: 'fake', cwd: tree, status: { type: 'active' }, turns: [] }
  let asked = 0
  const ctx = (sessions: readonly unknown[]): HostContext =>
    contextWith({
      workspaces: { openRoots: () => [repo] },
      registry: { snapshot: () => sessions },
      worktrees: {
        bringHome: async () => {
          asked += 1
          return { branch: 'wt', from: 'main', root: repo }
        },
      },
    })

  await assert.rejects(dispatch(ctx([working]), 'worktree/bringHome', { path: tree }), /still working/)
  assert.equal(asked, 0, 'nothing is asked of git while the turn runs')

  await dispatch(ctx([{ ...working, status: { type: 'idle' } }]), 'worktree/bringHome', { path: tree })
  assert.equal(asked, 1, 'and it goes once the turn is over')
})
