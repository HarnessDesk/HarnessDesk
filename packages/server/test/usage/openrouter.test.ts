import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MeterAuthError } from '../../src/usage/meter.js'
import { openRouterCredits, openRouterLane, OpenRouterMeter } from '../../src/usage/openrouter.js'

/**
 * OpenRouter's key limit (`GET /api/v1/key`,
 * https://openrouter.ai/docs/api-reference/limits) and its account credit
 * balance (`GET /api/v1/credits`,
 * https://openrouter.ai/docs/api-reference/credits) — a Metered-key lane
 * plus a Balance, for any agent this desk starts with `OPENROUTER_API_KEY`
 * set, never letting that key leak into a log, an error or the report.
 */

const NOW = Date.parse('2026-09-26T12:00:00Z')

const served = (
  answers: Readonly<Record<string, { status?: number; body?: unknown }>>,
  headerSeen?: (auth: string | null) => void,
): typeof globalThis.fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? null
    headerSeen?.(auth)
    const path = new URL(String(url)).pathname
    const answer = answers[path]
    if (!answer) return new Response('not found', { status: 404 })
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), { status: answer.status ?? 200 })
  }) as unknown as typeof globalThis.fetch

test('a key with a limit becomes a metered lane in the lane’s own unit', () => {
  const lane = openRouterLane({ limit: 10, limit_reset: 'monthly', usage: 3.5 })
  assert.deepEqual(lane, {
    id: 'key-limit',
    label: 'Key limit',
    unit: 'usd',
    used: 3.5,
    limit: 10,
    layer: 'plan',
    usedPercent: 35,
    windowMinutes: 30 * 24 * 60,
    resetsAt: null,
    resetText: 'monthly',
  })
})

test('a key with no limit is no lane at all — spend is shown through credits, never an invented ceiling', () => {
  assert.equal(openRouterLane({ limit: null, usage: 12 }), null)
})

test('the credits math is total_credits minus total_usage, in USD', () => {
  assert.deepEqual(openRouterCredits({ total_credits: 50, total_usage: 42 }), { remaining: 8, unit: 'USD', unlimited: false })
  assert.equal(openRouterCredits({}), null, 'a response missing either total is nothing to report')
})

test('the meter combines both endpoints into one reading: a metered lane plus a balance', async () => {
  const fetch = served({
    '/api/v1/key': { body: { data: { limit: 10, limit_reset: 'monthly', usage: 4 } } },
    '/api/v1/credits': { body: { data: { total_credits: 50, total_usage: 42 } } },
  })
  const meter = new OpenRouterMeter({ env: { OPENROUTER_API_KEY: 'sk-or-v1-abcd1234' }, fetch, now: () => NOW })
  const reading = await meter.read()
  assert.equal(reading?.lanes[0]?.used, 4)
  assert.deepEqual(reading?.credits, { remaining: 8, unit: 'USD', unlimited: false })
  assert.deepEqual(reading?.billing, { kinds: ['metered', 'balance'] })
  assert.equal(reading?.account, '•••· 1234', 'at most the last four characters of the key, never the key itself')
  assert.equal(reading?.fetchedAt, NOW)
})

test('a key with no limit at all reports only the balance, kind "balance"', async () => {
  const fetch = served({
    '/api/v1/key': { body: { data: { limit: null, usage: 4 } } },
    '/api/v1/credits': { body: { data: { total_credits: 50, total_usage: 42 } } },
  })
  const meter = new OpenRouterMeter({ env: { OPENROUTER_API_KEY: 'sk-or-v1-wxyz9999' }, fetch, now: () => NOW })
  const reading = await meter.read()
  assert.deepEqual(reading?.lanes, [])
  assert.deepEqual(reading?.billing, { kinds: ['balance'] })
})

test('a spent key limit, and a drained balance, are both "reached"', async () => {
  const spentKey = served({
    '/api/v1/key': { body: { data: { limit: 10, usage: 10 } } },
    '/api/v1/credits': { body: { data: { total_credits: 50, total_usage: 10 } } },
  })
  const meter = new OpenRouterMeter({ env: { OPENROUTER_API_KEY: 'sk-or-v1-key' }, fetch: spentKey, now: () => NOW })
  assert.equal((await meter.read())?.reached, 'key limit')

  const drained = served({
    '/api/v1/key': { body: { data: { limit: 10, usage: 1 } } },
    '/api/v1/credits': { body: { data: { total_credits: 40, total_usage: 40 } } },
  })
  const drainedMeter = new OpenRouterMeter({ env: { OPENROUTER_API_KEY: 'sk-or-v1-key' }, fetch: drained, now: () => NOW })
  assert.equal((await drainedMeter.read())?.reached, 'credits', 'the account balance is checked too, not only the key')
})

test('no key configured is silence', async () => {
  const meter = new OpenRouterMeter({ env: {}, fetch: served({}), now: () => NOW })
  assert.equal(await meter.read(), null)
})

test('a 401 from either endpoint is an auth failure, and the key never appears in it', async () => {
  const meter = new OpenRouterMeter({
    env: { OPENROUTER_API_KEY: 'sk-or-v1-the-secret-value' }, // hd-secrets-ok: a shape-only fixture value, never a real credential
    fetch: served({ '/api/v1/key': { status: 401 }, '/api/v1/credits': { body: { data: { total_credits: 1, total_usage: 0 } } } }),
    now: () => NOW,
  })
  await assert.rejects(meter.read(), (error: unknown) => {
    assert.ok(error instanceof MeterAuthError)
    assert.ok(!(error as Error).message.includes('sk-or-v1-the-secret-value')) // hd-secrets-ok: a shape-only fixture value, never a real credential
    return true
  })
})

test('an outage on either endpoint is a plain failure, still never naming the key', async () => {
  const meter = new OpenRouterMeter({
    env: { OPENROUTER_API_KEY: 'sk-or-v1-outage-key' },
    fetch: served({ '/api/v1/key': { status: 503 }, '/api/v1/credits': { body: { data: { total_credits: 1, total_usage: 0 } } } }),
    now: () => NOW,
  })
  await assert.rejects(meter.read(), (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof MeterAuthError))
    assert.ok(!(error as Error).message.includes('sk-or-v1-outage-key'))
    return true
  })
})

test('the key is sent as a bearer token to both endpoints and nowhere else', async () => {
  const seen: (string | null)[] = []
  const fetch = served(
    {
      '/api/v1/key': { body: { data: { limit: 5, usage: 1 } } },
      '/api/v1/credits': { body: { data: { total_credits: 5, total_usage: 1 } } },
    },
    (auth) => seen.push(auth),
  )
  await new OpenRouterMeter({ env: { OPENROUTER_API_KEY: 'sk-or-v1-header-key' }, fetch, now: () => NOW }).read()
  assert.deepEqual(seen, ['Bearer sk-or-v1-header-key', 'Bearer sk-or-v1-header-key'])
})
