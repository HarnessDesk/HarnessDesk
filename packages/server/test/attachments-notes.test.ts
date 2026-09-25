import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { clearAgentNotes, readAgentNotes } from '../src/attachments/notes.js'
import { tempDir } from './scratch.js'

/**
 * `NOTES.md` beside an Agent's file: read confined and bounded, cleared only
 * by an explicit, digest-bound person action that writes atomically and
 * never touches anything else in the folder.
 */

test('a missing notes file reads as text: null, and reading never creates one', async () => {
  const folder = tempDir('hd-notes-')
  const view = await readAgentNotes(folder, true)
  assert.deepEqual(view, { path: join(folder, 'NOTES.md'), text: null, digest: null, writable: true, problem: null })
  await assert.rejects(readFile(join(folder, 'NOTES.md')), /ENOENT/)
})

test('an ordinary notes file reads back its exact text and a stable digest', async () => {
  const folder = tempDir('hd-notes-')
  await writeFile(join(folder, 'NOTES.md'), 'Prefer small diffs.\n', 'utf8')
  const view = await readAgentNotes(folder, true)
  assert.equal(view.text, 'Prefer small diffs.\n')
  assert.match(view.digest ?? '', /^[0-9a-f]{64}$/)
  assert.equal(view.problem, null)
})

test('a file larger than 64 KiB is refused, not truncated and silently shown', async () => {
  const folder = tempDir('hd-notes-')
  await writeFile(join(folder, 'NOTES.md'), 'x'.repeat(64 * 1024 + 1), 'utf8')
  const view = await readAgentNotes(folder, true)
  assert.equal(view.text, null)
  assert.match(view.problem ?? '', /larger than/)
})

test('a NUL byte or invalid UTF-8 is a problem, never silently replaced', async () => {
  const folder = tempDir('hd-notes-')
  await writeFile(join(folder, 'NOTES.md'), Buffer.from([0x68, 0x69, 0x00]))
  const withNul = await readAgentNotes(folder, true)
  assert.equal(withNul.text, null)
  assert.match(withNul.problem ?? '', /NUL/)

  const folder2 = tempDir('hd-notes-')
  await writeFile(join(folder2, 'NOTES.md'), Buffer.from([0xff, 0xfe, 0x00, 0x41]))
  const invalid = await readAgentNotes(folder2, true)
  assert.equal(invalid.text, null)
  assert.ok(invalid.problem)
})

test('a symlinked notes file is refused, never read through', async () => {
  const folder = tempDir('hd-notes-')
  const outside = tempDir('hd-notes-outside-')
  await writeFile(join(outside, 'real.md'), 'not part of this Agent', 'utf8')
  await symlink(join(outside, 'real.md'), join(folder, 'NOTES.md'))
  const view = await readAgentNotes(folder, true)
  assert.equal(view.text, null)
  assert.match(view.problem ?? '', /link/)
})

test('a symlinked Agent folder is refused before anything under it is touched', async () => {
  const real = tempDir('hd-notes-real-')
  await writeFile(join(real, 'NOTES.md'), 'hi', 'utf8')
  const container = tempDir('hd-notes-container-')
  const linked = join(container, 'agent')
  await symlink(real, linked)
  await assert.rejects(readAgentNotes(linked, true), /is a link/)
})

test('clearing writes an empty file atomically, bound to the exact digest shown', async () => {
  const folder = tempDir('hd-notes-')
  await writeFile(join(folder, 'NOTES.md'), 'Prefer small diffs.\n', 'utf8')
  const shown = await readAgentNotes(folder, true)
  const cleared = await clearAgentNotes(folder, shown.digest!)
  assert.equal(cleared.text, '')
  assert.equal(await readFile(join(folder, 'NOTES.md'), 'utf8'), '')
})

test('clearing refuses a digest that no longer matches, and leaves the newer text intact', async () => {
  const folder = tempDir('hd-notes-')
  await writeFile(join(folder, 'NOTES.md'), 'first', 'utf8')
  const shown = await readAgentNotes(folder, true)
  await writeFile(join(folder, 'NOTES.md'), 'changed since then', 'utf8')
  await assert.rejects(clearAgentNotes(folder, shown.digest!), /changed since it was shown to you/)
  assert.equal(await readFile(join(folder, 'NOTES.md'), 'utf8'), 'changed since then')
})

test('clearing an already-absent file creates nothing and reports it as already clear', async () => {
  const folder = tempDir('hd-notes-')
  const result = await clearAgentNotes(folder, 'a'.repeat(64))
  assert.equal(result.text, null)
  await assert.rejects(readFile(join(folder, 'NOTES.md')), /ENOENT/)
})

test('clearing never removes the folder, the Agent file, or any skill file beside it', async () => {
  const folder = tempDir('hd-notes-')
  await writeFile(join(folder, 'AGENT.md'), '---\nname: X\n---\nBrief.\n', 'utf8')
  await mkdir(join(folder, 'skills', 'demo'), { recursive: true })
  await writeFile(join(folder, 'skills', 'demo', 'SKILL.md'), 'skill text', 'utf8')
  await writeFile(join(folder, 'NOTES.md'), 'notes text', 'utf8')
  const shown = await readAgentNotes(folder, true)
  await clearAgentNotes(folder, shown.digest!)
  assert.equal(await readFile(join(folder, 'AGENT.md'), 'utf8'), '---\nname: X\n---\nBrief.\n')
  assert.equal(await readFile(join(folder, 'skills', 'demo', 'SKILL.md'), 'utf8'), 'skill text')
})
