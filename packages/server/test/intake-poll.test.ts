import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { TriggerFact } from '@harnessdesk/protocol'

import type { ArmedTrigger } from '../src/intake/consent.js'
import { ForgeSource, type MentionPull, type MentionSubscriber } from '../src/intake/forge.js'
import { IntakeMonitor, intakeSources, SourceCursors } from '../src/intake/poll.js'
import { armOf, Clocks, FakeForge, FakeTimers, Gate, settle, sha, iso } from './fixtures/intake-forge.js'
import { tempDir } from './scratch.js'

/*
 * One bounded poll per project and source, however many triggers watch it;
 * a cursor that moves only after every fact it covers has a durable answer;
 * and a source whose reads fail says so, backs off, and loses nothing.
 */

const MINUTE = 60_000
const ARMED = Date.UTC(2026, 8, 1, 10)

interface Rig {
  forge: FakeForge
  clocks: Clocks
  timers: FakeTimers
  arms: ArmedTrigger[]
  offers: [string, string, string][]
  routes: (MentionSubscriber | undefined)[]
  offerFails: ((fact: TriggerFact) => boolean) | null
  /** Holds each offer until opened: admission in flight. */
  offerGate: Gate | null
  /** Resolves when an offer is held at `offerGate`. */
  offerHeld: Gate
  cursors: SourceCursors
  home: string
  monitor: IntakeMonitor
}

const rig = (options: { home?: string; write?: (file: string, value: unknown) => Promise<void>; linked?: () => Promise<readonly MentionPull[]>; loseRoutes?: () => boolean } = {}): Rig => {
  const forge = new FakeForge()
  const clocks = new Clocks(ARMED)
  const timers = new FakeTimers()
  const home = options.home ?? tempDir('hd-intake-poll-')
  const cursors = new SourceCursors(home, options.write ? { write: options.write } : {})
  const state: Rig = {
    forge, clocks, timers, arms: [], offers: [], routes: [], offerFails: null, offerGate: null, offerHeld: new Gate(), cursors, home,
    monitor: undefined as unknown as IntakeMonitor,
  }
  const source = intakeSources(new ForgeSource({ run: forge.runner, now: () => clocks.wall }), options.linked)
  state.monitor = new IntakeMonitor({
    armed: async () => state.arms,
    sources: { ...source, poll: async (...args) => { const batch = await source.poll(...args); return options.loseRoutes?.() ? { ...batch, mentionRoutes: undefined } : batch } },
    cursors,
    offer: async (arm, fact, _batch, route) => {
      if (state.offerGate) {
        state.offerHeld.open()
        await state.offerGate.opened
      }
      if (state.offerFails?.(fact)) throw new Error('admission could not record it')
      state.offers.push([arm.id, fact.action, fact.subject])
      state.routes.push(route)
    },
    wall: () => clocks.wall,
    monotonic: () => clocks.mono,
    timers,
  })
  return state
}

const lists = (forge: FakeForge): number => forge.calls.filter((path) => path.includes('pulls?state=all')).length
const cursorFile = (home: string): Promise<string> => readFile(join(home, 'triggers-cursors.json'), 'utf8').catch(() => '')

