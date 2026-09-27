import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MeterAuthError } from '../../src/usage/meter.js'
import { openRouterCredits, openRouterLane, OpenRouterMeter } from '../../src/usage/openrouter.js'

/**
 * OpenRouter's key limit (`GET /api/v1/key`,
 * https://openrouter.ai/docs/api-reference/limits) and its account credit
 * balance (`GET /api/v1/credits`,
 * https://openrouter.ai/docs/api-reference/credits) — a Metered-key lane
 * plus a Balance, for any agent whose own configuration names an
 * `OPENROUTER_API_KEY`, never letting that key leak into a log, an error or
 * the report.
 */

const NOW = Date.parse('2026-09-26T12:00:00Z')

interface Seen {
  readonly origin: string
  readonly pathname: string
  readonly auth: string | null
  readonly redirect: RequestInit['redirect']
}

const served = (
  answers: Readonly<Record<string, { status?: number; body?: unknown }>>,
  onRequest?: (seen: Seen) => void,
): typeof globalThis.fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url))
    const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? null
    onRequest?.({ origin: parsed.origin, pathname: parsed.pathname, auth, redirect: init?.redirect })
    const answer = answers[parsed.pathname]
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

test('used prefers limit minus limit_remaining over the lifetime usage total, which keeps growing past a reset period', () => {
  const lane = openRouterLane({ limit: 10, limit_reset: 'monthly', usage: 250, limit_remaining: 7 })
  assert.equal(lane?.used, 3)
  assert.equal((lane?.used ?? 0) >= (lane?.limit ?? Infinity), false, 'not reached — the key still has money left')
})

test('with no limit_remaining, the usage_* figure matching limit_reset is used, never the lifetime total', () => {
  const lane = openRouterLane({ limit: 10, limit_reset: 'weekly', usage: 999, usage_weekly: 2, usage_daily: 1 })
  assert.equal(lane?.used, 2)
})

test('with neither limit_remaining nor a matching usage_* figure, the lifetime usage is the last resort', () => {
  const lane = openRouterLane({ limit: 10, limit_reset: 'monthly', usage: 4 })
  assert.equal(lane?.used, 4)
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
  const meter = new OpenRouterMeter({ key: () => 'sk-or-v1-abcd1234', fetch, now: () => NOW })
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
  const meter = new OpenRouterMeter({ key: () => 'sk-or-v1-wxyz9999', fetch, now: () => NOW })
  const reading = await meter.read()
  assert.deepEqual(reading?.lanes, [])
  assert.deepEqual(reading?.billing, { kinds: ['balance'] })
})

test('a spent key limit, and a drained balance, are both "reached"', async () => {
  const spentKey = served({
    '/api/v1/key': { body: { data: { limit: 10, usage: 10 } } },
    '/api/v1/credits': { body: { data: { total_credits: 50, total_usage: 10 } } },
  })
  const meter = new OpenRouterMeter({ key: () => 'sk-or-v1-key', fetch: spentKey, now: () => NOW })
  assert.equal((await meter.read())?.reached, 'key limit')

  const drained = served({
    '/api/v1/key': { body: { data: { limit: 10, usage: 1 } } },
    '/api/v1/credits': { body: { data: { total_credits: 40, total_usage: 40 } } },
  })
  const drainedMeter = new OpenRouterMeter({ key: () => 'sk-or-v1-key', fetch: drained, now: () => NOW })
  assert.equal((await drainedMeter.read())?.reached, 'credits', 'the account balance is checked too, not only the key')
})

test('no key configured is silence', async () => {
  const meter = new OpenRouterMeter({ key: () => undefined, fetch: served({}), now: () => NOW })
  assert.equal(await meter.read(), null)
})

