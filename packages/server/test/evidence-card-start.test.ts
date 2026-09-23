import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { RuntimeId, TeamState } from '@harnessdesk/protocol'

import { Team, type TeamPeer, type TeamPort } from '../src/team.js'

/*
 * A claim remembers where its holder's checkout stood when the card was
 * taken: that is where the card's own work began, whatever the Seat did
 * before it, and it is what a diff of that card is measured from.
 */
test('a claim records the commit its holder’s checkout was at when it took the card', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-card-start-'))
  let head = 'a'.repeat(40)
  const peers: TeamPeer[] = [{ runtime: 'codex' as RuntimeId, sessionId: 'worker', title: null, cwd: '/repo', agent: 'codex', busy: false, canSteer: false, queuedByUser: 0, here: true }]
  const port: TeamPort = {
    peers: () => peers, rootOf: async () => '/repo', send: async () => {}, steer: async () => {},
    changed: () => {}, removed: () => {}, membershipChanged: () => {}, audit: () => {},
    headOf: async (cwd) => (cwd === '/repo' ? head : null),
  }
  const team = new Team(dir, port)
  t.after(async () => { team.stopWaiting('done'); await team.flush(); await rm(dir, { recursive: true, force: true }) })
  const room = (await team.createRoom('/repo', 'Goal')).id
  await team.joinRoom(room, 'codex' as RuntimeId, 'worker')
  team.addIntentForFlow(room, { title: 'First', role: 'build', dispatch: 'run:1:0' })
  team.addIntentForFlow(room, { title: 'Second', role: 'build', dispatch: 'run:1:1' })
  team.setRole(room, 'codex', 'worker', 'build')
  const scope = { runtime: 'codex', sessionId: 'worker' }
  await team.claim(1, scope)
  const first = (state: TeamState, id: number) => state.intents.find((one) => one.id === id)
  assert.equal(first(team.stateFor(room), 1)?.claim?.head, 'a'.repeat(40))
  await team.complete(1, {}, scope)
  head = 'b'.repeat(40)
  await team.claim(2, scope)
  assert.equal(first(team.stateFor(room), 2)?.claim?.head, 'b'.repeat(40), 'the second card begins where the checkout stood when it was taken')
})
