import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { SessionIndex } from '../src/session-index.js'

import { DailySessionSnapshots } from '../src/session-snapshots.js'

test('daily snapshots contain the database, keep three and persist the day across restarts', async t => {
  const home = await mkdtemp(join(tmpdir(), 'hd-snapshots-'))
  const file = join(home, 'sessions.sqlite')
  const index = new SessionIndex(file)
  index.close()
  let now = Date.UTC(2026, 9, 8)
  const Snapshots = DailySessionSnapshots
  const snapshots = new Snapshots(file, { now: () => now })
  t.after(async () => { await snapshots.close(); await rm(home, { recursive: true, force: true }) })
  assert.equal(await snapshots.runIfDue(), true)
  assert.equal(await snapshots.runIfDue(), false)
  for (let i = 0; i < 3; i++) { now += 86_400_000; assert.equal(await snapshots.runIfDue(), true) }
  const names = (await readdir(home)).filter(name => /^sessions-.*\.sqlite$/.test(name)).sort()
  assert.deepEqual(names, ['sessions-2026-10-09.sqlite', 'sessions-2026-10-10.sqlite', 'sessions-2026-10-11.sqlite'])
  const snapshot = new DatabaseSync(join(home, names[2]!), { readOnly: true })
  assert.equal(snapshot.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='sessions'").get()?.n, 1)
  snapshot.close()
  const restarted = new Snapshots(file, { now: () => now })
  try { assert.equal(await restarted.runIfDue(), false) } finally { await restarted.close() }
})

test('a snapshot never overlaps itself or holds a turn write while its worker is waiting', async t => {
  const home = await mkdtemp(join(tmpdir(), 'hd-snapshots-'))
  const file = join(home, 'sessions.sqlite')
  const index = new SessionIndex(file)
  let release!: () => void
  let entered!: () => void
  const began = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const Snapshots = DailySessionSnapshots
  const snapshots = new Snapshots(file, { take: async destination => {
    calls++; entered(); await held
    const db = new DatabaseSync(file)
    try { db.prepare('VACUUM INTO ?').run(destination) } finally { db.close() }
  } })
  t.after(async () => { release(); await snapshots.close(); index.close(); await rm(home, { recursive: true, force: true }) })
  const running = snapshots.runIfDue()
  await began
  assert.equal(await snapshots.runIfDue(), false)
  index.setTitle('demo' as never, 's1' as never, 'A write while the snapshot waits')
  assert.equal(calls, 1)
  release()
  assert.equal(await running, true)
})