test('a management-only 401/403 from /credits is silence for that route alone — the /key lane still stands, and nothing throws', async () => {
  const fetch = served({
    '/api/v1/key': { body: { data: { limit: 10, limit_remaining: 7 } } },
    '/api/v1/credits': { status: 403 },
  })
  const meter = new OpenRouterMeter({ key: () => 'sk-or-v1-ordinary-key', fetch, now: () => NOW })
  const reading = await meter.read()
  assert.ok(reading, 'a lane is present, not a thrown MeterAuthError')
  assert.equal(reading?.lanes[0]?.used, 3)
  assert.equal(reading?.credits, null)
  assert.deepEqual(reading?.billing, { kinds: ['metered'] })
})

test('a 401 from /key is an auth failure, and the key never appears in it', async () => {
  const meter = new OpenRouterMeter({
    key: () => 'sk-or-v1-the-secret-value', // hd-secrets-ok: a shape-only fixture value, never a real credential
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
    key: () => 'sk-or-v1-outage-key',
    fetch: served({ '/api/v1/key': { status: 503 }, '/api/v1/credits': { body: { data: { total_credits: 1, total_usage: 0 } } } }),
    now: () => NOW,
  })
  await assert.rejects(meter.read(), (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof MeterAuthError))
    assert.ok(!(error as Error).message.includes('sk-or-v1-outage-key'))
    return true
  })
})

test('a key with control characters in it is refused before any request, and never appears in the error', async () => {
  const requested: string[] = []
  const meter = new OpenRouterMeter({
    key: () => 'sk-or-v1-bad\nkey\0here',
    fetch: served(
      {},
      (seen) => {
        requested.push(seen.pathname)
      },
    ),
    now: () => NOW,
  })
  await assert.rejects(meter.read(), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.ok(!(error as Error).message.includes('bad'))
    assert.ok(!(error as Error).message.includes('key\0here'))
    return true
  })
  assert.deepEqual(requested, [], 'no request is ever sent with an unusable key')
})

test('the key is sent as a bearer token to both endpoints, over both real origins, and nowhere else', async () => {
  const seen: Seen[] = []
  const fetch = served(
    {
      '/api/v1/key': { body: { data: { limit: 5, usage: 1 } } },
      '/api/v1/credits': { body: { data: { total_credits: 5, total_usage: 1 } } },
    },
    (entry) => seen.push(entry),
  )
  await new OpenRouterMeter({ key: () => 'sk-or-v1-header-key', fetch, now: () => NOW }).read()
  assert.deepEqual(
    seen.map((entry) => entry.origin),
    ['https://openrouter.ai', 'https://openrouter.ai'],
  )
  assert.deepEqual(
    seen.map((entry) => entry.auth),
    ['Bearer sk-or-v1-header-key', 'Bearer sk-or-v1-header-key'],
  )
  assert.deepEqual(
    seen.map((entry) => entry.redirect),
    ['error', 'error'],
    'a fixed-origin request never follows a redirect',
  )
})

test('the key function is called fresh on every read — a key stored after construction is used on the next read, and a cleared key stops being sent', async () => {
  let stored: string | undefined
  const seen: (string | null)[] = []
  const fetch = served(
    {
      '/api/v1/key': { body: { data: { limit: 5, usage: 1 } } },
      '/api/v1/credits': { body: { data: { total_credits: 5, total_usage: 1 } } },
    },
    (entry) => seen.push(entry.auth),
  )
  const meter = new OpenRouterMeter({ key: () => stored, fetch, now: () => NOW })

  assert.equal(await meter.read(), null, 'nothing stored yet — silence, and no request')
  assert.deepEqual(seen, [])

  stored = 'sk-or-v1-stored-later'
  const reading = await meter.read()
  assert.ok(reading, 'the same meter instance picks up the key stored after it was built')
  assert.deepEqual(seen, ['Bearer sk-or-v1-stored-later', 'Bearer sk-or-v1-stored-later'])

  stored = undefined
  assert.equal(await meter.read(), null, 'a cleared key stops being sent, no restart needed')
})
