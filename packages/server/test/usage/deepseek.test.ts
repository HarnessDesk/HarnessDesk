import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { MeterAuthError } from '../../src/usage/meter.js'
import { deepSeekBalance, DeepSeekMeter } from '../../src/usage/deepseek.js'
import { tempDir } from '../scratch.js'

/**
 * DeepSeek's prepaid balance — `GET /user/balance`
 * (https://api-docs.deepseek.com/api/get-user-balance) — mapped to
 * `credits`, never a lane, and never letting the key it was asked with leak
 * into a log or a thrown message.
 */

const NOW = Date.parse('2026-09-26T12:00:00Z')

const served = (status: number, body?: unknown, headerSeen?: (auth: string | null) => void): typeof globalThis.fetch =>
  (async (_url: string | URL | Request, init?: RequestInit) => {
    headerSeen?.((init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? null)
    return new Response(body === undefined ? '' : JSON.stringify(body), { status })
  }) as unknown as typeof globalThis.fetch

test('a single funded currency maps straight across', () => {
  assert.deepEqual(deepSeekBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '42.50' }] }), {
    remaining: 42.5,
    unit: 'CNY',
    available: true,
  })
})

test('two funded currencies are never summed — USD is the one shown when it exists', () => {
  const mapped = deepSeekBalance({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '100.00' },
      { currency: 'USD', total_balance: '13.75' },
    ],
  })
  assert.deepEqual(mapped, { remaining: 13.75, unit: 'USD', available: true })
})

test('with no USD funded, the first currency the source lists is the one shown, not a sum of both', () => {
  const mapped = deepSeekBalance({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '100.00' },
      { currency: 'CNY', total_balance: '5.00' },
    ],
  })
  assert.equal(mapped?.remaining, 100, 'the first entry, never 105')
})

test('is_available: false reads as out, even with a positive number left', () => {
  const mapped = deepSeekBalance({ is_available: false, balance_infos: [{ currency: 'USD', total_balance: '4.00' }] })
  assert.deepEqual(mapped, { remaining: 4, unit: 'USD', available: false })
})

test('no balance_infos at all is nothing to report', () => {
  assert.equal(deepSeekBalance({ is_available: true, balance_infos: [] }), null)
  assert.equal(deepSeekBalance({}), null)
})

test('the meter reads the balance, maps is_available to reached, and never asks twice for the same reading', async () => {
  let calls = 0
  const fetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
    calls += 1
    return served(200, { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '9.10' }] })(...args)
  }) as typeof globalThis.fetch
  const meter = new DeepSeekMeter({ env: { DEEPSEEK_API_KEY: 'sk-test-key' }, fetch, now: () => NOW })
  const reading = await meter.read()
  assert.deepEqual(reading?.credits, { remaining: 9.1, unit: 'USD', unlimited: false })
  assert.equal(reading?.reached, null)
  assert.deepEqual(reading?.billing, { kinds: ['balance'] })
  assert.equal(reading?.fetchedAt, NOW)
  assert.equal(calls, 1)
})

test('a spent account reports "credits" as reached', async () => {
  const meter = new DeepSeekMeter({
    env: { DEEPSEEK_API_KEY: 'sk-test-key' },
    fetch: served(200, { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '0' }] }),
    now: () => NOW,
  })
  assert.equal((await meter.read())?.reached, 'credits')
})

test('no key anywhere this meter looks is silence, not an error', async () => {
  const meter = new DeepSeekMeter({ env: {}, fetch: served(200, {}), now: () => NOW })
  assert.equal(await meter.read(), null)
})

test('a 401 is an auth failure, not a crash, and the key itself never appears in it', async () => {
  const meter = new DeepSeekMeter({
    env: { DEEPSEEK_API_KEY: 'sk-the-secret-value' },
    fetch: served(401),
    now: () => NOW,
  })
  await assert.rejects(meter.read(), (error: unknown) => {
    assert.ok(error instanceof MeterAuthError)
    assert.ok(!(error as Error).message.includes('sk-the-secret-value'))
    return true
  })
})

test('a 403 is the same auth failure as a 401', async () => {
  const meter = new DeepSeekMeter({ env: { DEEPSEEK_API_KEY: 'sk-key' }, fetch: served(403), now: () => NOW })
  await assert.rejects(meter.read(), MeterAuthError)
})

test('a genuine outage is a plain failure, and still never names the key', async () => {
  const meter = new DeepSeekMeter({ env: { DEEPSEEK_API_KEY: 'sk-outage-key' }, fetch: served(503), now: () => NOW })
  await assert.rejects(meter.read(), (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof MeterAuthError))
    assert.ok(!(error as Error).message.includes('sk-outage-key'))
    return true
  })
})

test('the desk’s own stored key is asked before the row’s environment or DSH’s own files', async () => {
  let seenAuth: string | null = null
  const meter = new DeepSeekMeter({
    env: { DEEPSEEK_API_KEY: 'sk-env-key' },
    resolvedKey: 'sk-broker-key',
    fetch: served(200, { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1' }] }, (auth) => {
      seenAuth = auth
    }),
    now: () => NOW,
  })
  await meter.read()
  assert.equal(seenAuth, 'Bearer sk-broker-key')
})

test('with no env var and no broker key, DSH’s own credentials.yaml is read for the value, both shapes it is written in', async () => {
  const home = tempDir('hd-dsh-')
  writeFileSync(join(home, '.credentials.yaml'), '{ DEEPSEEK_API_KEY: sk-from-yaml }\n')
  const meter = new DeepSeekMeter({ env: { DSH_HOME: home }, fetch: served(200, { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '2' }] }), now: () => NOW })
  assert.deepEqual(meter.watchPaths(), [join(home, '.credentials.yaml'), join(home, '.env')])
  const reading = await meter.read()
  assert.equal(reading?.credits?.remaining, 2)
})

test('a block-style credentials.yaml is read too, and .env is the fallback when the yaml file is absent', async () => {
  const blockHome = tempDir('hd-dsh-')
  writeFileSync(join(blockHome, '.credentials.yaml'), 'someOtherKey: x\nDEEPSEEK_API_KEY: sk-block-style\n')
  const blockMeter = new DeepSeekMeter({
    env: { DSH_HOME: blockHome },
    fetch: served(200, { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '3' }] }),
    now: () => NOW,
  })
  assert.equal((await blockMeter.read())?.credits?.remaining, 3)

  const envHome = tempDir('hd-dsh-')
  writeFileSync(join(envHome, '.env'), 'DEEPSEEK_API_KEY=sk-from-dotenv\n')
  const envMeter = new DeepSeekMeter({
    env: { DSH_HOME: envHome },
    fetch: served(200, { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '4' }] }),
    now: () => NOW,
  })
  assert.equal((await envMeter.read())?.credits?.remaining, 4)
})
