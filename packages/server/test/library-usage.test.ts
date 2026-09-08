import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

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
