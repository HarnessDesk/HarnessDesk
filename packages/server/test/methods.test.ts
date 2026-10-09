import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { tempDir } from './scratch.js'

import { knownMethods, runtimeId, sessionId, type AgentRuntime, type RuntimeHealth } from '@harnessdesk/protocol'

import { dispatch, hostMethods, methodDomains, type HostContext } from '../src/methods/index.js'
import * as terminalModule from '../src/methods/terminals.js'

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

test('transcript search carries the viewer’s tool-output choice to its store', async () => {
  const calls: unknown[] = []
  const ctx = { transcripts: { search: async (...args: unknown[]) => { calls.push(args); return [] } } } as unknown as HostContext
  await dispatch(ctx, 'transcripts/search', { query: 'words', includeTools: true } as never)
  assert.deepEqual(calls, [['words', { includeTools: true }]])
})

test('a name that is not a method is refused, even one the prototype would answer', async () => {
  const ctx = {} as HostContext
  await assert.rejects(dispatch(ctx, 'constructor' as never, {} as never), /Unknown method "constructor"/)
  await assert.rejects(dispatch(ctx, 'git/statsu' as never, {} as never), /Unknown method/)
})

test('opening in a folder without runtime board tools sends a session-linked notice', async () => {
  const root = tempDir('hd-untrusted-open-')
  const pushed: unknown[] = []
  const indexed: unknown[] = []
  const session = { id: sessionId('s1'), runtime: runtimeId('gemini'), cwd: root }
  const runtime = {
    info: {
      id: runtimeId('gemini'),
      capabilities: { pluginTools: true },
      presentation: { name: 'Gemini CLI', pluginToolsUnavailable: 'Open Gemini here, run /permissions trust, and start again.' },
    },
    pluginToolsAvailableAt: async () => false,
    pluginToolsProblemAt: async () => "Gemini can't read its trusted-folders file, so it can't use board tools. Fix that file and start again.",
    createSession: async () => ({ id: session.id }),
    resumeSession: async (id: string) => ({ id, settings: () => ({}), options: () => ({ cwd: root }) }),
  } as unknown as AgentRuntime
  const ctx = contextWith({
    sessionIndex: { record: (session: unknown) => indexed.push(session) },
    runtimes: { resolve: () => runtime, ensureStarted: async () => {} },
    laneEnvironment: { forCheckout: () => undefined, forSession: async () => undefined },
    sessions: {
      attach: async () => session,
      read: async (_runtime: unknown, id: string) => ({ ...session, id, cwd: id === 's2' ? join(root, 'resumed') : root }),
    },
    registry: {
      get: () => null,
      upsert: (opened: unknown) => ({ session: opened }),
    },
    attachments: { carriesFilter: async () => false },
    evidence: { seats: { latestOf: () => null, latestKeptOf: () => null } },
    routes: { resolve: async () => null },
    push: (notification: unknown) => pushed.push(notification),
  })
  const opened = await dispatch(ctx, 'session/create', { runtime: runtime.info.id, options: { cwd: root } })
  assert.equal(opened, session)
  assert.equal(pushed.length, 1)
  assert.deepEqual(pushed[0], {
    method: 'person/notice',
    params: { notice: {
      id: (pushed[0] as { params: { notice: { id: string } } }).params.notice.id,
      where: 'inbox',
      title: 'Board tools are unavailable in this folder',
      body: "Gemini can't read its trusted-folders file, so it can't use board tools. Fix that file and start again.",
      from: { runtime: 'gemini', sessionId: 's1', name: 'Gemini CLI' },
      at: (pushed[0] as { params: { notice: { at: number } } }).params.notice.at,
    } },
  })
  await dispatch(ctx, 'session/resume', { runtime: runtime.info.id, sessionId: sessionId('s1') })
  assert.equal(pushed.length, 1, 'resuming the same folder does not repeat the notice')
  await dispatch(ctx, 'session/resume', { runtime: runtime.info.id, sessionId: sessionId('s2') })
  assert.equal(pushed.length, 2, 'a resumed session in a different folder gets its own notice')
  await dispatch(ctx, 'session/resume', { runtime: runtime.info.id, sessionId: sessionId('s3') })
  assert.equal(pushed.length, 2, 'the resumed folder is also deduplicated')
  assert.deepEqual(indexed.map(session => (session as { id: string }).id), ['s1', 's2', 's3'])
})

