import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeId, Session, SessionId } from '@harnessdesk/protocol'
import type { Stored } from './transcripts.js'

/** On-demand read only: older desk files are neither migrated nor changed. */
export async function readKeptTranscriptFile(directory: string, runtime: RuntimeId, id: SessionId): Promise<Session | null> {
  try {
    const stored = JSON.parse(await readFile(join(directory, encodeURIComponent(runtime), `${encodeURIComponent(id)}.json`), 'utf8')) as Stored
    if (!stored || stored.version !== 1 || stored.runtime !== runtime || stored.id !== id ||
      !Number.isFinite(stored.savedAt) || !Array.isArray(stored.turns) || !stored.turns.length ||
      stored.turns.some(turn => !turn || typeof turn.id !== 'string' || !Array.isArray(turn.items) ||
        turn.items.some((item: { id?: unknown; type?: unknown } | null) => !item || typeof item.id !== 'string' || typeof item.type !== 'string'))) return null
    const at = stored.updatedAt ?? stored.savedAt
    return { id, runtime, cwd: stored.cwd ?? '', status: { type: 'idle' }, itemsLoaded: true,
      createdAt: stored.createdAt ?? at, updatedAt: at, turns: stored.turns,
      ...(stored.title !== undefined ? { title: stored.title } : {}),
      ...(stored.preview !== undefined ? { preview: stored.preview } : {}),
      ...(stored.usage ? { usage: stored.usage } : {}),
    }
  } catch { return null }
}
