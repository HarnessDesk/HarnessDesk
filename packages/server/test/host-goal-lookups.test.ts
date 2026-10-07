import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { GoalStore, type GoalDocument } from '../src/goals/store.js'
import { goal } from './fixtures/goals.js'
import { Client, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

test('startup, health changes and Seat activity copy only the Goals they need', async (t) => {
  const home = tempDir('hd-goal-lookups-')
  const work = tempDir('hd-goal-lookups-work-')
  const ids = Array.from({ length: 320 }, (_, index) => `g-${index}`)
  await mkdir(join(home, 'goals'))
  await writeFile(join(home, 'goals', 'index.json'), JSON.stringify({ version: 1, noticeSeen: true, ids }))
  for (const id of ids) {
    const document: GoalDocument = {
      version: 1, goal: goal(id, { root: work, cwd: work }),
      board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
      citations: [], receipt: null, operation: null,
    }
    await writeFile(join(home, 'goals', `${id}.json`), JSON.stringify(document))
  }

  let copies = 0
  const { list, read } = GoalStore.prototype
  t.mock.method(GoalStore.prototype, 'list', function (this: GoalStore) {
    const documents = list.call(this)
    copies += documents.length
    return documents
  })
  t.mock.method(GoalStore.prototype, 'read', function (this: GoalStore, id: string) {
    copies += 1
    return read.call(this, id)
  })
  const rig = await start({ catalogRefreshMs: 0, idleStopMs: 0, retryDelaysMs: [] }, home)
  t.after(() => stop(rig))
  const startup = copies
  copies = 0
  rig.runtime.setHealth({ state: 'unavailable', reason: 'unknown', message: 'stopped' })
  const health = copies
  rig.runtime.setHealth({ state: 'ready' })
  const client = await Client.connect(rig.server)
  t.after(() => client.close())
  copies = 0
  await client.call('team/add', { room: ids[0], title: 'Observe activity' })
  await rig.host.teamPlane.flush()
  const activity = copies
  t.diagnostic(`store document copies: startup=${startup}, health=${health}, activity=${activity}`)

  await t.test('startup is linear in the number of stored Goals', () => {
    assert.ok(startup <= ids.length * 20, `${startup} document copies for ${ids.length} Goals`)
  })
  await t.test('health detachment copies at most one document per Team', () => {
    assert.ok(health <= ids.length, `${health} document copies for ${ids.length} Teams`)
    assert.ok(health > 0, 'the health change traversed the retained Teams')
  })
  await t.test('one board change does not copy unrelated Goals', () => {
    assert.ok(activity < 20, `${activity} document copies for one board change`)
  })
})