test('two triggers share one bounded poll', async () => {
  const r = rig()
  r.arms = [armOf('review-a'), armOf('review-b')]
  assert.equal(await r.monitor.baseline(r.arms[0]!), ARMED)
  assert.equal(await r.monitor.baseline(r.arms[1]!), ARMED, 'a second arm on a watched source reuses its cursor')
  r.forge.pulls.push({ number: 2, head: sha('c'), state: 'open', created: ARMED + MINUTE, updated: ARMED + MINUTE })
  r.clocks.advance(2 * MINUTE)
  r.forge.gate = new Gate()
  const first = r.monitor.tick(r.clocks.wall)
  const second = r.monitor.tick(r.clocks.wall)
  await r.forge.reached(1)
  r.forge.gate.open()
  r.forge.gate = null
  await Promise.all([first, second])
  assert.equal(lists(r.forge), 1, 'one read for two triggers and two ticks')
  assert.deepEqual(r.offers, [['review-a', 'opened', '2'], ['review-b', 'opened', '2']])

  // Paced: nothing sooner than a minute after the last poll of this source.
  r.clocks.advance(30_000)
  await r.monitor.tick(r.clocks.wall)
  assert.equal(lists(r.forge), 1)
  r.clocks.advance(30_000)
  await r.monitor.tick(r.clocks.wall)
  assert.equal(lists(r.forge), 2)

  // Machine-wide, at most two sources read at once; the third waits for a later tick.
  r.arms = ['/work/one', '/work/two', '/work/three'].map((project, index) => armOf(`t${index}`, { project }))
  for (const arm of r.arms) await r.monitor.baseline(arm)
  r.clocks.advance(2 * MINUTE)
  r.forge.gate = new Gate()
  const busy = r.monitor.tick(r.clocks.wall)
  await r.forge.reached(2)
  assert.equal(r.forge.waiting, 2)
  r.forge.gate.open()
  r.forge.gate = null
  await busy
  const before = lists(r.forge)
  await r.monitor.tick(r.clocks.wall)
  assert.equal(lists(r.forge), before + 1, 'the third source is read on the next tick')
  await r.monitor.close()
})

test('partial scan or failed admission never advances coverage', async () => {
  const r = rig()
  r.arms = [armOf('review')]
  await r.monitor.baseline(r.arms[0]!)
  const baseline = await cursorFile(r.home)
  const watermark = (text: string): number => (JSON.parse(text) as { cursors: Record<string, { observedThrough: number }> }).cursors[Object.keys(JSON.parse(text).cursors)[0]!]!.observedThrough

  // A failure on the second page: nothing offered, nothing committed.
  for (let number = 1; number <= 150; number += 1) {
    r.forge.pulls.push({ number, head: sha((number % 10).toString()), state: 'open', created: ARMED + number, updated: ARMED + number })
  }
  r.forge.fail = (path) => path.includes('state=all') && path.endsWith('page=2') ? { exitCode: 1, stderr: 'HTTP 502: Bad Gateway' } : null
  r.clocks.advance(2 * MINUTE)
  await r.monitor.tick(r.clocks.wall)
  assert.deepEqual(r.offers, [])
  assert.equal(await cursorFile(r.home), baseline)
  r.forge.fail = null

  // Admission cannot record the 100th fact: the first 99 had answers, but the cursor stays.
  r.offerFails = (fact) => fact.subject === '100'
  r.clocks.advance(2 * MINUTE)
  await r.monitor.tick(r.clocks.wall)
  assert.equal(r.offers.length, 99)
  assert.equal(await cursorFile(r.home), baseline, 'no commit before every offered fact has an answer')
  // Once it can, the whole batch is offered again — admission dedupes — and only then does the cursor move.
  r.offerFails = null
  r.clocks.advance(2 * MINUTE)
  await r.monitor.tick(r.clocks.wall)
  assert.equal(r.offers.length, 99 + 150)
  const moved = await cursorFile(r.home)
  assert.equal(watermark(moved), ARMED + 150)

  // The save itself fails: the old cursor stands, and the facts are offered again later.
  const failing = rig({ home: r.home, write: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) } })
  failing.arms = r.arms
  failing.forge.pulls = r.forge.pulls
  failing.forge.pulls.push({ number: 151, head: sha('f'), state: 'open', created: ARMED + 151, updated: ARMED + 151 })
  failing.clocks.advance(2 * MINUTE)
  await failing.monitor.tick(failing.clocks.wall)
  assert.deepEqual(failing.offers, [['review', 'opened', '151']])
  assert.equal(await cursorFile(r.home), moved)
  assert.equal(failing.monitor.statuses()[0]?.state, 'unreadable')
  failing.clocks.advance(2 * MINUTE)
  await failing.monitor.tick(failing.clocks.wall)
  assert.deepEqual(failing.offers, [['review', 'opened', '151'], ['review', 'opened', '151']])
  r.forge.pulls.pop()

  // Equal timestamps at the boundary: a push stamped exactly at the watermark is still seen.
  const at = r.forge.pulls.find((row) => row.number === 150)!
  at.head = sha('e')
  r.clocks.advance(2 * MINUTE)
  await r.monitor.tick(r.clocks.wall)
  assert.deepEqual(r.offers.at(-1), ['review', 'pushed', '150'])

  // More than one poll may read: a gap. Nothing is offered, the watermark stays, and the source waits for a person.
  const offered = r.offers.length
  const kept = await cursorFile(r.home)
  // A flood of closed pull requests: each still has to be read to find where the window ends.
  for (let number = 200; number < 1250; number += 1) {
    r.forge.pulls.push({ number, head: sha('a'), state: 'closed', created: ARMED + 100_000 + number, updated: ARMED + 100_000 + number })
  }
  r.clocks.advance(2 * MINUTE)
  await r.monitor.tick(r.clocks.wall)
  assert.equal(r.offers.length, offered)
  assert.equal(watermark(await cursorFile(r.home)), watermark(kept))
  const gap = r.monitor.statuses()[0]
  assert.equal(gap?.state, 'gap')
  assert.match(gap?.fix ?? '', /Resume/)
  const reads = r.forge.calls.length
  r.clocks.advance(20 * MINUTE)
  await r.monitor.tick(r.clocks.wall)
  assert.equal(r.forge.calls.length, reads, 'a source with a gap is not polled again on its own')
  // Resuming watches from now: what was missed is skipped, visibly, not replayed.
  await r.monitor.rebaseline('/work/project', 'pull-request')
  assert.equal(r.monitor.statuses()[0]?.state, 'watching')
  r.clocks.advance(2 * MINUTE)
  await r.monitor.tick(r.clocks.wall)
  assert.equal(r.offers.length, offered)

  // A batch whose normalized size passes 2 MiB is a gap too.
  const big = rig()
  big.arms = [armOf('review')]
  await big.monitor.baseline(big.arms[0]!)
  for (let number = 1; number <= 200; number += 1) {
    big.forge.pulls.push({ number, head: sha('b'), state: 'open', created: ARMED + number, updated: ARMED + number, body: 'y'.repeat(16_000) })
  }
  big.clocks.advance(2 * MINUTE)
  await big.monitor.tick(big.clocks.wall)
  assert.deepEqual(big.offers, [])
  assert.equal(big.monitor.statuses()[0]?.state, 'gap')
  await r.monitor.close()
  await failing.monitor.close()
  await big.monitor.close()
})