const fakeRuntime = (id: string, options: { processes?: boolean; ready?: boolean; health?: RuntimeHealth; signedOut?: boolean; noSignIn?: boolean } = {}): AgentRuntime =>
  ({
    info: { id: runtimeId(id), presentation: { name: `Agent ${id}` } },
    health: () => options.health ?? ({ state: options.ready === false ? 'starting' : 'ready' }),
    getAccount: async () => ({
      accounts: options.signedOut ? [] : [{ kind: 'apiKey', label: 'Demo account' }],
      signInMethods: options.noSignIn ? [] : [{ id: 'demo', label: 'Sign in', flow: 'external' }],
    }),
    ...(options.processes ? { processes: { tag: id } } : {}),
  }) as unknown as AgentRuntime

const contextWith = (overrides: object): HostContext => ({ logger: { warn: () => {} }, ...overrides }) as unknown as HostContext

test('client methods belong only to the client door', async () => {
  for (const method of ['client/hello', 'client/subscribe']) {
    await assert.rejects(dispatch(contextWith({}), method as never, {} as never), { wireCode: 'clientDoorOnly' })
  }
})

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

test('terminal provider selection prefers ready providers over starting and idle providers', async () => {
  const root = tempDir('hd-terminal-provider-')
  const requested = fakeRuntime('conversation')
  const starting = fakeRuntime('starting', { processes: true, health: { state: 'starting' } })
  const idle = fakeRuntime('idle', { processes: true, health: { state: 'idle' } })
  starting.getAccount = async () => { throw new Error('must not read a starting provider account') }
  idle.getAccount = async () => { throw new Error('must not read an idle provider account') }
  const ready = fakeRuntime('ready', { processes: true })
  const ctx = contextWith({
    runtimes: { resolve: () => requested, all: () => [requested, starting, idle, ready] },
    workspaces: { openRoots: () => [root] },
    terminals: { open: async () => 'term-1' },
  })
  assert.deepEqual(await dispatch(ctx, 'terminal/open', {
    runtime: requested.info.id, cwd: root, size: { cols: 80, rows: 24 },
  }), { terminalId: 'term-1', runtime: ready.info.id })
})

test('terminal provider selection prefers a starting provider over an idle one', async () => {
  const root = tempDir('hd-terminal-provider-')
  const requested = fakeRuntime('conversation')
  const starting = fakeRuntime('starting', { processes: true, health: { state: 'starting' } })
  const idle = fakeRuntime('idle', { processes: true, health: { state: 'idle' } })
  starting.getAccount = async () => { throw new Error('must not read a starting provider account') }
  idle.getAccount = async () => { throw new Error('must not read an idle provider account') }
  const ctx = contextWith({
    runtimes: { resolve: () => requested, all: () => [requested, idle, starting] },
    workspaces: { openRoots: () => [root] },
    terminals: { open: async () => 'term-1' },
  })
  assert.deepEqual(await dispatch(ctx, 'terminal/open', {
    runtime: requested.info.id, cwd: root, size: { cols: 80, rows: 24 },
  }), { terminalId: 'term-1', runtime: starting.info.id })
})

test('a terminal prefers a signed-in or sign-in-free ready provider over a signed-out one', async () => {
  const root = tempDir('hd-terminal-provider-')
  const requested = fakeRuntime('conversation')
  const signedOut = fakeRuntime('signed-out', { processes: true, signedOut: true })
  const local = fakeRuntime('local', { processes: true, noSignIn: true })
  const ctx = contextWith({
    runtimes: { resolve: () => requested, all: () => [requested, signedOut, local] },
    workspaces: { openRoots: () => [root] },
    terminals: { open: async () => 'term-1' },
  })
  assert.deepEqual(await dispatch(ctx, 'terminal/open', {
    runtime: requested.info.id, cwd: root, size: { cols: 80, rows: 24 },
  }), { terminalId: 'term-1', runtime: local.info.id })
})

