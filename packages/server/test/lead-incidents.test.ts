import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { initialLeadState, reduceLeadBudget } from '@harnessdesk/lead'

const rig = async (t: TestContext) => {
  const { LeadChatIncidents } = await import('../src/lead/' + 'incidents.js')
  const home = await mkdtemp('/tmp/hd-incidents-'), file = join(home, 'incidents.json')
  let now = 1000, allowed = true, busy = false
  let retryHook: (() => Promise<void | 'not-started'>) | undefined, retryCurrent: (() => boolean) | undefined
  const problems: string[] = []
  const scheduled = new Map<() => void, number>(), retries: string[] = [], wakes: any[] = []
  const state = { ...initialLeadState(), policy: { version: 1, revision: 7, mode: 'manage', rules: [{ id: 'deny-publish', effect: 'deny', method: 'git/*' }] }, workerApprovals: [{ id: 'saved-rule', contractDigest: 'a'.repeat(64), goalStartedSeq: 1, key: { kind: 'tool', tool: 'read' }, target: 'Read files', count: 4 }], budget: reduceLeadBudget(null, { version: 1, type: 'initialize', logicalGoalId: 'fixture', now,
    freshnessMs: 60_000, caps: { usdMicros: 10000, rounds: 3 } }) }
  const before = JSON.stringify(state)
  const ports = { file, project: 'fixture-project', now: () => now,
    schedule: (run: () => void, delay: number) => { scheduled.set(run, now + delay); return () => { scheduled.delete(run) } },
    problem: (reason: string) => { problems.push(reason) }, busy: () => busy, allowed: async () => allowed, retry: async (id: string, current: () => boolean, started: () => void) => { retryCurrent = current; retries.push(id); const result = await retryHook?.(); if (result !== 'not-started' && current()) started(); return result },
    publish: async (incident: any) => { wakes.push(incident) } }
  let service = new LeadChatIncidents(ports)
  t.after(async () => { service.close(); await service.idle(); await rm(home, { recursive: true, force: true }) })
  return { get service() { return service }, retries, wakes, scheduled, state, before, file,
    problems, revoke: () => { allowed = false }, allow: () => { allowed = true }, setBusy: (value: boolean) => { busy = value },
    elapse: (ms: number) => { now += ms },
    currentRetry: () => retryCurrent?.(),
    onRetry: (hook: () => Promise<void | 'not-started'>) => { retryHook = hook },
    restart: async () => { service.close(); service = new LeadChatIncidents(ports); await service.restore() },
    advance: async (ms: number) => { now += ms; for (const [run, at] of [...scheduled]) if (at <= now) { scheduled.delete(run); run() }; await service.idle() },
  }
}

