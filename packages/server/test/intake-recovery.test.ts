import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { makeRepo } from './fixtures/evidence-desk.js'
import { git } from './fixtures/flow-host-evidence.js'
import { child, desk, onDisk, prFact, sha, type CrashAt } from './fixtures/intake-restart.js'
import { ForgeSource } from '../src/intake/forge.js'
import { SourceCursors } from '../src/intake/poll.js'
import { FakeForge, iso } from './fixtures/intake-forge.js'
import { tempDir } from './scratch.js'

/*
 * A firing survives the process dying at any step: a fresh Node process over
 * the same folder reopens every store from disk, finishes what the journal
 * began under the ids it reserved, and never sends work before the firing is
 * recorded as applied — one Goal, one round, one Seat, one order.
 */

const journal = async (home: string) => JSON.parse(await readFile(join(home, 'intake.json'), 'utf8')) as {
  firings: Record<string, { goal: string | null }>
  operations: { key: string; goal: string; run: string; state: string }[]
}

const count = (events: readonly string[], prefix: string): number => events.filter((one) => one.startsWith(prefix)).length

test('fresh process completes record-before-round crash', async () => {
  const home = tempDir('hd-intake-recovery-')
  const fact = prFact(7, sha('a'), 'opened')
  const first = await child(home, [fact], 'goal')
  assert.equal(first.exited, 'crash')
  const before = await onDisk(home)
  assert.equal(before.goals.length, 1, 'the Goal was made before the process died')
  assert.equal(before.runs.length, 0, 'and nothing after it')
  const reserved = (await journal(home)).operations[0]!

  const second = await child(home, [fact])
  assert.deepEqual(second.answers.map((one) => one.outcome), ['duplicate'])
  const after = await onDisk(home)
  assert.deepEqual(after.goals, [reserved.goal], 'the Goal it reserved, not a replacement')
  assert.deepEqual(after.runs.map((run) => run.id), [reserved.run])
  assert.equal(after.rounds.length, 1)
  assert.equal(count(after.events, 'open:'), 1)
  assert.equal(count(after.events, 'order:'), 1)
})

test('every effect boundary is recoverable without early dispatch', async () => {
  const boundaries: readonly Exclude<CrashAt, null>[] = ['prepared', 'goal', 'evidence', 'round', 'applied', 'dispatched']
  for (const at of boundaries) {
    const home = tempDir(`hd-intake-recovery-${at}-`)
    const fact = prFact(7, sha('a'), 'opened')
    const first = await child(home, [fact], at)
    assert.equal(first.exited, 'crash', `${at}: the process died there`)
    const crashed = await onDisk(home)
    const reserved = (await journal(home)).operations[0]!
    if (at !== 'dispatched') {
      assert.equal(count(crashed.events, 'open:') + count(crashed.events, 'order:'), 0, `${at}: nothing was sent before the firing was released`)
    }

    // A fresh process: every store reopened. The journal finishes first, then the same fact is offered again.
    const second = await child(home, [fact])
    assert.deepEqual(second.answers.map((one) => one.outcome), ['duplicate'], at)
    const after = await onDisk(home)
    assert.deepEqual(after.goals, [reserved.goal], `${at}: the reserved Goal, once`)
    assert.deepEqual(after.runs.map((run) => run.id), [reserved.run], `${at}: the reserved run, once`)
    assert.equal(after.rounds.length, 1, `${at}: one round`)
    assert.equal(count(after.events, 'open:'), 1, `${at}: one Seat`)
    assert.equal(count(after.events, 'order:'), 1, `${at}: one order`)
    // Dispatch follows the applied record: the first Seat opens only after the firing was journaled applied.
    const applied = after.events.findIndex((one) => one.startsWith('applied:'))
    const opened = after.events.findIndex((one) => one.startsWith('open:'))
    assert.ok(applied >= 0 && applied < opened, `${at}: applied before any Seat (${after.events.join(', ')})`)
    const final = await journal(home)
    assert.equal(final.firings[reserved.key]?.goal, reserved.goal)
    assert.deepEqual(final.operations, [], `${at}: released operations keep only their tombstone`)
  }
})

test('a new head after a crash lands in the same Goal as one more round', async () => {
  const home = tempDir('hd-intake-recovery-again-')
  const opened = prFact(7, sha('a'), 'opened')
  const pushed = prFact(7, sha('b'), 'pushed')
  await child(home, [opened])
  const first = await child(home, [pushed], 'round')
  assert.equal(first.exited, 'crash')
  const second = await child(home, [opened, pushed])
  assert.deepEqual(second.answers.map((one) => one.outcome), ['duplicate', 'duplicate'])
  const after = await onDisk(home)
  assert.equal(after.goals.length, 1)
  assert.equal(after.rounds.length, 2)
  assert.equal(count(after.events, 'open:'), 2)
  assert.equal(count(after.events, 'order:'), 2)
})

