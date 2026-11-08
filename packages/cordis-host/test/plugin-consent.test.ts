import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ConsentRecord } from '../src/index.js'

/**
 * The consent record keys entries by plugin id, and an id is any safe
 * directory name — `constructor` and `toString` among them. An entry that
 * is not there has to read as absent, not as what every object inherits.
 */
test('a plugin named after an inherited property is recorded, then held to its record', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-consent-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const record = new ConsentRecord(join(dir, 'plugin-consent.json'))
  const manifest = new TextEncoder().encode('{"id":"constructor"}')

  for (const id of ['constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(await record.matches(id, manifest), false, `${id}: no entry is no agreement`)
    assert.equal(await record.check(id, manifest), 'recorded', `${id}: a first start records it`)
    assert.equal(await record.check(id, manifest), 'agreed', `${id}: and the next start agrees`)
    assert.equal(await record.check(id, new TextEncoder().encode('{}')), 'changed', `${id}: a changed manifest is refused`)
  }
})
