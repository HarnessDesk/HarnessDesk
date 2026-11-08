import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

const signal = new Int32Array(workerData.signal)
if (workerData.mode === 'reader') {
  const db = new DatabaseSync(workerData.file, { readOnly: true })
  try {
    db.exec('BEGIN')
    db.prepare('SELECT value FROM fixture_marker').get()
    parentPort.postMessage('locked')
    Atomics.wait(signal, 0, 0, 5000)
    if (Atomics.load(signal, 0) !== 1) throw new Error('The opener did not attempt WAL mode')
    Atomics.wait(signal, 1, 0, workerData.holdMs)
    Atomics.store(signal, 1, 1)
    db.exec('COMMIT')
  } finally { db.close() }
} else if (workerData.mode === 'future-version') {
  const db = new DatabaseSync(workerData.file)
  try {
    db.exec('BEGIN IMMEDIATE')
    parentPort.postMessage('locked')
    Atomics.wait(signal, 0, 0, 5000)
    if (Atomics.load(signal, 0) !== 1) throw new Error('The opener did not attempt migration')
    // Keep the writer lock briefly after the opener reaches BEGIN IMMEDIATE.
    Atomics.wait(signal, 1, 0, 150)
    db.exec('PRAGMA user_version = 8; COMMIT')
  } finally { db.close() }
} else {
  // Both real connections have read the old version before either acquires
  // its first migration lock. SQL results and transactions remain genuine.
  const exec = DatabaseSync.prototype.exec
  let first = true
  DatabaseSync.prototype.exec = function (sql) {
    if (first && sql === 'BEGIN IMMEDIATE') {
      first = false
      const entered = Atomics.add(signal, 0, 1) + 1
      Atomics.notify(signal, 0)
      if (entered < 2) Atomics.wait(signal, 0, entered, 5000)
      if (Atomics.load(signal, 0) !== 2) throw new Error('The other initializer did not reach its migration')
    }
    return exec.call(this, sql)
  }
  let db
  try {
    const { openSessionDatabase } = await import(workerData.module)
    db = openSessionDatabase(workerData.file)
    parentPort.postMessage({
      version: Number(db.prepare('PRAGMA user_version').get().user_version),
      marker: db.prepare('SELECT value FROM fixture_marker').get().value,
      worktreeColumns: db.prepare('PRAGMA table_info(session_worktrees)').all().map(row => row.name),
    })
  } finally {
    db?.close()
    DatabaseSync.prototype.exec = exec
  }
}