test('supersession replay across a process restart keeps the new round rearmable', async () => {
  for (const boundary of ['round', 'superseded'] as const) {
    const home = tempDir(`hd-intake-supersede-${boundary}-`)
    const opened = prFact(7, sha('a'), 'opened')
    const pushed = prFact(7, sha('b'), 'pushed')
    await child(home, [opened])
    assert.equal((await child(home, [pushed], boundary)).exited, 'crash')
    const pending = (await journal(home)).operations[0]!
    assert.equal(pending.state, 'prepared')
    assert.equal((await child(home, [])).exited, 'done')
    const d = await desk(home)
    await d.flows.reArm('alpha', 's1')
    await d.flows.reArm('alpha', 's2')
    await d.settle()
    const after = await onDisk(home)
    assert.equal(after.rounds.length, 2)
    assert.deepEqual(after.events.filter((one) => one.startsWith('order:')), ['order:seat-1', 'order:seat-2', 'order:seat-2'], boundary)

    // A distinct firing retires round 2. A delayed replay of round 2 cannot retire round 3.
    await d.admission.offer(d.arm, prFact(7, sha('c'), 'pushed'))
    await d.settle()
    assert.equal(await d.flows.supersedeTriggered(pending.run, 'A newer head arrived.', 'round', pending.key), false)
    await d.flows.reArm('alpha', 's2')
    await d.flows.reArm('alpha', 's3')
    await d.settle()
    const later = await onDisk(home)
    assert.equal(later.rounds.length, 3)
    assert.deepEqual(later.events.filter((one) => one.startsWith('order:')), [
      'order:seat-1', 'order:seat-2', 'order:seat-2', 'order:seat-3', 'order:seat-3',
    ], boundary)
  }
})

test('offline Intake recovery refuses a fetch interrupted before its pin was journaled without fetching again', async () => {
  const home = tempDir('hd-intake-base-crash-')
  const repo = await makeRepo('hd-intake-base-local-')
  const remote = tempDir('hd-intake-base-remote-')
  await repo.git('clone', '--no-hardlinks', repo.dir, remote)
  await repo.git('remote', 'add', 'origin', remote)
  const fact = prFact(7, sha('a'), 'opened')
  assert.equal((await child(home, [fact], 'base-fetched', repo.dir)).exited, 'crash')
  const reserved = (await journal(home)).operations[0]!
  const fetched = await repo.git('rev-parse', `refs/harnessdesk/flow-base/${reserved.run}`)
  await git(remote, 'commit', '--allow-empty', '-m', 'later remote head')
  await repo.git('remote', 'set-url', 'origin', join(home, 'offline'))

  assert.equal((await child(home, [fact], null, repo.dir)).exited, 'done')
  const after = await onDisk(home)
  assert.equal(count(after.events, 'fetch:'), 1, 'recovery never retries the network operation')
  assert.equal(await repo.git('rev-parse', `refs/harnessdesk/flow-base/${reserved.run}`), fetched)
  assert.equal(after.runs.length, 1, 'the pre-fetch intent survived the process exit')
  assert.equal(after.runs[0]?.state, 'stopped')
  const saved = JSON.parse(await readFile(join(home, 'flows-v2', `${reserved.run}.json`), 'utf8')) as { reason: string }
  assert.match(saved.reason, /base.*interrupted|fetch.*uncertain/i)
  assert.equal(after.rounds.length, 0)
  assert.equal(count(after.events, 'open:') + count(after.events, 'order:'), 0)
  assert.deepEqual((await journal(home)).operations, [], 'Intake records the refusal instead of retrying forever')
})


test('deferred review authors survive cursor reload and a permission outage', async () => {
  const at = Date.UTC(2026, 8, 1, 10)
  const home = tempDir('hd-intake-review-replay-')
  const forge = new FakeForge()
  forge.pulls.push({ number: 1, head: sha('a'), state: 'open', created: at - 3_600_000, updated: at - 3_600_000 })
  const reader = () => new ForgeSource({ run: forge.runner, now: () => at + 60_000 })
  const signal = new AbortController().signal
  const baseline = await new ForgeSource({ run: forge.runner, now: () => at }).inventory('/work/project', 'pull-request', 'acme/widgets', signal)
  forge.pulls[0]!.reviews = [7, 42].map((id) => ({ id, commit_id: sha('a'), body: 'Please fix this.', state: 'COMMENTED', submitted_at: iso(at + 1000), user: { id, login: `reviewer-${id}` } }))
  forge.permissions.set('reviewer-7', { id: 99, permission: 'write' })
  forge.permissions.set('reviewer-42', { id: 42, permission: 'write' })
  const options = { watches: [{ number: 1, checks: false, reviews: true }] }
  const pending = await reader().poll('/work/project', baseline, signal, options)
  assert.equal(pending.facts.length, 0)
  await new SourceCursors(home).commit('pr', pending.next)
  const loaded = await new SourceCursors(home).read('pr')
  assert.deepEqual(loaded, pending.next)
  forge.fail = (path) => path.includes('/permission') ? { exitCode: 1, stderr: 'HTTP 429' } : null
  await assert.rejects(reader().poll('/work/project', loaded!, signal, options), /rate limit/)
  assert.deepEqual(await new SourceCursors(home).read('pr'), loaded)
  forge.fail = null
  const refused = await reader().poll('/work/project', loaded!, signal, options)
  assert.equal(refused.facts.length, 0, 'a permission answer naming another numeric id never counts')
  const verified = await reader().poll('/work/project', refused.next, signal, options)
  assert.equal(verified.facts.length, 0, 'the body is reread only after permission succeeds')
  await new SourceCursors(home).commit('pr', verified.next)
  const bodyPending = await new SourceCursors(home).read('pr')
  assert.deepEqual(bodyPending, verified.next)
  const accepted = await reader().poll('/work/project', bodyPending!, signal, options)
  const replay = await reader().poll('/work/project', bodyPending!, signal, options)
  assert.equal(accepted.facts.length, 1)
  assert.equal(accepted.facts[0]?.authorWrites, true)
  assert.deepEqual(replay.facts, accepted.facts)
})
