import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexRuntime } from '../src/index.js'

/**
 * Codex's filesystem view through `RuntimeFiles`: search ranked by Codex,
 * reads decoded from base64, and watches routed by id — including the stop.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

const started = async (t: { after(fn: () => Promise<void>): void }): Promise<CodexRuntime> => {
  const runtime = new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-test' })
  t.after(() => runtime.dispose())
  await runtime.start()
  return runtime
}

test('search returns absolute paths ranked by Codex, with match positions', async (t) => {
  const runtime = await started(t)
  const matches = await runtime.files.search(['/w'], 'usrsvc', 10)
  assert.equal(matches.length, 1)
  assert.equal(matches[0]?.path, '/w/src/user_service.ts')
  assert.equal(matches[0]?.relativePath, 'src/user_service.ts')
  assert.equal(matches[0]?.kind, 'file')
  assert.deepEqual(matches[0]?.indices, [4, 5, 7, 9, 12, 14])
})

test('an empty query returns nothing, and never asks Codex', async (t) => {
  const runtime = await started(t)
  assert.deepEqual(await runtime.files.search(['/w'], '   ', 10), [])
  assert.deepEqual(await runtime.files.search([], 'x', 10), [])
})

test('reads come back as bytes; a missing file is an error with Codex\'s reason', async (t) => {
  const runtime = await started(t)
  const bytes = await runtime.files.read('/w/README.md')
  assert.equal(Buffer.from(bytes).toString('utf8'), 'hello from w\n')
  await assert.rejects(() => runtime.files.read('/w/nope.md'), /No such file/)
  await assert.rejects(() => runtime.files.read('relative.md'), /AbsolutePathBuf/)
})

test('directory listings and metadata carry kinds, not booleans', async (t) => {
  const runtime = await started(t)
  const entries = await runtime.files.list('/w')
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.kind]).sort(),
    [
      ['README.md', 'file'],
      ['src', 'directory'],
    ],
  )
  assert.equal((await runtime.files.stat('/w/src')).kind, 'directory')
  assert.equal((await runtime.files.stat('/w/README.md')).modifiedAt, 1_700_000_001_000)
})

test('a watch delivers changes until it is stopped, and no further', async (t) => {
  const runtime = await started(t)
  const seen: string[][] = []
  const stop = await runtime.files.watch('/w', (paths) => seen.push([...paths]))
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(seen, [['/w/first.txt']])
  stop()
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(seen, [['/w/first.txt']], 'nothing arrives after unwatch')
  // Stopping twice is harmless.
  stop()
})

test('two watches on different paths are routed to their own listeners', async (t) => {
  const runtime = await started(t)
  const a: string[] = []
  const b: string[] = []
  const stopA = await runtime.files.watch('/w', (paths) => a.push(...paths))
  const stopB = await runtime.files.watch('/w/src', (paths) => b.push(...paths))
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(a, ['/w/first.txt'])
  assert.deepEqual(b, ['/w/src/first.txt'])
  stopA()
  stopB()
})