test('pause and errors retain a truthful source status', async () => {
  const r = rig()
  // No arm: no timer and no forge call.
  await r.monitor.start()
  assert.equal(r.timers.live.size, 0)
  await r.monitor.tick(r.clocks.wall)
  assert.equal(r.forge.calls.length, 0)

  r.arms = [armOf('review')]
  await r.monitor.baseline(r.arms[0]!)
  await r.monitor.start()
  assert.equal(r.timers.live.size, 1, 'an arm starts one timer')
  const kept = await cursorFile(r.home)
  r.forge.pulls.push({ number: 7, head: sha('7'), state: 'open', created: ARMED + MINUTE, updated: ARMED + MINUTE })

  const failures: readonly [string, string, RegExp][] = [
    ['error connecting to api.github.com', 'offline', /could not be reached/],
    ['HTTP 401: Bad credentials (https://api.github.com/repos/acme/widgets/pulls) token ghp_secret', 'signed-out', /not signed in/],
    ['HTTP 403: API rate limit exceeded for user ID 123456.', 'rate-limited', /rate limit/],
  ]
  const backoff = [60, 120, 240, 480, 900, 900]
  let step = 0
  for (const [stderr, state, reason] of failures) {
    r.forge.fail = () => ({ exitCode: 1, stderr })
    // The first poll of each kind is due now; its failure paces the next by the backoff.
    r.clocks.advance(backoff[Math.max(0, step - 1)]! * 1000)
    await r.monitor.tick(r.clocks.wall)
    const status = r.monitor.statuses()[0]!
    assert.equal(status.state, state)
    assert.match(status.reason ?? '', reason)
    assert.ok(status.fix)
    for (const leak of ['Bad credentials', 'ghp_secret', 'user ID', 'https://api.github.com']) {
      assert.ok(!`${status.reason} ${status.fix}`.includes(leak), `${leak} is not repeated`)
    }
    assert.equal(await cursorFile(r.home), kept)
    step += 1
  }
  // The backoff grows 60, 120, 240, 480, then holds at 900 seconds.
  r.forge.fail = () => ({ exitCode: 1, stderr: 'error connecting to api.github.com' })
  for (let index = step; index < backoff.length; index += 1) {
    const wait = backoff[index - 1]! * 1000
    const seen: number = r.forge.calls.length
    r.clocks.advance(wait - 1000)
    await r.monitor.tick(r.clocks.wall)
    assert.equal(r.forge.calls.length, seen, `not before ${wait / 1000} seconds`)
    r.clocks.advance(1000)
    await r.monitor.tick(r.clocks.wall)
    assert.equal(r.forge.calls.length, seen + 1, `at ${wait / 1000} seconds`)
  }
  assert.deepEqual(r.offers, [])
  // A complete poll resets it.
  r.forge.fail = null
  r.clocks.advance(900_000)
  await r.monitor.tick(r.clocks.wall)
  assert.deepEqual(r.offers, [['review', 'opened', '7']])
  assert.equal(r.monitor.statuses()[0]?.state, 'watching')
  const calls = r.forge.calls.length
  r.clocks.advance(60_000)
  await r.monitor.tick(r.clocks.wall)
  assert.equal(r.forge.calls.length, calls + 1)

  // Paused: the timer stops and no tick reads anything.
  await r.monitor.pause()
  assert.equal(r.timers.live.size, 0)
  assert.equal(r.monitor.statuses()[0]?.state, 'paused')
  r.clocks.advance(5 * MINUTE)
  await r.monitor.tick(r.clocks.wall)
  assert.equal(r.forge.calls.length, calls + 1)
  await r.monitor.start()
  assert.equal(r.timers.live.size, 1)

  // Closed during a read: the read is abandoned, nothing is offered late, and close waits for it.
  r.forge.pulls.push({ number: 8, head: sha('8'), state: 'open', created: r.clocks.wall, updated: r.clocks.wall })
  r.clocks.advance(2 * MINUTE)
  r.forge.gate = new Gate()
  const reading = r.monitor.tick(r.clocks.wall)
  await r.forge.reached(1)
  assert.equal(r.forge.waiting, 1)
  let closed = false
  const closing = r.monitor.close().then(() => { closed = true })
  await settle()
  assert.equal(closed, false, 'close waits for the read in flight')
  r.forge.gate.open()
  await Promise.all([reading, closing])
  assert.equal(r.offers.length, 1, 'no offer after close')
  assert.equal(r.timers.live.size, 0)
  await r.monitor.tick(r.clocks.wall + 10 * MINUTE)
  assert.equal(r.offers.length, 1)

  // Closed while admission holds the first of two facts: that one finishes, the second is never offered,
  // and the cursor does not move past either.
  const held = rig()
  held.arms = [armOf('review')]
  await held.monitor.baseline(held.arms[0]!)
  const before = await cursorFile(held.home)
  held.forge.pulls.push({ number: 21, head: sha('1'), state: 'open', created: ARMED + MINUTE, updated: ARMED + MINUTE })
  held.forge.pulls.push({ number: 22, head: sha('2'), state: 'open', created: ARMED + 2 * MINUTE, updated: ARMED + 2 * MINUTE })
  held.clocks.advance(3 * MINUTE)
  held.offerGate = new Gate()
  const admitting = held.monitor.tick(held.clocks.wall)
  await held.offerHeld.opened
  const stopping = held.monitor.close()
  held.offerGate.open()
  await Promise.all([admitting, stopping])
  assert.deepEqual(held.offers, [['review', 'opened', '21']])
  assert.equal(await cursorFile(held.home), before)
})

