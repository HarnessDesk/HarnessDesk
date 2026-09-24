import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { TriggerArmPreview, TriggerAttention, TriggerHistoryPage, TriggerProjectView } from '@harnessdesk/protocol'

import { intakeDesk } from './fixtures/intake-host.js'
import { sha } from './fixtures/intake-forge.js'

/*
 * One effect that keeps failing never stops intake on the machine (review
 * #898). A run that will not start — here, because a run file the desk
 * cannot read blocks every new run — is tried a bounded number of times,
 * named as a wait the whole time, then set aside for the person with its
 * tombstone; intake itself stays on.
 */

const E2E = { timeout: 120_000 } as const

test('a firing whose run will not start is named, tried a bounded number of times, then set aside; intake stays on', E2E, async (t) => {
  const first = await intakeDesk()
  const preview = await first.host.call('trigger/preview', { root: first.repo.dir, id: 'review' }) as TriggerArmPreview
  await first.host.call('trigger/arm', { root: first.repo.dir, id: 'review', token: preview.token! })
  await first.stop()
  // A run file that names no Goal: the flow engine starts no new run anywhere until it is restored.
  await mkdir(join(first.stateDir, 'flows-v2'), { recursive: true })
  await writeFile(join(first.stateDir, 'flows-v2', 'broken.json'), '{}')
  const d = await intakeDesk({ repo: first.repo, stateDir: first.stateDir, forge: first.forge, clocks: first.clocks })
  t.after(() => d.stop())
  const root = d.repo.dir
  const attention = (): TriggerAttention[] => d.pushed.filter((one) => one.method === 'trigger/attention')
    .map((one) => (one as Extract<typeof one, { method: 'trigger/attention' }>).params.attention)

  const at = d.clocks.wall + 1000
  d.forge.pulls.push({ number: 1, head: sha('a'), state: 'open', created: at, updated: at })
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  assert.equal(d.host.intakePlane.problem, null, 'intake as a whole is not off')
  const trying = (await d.host.call('trigger/list', { root }) as TriggerProjectView).triggers[0]!
  assert.equal(trying.state, 'armed')
  assert.match(trying.reason ?? '', /A firing could not be finished \(.+\)\. It is tried again on its own/, 'the trigger says what its project waits on')
  const named = attention().find((one) => one.goal === null && one.resolvedAt === null && /could not be finished/.test(one.sentence))
  assert.ok(named, 'a named wait while it is tried again')
  assert.equal(named.waitingOn.kind, 'service')
  assert.equal(named.action, 'open-trigger')

  // Each later pass tries it again, up to the bound; then it is the person's.
  for (let pass = 0; pass < 2; pass += 1) {
    d.clocks.advance(60_000)
    await d.host.intakePlane.tick()
  }
  const aside = attention().find((one) => one.resolvedAt === null && /set aside for you/.test(one.sentence))
  assert.ok(aside, 'set aside, and said so')
  assert.equal(aside.waitingOn.kind, 'person')
  // Its Goal was made before its run refused: the Goal names it, once, until the person wraps it.
  assert.ok(aside.goal, 'named on the Goal it made')
  assert.equal(attention().filter((one) => one.resolvedAt === null && /set aside for you/.test(one.sentence)).length, 1, 'said once, not twice')
  assert.ok(attention().some((one) => one.id === named.id && one.resolvedAt !== null), 'the retry wait ended')
  const page = await d.host.call('trigger/history', { root, id: 'review' }) as TriggerHistoryPage
  assert.equal(page.items.length, 1)
  assert.match(page.items[0]!.reason ?? '', /set aside for you/, 'the tombstone keeps why')
  assert.equal(d.host.intakePlane.journal.read().operations.length, 0, 'nothing of it is retried again')
  assert.equal((await d.host.call('trigger/list', { root }) as TriggerProjectView).triggers[0]!.reason, null, 'its project admits again')

  // Intake keeps answering facts: the next pull request is admitted, not refused for the old fault.
  const later = d.clocks.wall + 1000
  d.forge.pulls.push({ number: 2, head: sha('b'), state: 'open', created: later, updated: later })
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const next = await d.host.call('trigger/history', { root, id: 'review' }) as TriggerHistoryPage
  assert.equal(next.items.length, 2, 'the next fact was answered')
})
