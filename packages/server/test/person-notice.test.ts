import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { PersonNotice, RuntimeId } from '@harnessdesk/protocol'

import { Team, type TeamPeer, type TeamPort } from '../src/team.js'

/**
 * An Agent telling the person something (`team/notify`), against a fake port.
 * It needs no room — an Agent alone in a conversation has news too — and it
 * is bounded: an empty title and a sixth message in ten minutes are refused,
 * and every attempt, delivered or not, reaches the audit.
 */

const peer: TeamPeer = {
  runtime: 'codex' as RuntimeId,
  sessionId: 's1',
  title: 'Checkout hardening',
  cwd: '/repo',
  agent: 'Codex',
  busy: false,
  canSteer: false,
  queuedByUser: 0,
  here: true,
}

const rig = async (t: { after(fn: () => Promise<void>): void }) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-person-notice-'))
  const delivered: PersonNotice[] = []
  const audited: string[] = []
  const port: TeamPort = {
    peers: () => [peer],
    rootOf: async () => '/repo',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: (entry) => audited.push(`${entry.kind}:${entry.decision ?? ''}`),
    notifyPerson: (notice) => delivered.push(notice),
  }
  const team = new Team(dir, port)
  t.after(async () => {
    await team.flush()
    await rm(dir, { recursive: true, force: true })
  })
  return { team, delivered, audited }
}

const scope = { runtime: 'codex', sessionId: 's1' }

test('an Agent outside any room can tell the person something, attributed to its conversation', async (t) => {
  const { team, delivered, audited } = await rig(t)
  const reply = await team.notify({ where: 'inbox', title: '  Five cards done  ', body: 'All green.', task: 'Review PR 971' }, scope)
  assert.match(reply, /inbox/)
  assert.equal(delivered.length, 1)
  assert.deepEqual(
    { where: delivered[0]!.where, title: delivered[0]!.title, body: delivered[0]!.body, task: delivered[0]!.task, from: delivered[0]!.from },
    { where: 'inbox', title: 'Five cards done', body: 'All green.', task: 'Review PR 971', from: { runtime: 'codex', sessionId: 's1', name: 'Checkout hardening' } },
  )
  assert.deepEqual(audited, ['person/notice:sent-inbox'])
})

test('a decision it waits on is asked for on its composer', async (t) => {
  const { team, delivered } = await rig(t)
  assert.match(await team.notify({ where: 'composer', title: 'A or B?' }, scope), /composer/)
  assert.equal(delivered[0]!.where, 'composer')
})

test('an empty title is refused, and so is a sixth message in ten minutes', async (t) => {
  const { team, delivered, audited } = await rig(t)
  assert.match(await team.notify({ where: 'inbox', title: '   ' }, scope), /^Refused/)
  for (let index = 0; index < 5; index += 1) await team.notify({ where: 'inbox', title: `n${index}` }, scope)
  assert.match(await team.notify({ where: 'inbox', title: 'one too many' }, scope), /^Refused: .*5 things/)
  assert.equal(delivered.length, 5)
  assert.ok(audited.includes('person/notice:refused-empty'))
  assert.ok(audited.includes('person/notice:refused-rate'))
})

test('long words are cut to size before they reach a window', async (t) => {
  const { team, delivered } = await rig(t)
  await team.notify({ where: 'inbox', title: 'x'.repeat(500), body: 'y'.repeat(5000) }, scope)
  assert.equal(delivered[0]!.title.length, 120)
  assert.equal(delivered[0]!.body!.length, 600)
})

test('an unattributed call is refused rather than guessed', async (t) => {
  const { team } = await rig(t)
  await assert.rejects(team.notify({ where: 'inbox', title: 'who am I' }, {}))
})

test('two messages the same conversation sends inside one millisecond get two different ids', async (t) => {
  // A real clock ticks between two awaited calls almost always, which is
  // exactly the case this would not catch — the collision only shows up when
  // `Date.now()` genuinely answers the same millisecond twice.
  t.mock.timers.enable({ apis: ['Date'] })
  const { team, delivered } = await rig(t)
  await team.notify({ where: 'inbox', title: 'first' }, scope)
  await team.notify({ where: 'inbox', title: 'second' }, scope)
  assert.equal(delivered.length, 2)
  assert.notEqual(delivered[0]!.id, delivered[1]!.id)
})

test('a sender that used up its window is not held to it once the window has fully elapsed', async (t) => {
  // Every call sweeps every sender's timestamps older than the window, not
  // only the caller's own — otherwise a conversation that sends once and is
  // never heard from again would sit in the map for the life of the host.
  // That sweep is only observable through the rate limit it also serves:
  // a sender that earned a refusal earns it back once its own window clears.
  t.mock.timers.enable({ apis: ['Date'] })
  const { team } = await rig(t)
  for (let index = 0; index < 5; index += 1) await team.notify({ where: 'inbox', title: `n${index}` }, scope)
  assert.match(await team.notify({ where: 'inbox', title: 'one too many' }, scope), /^Refused: .*5 things/)
  t.mock.timers.tick(10 * 60_000 + 1)
  assert.doesNotMatch(await team.notify({ where: 'inbox', title: 'fresh again' }, scope), /^Refused/)
})
