import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CodexAppServer,
  CodexError,
  CodexRpcError,
  type ConnectionState,
} from '../src/index.js'
import type { ServerNotification } from '../src/generated/index.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

const CLIENT_INFO = { name: 'harnessdesk-test', title: 'HarnessDesk (test)', version: '0.0.0' }

const make = (
  mode: string,
  overrides: Partial<ConstructorParameters<typeof CodexAppServer>[0]> = {},
): CodexAppServer =>
  new CodexAppServer({
    clientInfo: CLIENT_INFO,
    binaryPath: FAKE,
    env: { FAKE_CODEX_MODE: mode },
    requestTimeoutMs: 5_000,
    ...overrides,
  })

/** Resolves the first time `predicate` accepts a state. */
const waitForState = (
  server: CodexAppServer,
  predicate: (state: ConnectionState) => boolean,
  timeoutMs = 15_000,
): Promise<ConnectionState> =>
  new Promise((resolve, reject) => {
    if (predicate(server.state)) return resolve(server.state)
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timed out waiting for state; last was ${server.state.type}`))
    }, timeoutMs)
    const off = server.onStateChange((state) => {
      if (!predicate(state)) return
      clearTimeout(timer)
      off()
      resolve(state)
    })
  })

test('handshake reaches ready and reports the server info', async (t) => {
  const server = make('normal')
  t.after(() => server.stop())
  await server.start()
  assert.equal(server.state.type, 'ready')
  assert.equal(
    server.state.type === 'ready' ? server.state.info.codexHome : null,
    '/tmp/fake-codex-home',
  )
  assert.equal(server.installation?.path, FAKE)
})

test('start is idempotent and concurrent callers share one startup', async (t) => {
  const server = make('normal')
  t.after(() => server.stop())
  await Promise.all([server.start(), server.start(), server.start()])
  assert.equal(server.state.type, 'ready')
})

test('the initialized notification is sent before other traffic', async (t) => {
  const server = make('normal')
  t.after(() => server.stop())
  await server.start()
  const result = await server.request('skills/list', {} as never)
  assert.equal((result as unknown as { initialized: boolean }).initialized, true)
})

test('requests correlate to their own responses', async (t) => {
  const server = make('normal')
  t.after(() => server.stop())
  await server.start()
  const [a, b] = await Promise.all([
    server.request('thread/start', { cwd: '/tmp' } as never),
    server.request('model/list', {} as never),
  ])
  assert.equal((a as unknown as { thread: { id: string } }).thread.id, 'thread-1')
  assert.equal((b as unknown as { method: string }).method, 'model/list')
})

test('a JSON-RPC error becomes a CodexRpcError carrying code and data', async (t) => {
  const server = make('normal')
  t.after(() => server.stop())
  await server.start()
  await assert.rejects(
    () => server.request('rpc/error' as never, {} as never),
    (error: unknown) => {
      assert.ok(error instanceof CodexRpcError)
      assert.equal(error.rpcCode, -32000)
      assert.equal(error.message, 'scripted failure')
      assert.deepEqual(error.data, { hint: 'expected' })
      return true
    },
  )
})

test('a request that is never answered times out', async (t) => {
  const server = make('normal')
  t.after(() => server.stop())
  await server.start()
  await assert.rejects(
    () => server.request('never/answers' as never, {} as never, { timeoutMs: 150 }),
    (error: unknown) => error instanceof CodexError && error.code === 'timeout',
  )
})

test('an aborted request rejects as cancelled', async (t) => {
  const server = make('normal')
  t.after(() => server.stop())
  await server.start()
  const controller = new AbortController()
  const pending = server.request('never/answers' as never, {} as never, {
    signal: controller.signal,
    timeoutMs: 5_000,
  })
  controller.abort()
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof CodexError && error.code === 'cancelled',
  )
})

test('a multi-megabyte response arrives intact', async (t) => {
  const server = make('normal')
  t.after(() => server.stop())
  await server.start()
  const result = (await server.request('echo/big' as never, {} as never)) as unknown as {
    blob: string
  }
  assert.equal(result.blob.length, 2 * 1024 * 1024)
})

test('calling before start rejects rather than hanging', async () => {
  const server = make('normal')
  await assert.rejects(
    () => server.request('model/list', {} as never),
    (error: unknown) => error instanceof CodexError && error.code === 'notRunning',
  )
})

test('notifications reach listeners even when split across writes', async (t) => {
  const server = make('notify-on-init')
  t.after(() => server.stop())
  const seen: ServerNotification[] = []
  server.onNotification((notification) => seen.push(notification))
  await server.start()
  await waitForState(server, (state) => state.type === 'ready')
  const deadline = Date.now() + 5_000
  while (seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  assert.ok(
    seen.some((n) => n.method === 'thread/started'),
    'expected the split notification to be reassembled',
  )
})

test('server-initiated requests are handed to a listener and answered', async (t) => {
  const server = make('approval')
  t.after(() => server.stop())
  await server.start()

  const answered = new Promise<void>((resolve) => {
    server.onServerRequest((request, responder) => {
      assert.equal(request.method, 'item/commandExecution/requestApproval')
      responder.respond({ decision: 'accept' })
      resolve()
    })
  })
  await server.request('turn/start', { threadId: 'thread-1', input: [] } as never)
  await answered
})

test('an unhandled server request is refused rather than left hanging', async (t) => {
  const server = make('approval')
  t.after(() => server.stop())
  await server.start()

  const resolved = new Promise<unknown>((resolve) => {
    server.onNotification((notification) => {
      if (notification.method === 'serverRequest/resolved') resolve(notification.params)
    })
  })
  await server.request('turn/start', { threadId: 'thread-1', input: [] } as never)
  const params = (await resolved) as { answer?: { message?: string } }
  assert.match(params.answer?.message ?? '', /No handler/)
})

test('a crash rejects in-flight requests and restarts with backoff', async (t) => {
  const server = make('crash-on-request', { maxRestarts: 2 })
  t.after(() => server.stop())
  await server.start()

  await assert.rejects(
    () => server.request('thread/start', { cwd: '/tmp' } as never),
    (error: unknown) => error instanceof CodexError && error.code === 'crashed',
  )
  const restarting = await waitForState(server, (state) => state.type === 'restarting')
  assert.equal(restarting.type === 'restarting' ? restarting.attempt : 0, 1)
  await waitForState(server, (state) => state.type === 'ready')
})

test('restarts stop after the configured limit', async (t) => {
  const server = make('spawn-crash', { maxRestarts: 1 })
  t.after(() => server.stop())
  await assert.rejects(() => server.start())
  assert.equal(server.state.type, 'failed')
})

test('a minute ready refills the crash budget but short-lived restarts exhaust it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 })
  const server = make('crash-on-request', { maxRestarts: 1 })
  t.after(() => server.stop())
  await server.start()
  const crash = () => assert.rejects(
    () => server.request('thread/start', { cwd: '/tmp' } as never),
    (error: unknown) => error instanceof CodexError && error.code === 'crashed',
  )
  await crash()
  await waitForState(server, (state) => state.type === 'ready')
  t.mock.timers.tick(60_000)
  await crash()
  const next = await waitForState(server, (state) => state.type === 'restarting' || state.type === 'failed')
  assert.equal(next.type, 'restarting', 'healthy time refills the exhausted budget')
  assert.equal(next.type === 'restarting' ? next.attempt : null, 1)
  await waitForState(server, (state) => state.type === 'ready')
  t.mock.timers.tick(59_999)
  await crash()
  const failed = await waitForState(server, (state) => state.type === 'failed')
  assert.match(failed.type === 'failed' ? failed.error.message : '', /giving up after 1 restarts/)
})

test('an unavailable binary fails start with notInstalled', async () => {
  const server = new CodexAppServer({
    clientInfo: CLIENT_INFO,
    binaryPath: '/definitely/not/real/codex',
  })
  await assert.rejects(
    () => server.start(),
    (error: unknown) => error instanceof CodexError && error.code === 'notInstalled',
  )
  assert.equal(server.state.type, 'failed')
})

test('stop leaves the server stopped and refuses further calls', async () => {
  const server = make('normal')
  await server.start()
  await server.stop()
  assert.equal(server.state.type, 'stopped')
  await assert.rejects(
    () => server.request('model/list', {} as never),
    (error: unknown) => error instanceof CodexError && error.code === 'notRunning',
  )
})

test('a draining child cannot disturb its replacement', { skip: process.platform === 'win32', timeout: 15_000 }, async (t) => {
  const server = make('overlap-stop', { maxRestarts: 0 })
  let oldStop: Promise<void> | undefined
  const owned = new Set<number>()
  t.after(async () => {
    // Reap tracked children through their process handles first. Only a child
    // lost by the broken ownership guard still needs the recorded-PID fallback.
    const current = server.processId
    await Promise.all([server.stop(), oldStop])
    if (current !== null) owned.delete(current)
    t.diagnostic(`cleanup remaining owned child PIDs: ${[...owned].join(', ')}`)
    for (const pid of owned) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
    }
    for (const pid of owned) {
      const deadline = Date.now() + 5_000
      while (true) {
        try { process.kill(pid, 0) } catch { break }
        if (Date.now() >= deadline) throw new Error(`child ${pid} did not exit`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
  })
  const notices: string[] = []
  let pendingSeen!: () => void
  const pendingNotice = new Promise<void>((resolve) => { pendingSeen = resolve })
  server.onNotification((notice) => {
    notices.push(notice.method)
    if ((notice.method as string) === 'overlap/pending') pendingSeen()
  })
  await server.start()
  const oldPid = server.processId!
  owned.add(oldPid)
  oldStop = server.stop().finally(() => { owned.delete(oldPid) })
  await server.start()
  const replacement = server.processId!
  owned.add(replacement)
  assert.notEqual(replacement, oldPid)
  const pending = server.request('overlap/wait' as never, {} as never)
  // Attach a rejection handler immediately, including on the red run.
  const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }))
  await pendingNotice
  t.diagnostic(`releasing old child ${oldPid}; replacement ${replacement} has a pending request`)
  process.kill(oldPid, 'SIGUSR1')
  await oldStop
  assert.equal(server.processId, replacement)
  assert.equal(server.state.type, 'ready')
  assert.deepEqual(notices, ['overlap/pending'])
  process.kill(replacement, 'SIGUSR2')
  assert.deepEqual(await outcome, { value: { owner: 'replacement' } })
  const finalStop = server.stop()
  process.kill(replacement, 'SIGUSR1')
  await finalStop
  owned.delete(replacement)
  assert.throws(() => process.kill(replacement, 0), { code: 'ESRCH' })
})

test('stop after a crash does not trigger another restart', async (t) => {
  const server = make('crash-on-request', { maxRestarts: 5 })
  t.after(() => server.stop())
  await server.start()
  await assert.rejects(() => server.request('thread/start', { cwd: '/tmp' } as never))
  await server.stop()
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(server.state.type, 'stopped')
})
