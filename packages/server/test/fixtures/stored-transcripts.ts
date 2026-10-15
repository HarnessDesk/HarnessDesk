import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runtimeId, sessionId } from '@harnessdesk/protocol'
import { TranscriptDatabase } from '../../src/transcript-database.js'
import { TranscriptStore, type Stored } from '../../src/transcripts.js'

/** Database assertions for caller tests; all homes are isolated synthetic rigs. */
export const readStored = (home: string, runtime: string, id: string): Stored | null => {
  const file = join(home, 'sessions.sqlite')
  if (!existsSync(file)) return null
  const store = new TranscriptDatabase(file)
  try { return store.read(runtime, id) } finally { store.close() }
}

export const writeStored = async (home: string, runtime: string, id: string, data: unknown): Promise<void> => {
  const store = new TranscriptStore(join(home, 'transcripts'))
  try {
    const result = await store.importOne(runtime, id, data)
    if (result !== 'restored') throw new Error(`Synthetic transcript was ${result}`)
  } finally { await store.close() }
}

export const forgetStored = async (home: string, runtime: string, id: string): Promise<void> => {
  const store = new TranscriptStore(join(home, 'transcripts'))
  try { await store.forget(runtimeId(runtime), sessionId(id)) } finally { await store.close() }
}

export const editStoredTurn = (home: string, runtime: string, id: string, edit: (turn: Record<string, unknown>) => void): void => {
  const db = new DatabaseSync(join(home, 'sessions.sqlite'))
  try {
    const row = db.prepare('SELECT turn_id,payload FROM turns WHERE runtime=? AND id=? ORDER BY seq LIMIT 1').get(runtime, id)
    if (!row) throw new Error('Synthetic transcript has no turn')
    const payload = JSON.parse(String(row.payload)) as { turn: Record<string, unknown> }
    edit(payload.turn)
    db.prepare('UPDATE turns SET payload=? WHERE runtime=? AND id=? AND turn_id=?').run(JSON.stringify(payload), runtime, id, String(row.turn_id))
  } finally { db.close() }
}
