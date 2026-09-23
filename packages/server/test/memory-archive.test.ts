import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { CitationArchive } from '../src/memory/archive.js'
import { MemoryPlane, type MemoryPlanePort } from '../src/memory/plane.js'
import { tempDir } from './scratch.js'

/**
 * Durable, content-addressed citation snapshots: durable-before-reference
 * ordering, damaged- and linked-entry refusal, and convergence when more
 * than one caller retains the same bytes at once.
 */

test('reference sees durable bytes', async () => {
  const folder = tempDir('hd-memory-archive-durable-')
  const archive = new CitationArchive(folder)
  let sawOnDisk: string | null = null
  const key = await archive.retain('hello memory\n', async (attachedKey) => {
    // The reference callback runs only after the bytes are durably in place
    // — read the target path directly here, by its own name, never through
    // the archive's own (equally-durable) `read`.
    sawOnDisk = await readFile(join(folder, `${attachedKey}.json`), 'utf8')
  })
  assert.equal(sawOnDisk, 'hello memory\n')
  assert.equal(await archive.read(key), 'hello memory\n')

  // Concurrent retentions of the *same* bytes must each see their reference
  // fire — neither caller is dropped just because the other one's write wins.
  const attached: string[] = []
  const [k1, k2] = await Promise.all([
    archive.retain('shared bytes\n', async (k) => { attached.push(`a:${k}`) }),
    archive.retain('shared bytes\n', async (k) => { attached.push(`b:${k}`) }),
  ])
  assert.equal(k1, k2)
  assert.deepEqual(attached.sort(), [`a:${k1}`, `b:${k1}`])
})

test('refuses damaged or linked existing entries', async () => {
  const folder = tempDir('hd-memory-archive-damaged-')
  const archive = new CitationArchive(folder)
  const key = await archive.retain('original\n', async () => {})

  // Damaged: the file on disk no longer matches what its name promises.
  await writeFile(join(folder, `${key}.json`), 'tampered\n')
  let attachedAfterDamage = false
  await assert.rejects(
    archive.retain('original\n', async () => { attachedAfterDamage = true }),
    /damaged/,
  )
  assert.equal(attachedAfterDamage, false)
  assert.equal(await readFile(join(folder, `${key}.json`), 'utf8'), 'tampered\n', 'the damaged entry itself is left exactly as found')

  // Linked: the entry's name now leads to a link, never a regular file.
  await rm(join(folder, `${key}.json`))
  const elsewhere = join(tempDir('hd-memory-archive-elsewhere-'), 'planted.json')
  await writeFile(elsewhere, 'original\n')
  await symlink(elsewhere, join(folder, `${key}.json`))
  let attachedAfterLink = false
  await assert.rejects(archive.retain('original\n', async () => { attachedAfterLink = true }))
  assert.equal(attachedAfterLink, false)
  assert.equal(await readFile(elsewhere, 'utf8'), 'original\n', 'the link target itself was never touched')
})

test('failure before persistence cannot create a citation', async (t) => {
  const folder = tempDir('hd-memory-archive-failure-')
  const archive = new CitationArchive(folder)

  // The archive writes through a `FileHandle` (`open(...).writeFile(...)`),
  // not the module-level `writeFile` function, so the injection has to wrap
  // `open` itself and return a handle whose own `writeFile` fails — for the
  // one temporary path the archive is about to create, identified by its
  // fixed `.tmp` suffix inside this folder since its exact random name is
  // not known in advance.
  const fsp = createRequire(import.meta.url)('node:fs/promises') as { open: typeof open }
  const realOpen = fsp.open
  let injected = false
  fsp.open = (async (path: unknown, ...rest: unknown[]) => {
    const handle = await realOpen(path as string, ...(rest as [string]))
    if (!injected && typeof path === 'string' && path.startsWith(folder) && path.endsWith('.tmp')) {
      injected = true
      handle.writeFile = (async () => {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }) as typeof handle.writeFile
    }
    return handle
  }) as typeof open
  syncBuiltinESMExports()
  t.after(() => {
    fsp.open = realOpen
    syncBuiltinESMExports()
  })

  let attached = false
  await assert.rejects(archive.retain('never lands\n', async () => { attached = true }), /ENOSPC/)
  assert.equal(attached, false, 'a citation is never created for bytes that were not durably written')
  assert.equal(injected, true, 'the injected failure this test depends on actually fired')

  // The failure may leave an orphaned `.tmp` file; only an explicit sweep
  // removes it, and only the archive's own temporary names.
  const leftBehind = (await readdir(folder)).filter((name) => name.endsWith('.tmp'))
  assert.equal(leftBehind.length, 1)
  await archive.sweepOrphanedTemporaries()
  assert.deepEqual(await readdir(folder), [])

  // The next operation — on the same archive, same folder — succeeds normally.
  const key = await archive.retain('this one lands\n', async () => {})
  assert.equal(await archive.read(key), 'this one lands\n')
})

test('concurrent same-tuple captures converge on one key and one capturedAt', async () => {
  const folder = tempDir('hd-memory-archive-converge-')
  const root = tempDir('hd-memory-archive-converge-repo-')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  await exec('git', ['init', '-q'], { cwd: root })
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(root, '.harnessdesk', 'memory'), { recursive: true })
  await writeFile(join(root, '.harnessdesk', 'memory', 'note.md'), 'shared content\n')
  await exec('git', ['add', '.'], { cwd: root })
  await exec('git', ['-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'x'], { cwd: root })
  const at = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()

  const receipt = {
    version: 1 as const, id: 'receipt-1', goal: 'g1', sentence: 'Wrapped', wrappedAt: 1, summary: 'done',
    cards: [], seats: [], evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [],
  }
  let receiptReads = 0
  const port: MemoryPlanePort = {
    receiptOf: (goal) => {
      receiptReads += 1
      return goal === 'g1' ? receipt : null
    },
    seats: { byId: () => null },
  }
  const plane = new MemoryPlane(folder, port, () => 1234)
  const citation = { goal: 'g1', receipt: 'receipt-1', project: root, path: '.harnessdesk/memory/note.md', at }

  // `capture` de-duplicates in-flight work by tuple *before* its first
  // `await` (the in-flight-promise map is checked and set synchronously), so
  // two callers issued back to back — the ordinary shape of a race, since
  // nothing here needs an artificial delay to land in the same instant —
  // must converge on the very same operation, not merely the same result.
  const p1 = plane.capture(citation)
  const p2 = plane.capture(citation)
  const [key1, key2] = await Promise.all([p1, p2])
  assert.equal(key1, key2, 'both concurrent callers for the same tuple converge on one archive key')
  assert.equal(receiptReads, 1, "the second caller never re-read the receipt at all — it shared the first call's own operation")

  plane.register({ citations: [{ citation, archive: key1 }], satisfiedCitationSources: [] })
  const resolved = await plane.resolve(citation)
  assert.equal(resolved.state, 'retained')
  if (resolved.state === 'retained') assert.equal(resolved.snapshot.capturedAt, 1234)

  // A failed *target* mutation (simulated: the caller simply retries once the
  // first capture already finished) reuses the same key rather than minting
  // a new one with a different capturedAt.
  const retryKey = await plane.capture(citation)
  assert.equal(retryKey, key1)
})