test('a label filter offers only the labelled issues it names', async () => {
  const r = rig()
  r.arms = [armOf('ready', { source: 'issue', label: ['agent-ready'] }), armOf('everything', { source: 'issue' })]
  await r.monitor.baseline(r.arms[0]!)
  r.forge.issues.push({
    number: 9, state: 'open', created: ARMED + MINUTE, updated: ARMED + 2 * MINUTE, comments: [],
    events: [
      { id: 501, event: 'labeled', created: ARMED + MINUTE, label: 'bug' },
      { id: 502, event: 'labeled', created: ARMED + MINUTE, label: 'agent-ready' },
      { id: 503, event: 'closed', created: ARMED + 2 * MINUTE },
    ],
  })
  r.clocks.advance(3 * MINUTE)
  await r.monitor.tick(r.clocks.wall)
  assert.deepEqual(r.offers.filter(([id]) => id === 'ready'), [['ready', 'labelled', '9']], 'one labelled issue, the one it names')
  assert.equal(r.offers.filter(([id]) => id === 'everything').length, 3, 'a trigger with no label reads every event it declares')
  await r.monitor.close()
})


test('an opt-in arm watches old PRs and failed delivery preserves supplemental work', async () => {
  const r = rig()
  const base = armOf('follow')
  r.arms = [{ ...base, definition: { ...base.definition, on: { kind: 'pull-request', events: ['checks-failed'] } } }]
  r.forge.pulls.push({ number: 1, head: sha('a'), state: 'open', created: ARMED - 3_600_000, updated: ARMED - 3_600_000 })
  await r.monitor.baseline(r.arms[0]!)
  r.forge.pulls[0]!.checks = [{ id: 1, head_sha: sha('a'), name: 'build', status: 'completed', conclusion: 'failure', completed_at: iso(ARMED + 1) }]
  r.clocks.advance(MINUTE)
  await r.monitor.tick(r.clocks.wall) // The check page is retained before the status page completes the aggregate.
  const before = await cursorFile(r.home)
  r.offerFails = () => true
  r.clocks.advance(MINUTE)
  await r.monitor.tick(r.clocks.wall)
  assert.equal(await cursorFile(r.home), before, 'delivery failed before any supplemental watermark was committed')
  r.offerFails = null
  r.clocks.advance(2 * MINUTE)
  await r.monitor.tick(r.clocks.wall)
  assert.deepEqual(r.offers, [['follow', 'checks-failed', '1']])
  await r.monitor.close()
})

