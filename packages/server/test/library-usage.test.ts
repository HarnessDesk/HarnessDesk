import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { errnoOf } from '../src/errno.js'
import { LibraryUsageReader, internals } from '../src/library-usage.js'

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

test('activations are counted per conversation with their latest time', async () => {
  await withStore(async (transcripts, cache) => {
    await mkdir(join(transcripts, 'claude-code'), { recursive: true })
    await mkdir(join(transcripts, 'codex'), { recursive: true })
    await writeFile(join(transcripts, 'claude-code', 'a.json'), transcript(['browse', 'browse'], 100))
    await writeFile(join(transcripts, 'codex', 'b.json'), transcript(['browse'], 500))
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
    // Seed a cache that contradicts the file on disk while matching its
    // stat exactly. A reader that trusts its cache answers `cso`; one that
    // quietly re-parses answers `qa!`. No mtime games — the contradiction
    // is the proof.
    await mkdir(join(transcripts, 'codex'), { recursive: true })
    const path = join(transcripts, 'codex', 'a.json')
    await writeFile(path, transcript(['qa!'], 100))
    const info = await stat(path)
    await mkdir(join(cache, '..'), { recursive: true })
    await writeFile(
      cache,
      JSON.stringify({
        version: 1,
        files: {
          'codex/a.json': {
            mtimeMs: info.mtimeMs,
            size: info.size,
            skills: { cso: { n: 1, lastAt: 1 } },
          },
        },
      }),
    )
    const again = await new LibraryUsageReader(transcripts, cache).read()
    assert.equal(again.skills['cso']?.sessions, 1, 'cache hit: unchanged mtime+size is not re-read')
    assert.equal(again.skills['qa!'], undefined)
  })
})

test('a changed file is re-read, and a deleted one leaves the count', async () => {
  await withStore(async (transcripts, cache) => {
    await mkdir(join(transcripts, 'codex'), { recursive: true })
    const a = join(transcripts, 'codex', 'a.json')
    const b = join(transcripts, 'codex', 'b.json')
    await writeFile(a, transcript(['one'], 100))
    await writeFile(b, transcript(['two'], 100))
    const reader = new LibraryUsageReader(transcripts, cache)
    await reader.read()

    await writeFile(a, transcript(['one', 'three'], 200))
    await rm(b)
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

/*
 * A folder that cannot be opened is not a folder of conversations nobody had.
 *
 * The reader prunes every cached finding it did not see on this pass, which is
 * right for a conversation that was deleted — and it read a folder it could
 * not open as one with nothing in it. So a mode or a bad mount answered "no
 * skill has ever fired", and emptied the cache on the way: the next read
 * re-parses the whole store, measured at 184MB. The folders below point at
 * themselves, which is ELOOP for any user, root included.
 */

/** Moves a folder to `away` and leaves one that points at itself in its place. */
const loopAt = async (folder: string, away: string): Promise<void> => {
  await rename(folder, away)
  await symlink(folder, folder)
}

test('a transcripts folder that cannot be opened is raised, and its counts are kept', async () => {
  await withStore(async (transcripts, cache) => {
    await mkdir(join(transcripts, 'codex'), { recursive: true })
    await writeFile(join(transcripts, 'codex', 'a.json'), transcript(['browse'], 100))
    const reader = new LibraryUsageReader(transcripts, cache)
    assert.equal((await reader.read()).skills['browse']?.sessions, 1)

    const away = `${transcripts}.away`
    await loopAt(transcripts, away)
    await assert.rejects(reader.read(), (error: unknown) => {
      assert.equal(errnoOf(error), 'ELOOP')
      return true
    })
    await rm(transcripts)
    await rename(away, transcripts)

    const saved = JSON.parse(await readFile(cache, 'utf8')) as { files: Record<string, unknown> }
    assert.ok(saved.files['codex/a.json'], 'the cache was not emptied by a folder it could not open')
    assert.equal((await reader.read()).skills['browse']?.sessions, 1, 'and the count is still there')
  })
})

test('an agent’s folder it cannot open keeps its counts, and says which', async () => {
  await withStore(async (transcripts, cache) => {
    await mkdir(join(transcripts, 'codex'), { recursive: true })
    await mkdir(join(transcripts, 'claude-code'), { recursive: true })
    await writeFile(join(transcripts, 'codex', 'a.json'), transcript(['browse'], 100))
    await writeFile(join(transcripts, 'claude-code', 'b.json'), transcript(['qa'], 200))
    const logged: string[] = []
    const reader = new LibraryUsageReader(transcripts, cache, {
      log: (message, details) => logged.push(`${message} ${JSON.stringify(details ?? {})}`),
    })
    await reader.read()

    const codex = join(transcripts, 'codex')
    // Set aside beside the store rather than in it, where it would be read as an agent of its own.
    await loopAt(codex, join(transcripts, '..', 'codex.away'))
    /* A usage count is a scan, and one folder it cannot open must not cost it
       the others — but what it counted there before is still true of
       conversations that are still on disk, so it is kept rather than
       forgotten, and the folder is named. */
    const usage = await reader.read()
    assert.equal(usage.skills['browse']?.sessions, 1, 'the conversations in it still count')
    assert.equal(usage.skills['qa']?.sessions, 1, 'and the others were read')
    assert.ok(
      logged.some((line) => line.includes(codex) && line.includes('ELOOP')),
      'and the folder that could not be read is named, with the reason',
    )
  })
})

test('a stray file beside the agents’ folders is nothing, and neither is a store never written', async () => {
  // The control for the two above: this passes against the old catch-all too.
  await withStore(async (transcripts, cache) => {
    const logged: string[] = []
    const reader = new LibraryUsageReader(transcripts, cache, { log: (message) => logged.push(message) })
    assert.equal((await reader.read()).sessionsScanned, 0)
    await mkdir(join(transcripts, 'codex'), { recursive: true })
    await writeFile(join(transcripts, 'codex', 'a.json'), transcript(['browse'], 100))
    await writeFile(join(transcripts, '.DS_Store'), 'Finder was here')
    assert.equal((await reader.read()).skills['browse']?.sessions, 1)
    assert.deepEqual(logged, [])
  })
})
