import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { acquireDeskWriter } from '../src/goals/writer-lease.js'
import { tempDir } from './scratch.js'

test('a second writer refuses and an ordinary release admits the next one', async () => {
  const home = tempDir('hd-goal-writer-')
  const first = await acquireDeskWriter(home)
  await assert.rejects(acquireDeskWriter(home), /Another desk holds this state directory/)
  await first.release()
  const second = await acquireDeskWriter(home)
  await second.release()
})

test('release never removes a lock whose token changed', async () => {
  const home = tempDir('hd-goal-writer-token-')
  const first = await acquireDeskWriter(home)
  const file = join(home, 'desk-writer.lock')
  const owner = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...owner, token: 'replacement' }))
  await first.release()
  assert.equal(JSON.parse(await readFile(file, 'utf8')).token, 'replacement')
})

test('a demonstrably dead owner is recovered under the recovery directory', async () => {
  const home = tempDir('hd-goal-writer-dead-')
  await writeFile(join(home, 'desk-writer.lock'), JSON.stringify({ version: 1, pid: 2147483647, token: 'dead', startedAt: 1 }))
  const lease = await acquireDeskWriter(home)
  assert.equal(JSON.parse(await readFile(join(home, 'desk-writer.lock'), 'utf8')).pid, process.pid)
  await lease.release()
})

test('malformed ownership and an existing recovery directory are never removed on age', async () => {
  const home = tempDir('hd-goal-writer-bad-')
  const file = join(home, 'desk-writer.lock')
  await writeFile(file, '{ broken')
  await assert.rejects(acquireDeskWriter(home))
  assert.equal(await readFile(file, 'utf8'), '{ broken')
  const stale = JSON.stringify({ version: 1, pid: 2147483647, token: 'dead', startedAt: 1 })
  await writeFile(file, stale)
  await mkdir(join(home, 'desk-writer-recovery'))
  await assert.rejects(acquireDeskWriter(home), /Repair desk-writer-recovery/)
  assert.equal(await readFile(file, 'utf8'), stale)
})

test('a failed initial write removes only the lock this acquisition created', async () => {
  const home = tempDir('hd-goal-writer-write-')
  await assert.rejects(acquireDeskWriter(home, async () => { throw new Error('lock write failed') }), /lock write failed/)
  assert.deepEqual(await readdir(home), [])
  const retry = await acquireDeskWriter(home)
  await retry.release()
})