test('quota waits on the named provider window, retries twice, then asks; waiting costs no allowance', async t => {
  const r = await rig(t)
  const limits = { reached: 'Weekly', windows: [{ label: 'Weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: 5000 }] }
  await r.service.ended('fixture:chat', 'turn-1', { code: 'rateLimit', message: 'Quota for dev@example.com at /tmp/private/file' }, limits)
  assert.equal(r.service.get('fixture:chat')?.state, 'waiting-reset')
  assert.equal(r.service.get('fixture:chat')?.resetsAt, 5000)
  await r.advance(3999)
  assert.deepEqual(r.retries, []); assert.equal(r.wakes.length, 0)
  assert.equal(JSON.stringify(r.state), r.before, 'no reserve, charge, round, policy or approval write during wait')
  await r.advance(2000)
  assert.deepEqual(r.retries, ['fixture:chat'])
  await r.service.ended('fixture:chat', 'turn-2', { code: 'rateLimit', message: 'Quota' }, limits)
  await r.advance(299_999)
  assert.equal(r.retries.length, 1, 'stale reset uses five-minute backoff')
  await r.advance(1)
  assert.equal(r.retries.length, 2)
  await r.service.ended('fixture:chat', 'turn-3', { code: 'rateLimit', message: 'Quota' }, limits)
  assert.equal(r.wakes.length, 1); assert.equal(r.wakes[0]!.attempts, 2)
  await r.service.ended('fixture:chat', 'turn-3', { code: 'rateLimit', message: 'Quota' }, limits)
  assert.equal(r.wakes.length, 1, 'duplicate completion is not another incident')
  await r.service.ended('fixture:chat', 'turn-4', null)
  assert.equal(r.service.get('fixture:chat')?.state, 'cleared')
  assert.equal(JSON.stringify(r.state), r.before)
})

test('restart mid-wait and overdue restart claim exactly one retry', async t => {
  const r = await rig(t)
  await r.service.ended('fixture:chat', 'one', { code: 'network', message: 'Offline', retrying: false })
  await r.advance(30_000); await r.restart(); await r.advance(29_999)
  assert.equal(r.retries.length, 0)
  await r.advance(1); assert.equal(r.retries.length, 1)
  await r.restart(); await r.advance(600_000)
  assert.equal(r.retries.length, 1, 'an already claimed retry cannot replay after restart')
  assert.equal(r.wakes.at(-1)?.state, 'asked', 'uncertain in-flight recovery asks instead of replaying')
})

for (const code of ['credits', 'auth', 'versionGate', 'sandboxDenied', 'unknown'] as const) test(`${code} asks immediately without retry and scrubs persisted errors`, async t => {
  const r = await rig(t)
  await r.service.ended('fixture:chat', 'one', { code, message: 'dev@example.com /tmp/private/file token=secret ' + 'x'.repeat(1000) })
  assert.equal(r.wakes.length, 1); assert.equal(r.scheduled.size, 0)
  assert.equal(r.service.get('fixture:chat')?.state, 'asked')
  const disk = await readFile(r.file, 'utf8')
  assert.doesNotMatch(disk, /dev@example.com|private\/file|token=secret/)
  assert.ok(r.service.get('fixture:chat')!.lastError!.message.length <= 300)
})

test('person hold or scope withdrawal creates no incident, retries or wakes; cancellation stops existing waits', async t => {
  const r = await rig(t); r.revoke()
  await r.service.ended('fixture:held', 'one', { code: 'credits', message: 'No credit' })
  assert.equal(r.service.get('fixture:held'), undefined); assert.equal(r.wakes.length, 0)
  const s = await rig(t)
  await s.service.ended('fixture:chat', 'one', { code: 'network', message: 'Offline' })
  s.service.cancel(); await s.service.idle(); await s.advance(600_000)
  assert.equal(s.retries.length, 0); assert.equal(s.wakes.length, 0)
  assert.equal(s.service.get('fixture:chat')?.state, 'stopped')
})

test('a move is durable and cannot move an incident twice; the new chat starts fresh', async t => {
  const r = await rig(t)
  await r.service.ended('fixture:old', 'one', { code: 'credits', message: 'No credit' })
  await r.service.moved('fixture:old', 'other:new')
  assert.equal(r.service.get('fixture:old')?.movedTo, 'other:new')
  await assert.rejects(r.service.moved('fixture:old', 'third:duplicate'), /moved|incident/i)
  await r.service.ended('other:new', 'one', { code: 'credits', message: 'No credit' })
  assert.equal(r.service.get('other:new')?.attempts, 0)
  assert.equal(JSON.stringify(r.state), r.before)
})

test('every new failed turn republishes an asked incident, including identical failures', async t => {
  const r = await rig(t)
  await r.service.ended('fixture:chat', 'one', { code: 'credits', message: 'No credit' })
  await r.service.ended('fixture:chat', 'two', { code: 'auth', message: 'Sign in' })
  assert.equal(r.wakes.length, 2)
  await r.advance(1000)
  await r.service.ended('fixture:chat', 'three', { code: 'auth', message: 'Sign in' })
  assert.equal(r.wakes.length, 3)
  await r.service.ended('fixture:chat', 'three', { code: 'auth', message: 'Sign in' })
  assert.equal(r.wakes.length, 3)
})


test('an in-flight ordinary send never holds the incident writer needed by Stop', async t => {
  const r = await rig(t)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  r.onRetry(() => held)
  await r.service.ended('fixture:chat', 'one', { code: 'network', message: 'Offline' })
  const advance = r.advance(60_000)
  try {
    while (!r.retries.length) await new Promise(resolve => setTimeout(resolve, 1))
    const stopped = r.service.stop('fixture:chat')
    let settled = false; void stopped.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(settled, true, 'Stop must not wait for the ordinary send holding the other tail')
  } finally { release(); await advance }
})

test('missing or unmatched reset windows use one minute then five minutes and adapter retries stay owned by the adapter', async t => {
  const r = await rig(t)
  await r.service.ended('fixture:chat', 'adapter', { code: 'network', message: 'Recovering', retrying: true })
  assert.equal(r.service.get('fixture:chat'), undefined)
  await r.service.ended('fixture:chat', 'one', { code: 'rateLimit', message: 'Quota' }, { reached: 'Weekly', windows: [{ label: 'Daily', usedPercent: 100, windowMinutes: 1440, resetsAt: 3000 }] })
  assert.equal(r.service.get('fixture:chat')?.resetsAt, null)
  await r.advance(59_999); assert.equal(r.retries.length, 0)
  await r.advance(1); assert.equal(r.retries.length, 1)
  await r.service.ended('fixture:chat', 'two', { code: 'interrupted', message: 'Connection interrupted', retrying: false })
  await r.advance(299_999); assert.equal(r.retries.length, 1)
  await r.advance(1); assert.equal(r.retries.length, 2)
})

test('incident storage and timers stay within the tracked-chat bound', async t => {
  const r = await rig(t)
  for (let i = 0; i < 65; i++) await r.service.ended(`fixture:chat-${i}`, 'one', { code: 'network', message: 'Offline' })
  assert.equal(r.service.get('fixture:chat-0'), undefined)
  assert.equal(JSON.parse(await readFile(r.file, 'utf8')).records.length, 64)
  assert.equal(r.scheduled.size, 64)
})


test('successful work after Stop clears the incident, and a later failure begins fresh', async t => {
  const r = await rig(t)
  await r.service.ended('fixture:chat', 'one', { code: 'credits', message: 'No credit' })
  await r.service.stop('fixture:chat')
  await r.service.ended('fixture:chat', 'two', null)
  assert.equal(r.service.get('fixture:chat')?.state, 'cleared')
  await r.service.ended('fixture:chat', 'three', { code: 'network', message: 'Offline' })
  assert.equal(r.service.get('fixture:chat')?.attempts, 0)
  assert.equal(r.service.get('fixture:chat')?.state, 'waiting-reset')
  assert.equal(JSON.stringify(r.state), r.before, 'policy, caps and nonempty saved approvals are unchanged through all transitions')
})


test('simultaneously overdue chats serialize their ordinary sends without locking incident Stop', async t => {
  const r = await rig(t)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let first = true
  r.onRetry(async () => { if (first) { first = false; await held } })
  for (const id of ['fixture:first', 'fixture:second']) await r.service.ended(id, 'one', { code: 'network', message: 'Offline' })
  const advanced = r.advance(60_000)
  try {
    while (!r.retries.length) await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(r.retries.length, 1, 'only one ordinary mutation is admitted at once')
    await r.service.stop('fixture:first')
  } finally { release(); await advanced }
  assert.equal(r.retries.length, 2)
})


test('a retry accepted into the ordinary queue retains its synchronous Stop fence', async t => {
  const r = await rig(t)
  await r.service.ended('fixture:chat', 'one', { code: 'network', message: 'Offline' })
  await r.advance(60_000)
  assert.equal(r.currentRetry(), true, 'accepted queued delivery keeps its claim')
  const stopping = r.service.stop('fixture:chat')
  assert.equal(r.currentRetry(), false, 'Stop revokes even before the durable write yields')
  await stopping
})

for (const content of ['{private truncated', JSON.stringify({ version: 99, project: 'fixture-project', records: [] })]) test('invalid incident files recover empty, log no content and allow future wakes', async t => {
  const r = await rig(t)
  await writeFile(r.file, content)
  await r.service.restore()
  await r.service.ended('fixture:chat', 'one', { code: 'credits', message: 'No credit' })
  assert.equal(r.wakes.length, 1)
  assert.equal(r.problems.length, 1)
  assert.doesNotMatch(r.problems.join(''), /private|99/)
  assert.equal(JSON.parse(await readFile(r.file, 'utf8')).records.length, 1)
})

test('loading salvages valid records individually and bounds an oversized record list', async t => {
  const r = await rig(t)
  await r.service.ended('fixture:good', 'one', { code: 'credits', message: 'No credit' })
  const disk = JSON.parse(await readFile(r.file, 'utf8')), good = disk.records[0]
  disk.records = [good, { ...good, chatId: 'fixture:bad', lastError: { code: 'future-code', message: 'private' } }]
  await writeFile(r.file, JSON.stringify(disk)); await r.restart()
  assert.equal(r.service.get('fixture:good')?.state, 'asked')
  assert.equal(r.service.get('fixture:bad'), undefined)
  await r.service.ended('fixture:good', 'two', { code: 'credits', message: 'No credit' })
  assert.equal(r.wakes.length, 2)
  disk.records = Array.from({ length: 65 }, (_, i) => ({ ...good, chatId: `fixture:chat-${i}` }))
  await writeFile(r.file, JSON.stringify(disk)); await r.restart()
  assert.equal(r.service.get('fixture:chat-0'), undefined)
  assert.equal(r.service.get('fixture:chat-64')?.state, 'asked')
  await r.service.ended('fixture:new', 'one', { code: 'credits', message: 'No credit' })
  assert.equal(JSON.parse(await readFile(r.file, 'utf8')).records.length, 64)
})

test('a stopped chat can fail freshly after take-over and hand-back without an intervening success', async t => {
  const r = await rig(t)
  await r.service.ended('fixture:chat', 'one', { code: 'credits', message: 'No credit' })
  await r.service.stop('fixture:chat'); r.revoke()
  await r.service.ended('fixture:chat', 'held', { code: 'network', message: 'Offline' })
  r.allow()
  await r.service.ended('fixture:chat', 'two', { code: 'network', message: 'Offline' })
  assert.equal(r.service.get('fixture:chat')?.state, 'waiting-reset')
  assert.equal(r.service.get('fixture:chat')?.attempts, 0)
})

test('temporary admission failures back off then ask instead of silently stopping', async t => {
  const r = await rig(t)
  await r.service.ended('fixture:chat', 'one', { code: 'network', message: 'Offline' })
  r.revoke(); await r.advance(60_000)
  assert.equal(r.service.get('fixture:chat')?.state, 'waiting-reset')
  assert.equal(r.retries.length, 0)
  await r.advance(60_000)
  assert.equal(r.service.get('fixture:chat')?.state, 'asked')
  assert.equal(r.wakes.length, 1)
  assert.equal(r.service.get('fixture:chat')?.attempts, 0)
})

test('a busy chat defers a due retry without consuming an automatic attempt', async t => {
  const r = await rig(t)
  await r.service.ended('fixture:chat', 'one', { code: 'network', message: 'Offline' })
  r.setBusy(true); await r.advance(60_000)
  assert.equal(r.retries.length, 0); assert.equal(r.service.get('fixture:chat')?.attempts, 0)
  r.setBusy(false); await r.advance(60_000)
  assert.equal(r.retries.length, 1); assert.equal(r.service.get('fixture:chat')?.attempts, 1)
})

test('a reset already in the past uses the one-minute backoff, including at initial failure', async t => {
  const r = await rig(t)
  await r.service.ended('fixture:chat', 'one', { code: 'rateLimit', message: 'Quota' }, { reached: 'Daily', windows: [{ label: 'Daily', resetsAt: 1000, usedPercent: 100, windowMinutes: 1440 }] })
  await r.advance(59_999); assert.equal(r.retries.length, 0)
  await r.advance(1); assert.equal(r.retries.length, 1)
})

test('an overdue persisted reset fires once after restart and preserves policy, caps and approvals', async t => {
  const r = await rig(t)
  await r.service.ended('fixture:chat', 'one', { code: 'rateLimit', message: 'Quota' }, { reached: 'Daily', windows: [{ label: 'Daily', resetsAt: 2000, usedPercent: 100, windowMinutes: 1440 }] })
  r.elapse(60_000); await r.restart(); await r.advance(0); await r.advance(60_000)
  assert.equal(r.retries.length, 1)
  assert.equal(JSON.stringify(r.state), r.before)
})


test('a chosen reset retry starts a fresh bounded generation and fires once on the provider clock', async t => {
  const r = await rig(t)
  await r.service.ended('fixture:chat', 'one', { code: 'network', message: 'Offline' }); await r.advance(60_000)
  await r.service.ended('fixture:chat', 'two', { code: 'network', message: 'Offline' }); await r.advance(300_000)
  await r.service.ended('fixture:chat', 'three', { code: 'rateLimit', message: 'Quota' }, { reached: 'Daily', windows: [{ label: 'Daily', resetsAt: 400_000, usedPercent: 100, windowMinutes: 1440 }] })
  assert.equal(r.service.get('fixture:chat')?.attempts, 2)
  await r.service.beginRetry('fixture:chat', true)
  assert.equal(r.service.get('fixture:chat')?.attempts, 0)
  await r.advance(38_999); assert.equal(r.retries.length, 2)
  await r.advance(2000); assert.equal(r.retries.length, 3)
  await r.advance(60_000); assert.equal(r.retries.length, 3)
  assert.equal(JSON.stringify(r.state), r.before)
})


test('a proven pre-effect retry refusal backs off without consuming the automatic attempt bound', async t => {
  const r = await rig(t)
  r.onRetry(async () => 'not-started')
  await r.service.ended('fixture:chat', 'one', { code: 'network', message: 'Offline' })
  await r.advance(60_000)
  assert.equal(r.service.get('fixture:chat')?.state, 'waiting-reset')
  assert.equal(r.service.get('fixture:chat')?.attempts, 0)
  await r.advance(60_000)
  assert.equal(r.service.get('fixture:chat')?.state, 'asked')
  assert.equal(r.service.get('fixture:chat')?.attempts, 0)
  assert.equal(r.wakes.length, 1)
})


test('a superseding turn revokes an undispatched retry before its incident write can yield', async t => {
  const r = await rig(t)
  let release!: () => void
  r.onRetry(() => new Promise<void>(resolve => { release = resolve }))
  await r.service.ended('fixture:chat', 'one', { code: 'network', message: 'Offline' })
  const advanced = r.advance(60_000)
  try {
    while (!release) await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(r.currentRetry(), true)
    const ending = r.service.ended('fixture:chat', 'two', { code: 'network', message: 'Person follow-up failed' })
    // Drain promise continuations, without allowing the atomic file write to finish.
    for (let i = 0; i < 20; i++) await Promise.resolve()
    assert.equal(r.currentRetry(), false, 'revoked synchronously before the successor persistence yields')
    await ending
    assert.equal(r.service.get('fixture:chat')?.attempts, 0)
  } finally { release?.(); await advanced }
})