test('the first of two signed-out ready providers hosts a terminal', async () => {
  const root = tempDir('hd-terminal-provider-')
  const requested = fakeRuntime('conversation')
  const first = fakeRuntime('first-signed-out', { processes: true, signedOut: true })
  const second = fakeRuntime('second-signed-out', { processes: true, signedOut: true })
  const ctx = contextWith({
    runtimes: { resolve: () => requested, all: () => [requested, first, second] },
    workspaces: { openRoots: () => [root] },
    terminals: { open: async () => 'term-1' },
  })
  assert.deepEqual(await dispatch(ctx, 'terminal/open', {
    runtime: requested.info.id, cwd: root, size: { cols: 80, rows: 24 },
  }), { terminalId: 'term-1', runtime: first.info.id })
})

test('a provider with no account and no sign-in method ranks ahead of signed-out', async () => {
  const root = tempDir('hd-terminal-provider-')
  const requested = fakeRuntime('conversation')
  const signedOut = fakeRuntime('signed-out', { processes: true, signedOut: true })
  const signInFree = fakeRuntime('sign-in-free', { processes: true, signedOut: true, noSignIn: true })
  const ctx = contextWith({
    runtimes: { resolve: () => requested, all: () => [requested, signedOut, signInFree] },
    workspaces: { openRoots: () => [root] },
    terminals: { open: async () => 'term-1' },
  })
  assert.deepEqual(await dispatch(ctx, 'terminal/open', {
    runtime: requested.info.id, cwd: root, size: { cols: 80, rows: 24 },
  }), { terminalId: 'term-1', runtime: signInFree.info.id })
})

test('starting and idle provider tiers choose their first candidate without account reads', async () => {
  const root = tempDir('hd-terminal-provider-')
  const requested = fakeRuntime('conversation')
  for (const state of ['starting', 'idle'] as const) {
    const first = fakeRuntime(`first-${state}`, { processes: true, health: { state } })
    const second = fakeRuntime(`second-${state}`, { processes: true, health: { state } })
    let accountReads = 0
    first.getAccount = second.getAccount = async () => {
      accountReads += 1
      throw new Error(`must not read a ${state} provider account`)
    }
    const ctx = contextWith({
      runtimes: { resolve: () => requested, all: () => [requested, first, second] },
      workspaces: { openRoots: () => [root] },
      terminals: { open: async () => `term-${state}` },
    })
    assert.deepEqual(await dispatch(ctx, 'terminal/open', {
      runtime: requested.info.id, cwd: root, size: { cols: 80, rows: 24 },
    }), { terminalId: `term-${state}`, runtime: first.info.id })
    assert.equal(accountReads, 0, `no ${state} provider account is read`)
  }
})

test('a terminal accepts a lone signed-out ready provider without reading its account', async () => {
  const root = tempDir('hd-terminal-provider-')
  const requested = fakeRuntime('conversation')
  const signedOut = fakeRuntime('signed-out', { processes: true, signedOut: true })
  let accountReads = 0
  signedOut.getAccount = async () => { accountReads += 1; throw new Error('account unavailable') }
  const ctx = contextWith({
    runtimes: { resolve: () => requested, all: () => [requested, signedOut] },
    workspaces: { openRoots: () => [root] },
    terminals: { open: async () => 'term-1' },
  })
  assert.deepEqual(await dispatch(ctx, 'terminal/open', {
    runtime: requested.info.id, cwd: root, size: { cols: 80, rows: 24 },
  }), { terminalId: 'term-1', runtime: signedOut.info.id })
  assert.equal(accountReads, 0)
})