test('host-owned PR watches poll without arms and deliver observations before advancing the cursor', async () => {
  const forge = new FakeForge(), clocks = new Clocks(ARMED), timers = new FakeTimers()
  const home = tempDir('hd-lead-watch-'), cursors = new SourceCursors(home)
  forge.pulls = [{ number: 7, head: sha('a'), state: 'open', created: ARMED - 1, updated: ARMED - 1 }]
  const watches = [{ project: '/project', repository: 'acme/widgets', number: 7, head: sha('a'), checks: true, reviews: true, since: ARMED }]
  const observations: any[] = []
  let refuse = true
  const monitor = new IntakeMonitor({ armed: async () => [], watches: () => watches,
    sources: intakeSources(new ForgeSource({ run: forge.runner, now: () => clocks.wall })), cursors,
    offer: async () => { throw new Error('No project arm exists') },
    deliver: async (_watch: unknown, batch: any) => { if (refuse) throw new Error('not durable yet'); observations.push(...batch.observations ?? []) },
    wall: () => clocks.wall, monotonic: () => clocks.mono, timers } as any)
  await monitor.start()
  assert.equal(timers.live.size, 1)
  await monitor.tick(clocks.wall)
  clocks.advance(MINUTE)
  await monitor.tick(clocks.wall)
  assert.equal(observations.length, 0)
  refuse = false
  clocks.advance(2 * MINUTE)
  await monitor.tick(clocks.wall)
  assert.ok(observations.some(row => row.number === 7))
  await monitor.close()
})

