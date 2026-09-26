import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { RunResult } from '../../src/installs/run.js'
import { AmpMeter, ampBalance } from '../../src/usage/amp.js'
import { ClineMeter, clineSession } from '../../src/usage/cline.js'
import { tempDir } from '../scratch.js'

/**
 * The two agents whose balance lives on the vendor's server: Amp, asked
 * through its own CLI, and Cline, asked with the session its CLI already
 * holds. The Amp report is the one `amp usage` printed on 2026-09-18, with
 * the address swapped for a placeholder.
 */

const NOW = Date.parse('2026-09-18T12:00:00Z')

const AMP_REPORT = [
  'Signed in as dev@example.com',
  '**Individual credits:** $10 remaining (set up auto-reload to avoid running out) - https://ampcode.com/settings',
  '',
  '# Run `amp usage --details` for more detailed information.',
  '',
].join('\n')

const ran = (stdout: string, overrides: Partial<RunResult> = {}): RunResult => ({
  ok: true,
  code: 0,
  stdout,
  stderr: '',
  timedOut: false,
  ...overrides,
})

const queue = (...answers: RunResult[]) => {
  const calls: (readonly string[])[] = []
  return {
    calls,
    run: async (_command: string, args: readonly string[]): Promise<RunResult> => {
      calls.push(args)
      const next = answers.shift()
      assert.ok(next, 'amp was run more often than the test expected')
      return next
    },
  }
}

test('Amp’s report gives the balance and who it belongs to, and nothing it does not say', () => {
  assert.deepEqual(ampBalance(AMP_REPORT), { account: 'dev@example.com', label: 'Individual credits', remaining: 10 })
  assert.equal(ampBalance('**Workspace credits:** $1,234.50 remaining')?.remaining, 1234.5)
  // No balance line: nothing, rather than a zero nobody reported.
  assert.equal(ampBalance('Signed in as dev@example.com\n'), null)
  assert.equal(ampBalance(''), null)
})

test('Amp is asked sparingly, and its balance is the card', async () => {
  let now = NOW
  const { calls, run } = queue(ran(AMP_REPORT), ran(AMP_REPORT))
  const meter = new AmpMeter({ command: '/opt/amp', run, now: () => now })
  const reading = await meter.read()
  assert.deepEqual(reading?.credits, { remaining: 10, unit: 'USD', unlimited: false })
  assert.equal(reading?.account, 'dev@example.com')
  assert.equal(reading?.reached, null)
  assert.deepEqual(reading?.billing, { kinds: ['balance'] })
  assert.deepEqual(calls, [['usage', '--no-color']])
  // Account lookups share Amp's 60-an-hour limit: turns finishing do not re-ask.
  now += 4 * 60_000
  assert.equal(await meter.read(), reading)
  assert.equal(calls.length, 1)
  now += 2 * 60_000
  await meter.read()
  assert.equal(calls.length, 2)
})

test('Amp signed out is silence; anything else it refuses is an error worth logging', async () => {
  const signedOut = new AmpMeter({
    command: '/opt/amp',
    run: queue(ran('', { ok: false, code: 1, stderr: 'Error: not logged in. Run `amp login`.' })).run,
  })
  assert.equal(await signedOut.read(), null)
  const broken = new AmpMeter({
    command: '/opt/amp',
    run: queue(ran('', { ok: false, code: 1, stderr: 'Error: fetch failed (503)' })).run,
  })
  await assert.rejects(broken.read(), /amp usage failed: Error: fetch failed \(503\)/)
  const spent = new AmpMeter({
    command: '/opt/amp',
    run: queue(ran('**Individual credits:** $0 remaining')).run,
  })
  assert.equal((await spent.read())?.reached, 'credits', 'a spent balance is a reached limit')
})

/** Cline's `providers.json`, as the CLI writes it. */
const clineSettings = (dir: string, auth: Record<string, unknown>): string => {
  const path = join(dir, 'providers.json')
  writeFileSync(
    path,
    JSON.stringify({ version: 1, lastUsedProvider: 'cline', providers: { cline: { settings: { provider: 'cline', auth } } } }),
  )
  return path
}

interface Served {
  readonly calls: string[]
  readonly fetch: typeof globalThis.fetch
}