test('a failed account read ranks that ready provider as signed out and uses the next one', async () => {
  const root = tempDir('hd-terminal-provider-')
  const requested = fakeRuntime('conversation')
  const failedRead = fakeRuntime('failed-account', { processes: true })
  const next = fakeRuntime('next-ready', { processes: true })
  failedRead.getAccount = async () => { throw new Error('account endpoint refused the read') }
  const ctx = contextWith({
    runtimes: { resolve: () => requested, all: () => [requested, failedRead, next] },
    workspaces: { openRoots: () => [root] },
    terminals: { open: async () => 'term-1' },
  })
  assert.deepEqual(await dispatch(ctx, 'terminal/open', {
    runtime: requested.info.id, cwd: root, size: { cols: 80, rows: 24 },
  }), { terminalId: 'term-1', runtime: next.info.id })
})

test('a signed-in first provider opens without waiting for a later silent provider', async () => {
  const root = tempDir('hd-terminal-provider-')
  const requested = fakeRuntime('conversation')
  const first = fakeRuntime('first-ready', { processes: true })
  const silent = fakeRuntime('silent-ready', { processes: true })
  let silentReads = 0
  first.getAccount = async () => ({ accounts: [{ kind: 'apiKey', label: 'Demo account' }], signInMethods: [] })
  silent.getAccount = () => {
    silentReads += 1
    return new Promise(() => {})
  }
  const ctx = contextWith({
    runtimes: { resolve: () => requested, all: () => [requested, first, silent] },
    workspaces: { openRoots: () => [root] },
    terminals: { open: async () => 'term-1' },
  })
  const opening = dispatch(ctx, 'terminal/open', {
    runtime: requested.info.id, cwd: root, size: { cols: 80, rows: 24 },
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(silentReads, 0)
  assert.deepEqual(await opening, { terminalId: 'term-1', runtime: first.info.id })
})

test('terminal account reads expose the two-second production deadline', () => {
  assert.equal(Reflect.get(terminalModule, 'TERMINAL_ACCOUNT_READ_DEADLINE_MS'), 2_000)
})

for (const answer of [undefined, null, { signInMethods: [] }, { accounts: [] }]) {
  test(`a malformed provider answer ${JSON.stringify(answer)} does not stop a terminal`, async () => {
    const root = tempDir('hd-terminal-provider-')
    const requested = fakeRuntime('conversation')
    const malformed = fakeRuntime('malformed', { processes: true })
    const next = fakeRuntime('next-ready', { processes: true })
    malformed.getAccount = async () => answer as never
    const warnings: unknown[] = []
    const ctx = contextWith({
      runtimes: { resolve: () => requested, all: () => [requested, malformed, next] },
      workspaces: { openRoots: () => [root] },
      terminals: { open: async () => 'term-1' },
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
    })
    assert.deepEqual(await dispatch(ctx, 'terminal/open', {
      runtime: requested.info.id, cwd: root, size: { cols: 80, rows: 24 },
    }), { terminalId: 'term-1', runtime: next.info.id })
    assert.equal(warnings.length, 1)
    assert.match(JSON.stringify(warnings), /malformed/)
  })
}

test('an answered signed-out provider ranks ahead of a failed account read', async () => {
  const root = tempDir('hd-terminal-provider-')
  const requested = fakeRuntime('conversation')
  const failed = fakeRuntime('failed-account', { processes: true })
  const signedOut = fakeRuntime('signed-out', { processes: true, signedOut: true })
  failed.getAccount = async () => { throw new Error('fixture account failure') }
  const warnings: unknown[] = []
  const ctx = contextWith({
    runtimes: { resolve: () => requested, all: () => [requested, failed, signedOut] },
    workspaces: { openRoots: () => [root] },
    terminals: { open: async () => 'term-1' },
    logger: { warn: (...args: unknown[]) => warnings.push(args) },
  })
  assert.deepEqual(await dispatch(ctx, 'terminal/open', {
    runtime: requested.info.id, cwd: root, size: { cols: 80, rows: 24 },
  }), { terminalId: 'term-1', runtime: signedOut.info.id })
  assert.equal(warnings.length, 1)
  assert.match(JSON.stringify(warnings), /failed-account/)
  assert.match(JSON.stringify(warnings), /fixture account failure/)
  assert.deepEqual((warnings[0] as [string, object])[1], {
    runtime: failed.info.id,
    error: 'Error: fixture account failure',
  })
})

for (const signedOut of [false, true]) {
  test(`a late ready provider loses to an answered ${signedOut ? 'signed-out' : 'signed-in'} provider`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const root = tempDir('hd-terminal-provider-')
    const requested = fakeRuntime('conversation')
    const silent = fakeRuntime('silent-ready', { processes: true })
    const answered = fakeRuntime('answered-ready', { processes: true, signedOut })
    let answeredReads = 0
    let answerLate!: (answer: Awaited<ReturnType<AgentRuntime['getAccount']>>) => void
    silent.getAccount = () => new Promise(resolve => { answerLate = resolve })
    const account = answered.getAccount.bind(answered)
    answered.getAccount = async () => {
      answeredReads += 1
      return account()
    }
    const warnings: unknown[] = []
    const ctx = contextWith({
      runtimes: { resolve: () => requested, all: () => [requested, silent, answered] },
      workspaces: { openRoots: () => [root] },
      terminals: { open: async () => 'term-1' },
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
    })
    const opening = dispatch(ctx, 'terminal/open', {
      runtime: requested.info.id, cwd: root, size: { cols: 80, rows: 24 },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    t.mock.timers.tick(1_999)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(answeredReads, 0, 'the production deadline has not expired')
    t.mock.timers.tick(1)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(answeredReads, 1)
    assert.deepEqual(await opening, { terminalId: 'term-1', runtime: answered.info.id })
    answerLate({ accounts: [{ kind: 'apiKey', label: 'Demo account' }], signInMethods: [] })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(warnings.length, 1)
    assert.match(JSON.stringify(warnings), /silent-ready/)
    assert.match(JSON.stringify(warnings), /2000/)
  })
}

test('a terminal refuses when every process provider is unavailable', async () => {
  const requested = fakeRuntime('conversation')
  const unavailable = fakeRuntime('unavailable', { processes: true,
    health: { state: 'unavailable', reason: 'crashed', message: 'Not running' } })
  const ctx = contextWith({ runtimes: { resolve: () => requested, all: () => [requested, unavailable] } })
  await assert.rejects(dispatch(ctx, 'terminal/open', {
    runtime: requested.info.id, cwd: '/tmp', size: { cols: 80, rows: 24 },
  }), /no other runtime is available/)
})

test('terminals can use idle providers without reading their accounts', async () => {
  const root = tempDir('hd-terminal-local-')
  const requested = fakeRuntime('conversation')
  const provider = fakeRuntime('local', { processes: true, health: { state: 'idle' } })
  provider.getAccount = async () => { throw new Error('must not read an idle provider account') }
  const ctx = contextWith({
    runtimes: { resolve: () => requested, all: () => [requested, provider] },
    workspaces: { openRoots: () => [root] },
    terminals: { open: async () => 'term-1' },
  })
  assert.deepEqual(await dispatch(ctx, 'terminal/open', {
    runtime: requested.info.id, cwd: root, size: { cols: 80, rows: 24 },
  }), { terminalId: 'term-1', runtime: provider.info.id })
})

/**
 * The handler's half of the boundary: the host's git confinement decides, and
 * the service is asked about the folder it answered with, links resolved, not
 * about the spelling off the wire.
 */
test('a worktree is only created where the git confinement admits, in the folder it answers with', async () => {
  const open = tempDir('hd-methods-open-')
  const elsewhere = tempDir('hd-methods-elsewhere-')
  const link = join(open, 'link')
  const real = join(open, 'real')
  const asked: string[] = []
  const ctx = contextWith({
    workspaces: {
      confineGitRoot: async (root: string) => {
        if (root === link) return real
        throw new Error(`${root} is outside every open workspace.`)
      },
    },
    worktrees: {
      create: async (root: string) => {
        asked.push(root)
        return { path: join(open, 'wt'), branch: 'wt' }
      },
    },
  })
  await assert.rejects(dispatch(ctx, 'worktree/create', { root: elsewhere, name: 'wt' }), /outside every open workspace/)
  assert.deepEqual(asked, [], 'the service is not asked about a root the confinement refused')
  await dispatch(ctx, 'worktree/create', { root: link, name: 'wt' })
  assert.deepEqual(asked, [real])
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

/**
 * Git lists a submodule's main checkout as its git directory,
 * `<super>/.git/modules/<name>`, never as the folder it is checked out at,
 * and the repository was judged by that listing alone. So with only that
 * folder open — the submodule opened as a project of its own — its worktrees
 * were refused as belonging to a project not opened here, and so was the
 * bring-home dialog's read of the main checkout, whose path it takes from
 * that listing.
 */
test("a submodule's worktree is brought home or removed with only the submodule's folder open", async () => {
  const quiet = { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }
  const origin = tempDir('hd-methods-origin-')
  const superproject = tempDir('hd-methods-super-')
  for (const repo of [origin, superproject]) {
    execFileSync('git', ['init', '-q', '-b', 'main', repo], quiet)
    execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], quiet)
  }
  execFileSync('git', ['-C', superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, 'sub'], quiet)
  const sub = join(superproject, 'sub')
  const listedMain = join(superproject, '.git', 'modules', 'sub')
  const tree = join(tempDir('hd-methods-state-'), 'wt')
  execFileSync('git', ['-C', sub, 'worktree', 'add', '-q', '-b', 'wt', tree], quiet)
  const elsewhere = tempDir('hd-methods-elsewhere-')
  const asked: string[] = []
  const ctx = (roots: string[]): HostContext =>
    contextWith({
      workspaces: { openRoots: () => roots },
      registry: { snapshot: () => [] },
      worktrees: {
        bringHome: async (path: string) => {
          asked.push(`home ${path}`)
          return { branch: 'wt', from: 'main', root: sub }
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

  // The control: the submodule is still a repository of its own, refused
  // while nothing of it is open.
  await assert.rejects(dispatch(ctx([elsewhere]), 'worktree/bringHome', { path: tree }), /not a project opened here/)
  await assert.rejects(dispatch(ctx([elsewhere]), 'worktree/remove', { path: tree }), /not a project opened here/)
  await assert.rejects(dispatch(ctx([elsewhere]), 'worktree/changes', { path: listedMain }), /not a project opened here/)
  assert.deepEqual(asked, [], 'the service is not asked about a submodule the window does not have open')

  const inside = join(sub, 'src')
  mkdirSync(inside)
  await dispatch(ctx([sub]), 'worktree/bringHome', { path: tree })
  await dispatch(ctx([sub]), 'worktree/remove', { path: tree })
  await dispatch(ctx([inside]), 'worktree/changes', { path: tree })
  await dispatch(ctx([sub]), 'worktree/changes', { path: listedMain })
  assert.deepEqual(
    asked,
    [`home ${tree}`, `remove ${tree}`, `changes ${tree}`, `changes ${listedMain}`],
    "the submodule's folder open, or a folder inside it, is its repository open",
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

test('worktree removal is refused while a conversation in the worktree is still working', async () => {
  const quiet = { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }
  const repo = tempDir('hd-methods-repo-busy-')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], quiet)
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], quiet)
  const tree = join(tempDir('hd-methods-state-busy-'), 'wt')
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'wt', tree], quiet)

  let removed = false
  const ctx = contextWith({
    workspaces: { openRoots: () => [repo] },
    registry: {
      snapshot: () => [
        {
          cwd: tree,
          status: { type: 'active' },
        },
      ],
    },
    worktrees: {
      remove: async () => {
        removed = true
        return { branch: 'wt' }
      },
    },
  })

  await assert.rejects(
    dispatch(ctx, 'worktree/remove', { path: tree }),
    /A conversation in .* is still working\. Remove it once its turn ends\./,
  )
  assert.equal(removed, false)
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
    credentials: {
      describe: async () => [
        { ref: 'cred-alone', name: 'C', createdAt: 1, agent: null, writer: 'endpoint' },
      ],
      delete: async (ref: string) => deleted.push(ref),
    },
    accounts: { gatewayCredentials: () => [] },
  })
  await dispatch(ctx, 'routes/delete', { id: 'a' })
  assert.deepEqual(deleted, [], 'a credential another route uses is kept')
  assert.deepEqual(stopped, ['a'])
  assert.deepEqual((stored as { id: string }[]).map((route) => route.id), ['b', 'c'])

  await dispatch(ctx, 'routes/delete', { id: 'c' })
  assert.deepEqual(deleted, ['cred-alone'], 'an orphaned credential goes with its route')
})

test('routes/delete does not delete agent or gateway credentials referenced by a route (#423)', async () => {
  const routes = [
    { id: 'r1', name: 'R1', endpoint: 'https://r1', wireProtocol: 'responses', credentialRef: 'cred_agent' },
    { id: 'r2', name: 'R2', endpoint: 'https://r2', wireProtocol: 'responses', credentialRef: 'cred_gw' },
    { id: 'r3', name: 'R3', endpoint: 'https://r3', wireProtocol: 'responses', credentialRef: 'cred_endpoint' },
    { id: 'r4', name: 'R4', endpoint: 'https://r4', wireProtocol: 'responses', credentialRef: 'cred_legacy_endpoint' },
    { id: 'r5', name: 'R5', endpoint: 'https://r5', wireProtocol: 'responses', credentialRef: 'cred_unknown' },
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
    credentials: {
      describe: async () => [
        { ref: 'cred_agent', name: 'agent:codex:OPENAI_API_KEY', createdAt: 1, agent: 'codex', writer: 'agent' },
        { ref: 'cred_gw', name: 'Gateway key', createdAt: 2, agent: null, writer: 'gateway' },
        { ref: 'cred_endpoint', name: 'Proxy key', createdAt: 3, agent: null, writer: 'endpoint' },
        { ref: 'cred_legacy_endpoint', name: 'Legacy proxy key', createdAt: 4, agent: null, writer: null },
      ],
      delete: async (ref: string) => {
        deleted.push(ref)
      },
    },
    accounts: {
      gatewayCredentials: () => [{ ref: 'cred_gw', name: 'Acme gateway' }],
    },
  })

  await dispatch(ctx, 'routes/delete', { id: 'r1' })
  assert.deepEqual(deleted, [], 'deleting route pointing to an agent credential preserves the agent key')

  await dispatch(ctx, 'routes/delete', { id: 'r2' })
  assert.deepEqual(deleted, [], 'deleting route pointing to a gateway credential preserves the gateway key')

  await dispatch(ctx, 'routes/delete', { id: 'r3' })
  assert.deepEqual(deleted, ['cred_endpoint'], 'an orphaned endpoint credential is deleted with its route')

  await dispatch(ctx, 'routes/delete', { id: 'r4' })
  assert.deepEqual(
    deleted,
    ['cred_endpoint', 'cred_legacy_endpoint'],
    'an orphaned legacy endpoint credential is deleted with its route',
  )

  await dispatch(ctx, 'routes/delete', { id: 'r5' })
  assert.deepEqual(
    deleted,
    ['cred_endpoint', 'cred_legacy_endpoint'],
    'an unknown or missing credential is not deleted on route delete',
  )
})

test('routes/list and routes/save tolerate null or malformed modelRoutes entries (#426)', async () => {
  let stored: unknown = null
  const malformedRoutes = [
    null,
    undefined,
    'not-a-route',
    { id: 'r1', name: 'Valid 1', endpoint: 'https://r1', wireProtocol: 'responses', credentialRef: 'c1' },
    null,
  ]
  const runtime = fakeRuntime('acp')
  const ctx = contextWith({
    routes: {
      list: () => malformedRoutes.filter((r): r is any => typeof r === 'object' && r !== null && 'id' in r && 'wireProtocol' in r),
      usable: () => ({ usable: true }),
    },
    runtimes: {
      get: () => runtime,
    },
    state: {
      setPreferences: async (patch: { modelRoutes: unknown }) => {
        stored = patch.modelRoutes
      },
    },
    gateways: { stop: () => {} },
    accounts: { gatewayCredentials: () => [] },
    credentials: { describe: async () => [], delete: async () => {} },
  })

  const listed = (await dispatch(ctx, 'routes/list', { runtime: runtimeId('acp') })) as any[]
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, 'r1')

  const saved = (await dispatch(ctx, 'routes/save', {
    name: 'New Route',
    endpoint: 'https://new',
    wireProtocol: 'responses',
    credentialRef: 'c2',
  })) as { id: string }
  assert.ok(saved.id)

  await dispatch(ctx, 'routes/delete', { id: 'r1' })
  assert.deepEqual(stored, [])
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
      sessions: { assertDispatchable: () => {}, record: () => record(busy) },
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

/**
 * `workspace/recent` still resolves the most recent workspace's `realPath`
 * live, and used to await it unbounded: a stalled mount held up the whole
 * list, not just its own row. It now races that resolve against a bound
 * (`RECENT_LATEST_READ_TIMEOUT_MS`) and answers with the saved key — the same
 * comparison key `#openWorkspace` already persisted onto the record — the
 * moment the live resolve misses it, rather than waiting on a filesystem call
 * that may never return (#939).
 */
test('the most recent workspace answers with its saved key when its live realpath resolve never returns', { timeout: 5_000 }, async (t) => {
  const { RECENT_LATEST_READ_TIMEOUT_MS } = await import('../src/methods/workspace.js')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const folder = tempDir('hd-methods-recent-stalled-')
  const latest = { path: folder, name: 'folder', lastOpenedAt: 1, realPath: `${folder}-saved-key` }
  const ctx = contextWith({
    state: { state: { workspaces: [latest] } },
    workspaces: {
      gitStatus: async () => null,
      repoOf: async () => null,
      topLevel: async () => null,
      // A live resolve that never settles on its own — a stalled mount.
      realPath: () => new Promise<string>(() => {}),
    },
  })
  const settled = dispatch(ctx, 'workspace/recent', {})
  t.mock.timers.tick(RECENT_LATEST_READ_TIMEOUT_MS)
  const recent = (await settled) as unknown as { path: string; realPath?: string }[]
  assert.equal(recent[0]?.realPath, latest.realPath, 'the saved key answers once the bound is reached')
})

/**
 * The other three live reads `workspace/recent` makes of the most recent
 * workspace — its git status, its `repoOf`, and its `topLevel` — used to be
 * awaited unbounded, exactly like `realPath` before #939: any one of them
 * stalled (a `git` shelled out to a dead mount, a `repoOf`/`topLevel` walk
 * over the same) held up the whole list, not only its own field (#948). Each
 * now races the same bound and answers with an empty stand-in the moment it
 * is reached, independently of whether the other three ever settle.
 */
test('the most recent workspace answers with an empty git status, repo and checkout root when their live reads never return', { timeout: 5_000 }, async (t) => {
  const { RECENT_LATEST_READ_TIMEOUT_MS } = await import('../src/methods/workspace.js')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const folder = tempDir('hd-methods-recent-stalled-fields-')
  const latest = { path: folder, name: 'folder', lastOpenedAt: 1, realPath: folder }
  const ctx = contextWith({
    state: { state: { workspaces: [latest] } },
    workspaces: {
      // Every one of the three stalls on its own — none ever settles.
      gitStatus: () => new Promise<null>(() => {}),
      repoOf: () => new Promise<null>(() => {}),
      topLevel: () => new Promise<null>(() => {}),
      realPath: async () => folder,
    },
  })
  const settled = dispatch(ctx, 'workspace/recent', {})
  t.mock.timers.tick(RECENT_LATEST_READ_TIMEOUT_MS)
  const recent = (await settled) as unknown as { path: string; git: unknown; repo: unknown; checkoutRoot: unknown }[]
  assert.equal(recent[0]?.git, null, 'a stalled git status answers null once the bound is reached')
  assert.equal(recent[0]?.repo, null, 'a stalled repoOf answers null once the bound is reached')
  assert.equal(recent[0]?.checkoutRoot, null, 'a stalled topLevel answers null once the bound is reached')
})
