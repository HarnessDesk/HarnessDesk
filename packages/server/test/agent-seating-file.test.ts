import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'

import { SEAT_PREFERENCE_LIMIT } from '@harnessdesk/protocol'

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
  const { seating: after, wrote } = await file.set('code-reviewer', [
    { runtime: 'claude-code', model: 'opus-5', effort: 'high' },
    { runtime: 'cursor', model: 'vendor/model-1' },
  ])
  assert.equal(wrote, true)
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

test('set() holds a list to the limit itself, and writes nothing — the wire in front of it is not its only guard', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  const tooMany = Array.from({ length: SEAT_PREFERENCE_LIMIT + 1 }, () => ({ runtime: 'codex' }))
  await assert.rejects(
    () => new MachineSeatingFile(path).set('judge', tooMany),
    new RegExp(`may name at most ${SEAT_PREFERENCE_LIMIT}, not ${SEAT_PREFERENCE_LIMIT + 1}`),
  )
  await assert.rejects(readFile(path, 'utf8'), /ENOENT/, 'nothing was written')
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
 * And the one read, proven by what a second would do. Every read of the file
 * after the first, before it is written, is handed text that is not JSON: the
 * one read keeps every entry, where the old shape — a second read behind a
 * bare `catch {}` — took that for an empty file and wrote it down to one
 * entry. Only reads before the write count: `set()` builds its answer with a
 * read of its own once the file is written.
 *
 * `node:fs/promises` cannot be redefined through its ESM namespace, so it is
 * patched through its CommonJS face and pushed into the bindings every module
 * already imported (`syncBuiltinESMExports`) — and put back the same way, so no
 * other test sees it.
 */

test('set() reads the file once before it writes it — what a second read would say never reaches the file', async (t) => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  await writeFile(path, JSON.stringify({ judge: ['codex'], researcher: ['cursor'] }), 'utf8')
  const fsp = createRequire(import.meta.url)('node:fs/promises') as {
    readFile: (...args: unknown[]) => Promise<unknown>
    rename: (...args: unknown[]) => Promise<void>
  }
  const { readFile: realRead, rename: realRename } = fsp
  let reads = 0
  let written = false
  fsp.readFile = async (...args) => {
    if (String(args[0]) !== path || written) return realRead(...args)
    reads += 1
    return reads === 1 ? realRead(...args) : '{ oops'
  }
  fsp.rename = async (...args) => {
    await realRename(...args)
    if (String(args[1]) === path) written = true
  }
  syncBuiltinESMExports()
  t.after(() => {
    fsp.readFile = realRead
    fsp.rename = realRename
    syncBuiltinESMExports()
  })

  const { seating, wrote } = await new MachineSeatingFile(path).set('code-reviewer', [{ runtime: 'codex' }])
  assert.equal(wrote, true)
  assert.deepEqual(
    JSON.parse(String(await realRead(path, 'utf8'))),
    { judge: ['codex'], researcher: ['cursor'], 'code-reviewer': ['codex'] },
    'every entry kept',
  )
  // Also what shows the patch reached the module under test: unpatched, nothing here would count a read.
  assert.equal(reads, 1, 'read once before it was written')
  assert.deepEqual(
    seating.entries.map((one) => one.id),
    ['judge', 'researcher', 'code-reviewer'],
  )
})

/*
 * M4: a seat is written the way that reads back the same seat — the compact
 * form when it does, the long form when a runtime, model or effort itself
 * contains a character the compact grammar reads specially.
 */

test('an effort with a + in it is written the long way, not split into an effort and a switch', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  const file = new MachineSeatingFile(path)
  const { seating: after } = await file.set('judge', [{ runtime: 'codex', effort: 'high+thinking' }])
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { judge: [{ runtime: 'codex', effort: 'high+thinking' }] })
  assert.deepEqual(after.entries, [{ id: 'judge', seats: [{ runtime: 'codex', effort: 'high+thinking' }] }])
})

test('an effort with a / in it is written the long way, not cut at the slash', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  const file = new MachineSeatingFile(path)
  const { seating: after } = await file.set('judge', [{ runtime: 'codex', effort: 'x/y' }])
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { judge: [{ runtime: 'codex', effort: 'x/y' }] })
  assert.deepEqual(after.entries, [{ id: 'judge', seats: [{ runtime: 'codex', effort: 'x/y' }] }])
})

test('a runtime with an = in it is written the long way, not read back as a runtime and a model', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  const file = new MachineSeatingFile(path)
  const { seating: after } = await file.set('judge', [{ runtime: 'cursor=m' }])
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
    const { seating, wrote } = await file.set('ghost', null)
    assert.equal(wrote, false, 'and says so')
    assert.deepEqual(seating, { path, entries: [], problems: [] })
  } finally {
    await chmod(dir, 0o755)
  }
})