test('mention review cursors retain per-PR baseline across reload and accept older cursors', async () => {
  const home = tempDir('hd-mention-review-cursor-'), key = 'fixture'
  const original = { version: 1 as const, source: 'mention' as const, repository: 'acme/widgets', baseline: 1000,
    observedThrough: 5000, continuation: null, subjects: {}, mentionReviews: { next: 0, pulls: { '5': { through: 5000, since: 2000, seen: { r101: 4000 } } } } }
  await new SourceCursors(home).commit(key, original)
  assert.deepEqual(await new SourceCursors(home).read(key), original)
  const legacy = { ...original, mentionReviews: { next: 0, pulls: { '5': { through: 5000, seen: { r101: 4000 } } } } }
  await new SourceCursors(home).commit(key, legacy)
  assert.deepEqual(await new SourceCursors(home).read(key), legacy)
  const subscriber = JSON.stringify(['thread', 'ask', 2000, '12345678-1234-1234-1234-123456789abc'])
  const current = { ...original, mentionReviews: { next: 0, pulls: { '5': { through: 5000, since: 2000, seen: {}, subscribers: { [subscriber]: 5000 } } } } }
  await new SourceCursors(home).commit(key, current)
  assert.deepEqual(await new SourceCursors(home).read(key), current, 'subscriber tombstones survive reload')
  const corrupt = { ...original, mentionReviews: { next: 0, pulls: { '5': { through: 5000, seen: {}, subscribers: { 'not a subscriber': 5000 } } } } }
  await new SourceCursors(home).commit(key, corrupt)
  await assert.rejects(new SourceCursors(home).read(key), /will not be rebaselined/)
  const invalid = { ...original, mentionReviews: { next: 0, pulls: { '5': { through: 5000, since: -1, seen: {} } } } }
  const invalidHome = tempDir('hd-mention-review-invalid-')
  await new SourceCursors(invalidHome).commit(key, invalid)
  await assert.rejects(new SourceCursors(invalidHome).read(key), /will not be rebaselined/, 'a corrupt boundary cannot trigger a fresh baseline')
})


test('a failed targeted offer retries its exact subscriber after monitor restart', async () => {
  const a = { id: 'thread-a', trigger: 'ask', since: ARMED + MINUTE, incarnation: '11111111-1111-1111-1111-111111111111' }
  const b = { id: 'thread-b', trigger: 'triage', since: ARMED + 2 * MINUTE, incarnation: '22222222-2222-2222-2222-222222222222' }
  let linked = [a]
  const links = async () => linked.map(subscriber => ({ number: 5, since: subscriber.since, subscriber }))
  const mention = (id: string): ArmedTrigger => {
    const base = armOf(id, { source: 'issue' })
    return { ...base, definition: { ...base.definition, on: { kind: 'mention', events: ['commented'] } } }
  }
  let loseRoutes = false
  const r = rig({ linked: links, loseRoutes: () => loseRoutes }); r.arms = [mention('ask'), mention('triage')]
  await r.monitor.baseline(r.arms[0]!)
  const at = ARMED + 3 * MINUTE
  const pull = { number: 5, head: sha('c'), state: 'open' as const, created: ARMED, updated: at,
    reviews: [{ id: 901, commit_id: sha('c'), body: '@triager follow up', state: 'COMMENTED', submitted_at: iso(at), user: { id: 7, login: 'jane-doe' } }], reviewComments: [] }
  r.forge.pulls.push(pull)
  r.clocks.advance(10 * MINUTE); await r.monitor.tick(r.clocks.wall)
  const before = await cursorFile(r.home)
  linked = [a, b]; r.offerFails = () => true
  r.clocks.advance(10 * MINUTE); await r.monitor.tick(r.clocks.wall)
  assert.equal(await cursorFile(r.home), before, 'failed offer cannot commit subscriber coverage')
  r.offerFails = null; loseRoutes = true
  const previousOffers = r.offers.length
  r.clocks.advance(2 * MINUTE); await r.monitor.tick(r.clocks.wall)
  assert.equal(r.offers.length, previousOffers, 'lost internal route never falls back to broadcast')
  assert.equal(await cursorFile(r.home), before)
  await r.monitor.close()
  const restarted = rig({ home: r.home, linked: links }); restarted.arms = [mention('ask'), mention('triage')]
  restarted.forge.pulls.push(pull)
  restarted.clocks.advance(22 * MINUTE); await restarted.monitor.tick(restarted.clocks.wall)
  assert.deepEqual(restarted.offers.map(one => one[0]), ['triage'])
  assert.deepEqual(restarted.routes, [b])
  assert.notEqual(await cursorFile(r.home), before)
  await restarted.monitor.close()
})


