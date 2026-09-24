import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { child, onDisk, prFact, sha, type CrashAt } from './fixtures/intake-restart.js'
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