test('setting the list already there writes nothing', async (t) => {
  const dir = tempDir('hd-seating-')
  const path = join(dir, 'seating.json')
  const file = new MachineSeatingFile(path)
  const seats = [{ runtime: 'codex', effort: 'high' }]
  assert.equal((await file.set('judge', seats)).wrote, true, 'the first set writes the entry')
  await chmod(dir, 0o555)
  try {
    const writable = await writeFile(join(dir, '.probe'), 'x', 'utf8').then(
      () => true,
      () => false,
    )
    if (writable) return t.skip('this user can write into a folder with mode 555')
    const { seating, wrote } = await file.set('judge', seats)
    assert.equal(wrote, false, 'and says so')
    assert.deepEqual(seating.entries, [{ id: 'judge', seats }])
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
  assert.deepEqual(first.seating.entries.map((one) => one.id), ['first'])
  assert.deepEqual(second.seating.entries.map((one) => one.id), ['first', 'second'])
  assert.deepEqual([first.wrote, second.wrote], [true, true], 'two writes, each saying so')
})

test('onlyIfAbsent decides inside the set queue, after an earlier local set has landed', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  const file = new MachineSeatingFile(path)
  const local = file.set('judge', [{ runtime: 'cursor' }])
  const restored = (file.set as unknown as (
    id: string,
    seats: readonly { runtime: string }[],
    options: { onlyIfAbsent: boolean },
  ) => ReturnType<MachineSeatingFile['set']>)('judge', [{ runtime: 'codex' }], { onlyIfAbsent: true })

  const [localOutcome, restoreOutcome] = await Promise.all([local, restored])
  assert.equal(localOutcome.wrote, true)
  assert.equal(restoreOutcome.wrote, false, 'the queued restore saw the local entry and did not overwrite it')
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { judge: ['cursor'] })
})

/*
 * R1 (PR #814 round 1): a project Save reads `seating.json`, decides the id
 * is absent or already its own seat, then walks the project path and writes
 * the Agent folder before it ever calls `set()` — a different window's set
 * for the same id can land in that gap. `refuseIfDifferent` is Save's
 * compare-and-set: decided inside the write queue, the same turn `onlyIfAbsent`
 * already decides its own question in, against whatever is in the file the
 * instant before this call writes it — not the read Save took before any of
 * that awaiting.
 */

test('refuseIfDifferent decides inside the set queue: a queued local set first makes the entry present and different, and the compare-and-set refuses instead of overwriting it', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  const file = new MachineSeatingFile(path)
  // Queued, not raced: started together, the local set's `run()` occupies the
  // queue first and the compare-and-set's `run()` does not read the file
  // until the local set has written it — the same ordering M8's two-sets test
  // already pins, here made to matter for a third call's own decision.
  const local = file.set('scratch', [{ runtime: 'cursor' }])
  const save = (file.set as unknown as (
    id: string,
    seats: readonly { runtime: string; model?: string }[],
    options: { refuseIfDifferent: string },
  ) => ReturnType<MachineSeatingFile['set']>)('scratch', [{ runtime: 'claude-code', model: 'opus-5' }], {
    refuseIfDifferent: 'This Mac already has seats for “scratch”, and they would win over the one you are saving.',
  })

  const [localOutcome] = await Promise.all([local, save.catch((error: unknown) => error)])
  assert.equal(localOutcome.wrote, true)
  await assert.rejects(save, /would win over the one you are saving/)
  assert.deepEqual(
    JSON.parse(await readFile(path, 'utf8')),
    { scratch: ['cursor'] },
    'the queued local set is what stayed — the refused compare-and-set wrote nothing over it',
  )
})

test('refuseIfDifferent writes through when the id is still absent, and is a silent no-op when it already reads back the same seat', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  const file = new MachineSeatingFile(path)
  const seats = [{ runtime: 'claude-code', model: 'opus-5', effort: 'high' }]
  const first = await file.set('scratch', seats, { refuseIfDifferent: 'would win' })
  assert.equal(first.wrote, true, 'absent — the compare-and-set writes through like a plain set')
  const second = await file.set('scratch', seats, { refuseIfDifferent: 'would win' })
  assert.equal(second.wrote, false, 'already exactly this seat — a no-op, never a refusal')
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { scratch: ['claude-code=opus-5/high'] })
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
  // Node's own words for the failure, so this pins the sentence around them, not their wording.
  const error = await readFile(path, 'utf8').then(
    () => '',
    (failure: Error) => failure.message,
  )
  assert.match(error, /EISDIR/)
  const file = new MachineSeatingFile(path)
  const read = await file.read()
  // A sentence, like every other problem this file reports ("it is not JSON: …") — never the error bare.
  assert.deepEqual(read.problems, [{ id: null, at: '', text: `it could not be read: ${error}` }])
  assert.deepEqual(read.entries, [])
  // And set() refuses the file in the same words.
  await assert.rejects(() => file.set('judge', [{ runtime: 'codex' }]), {
    message: `${path} was not changed: it could not be read: ${error}. Fix it or remove it first, so what is in it is not lost.`,
  })
})

test('a file whose JSON is not an object — an array — is a problem, not read as naming no Agent', () => {
  const read = parseSeating('[]')
  assert.deepEqual(read.entries, [])
  assert.equal(read.problems.length, 1)
  assert.equal(read.problems[0]?.id, null)
  assert.match(read.problems[0]?.text ?? '', /not an object/)
})

test('set() refuses a file whose JSON is not an object — a list, a string, null — and leaves it exactly as it was', async () => {
  for (const text of ['[]', '"x"', 'null']) {
    const path = join(tempDir('hd-seating-'), 'seating.json')
    await writeFile(path, text, 'utf8')
    await assert.rejects(
      () => new MachineSeatingFile(path).set('judge', [{ runtime: 'codex' }]),
      /was not changed: it is not an object of Agent ids to lists of seats/,
      `${text} is refused`,
    )
    assert.equal(await readFile(path, 'utf8'), text, `${text} is left byte for byte`)
  }
})

test('thinking survives a write and a read, in both the compact and the long form', async () => {
  const path = join(tempDir('hd-seating-'), 'seating.json')
  const file = new MachineSeatingFile(path)
  const { seating: after } = await file.set('judge', [
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
