import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
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

/*
 * I1: `__proto__`, and every other name an object already answers to on its
 * own, is refused as an Agent id — read back it would sit beside real entries
 * indistinguishably, and there is no way to remove what you cannot see.
 */

test('__proto__ and every other name an object already answers to is refused as an Agent id, and every other entry still reads', () => {
  // Built from pairs, not an object literal: `{ __proto__: [...] }` in source
  // sets a prototype, not a key — the file's own text has no such reading,
  // since `JSON.parse` always treats a key as a key, whatever it is spelled.
  const text = JSON.stringify(
    Object.fromEntries([
      ['__proto__', ['codex']],
      ['constructor', ['codex']],
      ['hasOwnProperty', ['codex']],
      ['judge', ['codex']],
    ]),
  )
  const read = parseSeating(text)
  assert.deepEqual(read.entries, [{ id: 'judge', seats: [{ runtime: 'codex' }] }])
  assert.deepEqual(
    read.problems.map((one) => one.id),
    ['__proto__', 'constructor', 'hasOwnProperty'],
  )
  for (const one of read.problems) assert.match(one.text, /rename it/)
})

test('a reserved id is refused by set(), before anything is read or written', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  const file = new MachineSeatingFile(path)
  await assert.rejects(() => file.set('__proto__', [{ runtime: 'codex' }]), /rename it/)
  await assert.rejects(() => file.set('constructor', [{ runtime: 'codex' }]), /rename it/)
  await assert.rejects(readFile(path, 'utf8'), /ENOENT/, 'refused before the first entry could make the file')
})

/*
 * I2: the file is read once. What checks it as a whole and what is kept from
 * it are the same text, so a read that fails for any reason but ENOENT is a
 * refusal, never a file quietly treated as empty and written down to one entry.
 */

test('a file that cannot be read for any reason but ENOENT refuses the set, and is never written over', async (t) => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  await writeFile(path, JSON.stringify({ judge: ['codex'] }), 'utf8')
  await chmod(path, 0o000)
  try {
    const readable = await readFile(path, 'utf8').then(
      () => true,
      () => false,
    )
    if (readable) {
      await chmod(path, 0o700)
      return t.skip('this user can read a file with mode 000')
    }
    const file = new MachineSeatingFile(path)
    await assert.rejects(() => file.set('reviewer', [{ runtime: 'codex' }]), /was not changed/)
  } finally {
    await chmod(path, 0o700)
  }
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { judge: ['codex'] }, 'never written over')
})

/*
 * M4: a seat is written the way that reads back the same seat — the compact
 * form when it does, the long form when a runtime, model or effort itself
 * contains a character the compact grammar reads specially.
 */

test('an effort with a + in it is written the long way, not split into an effort and a switch', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  const file = new MachineSeatingFile(path)
  const after = await file.set('judge', [{ runtime: 'codex', effort: 'high+thinking' }])
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { judge: [{ runtime: 'codex', effort: 'high+thinking' }] })
  assert.deepEqual(after.entries, [{ id: 'judge', seats: [{ runtime: 'codex', effort: 'high+thinking' }] }])
})

test('an effort with a / in it is written the long way, not cut at the slash', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  const file = new MachineSeatingFile(path)
  const after = await file.set('judge', [{ runtime: 'codex', effort: 'x/y' }])
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { judge: [{ runtime: 'codex', effort: 'x/y' }] })
  assert.deepEqual(after.entries, [{ id: 'judge', seats: [{ runtime: 'codex', effort: 'x/y' }] }])
})

test('a runtime with an = in it is written the long way, not read back as a runtime and a model', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  const file = new MachineSeatingFile(path)
  const after = await file.set('judge', [{ runtime: 'cursor=m' }])
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { judge: [{ runtime: 'cursor=m' }] })
  assert.deepEqual(after.entries, [{ id: 'judge', seats: [{ runtime: 'cursor=m' }] }])
})

/*
 * M5: a long-form seat's unknown field is a problem here too, the same as in
 * a flow's own `seat` and an Agent's `prefer` — `seatFromMap` is shared.
 */

