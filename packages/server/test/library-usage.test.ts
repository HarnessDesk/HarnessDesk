import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DatabaseSync } from 'node:sqlite'
import { LibraryUsageReader, internals } from '../src/library-usage.js'
import { writeStored, forgetStored } from './fixtures/stored-transcripts.js'

/**
 * The usage reader.
 *
 * Two properties carry it: the extraction reads the shapes the transcripts
 * actually take, and the cache means a second read parses nothing that did
 * not change — proven here by corrupting the file *without* touching its
 * mtime and size, so a re-parse would visibly change the answer.
 */

const transcript = (skills: readonly string[], at: number): string =>
  JSON.stringify({
    version: 1,
    runtime: 'claude-code',
    id: 'session',
    savedAt: at,
    turns: [
      {
        items: skills.map((name, index) => ({
          id: `item-${index}`,
          type: 'command',
          command: `cat /home/u/.claude/skills/${name}/SKILL.md`,
          startedAt: at + index,
        })),
      },
    ],
  })

const withStore = async (
  run: (dir: string, cache: string) => Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-usage-'))
  try {
    await run(join(dir, 'transcripts'), join(dir, 'cache', 'usage.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('skill usage reads new database bodies and ignores the retained transcript folder', async () => {
  await withStore(async (transcripts, cache) => {
    const data = JSON.parse(transcript(['browse'], 100))
    data.turns[0].id = 'turn-1'
    await writeStored(join(transcripts, '..'), 'codex', 'new', data)
    await mkdir(join(transcripts, 'codex'), { recursive: true })
    await writeFile(join(transcripts, 'codex', 'old.json'), transcript(['oldonly'], 1))
    const usage = await new LibraryUsageReader(transcripts, cache).read()
    assert.equal(usage.skills['browse']?.sessions, 1)
    assert.equal(usage.skills['oldonly'], undefined)
  })
})

const writeTranscript = async (path: string, raw: string): Promise<void> => {
  const home = join(path, '../../..')
  const runtime = path.split('/').at(-2)!
  const id = path.split('/').at(-1)!.replace(/\.json$/, '')
  const data = JSON.parse(raw)
  data.runtime = runtime
  data.id = id
  data.turns.forEach((turn: { id?: string }, i: number) => { turn.id = `turn-${i}` })
  await writeStored(home, runtime, id, data)
}
const editDatabase = (transcripts: string, change: (db: DatabaseSync) => void): void => {
  const db = new DatabaseSync(join(transcripts, '..', 'sessions.sqlite'))
  try { change(db) } finally { db.close() }
}

test('activations are counted per conversation with their latest time', async () => {
  await withStore(async (transcripts, cache) => {
    await mkdir(join(transcripts, 'claude-code'), { recursive: true })
    await mkdir(join(transcripts, 'codex'), { recursive: true })
    await writeTranscript(join(transcripts, 'claude-code', 'a.json'), transcript(['browse', 'browse'], 100))
    await writeTranscript(join(transcripts, 'codex', 'b.json'), transcript(['browse'], 500))
    const usage = await new LibraryUsageReader(transcripts, cache).read()
    assert.equal(usage.sessionsScanned, 2)
    // Split by the runtime id each conversation was stored under — the
    // directory name is that id, retired registrations included.
    assert.deepEqual(usage.skills['browse'], {
      sessions: 2,
      activations: 3,
      lastAt: 500,
      byRuntime: {
        'claude-code': { sessions: 1, activations: 2 },
        codex: { sessions: 1, activations: 1 },
      },
    })
  })
})

test('a second read is served from the cache, not a re-parse', async () => {
  await withStore(async (transcripts, cache) => {
    await writeTranscript(join(transcripts, 'codex', 'a.json'), transcript(['qa'], 100))
    const reader = new LibraryUsageReader(transcripts, cache)
    assert.equal((await reader.read()).skills['qa']?.sessions, 1)
    // Keep the durable fingerprint while corrupting its item out of band:
    // re-parsing would lose the skill, so this proves the cache is used.
    editDatabase(transcripts, db => db.prepare("UPDATE items SET payload='broken'").run())
    assert.equal((await new LibraryUsageReader(transcripts, cache).read()).skills['qa']?.sessions, 1)
  })
})

test('a changed file is re-read, and a deleted one leaves the count', async () => {
  await withStore(async (transcripts, cache) => {
    await mkdir(join(transcripts, 'codex'), { recursive: true })
    const a = join(transcripts, 'codex', 'a.json')
    const b = join(transcripts, 'codex', 'b.json')
    await writeTranscript(a, transcript(['one'], 100))
    await writeTranscript(b, transcript(['two'], 100))
    const reader = new LibraryUsageReader(transcripts, cache)
    await reader.read()

    await writeTranscript(a, transcript(['one', 'three'], 200))
    await forgetStored(join(transcripts, '..'), 'codex', 'b')
    const usage = await reader.read()
    assert.equal(usage.sessionsScanned, 1)
    assert.equal(usage.skills['three']?.sessions, 1, 'grown file re-parsed')
    assert.equal(usage.skills['two'], undefined, 'deleted conversation no longer counts')
  })
})

test('extraction survives a file that is not what it claims', () => {
  assert.deepEqual(internals.extract('not json at all'), {})
  assert.deepEqual(internals.extract('{"turns": "wrong shape"}'), {})
})

test('an unavailable database is raised and leaves its cached counts intact', async () => {
  await withStore(async (transcripts, cache) => {
    await writeTranscript(join(transcripts, 'codex', 'a.json'), transcript(['browse'], 100))
    const reader = new LibraryUsageReader(transcripts, cache)
    assert.equal((await reader.read()).skills['browse']?.sessions, 1)
    const file = join(transcripts, '..', 'sessions.sqlite')
    await rename(file, `${file}.away`)
    await writeFile(file, 'not a database')
    await assert.rejects(reader.read())
    await rm(file)
    await rename(`${file}.away`, file)
    const saved = JSON.parse(await readFile(cache, 'utf8')) as { files: Record<string, unknown> }
    assert.ok(saved.files['codex/a.json'])
    assert.equal((await reader.read()).skills['browse']?.sessions, 1)
  })
})

test('an unreadable conversation keeps its count while other conversations are still read', async () => {
  await withStore(async (transcripts, cache) => {
    await writeTranscript(join(transcripts, 'codex', 'a.json'), transcript(['browse'], 100))
    await writeTranscript(join(transcripts, 'claude-code', 'b.json'), transcript(['qa'], 200))
    const logged: string[] = []
    const reader = new LibraryUsageReader(transcripts, cache, { log: (message, details) => logged.push(`${message} ${JSON.stringify(details)}`) })
    await reader.read()
    editDatabase(transcripts, db => {
      db.prepare("UPDATE items SET payload='broken' WHERE runtime='codex'").run()
      db.prepare("UPDATE turns SET fingerprint='changed' WHERE runtime='codex'").run()
    })
    const usage = await reader.read()
    assert.equal(usage.skills['browse']?.sessions, 1)
    assert.equal(usage.skills['qa']?.sessions, 1)
    assert.ok(logged.some(line => line.includes('codex') && line.includes('could not be read')))
  })
})

test('a stray file beside the agents’ folders is nothing, and neither is a store never written', async () => {
  // The control for the two above: this passes against the old catch-all too.
  await withStore(async (transcripts, cache) => {
    const logged: string[] = []
    const reader = new LibraryUsageReader(transcripts, cache, { log: (message) => logged.push(message) })
    assert.equal((await reader.read()).sessionsScanned, 0)
    await mkdir(join(transcripts, 'codex'), { recursive: true })
    await writeTranscript(join(transcripts, 'codex', 'a.json'), transcript(['browse'], 100))
    await writeFile(join(transcripts, '.DS_Store'), 'Finder was here')
    assert.equal((await reader.read()).skills['browse']?.sessions, 1)
    assert.deepEqual(logged, [])
  })
})
