import assert from 'node:assert/strict'
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
    upstream.server.close()
  }
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
    upstream.server.close()
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