test("an unknown field in a long-form seat is a problem, not a silently ignored typo", () => {
  const read = parseSeating(JSON.stringify({ judge: [{ runtime: 'codex', modle: 'gpt-5.3-codex' }] }))
  assert.deepEqual(read.entries, [])
  assert.deepEqual(read.problems, [
    { id: 'judge', at: '[0]', text: `"modle" is not a seat's field — a seat takes runtime, model, effort and thinking` },
  ])
})

/*
 * M7: a set that changes nothing writes nothing — clearing an entry that was
 * never there, or setting the list already in it. Proven by making the
 * folder itself unwritable: a set that (wrongly) tried to write would fail
 * there, and a true no-op never reaches that far.
 */

test('clearing an entry that was never there writes nothing', async (t) => {
  const dir = tempDir('hd-seating-')
  const path = join(dir, 'seating.json')
  await chmod(dir, 0o555)
  try {
    const writable = await writeFile(join(dir, '.probe'), 'x', 'utf8').then(
      () => true,
      () => false,
    )
    if (writable) return t.skip('this user can write into a folder with mode 555')
    const file = new MachineSeatingFile(path)
    const after = await file.set('ghost', null)
    assert.deepEqual(after, { path, entries: [], problems: [] })
  } finally {
    await chmod(dir, 0o755)
  }
})

test('setting the list already there writes nothing', async (t) => {
  const dir = tempDir('hd-seating-')
  const path = join(dir, 'seating.json')
  const file = new MachineSeatingFile(path)
  const seats = [{ runtime: 'codex', effort: 'high' }]
  await file.set('judge', seats)
  await chmod(dir, 0o555)
  try {
    const writable = await writeFile(join(dir, '.probe'), 'x', 'utf8').then(
      () => true,
      () => false,
    )
    if (writable) return t.skip('this user can write into a folder with mode 555')
    const after = await file.set('judge', seats)
    assert.deepEqual(after.entries, [{ id: 'judge', seats }])
  } finally {
    await chmod(dir, 0o755)
  }
})

/*
 * M8: two sets started together both land — `set()` queues them rather than
 * letting the second read the file before the first has written it.
 */

test('two sets started together both land, each on top of what the other wrote', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  const file = new MachineSeatingFile(path)
  // Queued, not raced: the second does not read the file until the first has
  // written it, so its own answer already carries the first's entry too —
  // the un-queued bug reads both from an empty file and the loser's write is lost.
  const [first, second] = await Promise.all([
    file.set('first', [{ runtime: 'codex' }]),
    file.set('second', [{ runtime: 'claude' }]),
  ])
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { first: ['codex'], second: ['claude'] })
  assert.deepEqual(first.entries.map((one) => one.id), ['first'])
  assert.deepEqual(second.entries.map((one) => one.id), ['first', 'second'])
})

/*
 * M11: three gaps the review found — a directory where a file was expected,
 * JSON that is not an object at all, and `thinking` surviving both forms of
 * a write and a read.
 */

test('read() failing with something other than ENOENT — a directory at the path — is a problem, not silence', async () => {
  const dir = tempDir('hd-seating-')
  const path = join(dir, 'seating.json')
  await mkdir(path)
  const file = new MachineSeatingFile(path)
  const read = await file.read()
  assert.equal(read.problems.length, 1)
  assert.equal(read.problems[0]?.id, null)
  assert.match(read.problems[0]?.text ?? '', /EISDIR/)
  assert.deepEqual(read.entries, [])
})

test('a file whose JSON is not an object — an array — is a problem, not read as naming no Agent', () => {
  const read = parseSeating('[]')
  assert.deepEqual(read.entries, [])
  assert.equal(read.problems.length, 1)
  assert.equal(read.problems[0]?.id, null)
  assert.match(read.problems[0]?.text ?? '', /not an object/)
})

test('thinking survives a write and a read, in both the compact and the long form', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  const file = new MachineSeatingFile(path)
  const after = await file.set('judge', [
    { runtime: 'codex', thinking: true },
    { runtime: 'cursor', model: 'vendor/model-1', thinking: true },
  ])
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    judge: ['codex+thinking', { runtime: 'cursor', model: 'vendor/model-1', thinking: true }],
  })
  assert.deepEqual(after.entries, [
    {
      id: 'judge',
      seats: [
        { runtime: 'codex', thinking: true },
        { runtime: 'cursor', model: 'vendor/model-1', thinking: true },
      ],
    },
  ])
})
