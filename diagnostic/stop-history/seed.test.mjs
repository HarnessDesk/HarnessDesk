import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { makeLedger } from './seed.mjs'

test('fixture uses unique source-bound stop identities and empty effect receipts', () => {
  const project = '/private/synthetic-project', ledger = makeLedger(project)
  assert.equal(ledger.version, 2)
  assert.deepEqual(ledger.stopIntents.map(x => x.state), ['inFlight','unconfirmed','reviewed'])
  assert.equal(new Set(ledger.stopIntents.map(x => x.id)).size, 3)
  for (const row of ledger.stopIntents) {
    assert.equal(row.id, `u-${createHash('sha256').update(JSON.stringify([project,row.key.trigger,row.key.repository,row.key.comment])).digest('hex')}`)
    assert.equal(new URL(row.url).hash, `#issuecomment-${row.key.comment}`)
    assert.deepEqual(row.receipts, { queued: [], runs: [], interrupts: [], leadRuns: [], leadPlan: false })
    for (const key of ['goals','firings','queuedTargets','runTargets','interruptTargets','leadRunTargets']) assert.deepEqual(row[key], [])
    assert.equal(row.leadPlanTarget, null)
  }
  assert.notEqual(ledger.stopIntents[0].id, makeLedger('/private/other-project').stopIntents[0].id)
  assert.throws(() => makeLedger('relative'))
})