test('a malformed cursor file is preserved and never treated as a fresh source', async () => {
  const home = tempDir('hd-intake-bad-cursor-'), file = join(home, 'triggers-cursors.json'), corrupt = '{broken'
  await writeFile(file, corrupt)
  const cursors = new SourceCursors(home)
  await assert.rejects(cursors.read('fixture'), /cursor/i)
  await assert.rejects(cursors.commit('fixture', { version: 1, source: 'mention', repository: 'acme/widgets', baseline: 1, observedThrough: 1, continuation: null, subjects: {} }), /cursor/i)
  assert.equal(await readFile(file, 'utf8'), corrupt)
})

test('malformed legacy and non-object cursor entries do not become fresh baselines', async () => {
  for (const value of [null, { version: 1, source: 'mention', repository: 'acme/widgets', baseline: -1, observedThrough: 'bad', continuation: null, subjects: {} }]) {
    const home = tempDir('hd-intake-invalid-entry-'), file = join(home, 'triggers-cursors.json')
    const original = JSON.stringify({ version: 1, cursors: { fixture: value } })
    await writeFile(file, original)
    await assert.rejects(new SourceCursors(home).read('fixture'), /will not be rebaselined/)
    assert.equal(await readFile(file, 'utf8'), original)
  }
})

test('legacy mention comment watermarks must be nonnegative safe decimal integers', async () => {
  for (const event of ['bad', '-1', '9007199254740992', '1.5', '']) {
    const home = tempDir('hd-intake-invalid-mark-'), file = join(home, 'triggers-cursors.json')
    const cursor = { version: 1, source: 'mention', repository: 'acme/widgets', baseline: 1, observedThrough: 1, continuation: null, subjects: { _comments: { head: null, event } } }
    const original = JSON.stringify({ version: 1, cursors: { fixture: cursor } })
    await writeFile(file, original)
    await assert.rejects(new SourceCursors(home).read('fixture'), /will not be rebaselined/)
    assert.equal(await readFile(file, 'utf8'), original)
  }
  const home = tempDir('hd-intake-empty-mark-'), cursors = new SourceCursors(home)
  const initial = { version: 1 as const, source: 'mention' as const, repository: 'acme/widgets', baseline: 1, observedThrough: 1, continuation: null, subjects: {} }
  await cursors.commit('fixture', initial)
  assert.deepEqual(await cursors.read('fixture'), initial)
})

