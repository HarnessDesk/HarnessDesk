import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { bindingLane } from '@harnessdesk/protocol'
import { UsageReader, type UsageQuery } from '../src/usage.js'
import { HarnessDeskClaudeAgent } from '../src/bridge.js'
import { USAGE_READ } from '../src/usage.js'
import { scratch } from './scratch.js'

const payload = (used = 99) => ({ subscription_type: 'max', rate_limits_available: true,
  rate_limits: { seven_day: { utilization: used, resets_at: '2026-12-04T00:00:00Z' } } })
const cache = (path: string, email: string, used = 99, at = 100_000, uuid = email) => writeFileSync(path, JSON.stringify({
  oauthAccount: { emailAddress: email, accountUuid: email },
  cachedUsageUtilization: { accountUuid: uuid, fetchedAtMs: at, utilization: payload(used).rate_limits },
}))
const query = (email: string, read: () => Promise<unknown>): UsageQuery => ({
  accountInfo: async () => ({ email, subscriptionType: 'max', apiProvider: 'firstParty' }),
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: read,
})

test('ended session husks cannot hide a later healthy usage query, and all-ended sessions fall back', async t => {
  const ended = query('dev@example.com', async () => { throw new Error('closed transport') })
  const healthy = query('dev@example.com', async () => payload())
  const seen: UsageQuery[][] = []
  t.mock.method(UsageReader.prototype, 'read', async (queries: readonly UsageQuery[]) => {
    seen.push([...queries])
    return queries.length ? { lanes: [] } : null
  })
  const agent = new HarnessDeskClaudeAgent({ requestPermission: async () => ({}), sessionUpdate: async () => {} } as never,
    { stateDir: scratch('usage-session-husks-'), log: () => {} })
  agent.sessions['ended'] = { query: ended, queryClosed: true } as unknown as (typeof agent.sessions)[string]
  agent.sessions['healthy'] = { query: healthy, queryClosed: false } as unknown as (typeof agent.sessions)[string]
  await agent.extMethod(USAGE_READ, {})
  assert.deepEqual(seen[0], [healthy])
  agent.sessions['healthy']!.queryClosed = true
  assert.equal((await agent.extMethod(USAGE_READ, {}))['limits'], null)
  assert.deepEqual(seen[1], [])
})

test('a missing or mismatched source clock never becomes the time of the control request', async () => {
  const path = join(scratch('usage-clock-'), '.claude.json')
  const reader = new UsageReader(() => 110_000, () => 0, 100, path)
  cache(path, 'dev@example.com', 0)
  const result = await reader.read([query('dev@example.com', async () => payload())])
  assert.equal(result?.fetchedAt, 0, 'different figures cannot lend their timestamp')
})

test('subscriber eligibility accepts the CLI display plan name rather than assuming an enum', async () => {
  const path = join(scratch('usage-plan-name-'), '.claude.json')
  cache(path, 'dev@example.com', 99)
  const reader = new UsageReader(() => 110_000, () => 0, 100, path)
  const source = { ...query('dev@example.com', async () => payload(99)),
    accountInfo: async () => ({ apiProvider: 'firstParty', subscriptionType: 'Claude Ultra', email: 'dev@example.com' }) }
  const result = await reader.read([source])
  assert.equal(result?.lanes?.[0]?.usedPercent, 99)
  assert.equal(result?.planLimitsUnavailable, undefined)
})

for (const info of [
  { apiProvider: 'firstParty', subscriptionType: 'Claude Ultra' },
  { apiProvider: 'firstParty', email: 'dev@example.com' },
]) test(`incomplete first-party metadata leaves the file fallback reachable: ${Object.keys(info).join(',')}`, async () => {
  const path = join(scratch('usage-incomplete-account-'), '.claude.json')
  cache(path, 'dev@example.com')
  const source = { ...query('dev@example.com', async () => payload()), accountInfo: async () => info }
  assert.equal(await new UsageReader(() => 110_000, () => 0, 100, path).read([source]), null)
})

test('stalled initialization metadata is bounded and shared without stacking control requests', async () => {
  const path = join(scratch('usage-metadata-timeout-'), '.claude.json')
  cache(path, 'dev@example.com')
  let finish!: (value: unknown) => void
  const pending = new Promise(resolve => { finish = resolve })
  let calls = 0
  const source = { ...query('dev@example.com', async () => payload()), accountInfo: () => { calls++; return pending } }
  const reader = new UsageReader(() => 110_000, () => 0, 5, path)
  const work = Array.from({ length: 3 }, () => reader.read([source]))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([Promise.all(work), new Promise(resolve => { timer = setTimeout(() => resolve('still waiting'), 100) })])
    assert.deepEqual(result, [null, null, null])
    assert.equal(calls, 1)
  } finally {
    clearTimeout(timer)
    finish({ apiProvider: 'firstParty', subscriptionType: 'max', email: 'dev@example.com' })
    await Promise.allSettled(work)
  }
  assert.equal((await reader.read([source]))?.lanes?.[0]?.usedPercent, 99)
  assert.equal(calls, 1, 'the completed initialization metadata is reused')
})

