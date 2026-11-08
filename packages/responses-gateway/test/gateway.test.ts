import assert from 'node:assert/strict'
import childProcess, { type ChildProcess } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'

import { GatewaySupervisor } from '../src/index.js'

/**
 * The gateway's whole job, verified: token-gated on loopback, provider key
 * injected out-of-band, model pinning, and clean failure when the upstream
 * is unreachable. The upstream here is a scripted server so the assertions
 * are about bytes, not beliefs.
 */

interface Seen {
  auth: string | undefined
  url: string | undefined
  body: string
}

const upstreamServer = (): Promise<{ server: Server; port: number; seen: Seen[] }> =>
  new Promise((resolve) => {
    const seen: Seen[] = []
    const server = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => {
        seen.push({
          auth: incoming.headers.authorization,
          url: incoming.url,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        outgoing.writeHead(200, { 'content-type': 'application/json' })
        outgoing.end(JSON.stringify({ ok: true }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0, seen })
    })
  })

test('the gateway swaps its token for the provider key and forwards', async () => {
  const upstream = await upstreamServer()
  const supervisor = new GatewaySupervisor()
  try {
    let resolved = 0
    const gateway = await supervisor.ensure('r1', {
      upstream: `http://127.0.0.1:${upstream.port}/v1`,
      resolveKey: async () => {
        resolved += 1
        return 'real-provider-key'
      },
    })
    assert.equal(resolved, 1, 'the credential is read exactly once, at spawn')
    assert.match(gateway.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]+$/)

    // Without the token: refused, upstream never sees it.
    const gwBase = gateway.endpoint.replace(/\/t\/[0-9a-f]+$/, '')
    const refused = await fetch(`${gwBase}/v1/responses`, { method: 'POST', body: '{}' })
    assert.equal(refused.status, 401)
    assert.equal(upstream.seen.length, 0)

    // With the path token: forwarded, with the real key and the spliced path.
    const accepted = await fetch(`${gateway.endpoint}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'as-sent', input: 'hello' }),
    })
    assert.equal(accepted.status, 200)
    assert.equal(upstream.seen.length, 1)
    assert.equal(upstream.seen[0]!.auth, 'Bearer real-provider-key')
    assert.equal(upstream.seen[0]!.url, '/v1/responses')

    // Reuse: a second ensure for the same route returns the same process.
    const again = await supervisor.ensure('r1', {
      upstream: `http://127.0.0.1:${upstream.port}/v1`,
      resolveKey: async () => 'should-not-be-read',
    })
    assert.equal(again.endpoint, gateway.endpoint)
    assert.equal(resolved, 1)
  } finally {
    await supervisor.dispose()
    await new Promise<void>((resolve, reject) => upstream.server.close(error => error ? reject(error) : resolve()))
  }
})

test('an acquisition cannot stop a borrowed gateway or a replacement', async () => {
  const upstream = await upstreamServer()
  const supervisor = new GatewaySupervisor()
  let releaseReplacement: (() => Promise<void>) | undefined
  const options = (key: string) => ({ upstream: `http://127.0.0.1:${upstream.port}/v1`, resolveKey: async () => key })
  const send = async (endpoint: string) => {
    const response = await fetch(`${endpoint}/responses`, { method: 'POST', body: '{}' })
    assert.equal(response.status, 200)
    await response.arrayBuffer()
  }
  try {
    const existing = await supervisor.ensure('borrowed', options('fixture-existing'))
    const borrowed = await supervisor.acquire('borrowed', options('fixture-unused'))
    assert.equal(borrowed.gateway.endpoint, existing.endpoint)
    await borrowed.release()
    await send(existing.endpoint)
    assert.equal(upstream.seen.at(-1)?.auth, 'Bearer fixture-existing')

    const first = await supervisor.acquire('replacement', options('fixture-first'))
    supervisor.stop('replacement')
    const replacement = await supervisor.acquire('replacement', options('fixture-replacement'))
    releaseReplacement = replacement.release
    await Promise.all([first.release(), first.release()])
    await send(replacement.gateway.endpoint)
    assert.equal(upstream.seen.at(-1)?.auth, 'Bearer fixture-replacement')
    const current = await supervisor.acquire('replacement', options('fixture-unused'))
    try {
      assert.equal(current.gateway.endpoint === replacement.gateway.endpoint, true, 'replacement remains registered')
    } finally {
      await current.release()
    }
  } finally {
    await supervisor.dispose()
    await releaseReplacement?.()
    await new Promise<void>((resolve, reject) => upstream.server.close(error => error ? reject(error) : resolve()))
  }
})

