import { DatabaseSync } from 'node:sqlite'
import { workerData } from 'node:worker_threads'

const { file, destination } = workerData as { file: string; destination: string }
const db = new DatabaseSync(file, { readOnly: true })
try { db.prepare('VACUUM INTO ?').run(destination) }
finally { db.close() }