test('a replacement query can recover after a timed-out closed query without losing its own pending guard', async () => {
  const path = join(scratch('usage-replaced-query-'), '.claude.json')
  cache(path, 'dev@example.com')
  let now = 110_000, replacements = 0
  let finishOld!: (value: unknown) => void, finishNew!: (value: unknown) => void
  const oldRequest = new Promise(resolve => { finishOld = resolve })
  const newRequest = new Promise(resolve => { finishNew = resolve })
  const old = query('dev@example.com', () => oldRequest)
  const replacement = query('dev@example.com', () => { replacements++; return newRequest })
  const reader = new UsageReader(() => now, () => 0, 5, path)
  try {
    await assert.rejects(reader.read([old]), /refresh usage/)
    now += 20 * 60_000
    await assert.rejects(reader.read([replacement]), /refresh usage/)
    assert.equal(replacements, 1)
    finishOld(payload())
    await oldRequest
    now += 20 * 60_000
    await assert.rejects(reader.read([replacement]), /still pending/)
    assert.equal(replacements, 1, 'the old request finishing does not clear the replacement guard')
  } finally { finishOld(payload()); finishNew(payload()); await Promise.all([oldRequest, newRequest]) }
})

test('modern active rows date the response without legacy reset precision or inactive scoped placeholders', async () => {
  const path = join(scratch('usage-modern-'), '.claude.json')
  const response = { ...payload(), rate_limits: {
    seven_day: { utilization: 99, resets_at: '2026-12-04T00:00:00.100Z' },
    model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: '2026-12-04T00:00:00Z' }],
    limits: [
      { kind: 'weekly_all', percent: 99, resets_at: '2026-12-04T00:00:00.300Z', is_active: true },
      { kind: 'weekly_scoped', percent: 0, resets_at: '2026-12-04T00:00:00Z', is_active: false,
        scope: { model: { display_name: 'Fable' } } },
    ],
  } }
  writeFileSync(path, JSON.stringify({ oauthAccount: { accountUuid: 'fixture-account', emailAddress: 'dev@example.com' },
    cachedUsageUtilization: { accountUuid: 'fixture-account', fetchedAtMs: 100_000, utilization: response.rate_limits } }))
  const reader = new UsageReader(() => 110_000, () => 0, 100, path)
  const result = await reader.read([query('dev@example.com', async () => response)])
  assert.equal(result?.lanes?.length, 1)
  assert.equal(result?.lanes?.[0]?.usedPercent, 99)
  assert.equal(result?.lanes?.[0]?.resetsAt, Date.parse('2026-12-04T00:00:00.300Z'))
  assert.equal(result?.fetchedAt, 100_000)
})

test('saved file-meter lane pins survive a switch to the live source', async () => {
  const path = join(scratch('usage-lane-pin-'), '.claude.json')
  const response = { ...payload(), rate_limits: { limits: [
    { kind: 'session', percent: 30, resets_at: '2026-12-01T00:00:00Z', is_active: true },
    { kind: 'weekly_all', percent: 99, resets_at: '2026-12-04T00:00:00Z', is_active: true },
    { kind: 'weekly_scoped', percent: 20, resets_at: '2026-12-04T00:00:00Z', is_active: true,
      scope: { model: { display_name: 'Fable' } } },
  ] } }
  writeFileSync(path, JSON.stringify({ oauthAccount: { accountUuid: 'fixture-account', emailAddress: 'dev@example.com' },
    cachedUsageUtilization: { accountUuid: 'fixture-account', fetchedAtMs: 100_000, utilization: response.rate_limits } }))
  const reader = new UsageReader(() => 110_000, () => 0, 100, path)
  const result = await reader.read([query('dev@example.com', async () => response)])
  assert.deepEqual(result?.lanes?.map(lane => lane.id), ['session', 'weekly_all', 'weekly_scoped:fable'])
  assert.equal(bindingLane(result!.lanes!, { pinLaneId: 'weekly_all' })?.label, 'Weekly')
})