/** Cline's API: its `{ success, data }` envelope around whatever each path answers. */
const clineApi = (answers: Record<string, { status?: number; data?: unknown }>): Served => {
  const calls: string[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    calls.push(`${path} ${(init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? ''}`)
    const answer = answers[path]
    if (!answer) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify({ success: true, data: answer.data }), { status: answer.status ?? 200 })
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

test('Cline’s session is read from its own file, prefix and all', () => {
  assert.deepEqual(clineSession(JSON.stringify({ providers: { cline: { settings: { auth: { accessToken: 'workos:abc', expiresAt: 5, accountId: 'u1' } } } } })), {
    token: 'workos:abc',
    expiresAt: 5,
    accountId: 'u1',
  })
  assert.equal(clineSession(JSON.stringify({ providers: { anthropic: {} } })), null)
  assert.equal(clineSession('{ not json'), null)
})

test('Cline’s balance is the billed account’s, in dollars, while the session is valid', async () => {
  const dir = tempDir('hd-cline-')
  const settingsPath = clineSettings(dir, { accessToken: 'workos:tok', expiresAt: NOW + 3_600_000, accountId: 'u1' })
  const api = clineApi({
    '/api/v1/users/me': { data: { id: 'u1', email: 'dev@example.com', organizations: [] } },
    '/api/v1/users/u1/balance': { data: { balance: 12_345_678, userId: 'u1' } },
  })
  const meter = new ClineMeter({ settingsPath, apiBase: 'https://api.example.test', fetch: api.fetch, now: () => NOW })
  const reading = await meter.read()
  assert.deepEqual(reading?.credits, { remaining: 12.345678, unit: 'USD', unlimited: false }, 'micro-dollars')
  assert.equal(reading?.account, 'dev@example.com')
  assert.equal(reading?.plan, null)
  assert.deepEqual(reading?.billing, { kinds: ['balance'] })
  assert.deepEqual(api.calls, ['/api/v1/users/me Bearer workos:tok', '/api/v1/users/u1/balance Bearer workos:tok'])

  // Billed to an organization: its balance, and its name as the plan.
  const orgApi = clineApi({
    '/api/v1/users/me': {
      data: { id: 'u1', email: 'dev@example.com', organizations: [{ organizationId: 'o1', name: 'Acme', active: true }] },
    },
    '/api/v1/organizations/o1/balance': { data: { balance: 500_000_000 } },
  })
  const org = await new ClineMeter({ settingsPath, apiBase: 'https://api.example.test', fetch: orgApi.fetch, now: () => NOW }).read()
  assert.equal(org?.credits?.remaining, 500)
  assert.equal(org?.plan, 'Acme')
})

test('an expired Cline session is never refreshed: the last reading stands, with its own age', async () => {
  const dir = tempDir('hd-cline-')
  let now = NOW
  const settingsPath = clineSettings(dir, { accessToken: 'workos:tok', expiresAt: NOW + 60_000, accountId: 'u1' })
  const api = clineApi({
    '/api/v1/users/me': { data: { id: 'u1', email: 'dev@example.com' } },
    '/api/v1/users/u1/balance': { data: { balance: 1_000_000 } },
  })
  const meter = new ClineMeter({ settingsPath, apiBase: 'https://api.example.test', fetch: api.fetch, now: () => now })
  const live = await meter.read()
  assert.equal(live?.fetchedAt, NOW)

  now += 2 * 3_600_000
  const later = await meter.read()
  assert.equal(later, live, 'the same reading, dated when it was read')
  assert.equal(api.calls.length, 2, 'and nothing was asked with a dead token')

  // Signed in as someone else since: the last account's figure is not theirs.
  clineSettings(dir, { accessToken: 'workos:other', expiresAt: NOW, accountId: 'u2' })
  assert.equal(await meter.read(), null)
})

test('Cline signed out, revoked, or never set up is silence', async () => {
  const dir = tempDir('hd-cline-')
  const missing = new ClineMeter({ settingsPath: join(dir, 'absent.json'), fetch: clineApi({}).fetch, now: () => NOW })
  assert.equal(await missing.read(), null)
  const settingsPath = clineSettings(dir, { accessToken: 'workos:tok', expiresAt: NOW + 3_600_000 })
  const revoked = new ClineMeter({
    settingsPath,
    apiBase: 'https://api.example.test',
    fetch: clineApi({ '/api/v1/users/me': { status: 401 } }).fetch,
    now: () => NOW,
  })
  assert.equal(await revoked.read(), null)
  const down = new ClineMeter({
    settingsPath,
    apiBase: 'https://api.example.test',
    fetch: clineApi({ '/api/v1/users/me': { status: 503 } }).fetch,
    now: () => NOW,
  })
  await assert.rejects(down.read(), /HTTP 503/)
})

test('Cline’s data folder follows the agent’s own environment', async () => {
  const dir = tempDir('hd-cline-')
  const data = join(dir, 'isolated')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(data, 'settings'), { recursive: true })
  writeFileSync(
    join(data, 'settings', 'providers.json'),
    JSON.stringify({ providers: { cline: { settings: { auth: { accessToken: 'workos:iso', expiresAt: NOW + 3_600_000 } } } } }),
  )
  const api = clineApi({
    '/api/v1/users/me': { data: { id: 'u9' } },
    '/api/v1/users/u9/balance': { data: { balance: 0 } },
  })
  const meter = new ClineMeter({
    env: { CLINE_DATA_DIR: data, CLINE_API_BASE_URL: 'https://api.example.test/' },
    fetch: api.fetch,
    now: () => NOW,
  })
  assert.deepEqual(meter.watchPaths(), [join(data, 'settings', 'providers.json')])
  const reading = await meter.read()
  assert.equal(reading?.credits?.remaining, 0)
  assert.equal(reading?.reached, 'credits')
})
