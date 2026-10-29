import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { Worker } from 'node:worker_threads'
import { openSessionDatabase } from '../src/session-database.js'

interface Opened {
  version: number
  marker: string
  worktreeColumns: string[]
}

const observeWalAttempt = (t: TestContext, buffer: SharedArrayBuffer): void => {
  const signal = new Int32Array(buffer)
  const exec = DatabaseSync.prototype.exec
  t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql === 'PRAGMA journal_mode = WAL') {
      // Start the peer's hold from the actual WAL attempt, not from a ready
      // message that the main thread may receive much later under load.
      Atomics.store(signal, 0, 1)
      Atomics.notify(signal, 0)
      assert.equal(Atomics.load(signal, 1), 0, 'the real reader still holds its transaction')
    }
    return exec.call(this, sql)
  })
}

const fixture = async (t: TestContext) => {
  const home = await mkdtemp(join(tmpdir(), 'hd-session-open-'))
  const file = join(home, 'sessions.sqlite')
  const seed = new DatabaseSync(file)
  seed.exec("CREATE TABLE fixture_marker(value TEXT); INSERT INTO fixture_marker VALUES('preserved')")
  seed.close()
  const exits: Promise<number>[] = []
  t.after(async () => {
    try {
      const codes = await Promise.all(exits)
      assert.deepEqual(codes, codes.map(() => 0), 'owned peers finish before scratch removal')
    } finally { await rm(home, { recursive: true, force: true }) }
  })
  const peer = (mode: 'reader' | 'initialize', signal: SharedArrayBuffer, holdMs = 0) => {
    const worker = new Worker(new URL('./fixtures/session-database-peer.mjs', import.meta.url), {
      workerData: { file, mode, signal, holdMs, module: new URL('../src/session-database.js', import.meta.url).href },
    })
    exits.push(new Promise(resolve => { worker.once('exit', resolve) }))
    return new Promise<'locked' | Opened>((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', code => { if (code !== 0) reject(new Error(`Database peer exited with ${code}`)) })
    })
  }
  return { file, peer }
}

test('opening WAL mode waits for a short independent read lock', { timeout: 15_000 }, async t => {
  const { file, peer } = await fixture(t)
  const signal = new SharedArrayBuffer(8)
  assert.equal(await peer('reader', signal, 150), 'locked')
  observeWalAttempt(t, signal)
  const db = openSessionDatabase(file)
  try {
    assert.equal(Atomics.load(new Int32Array(signal), 1), 1, 'the peer finished its bounded hold')
    assert.equal(db.prepare('PRAGMA journal_mode').get()?.['journal_mode'], 'wal')
    assert.equal(db.prepare('PRAGMA user_version').get()?.['user_version'], 7)
    assert.equal(db.prepare('SELECT value FROM fixture_marker').get()?.['value'], 'preserved')
  } finally { db.close() }
})

test('concurrent initializers apply each migration only once after acquiring its write lock', { timeout: 15_000 }, async t => {
  const { file, peer } = await fixture(t)
  const seed = new DatabaseSync(file)
  seed.exec('PRAGMA journal_mode = WAL')
  seed.close()
  const signal = new SharedArrayBuffer(4)
  const opened = await Promise.all([peer('initialize', signal), peer('initialize', signal)])
  assert.equal(Atomics.load(new Int32Array(signal), 0), 2)
  for (const result of opened) {
    assert.notEqual(result, 'locked')
    const value = result as Opened
    assert.equal(value.version, 7)
    assert.equal(value.marker, 'preserved')
    assert.ok(value.worktreeColumns.includes('title'))
    assert.ok(value.worktreeColumns.includes('updated_at'))
  }
})

test('a lock that outlasts the busy budget still raises the real SQLite error', { timeout: 15_000 }, async t => {
  const { file, peer } = await fixture(t)
  const signal = new SharedArrayBuffer(8)
  assert.equal(await peer('reader', signal, 6000), 'locked')
  observeWalAttempt(t, signal)
  assert.throws(() => openSessionDatabase(file), (error: unknown) => (error as { errcode?: number }).errcode === 5)
})

test('database opening still rejects corrupted files and a newer schema', async t => {
  const { file } = await fixture(t)
  const newer = new DatabaseSync(file)
  newer.exec('PRAGMA user_version = 8')
  newer.close()
  assert.throws(() => openSessionDatabase(file), /newer schema/)
  await writeFile(file, 'not a SQLite database')
  assert.throws(() => openSessionDatabase(file), /not a database/)
})