test('modern rows retain severity, reached limits, other windows and named or id scopes', async () => {
  const path = join(scratch('usage-row-parity-'), '.claude.json')
  const response = { ...payload(), rate_limits: { limits: [
    { kind: 'weekly_all', percent: 99, severity: 'warn', resets_at: '2026-12-04T00:00:00Z' },
    { kind: 'weekly_scoped', percent: 100, severity: 'critical', scope: { model: { id: 'sample-model' } } },
    { kind: 'daily_custom', group: 'daily', percent: 20, severity: 'normal', scope: { surface: { display_name: 'Desktop' } } },
    { kind: 'monthly_custom', group: 'monthly', percent: 30 },
  ] } }
  writeFileSync(path, JSON.stringify({ oauthAccount: { accountUuid: 'fixture-account', emailAddress: 'dev@example.com' },
    cachedUsageUtilization: { accountUuid: 'fixture-account', fetchedAtMs: 100_000, utilization: response.rate_limits } }))
  const result = await new UsageReader(() => 110_000, () => 0, 100, path).read([query('dev@example.com', async () => response)])
  assert.deepEqual(result?.lanes?.map(lane => [lane.id, lane.scope ?? null, lane.windowMinutes, lane.severity]), [
    ['weekly_all', null, 10_080, 'warning'], ['weekly_scoped:sample-model', 'sample-model', 10_080, 'critical'],
    ['daily_custom:desktop', 'Desktop', 1_440, 'normal'], ['monthly_custom', null, 43_200, null],
  ])
  assert.equal(result?.reached, 'weekly_scoped:sample-model')
  assert.equal(result?.fetchedAt, 100_000)
})

test('a matching subset cannot borrow the clock of a cache with another measured limit', async () => {
  const path = join(scratch('usage-clock-subset-'), '.claude.json')
  const response = { ...payload(), rate_limits: { limits: [{ kind: 'weekly_all', percent: 99 }] } }
  writeFileSync(path, JSON.stringify({ oauthAccount: { accountUuid: 'fixture-account', emailAddress: 'dev@example.com' },
    cachedUsageUtilization: { accountUuid: 'fixture-account', fetchedAtMs: 100_000, utilization: { limits: [
      ...response.rate_limits.limits, { kind: 'session', percent: 100, severity: 'critical' },
    ] } } }))
  const result = await new UsageReader(() => 110_000, () => 0, 100, path).read([query('dev@example.com', async () => response)])
  assert.equal(result?.fetchedAt, 0)
})

for (const mismatch of [false, true]) test(`a seeded legacy reply preserves modern cache identity only with complete matching aliases: mismatch=${mismatch}`, async () => {
  const path = join(scratch('usage-seeded-modern-'), '.claude.json')
  const aliases = payload().rate_limits
  writeFileSync(path, JSON.stringify({ oauthAccount: { accountUuid: 'fixture-account', emailAddress: 'dev@example.com' },
    cachedUsageUtilization: { accountUuid: 'fixture-account', fetchedAtMs: 100_000, utilization: { ...aliases, limits: [
      { kind: 'weekly_all', percent: 99, severity: 'warn', resets_at: aliases.seven_day.resets_at },
    ] } } }))
  const result = await new UsageReader(() => 110_000, () => 0, 100, path)
    .read([query('dev@example.com', async () => payload(mismatch ? 98 : 99))])
  assert.equal(result?.fetchedAt, mismatch ? 0 : 100_000)
  if (!mismatch) {
    assert.equal(result?.lanes?.[0]?.id, 'weekly_all')
    assert.equal(result?.lanes?.[0]?.severity, 'warning')
    assert.equal(bindingLane(result!.lanes!, { pinLaneId: 'weekly_all' })?.id, 'weekly_all')
  }
})

test('a seeded reply missing a measured legacy alias cannot borrow a modern cache clock', async () => {
  const path = join(scratch('usage-seeded-subset-'), '.claude.json')
  writeFileSync(path, JSON.stringify({ oauthAccount: { accountUuid: 'fixture-account', emailAddress: 'dev@example.com' },
    cachedUsageUtilization: { accountUuid: 'fixture-account', fetchedAtMs: 100_000, utilization: {
      ...payload().rate_limits, five_hour: { utilization: 100 }, limits: [
        { kind: 'weekly_all', percent: 99 }, { kind: 'session', percent: 100, severity: 'critical' },
      ],
    } } }))
  assert.equal((await new UsageReader(() => 110_000, () => 0, 100, path)
    .read([query('dev@example.com', async () => payload())]))?.fetchedAt, 0)
})