test('owned release bounds a child that does not receive EOF', async t => {
  const supervisor = new GatewaySupervisor()
  const spawn = childProcess.spawn
  let child: ChildProcess | undefined
  let closed: Promise<void> | undefined
  let closeSeen = false
  let closeInput: (() => void) | undefined
  let endCalls = 0
  const signals: Array<NodeJS.Signals | number | undefined> = []
  t.mock.method(childProcess, 'spawn', ((...args: Parameters<typeof spawn>) => {
    const spawned = spawn(...args)
    child = spawned
    closed = new Promise(resolve => spawned.once('close', () => { closeSeen = true; resolve() }))
    const stdin = spawned.stdin!
    const end = stdin.end.bind(stdin)
    let inputClosed = false
    closeInput = () => { if (!inputClosed) { inputClosed = true; end() } }
    stdin.end = (() => { endCalls++; return stdin }) as typeof stdin.end
    const kill = spawned.kill.bind(spawned)
    spawned.kill = ((signal?: NodeJS.Signals | number) => {
      signals.push(signal)
      return kill(signal)
    }) as typeof spawned.kill
    return spawned
  }) as typeof spawn)
  syncBuiltinESMExports()
  let timersEnabled = false
  let mockSetTimeout: typeof setTimeout | undefined
  t.after(async () => {
    if (mockSetTimeout) globalThis.setTimeout = mockSetTimeout
    if (timersEnabled) t.mock.timers.reset()
    t.mock.restoreAll()
    syncBuiltinESMExports()
    if (child && child.exitCode === null && child.signalCode === null && !child.killed) closeInput?.()
    await closed
    await supervisor.dispose()
  })
  const options = { upstream: 'http://127.0.0.1:1', resolveKey: async () => 'fixture-key' }
  const owned = await supervisor.acquire('held', options)
  assert.ok(child)
  const borrowed = await supervisor.acquire('held', options)
  assert.equal(borrowed.gateway.endpoint, owned.gateway.endpoint)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  timersEnabled = true
  mockSetTimeout = globalThis.setTimeout
  let scheduled = 0
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    scheduled++
    return mockSetTimeout!(...args)
  }) as typeof setTimeout
  await borrowed.release()
  assert.equal(scheduled, 0, 'borrowed release must not schedule a deadline')
  assert.equal(endCalls, 0, 'borrowed release must not close the child input')
  t.mock.timers.tick(2_500)
  assert.deepEqual(signals, [])
  assert.equal(child.exitCode, null)
  let resolvedBeforeClose = false
  const first = owned.release().then(() => { resolvedBeforeClose = !closeSeen })
  const second = owned.release()
  assert.equal(endCalls, 1, 'repeated release must close input only once')
  assert.equal(scheduled, 1, 'repeated release must share one deadline')
  t.mock.timers.tick(2_499)
  assert.deepEqual(signals, [])
  t.mock.timers.tick(1)
  assert.deepEqual(signals, ['SIGKILL'], 'deadline must signal the captured child')
  await Promise.all([first, second])
  assert.equal(resolvedBeforeClose, false, 'release must wait for child close')
  assert.equal(child.signalCode, 'SIGKILL')
  assert.equal(closeSeen, true)
})

test('a pinned model rewrites the request body; the caller cannot override it', async () => {
  const upstream = await upstreamServer()
  const supervisor = new GatewaySupervisor()
  try {
    const gateway = await supervisor.ensure('r2', {
      upstream: `http://127.0.0.1:${upstream.port}/v1`,
      model: 'pinned-model',
      resolveKey: async () => 'k',
    })
    await fetch(`${gateway.endpoint}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.5', input: 'x' }),
    })
    const sent = JSON.parse(upstream.seen[0]!.body) as { model: string }
    assert.equal(sent.model, 'pinned-model')
  } finally {
    await supervisor.dispose()
    await new Promise<void>((resolve, reject) => upstream.server.close(error => error ? reject(error) : resolve()))
  }
})

test('an unreachable upstream answers with a clean 502, never a hang', async () => {
  const supervisor = new GatewaySupervisor()
  try {
    const gateway = await supervisor.ensure('r3', {
      upstream: 'http://127.0.0.1:1/v1', // nothing listens on port 1
      resolveKey: async () => 'k',
    })
    const answer = await fetch(`${gateway.endpoint}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(answer.status, 502)
    const body = (await answer.json()) as { error: { message: string } }
    assert.match(body.error.message, /gateway:/)
  } finally {
    await supervisor.dispose()
  }
})