test('a stalled review read is visible even when issue comments make progress', async () => {
  const r = rig({ linked: async () => [{ number: 5, since: ARMED }] })
  const base = armOf('ask', { source: 'issue' })
  r.arms = [{ ...base, definition: { ...base.definition, on: { kind: 'mention', events: ['commented'] } } }]
  await r.monitor.baseline(r.arms[0]!)
  const at = ARMED + 2 * MINUTE
  r.forge.pulls.push({ number: 5, head: sha('c'), state: 'open', created: ARMED, updated: ARMED, reviews: [] })
  r.clocks.advance(MINUTE); await r.monitor.tick(r.clocks.wall)
  const before = JSON.parse(await cursorFile(r.home)) as { cursors: Record<string, { mentionReviews?: unknown }> }
  const priorReviews = Object.values(before.cursors)[0]!.mentionReviews
  assert.ok(priorReviews)
  r.forge.issues.push({ number: 1, state: 'open', created: at, updated: at, events: [], comments: [{ id: 101, body: '@dex issue comment', created: at, updated: at, user: { id: 7, login: 'jane-doe' } }] })
  r.forge.pulls[0]!.reviews = [{ id: 102, commit_id: sha('c'), body: '@dex review', state: 'COMMENTED', submitted_at: iso(at), user: { id: 7, login: 'jane-doe' } }]
  r.forge.fail = path => path.includes('/pulls/5/reviews?') ? { exitCode: 1, stderr: 'synthetic failure' } : null
  r.clocks.advance(2 * MINUTE); await r.monitor.tick(r.clocks.wall)
  assert.equal(r.offers.length, 1, 'the issue comment is offered')
  assert.equal(r.monitor.statuses()[0]?.state, 'unreadable', 'review failure is visible')
  const saved = JSON.parse(await cursorFile(r.home)) as { cursors: Record<string, { subjects: Record<string, { event: string }>; mentionReviews?: unknown }> }
  const cursor = Object.values(saved.cursors)[0]!
  assert.equal(cursor.subjects['_comments']?.event, '101')
  assert.deepEqual(cursor.mentionReviews, priorReviews, 'failed review coverage did not advance')
  r.forge.fail = null; r.clocks.advance(2 * MINUTE); await r.monitor.tick(r.clocks.wall)
  assert.equal(r.offers.length, 2, 'the review is retried without replaying the comment')
  assert.equal(r.monitor.statuses()[0]?.state, 'watching')
  await r.monitor.close()
})

test('unsafe PR keys in review coverage are refused without overwriting cursor bytes', async () => {
  const home = tempDir('hd-intake-unsafe-pr-key-'), file = join(home, 'triggers-cursors.json')
  const cursor = { version: 1, source: 'mention', repository: 'acme/widgets', baseline: 1, observedThrough: 1, continuation: null, subjects: {},
    mentionReviews: { next: 0, pulls: { '9999999999999999': { through: 1, seen: {} } } } }
  const original = JSON.stringify({ version: 1, cursors: { fixture: cursor } })
  await writeFile(file, original)
  const cursors = new SourceCursors(home)
  await assert.rejects(cursors.read('fixture'), /will not be rebaselined/)
  await assert.rejects(cursors.commit('fixture', cursor as any), /will not be rebaselined/)
  assert.equal(await readFile(file, 'utf8'), original)
})

test('unsafe request-settlement PR keys are refused without overwriting cursor bytes', async () => {
  const home = tempDir('hd-intake-unsafe-request-pr-'), file = join(home, 'triggers-cursors.json')
  const cursor = { version: 1, source: 'pull-request', repository: 'acme/widgets', baseline: 1, observedThrough: 1, continuation: null, subjects: {},
    requests: { seen: { u9999999999999999: 1 } } }
  const original = JSON.stringify({ version: 1, cursors: { fixture: cursor } })
  await writeFile(file, original)
  const cursors = new SourceCursors(home)
  await assert.rejects(cursors.read('fixture'), /will not be rebaselined/)
  assert.equal(await readFile(file, 'utf8'), original)
})

test('maximum safe numeric PR keys round-trip in both coverage formats', async () => {
  const home = tempDir('hd-intake-safe-pr-key-'), cursors = new SourceCursors(home)
  const mention = { version: 1 as const, source: 'mention' as const, repository: 'acme/widgets', baseline: 1, observedThrough: 1, continuation: null, subjects: {},
    mentionReviews: { next: 0, pulls: { '9007199254740991': { through: 1, seen: {} } } } }
  const pull = { version: 1 as const, source: 'pull-request' as const, repository: 'acme/widgets', baseline: 1, observedThrough: 1, continuation: null, subjects: {},
    requests: { seen: { u9007199254740991: 1 } } }
  await cursors.commit('mention', mention); await cursors.commit('pull', pull)
  assert.deepEqual(await cursors.read('mention'), mention)
  assert.deepEqual(await cursors.read('pull'), pull)
})