test('seeded model projections must match measured modern scopes before adopting cache identities', async () => {
  const path = join(scratch('usage-seeded-scopes-'), '.claude.json')
  const aliases = payload().rate_limits
  const limits = [{ kind: 'weekly_all', percent: 99, resets_at: aliases.seven_day.resets_at },
    { kind: 'weekly_scoped', percent: 100, severity: 'critical', resets_at: aliases.seven_day.resets_at,
      scope: { model: { display_name: 'Fable' } } }]
  writeFileSync(path, JSON.stringify({ oauthAccount: { accountUuid: 'fixture-account', emailAddress: 'dev@example.com' },
    cachedUsageUtilization: { accountUuid: 'fixture-account', fetchedAtMs: 100_000, utilization: { ...aliases, limits } } }))
  for (const used of [100, 90]) {
    const response = { ...payload(), rate_limits: { ...aliases,
      model_scoped: [{ display_name: 'Fable', utilization: used, resets_at: aliases.seven_day.resets_at }] } }
    const result = await new UsageReader(() => 110_000, () => 0, 100, path).read([query('dev@example.com', async () => response)])
    assert.equal(result?.fetchedAt, used === 100 ? 100_000 : 0)
    if (used === 100) assert.equal(result?.reached, 'weekly_scoped:fable')
  }
})

test('an explicit modern array is not mistaken for the CLI seeded projection', async () => {
  const path = join(scratch('usage-explicit-modern-empty-'), '.claude.json')
  const aliases = payload().rate_limits
  writeFileSync(path, JSON.stringify({ oauthAccount: { accountUuid: 'fixture-account', emailAddress: 'dev@example.com' },
    cachedUsageUtilization: { accountUuid: 'fixture-account', fetchedAtMs: 100_000, utilization: {
      ...aliases, limits: [{ kind: 'weekly_all', percent: 99, resets_at: aliases.seven_day.resets_at }],
    } } }))
  const response = { ...payload(), rate_limits: { ...aliases, limits: [] } }
  assert.equal((await new UsageReader(() => 110_000, () => 0, 100, path)
    .read([query('dev@example.com', async () => response)]))?.fetchedAt, 0)
})

test('no live query leaves the newer file fallback reachable', async () => {
  const path = join(scratch('usage-close-'), '.claude.json')
  cache(path, 'dev@example.com')
  const reader = new UsageReader(() => 110_000, () => 0, 100, path)
  assert.equal((await reader.read([query('dev@example.com', async () => payload())]))?.fetchedAt, 100_000)
  assert.equal(await reader.read([]), null)
})

test('changing identity during the cooldown cannot return the previous account reading', async () => {
  const path = join(scratch('usage-identity-'), '.claude.json')
  const reader = new UsageReader(() => 110_000, () => 0, 100, path)
  let calls = 0
  const first = query('first@example.com', async () => { calls++; return payload(99) })
  const second = query('second@example.com', async () => { calls++; return payload(20) })
  cache(path, 'first@example.com', 99)
  await reader.read([first])
  cache(path, 'second@example.com', 20)
  const result = await reader.read([first, second])
  assert.equal(result?.account, 'second@example.com')
  assert.equal(result?.lanes?.[0]?.usedPercent, 20)
  assert.equal(calls, 2)
})

test('a subscriber with an old initialization identity leaves the new login file reachable', async () => {
  const path = join(scratch('usage-login-change-'), '.claude.json')
  cache(path, 'second@example.com', 20)
  const reader = new UsageReader(() => 110_000, () => 0, 100, path)
  const old = query('first@example.com', async () => payload(99))
  assert.equal(await reader.read([old]), null)
})

test('extra usage preserves its monetary balance and billing kind', async () => {
  const path = join(scratch('usage-money-'), '.claude.json')
  cache(path, 'dev@example.com')
  const response = { ...payload(), rate_limits: { ...payload().rate_limits,
    extra_usage: { is_enabled: true, utilization: 60, monthly_limit: 50, used_credits: 30, currency: 'USD' } } }
  const reader = new UsageReader(() => 110_000, () => 0, 100, path)
  const result = await reader.read([query('dev@example.com', async () => response)])
  assert.deepEqual(result?.credits, { remaining: 20, unit: 'USD' })
  assert.deepEqual(result?.billing?.kinds, ['windows', 'metered'])
})

test('a timed-out control remains single-flight even when its retry budget expires', async () => {
  const path = join(scratch('usage-timeout-'), '.claude.json')
  cache(path, 'dev@example.com')
  let now = 110_000, calls = 0
  let finish!: (value: unknown) => void
  const pending = new Promise<unknown>(resolve => { finish = resolve })
  const reader = new UsageReader(() => now, () => 0, 5, path)
  const source = query('dev@example.com', async () => { calls++; return pending })
  await assert.rejects(reader.read([source]), /refresh usage/)
  now += 20 * 60_000
  await assert.rejects(reader.read([source]), /still pending/)
  assert.equal(calls, 1)
  finish(payload())
  await pending
})
