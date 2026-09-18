import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { MachineSeatingFile, parseSeating } from '../src/agent-seating-file.js'
import { tempDir } from './scratch.js'

/**
 * This machine's seats. An entry that does not read is reported by its Agent,
 * never dropped — dropped, the Agent would be seated on the list the person
 * replaced — and a file that is not JSON is never written over.
 */

test('each Agent id reads to its seats, in both forms a seat is written in', () => {
  const read = parseSeating(
    JSON.stringify({
      'code-reviewer': ['claude-code=opus-5/high', 'codex/high'],
      researcher: [{ runtime: 'cursor', model: 'vendor/model-1', effort: 'high' }],
    }),
  )
  assert.deepEqual(read.problems, [])
  assert.deepEqual(read.entries, [
    {
      id: 'code-reviewer',
      seats: [
        { runtime: 'claude-code', model: 'opus-5', effort: 'high' },
        { runtime: 'codex', effort: 'high' },
      ],
    },
    { id: 'researcher', seats: [{ runtime: 'cursor', model: 'vendor/model-1', effort: 'high' }] },
  ])
})

test('an entry that does not read is a problem with its Agent and its place, and the others still read', () => {
  const read = parseSeating(JSON.stringify({ judge: ['codex', 'claude-code+fast'], implementer: ['codex'] }))
  assert.deepEqual(read.entries, [{ id: 'implementer', seats: [{ runtime: 'codex' }] }])
  assert.deepEqual(read.problems, [
    { id: 'judge', at: '[1]', text: '"+fast" is not a switch a seat takes — the only one is +thinking' },
  ])
})

test('an entry with no seat, or more than an Agent may name, is refused whole; a lone seat is one seat', () => {
  const nine = Array.from({ length: 9 }, () => 'codex')
  const read = parseSeating(JSON.stringify({ empty: [], long: nine, word: 'codex' }))
  assert.deepEqual(read.entries, [{ id: 'word', seats: [{ runtime: 'codex' }] }])
  assert.deepEqual(
    read.problems.map((one) => [one.id, one.at]),
    [
      ['empty', ''],
      ['long', ''],
    ],
  )
})

test('a file that is not JSON is one problem, for every Agent', () => {
  const read = parseSeating('{ "judge": [codex] }')
  assert.deepEqual(read.entries, [])
  assert.equal(read.problems.length, 1)
  assert.equal(read.problems[0]?.id, null)
  assert.match(read.problems[0]?.text ?? '', /^it is not JSON/)
})

test('no file is no entries and nothing wrong', async () => {
  const file = new MachineSeatingFile(join(tempDir('hd-seating-'), 'seating.json'))
  assert.deepEqual(await file.read(), { path: file.path, entries: [], problems: [] })
})

test('setting one Agent leaves every other entry as it was written, in its place', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  await writeFile(path, JSON.stringify({ judge: ['codex', 'claude-code+fast'], researcher: ['cursor'] }), 'utf8')
  const file = new MachineSeatingFile(path)
  const after = await file.set('code-reviewer', [
    { runtime: 'claude-code', model: 'opus-5', effort: 'high' },
    { runtime: 'cursor', model: 'vendor/model-1' },
  ])
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    // Broken, and kept exactly as written: it is the person's, and they will fix it.
    judge: ['codex', 'claude-code+fast'],
    researcher: ['cursor'],
    // A model whose name the compact form cannot carry is written the long way.
    'code-reviewer': ['claude-code=opus-5/high', { runtime: 'cursor', model: 'vendor/model-1' }],
  })
  assert.deepEqual(
    after.entries.map((one) => one.id),
    ['researcher', 'code-reviewer'],
  )
  await file.set('researcher', null)
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path, 'utf8'))), ['judge', 'code-reviewer'])
})

test('a file that is not JSON is never written over, and an empty list is not a way to clear', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  await writeFile(path, '{ oops', 'utf8')
  const file = new MachineSeatingFile(path)
  await assert.rejects(() => file.set('judge', [{ runtime: 'codex' }]), /was not changed/)
  assert.equal(await readFile(path, 'utf8'), '{ oops')
  const fresh = new MachineSeatingFile(join(tempDir('hd-seating-'), 'seating.json'))
  await assert.rejects(() => fresh.set('judge', []), /at least one seat/)
})
