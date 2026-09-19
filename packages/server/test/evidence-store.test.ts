import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Evidence, EvidenceRecord } from '@harnessdesk/protocol'

import { foldSeats, LINE_LIMIT, lineOf, TAIL_LIMIT, type SeatOpening, type StoredLine } from '../src/evidence/records.js'
import { EvidenceStore, type Admit } from '../src/evidence/store.js'
import { tempDir } from './scratch.js'

/*
 * The evidence store: append-only, one folder per project, never inside the
 * project, durable when an append answers, and read through the one
 * contextual, bounded rule a restore uses too (`lineOf`).
 */

const A = 'a'.repeat(40)
const SEATS = { file: 'seats', project: '/work/repo' } as const
const FACTS = { file: 'evidence', project: '/work/repo' } as const

const opening = (over: Partial<SeatOpening> = {}): SeatOpening => ({
  id: 'seat-1',
  agent: { id: 'reviewer', name: 'Reviewer', origin: 'user' },
  briefDigest: 'digest-1',
  seat: { runtime: 'fake' },
  seatLabel: 'Fake Runtime',
  passedOver: [],
  standing: { kind: 'permission', permission: 'read' },
  ceiling: null,
  checkout: { cwd: '/work/repo', project: '/work/repo', branch: 'main', head: A },
  session: { runtime: 'fake', sessionId: 'fake-session-1' },
  board: null,
  role: null,
  openedAt: 1,
  ...over,
})

type CheckFact = Extract<Evidence, { kind: 'check' }>

const check = (over: Partial<CheckFact> = {}): CheckFact => ({
  kind: 'check',
  name: 'verify',
  run: 'pnpm verify',
  exit: 0,
  timedOut: false,
  at: A,
  dirty: false,
  tail: '',
  ...over,
})

const checkFact = (over: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id: 'fact-1',
  fact: check(),
  card: { board: 'room-1', id: 3 },
  checkout: { cwd: '/work/repo', branch: 'main' },
  seat: null,
  round: null,
  observedAt: 2,
  posted: null,
  ...over,
})

const seatLine = (over: Partial<SeatOpening> = {}): StoredLine => ({ type: 'seat', record: opening(over) })
const factLine = (over: Partial<EvidenceRecord> = {}): StoredLine => ({ type: 'evidence', record: checkFact(over) })
const ids = (lines: readonly StoredLine[]): string[] => lines.map((line) => (line.type === 'evidence' ? line.record.id : ''))

test('what is appended is read back in the order it was written, apart per project and per file', async () => {
  const dir = tempDir('hd-evidence-store-')
  const store = new EvidenceStore(dir)
  await store.append('/work/repo', 'seats', [seatLine()])
  await store.append('/work/repo', 'evidence', [factLine(), factLine({ id: 'fact-2', observedAt: 3 })])
  await store.append('/work/other', 'evidence', [factLine({ id: 'fact-3' })])

  assert.deepEqual((await store.read('/work/repo', 'seats')).lines, [seatLine()])
  assert.deepEqual(ids((await store.read('/work/repo', 'evidence')).lines), ['fact-1', 'fact-2'])
  assert.deepEqual(ids((await store.read('/work/other', 'evidence')).lines), ['fact-3'])
  assert.deepEqual(await store.projects(), ['/work/other', '/work/repo'])
  // Beside the desk's other state, named for the project, and nowhere inside it.
  assert.ok(store.folderOf('/work/repo').startsWith(dir))
  assert.match(store.folderOf('/work/repo'), /\/repo-[0-9a-f]{10}$/)
})

test('appends that arrive together are all written, and none is lost or torn', async () => {
  const store = new EvidenceStore(tempDir('hd-evidence-store-'))
  await Promise.all(
    Array.from({ length: 50 }, (_, n) => store.append('/work/repo', 'evidence', [factLine({ id: `fact-${n}` })])),
  )
  const { lines, skipped } = await store.read('/work/repo', 'evidence')
  assert.equal(skipped, 0)
  assert.equal(new Set(ids(lines)).size, 50)
})

test('two stores writing one folder at once put their lines in either order, never inside each other', async () => {
  const dir = tempDir('hd-evidence-store-')
  const first = new EvidenceStore(dir)
  const second = new EvidenceStore(dir)
  const tail = 'x'.repeat(TAIL_LIMIT)
  await Promise.all(
    Array.from({ length: 100 }, (_, n) => [
      first.append('/work/repo', 'evidence', [factLine({ id: `first-${n}`, fact: check({ tail }) })]),
      second.append('/work/repo', 'evidence', [factLine({ id: `second-${n}`, fact: check({ tail }) })]),
    ]).flat(),
  )
  const { lines, skipped } = await new EvidenceStore(dir).read('/work/repo', 'evidence')
  assert.equal(skipped, 0)
  assert.equal(new Set(ids(lines)).size, 200)
})

test('a process killed while it writes leaves whole lines, and the store goes on after it', async () => {
  const dir = tempDir('hd-evidence-store-')
  const module = new URL('../src/evidence/store.js', import.meta.url).href
  const record = checkFact()
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { EvidenceStore } = await import(${JSON.stringify(module)})
       const store = new EvidenceStore(${JSON.stringify(dir)})
       const record = ${JSON.stringify(record)}
       for (let n = 0; ; n += 1) {
         await store.append('/work/repo', 'evidence', [{ type: 'evidence', record: { ...record, id: 'fact-' + n } }])
         if (n === 20) process.stdout.write('ready\\n')
       }`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) resolve()
    })
    child.on('exit', () => reject(new Error('the writer ended before it was killed')))
  })
  const ended = new Promise((resolve) => child.on('exit', resolve))
  child.kill('SIGKILL')
  await ended

  const store = new EvidenceStore(dir)
  const before = await store.read('/work/repo', 'evidence')
  assert.ok(before.lines.length >= 21, 'every line it answered for is there')
  assert.ok(before.skipped <= 1, 'at most the one line it was writing when it was killed')
  await store.append('/work/repo', 'evidence', [factLine({ id: 'after' })])
  const after = await store.read('/work/repo', 'evidence')
  assert.equal(ids(after.lines).at(-1), 'after')
  assert.equal(after.skipped, before.skipped)
})

test('a line a crash cut short is ended before the next is written, so it swallows nothing', async () => {
  const store = new EvidenceStore(tempDir('hd-evidence-store-'))
  await store.append('/work/repo', 'evidence', [factLine()])
  const file = join(store.folderOf('/work/repo'), 'evidence.ndjson')
  await appendFile(file, '{"v":1,"type":"evidence","record":{"id":"half')
  await store.append('/work/repo', 'evidence', [factLine({ id: 'fact-2' })])

  const { lines, skipped } = await store.read('/work/repo', 'evidence')
  assert.deepEqual(ids(lines), ['fact-1', 'fact-2'])
  assert.equal(skipped, 1, 'the torn line is counted, not hidden')
})

test('a write that fails is refused to its caller, and reported again by the next flush', async () => {
  const dir = tempDir('hd-evidence-store-')
  const store = new EvidenceStore(join(dir, 'blocked'))
  await writeFile(join(dir, 'blocked'), 'a file where the store wanted a folder')
  await assert.rejects(store.append('/work/repo', 'evidence', [factLine()]))
  await assert.rejects(store.flush(), 'the quit is told what was lost')
  await store.flush()
})

test('a record too large to be one line is refused, and a line too large is never read', async () => {
  const store = new EvidenceStore(tempDir('hd-evidence-store-'))
  const huge = factLine({ fact: check({ tail: 'x'.repeat(LINE_LIMIT) }) })
  await assert.rejects(store.append('/work/repo', 'evidence', [huge]), /a line may be at most 65536/)
  await store.append('/work/repo', 'evidence', [factLine()])
  const file = join(store.folderOf('/work/repo'), 'evidence.ndjson')
  await appendFile(file, `${JSON.stringify({ v: 1, type: 'evidence', record: { ...checkFact({ id: 'big' }), posted: null, pad: 'y'.repeat(LINE_LIMIT) } })}\n`)
  const { lines, skipped } = await store.read('/work/repo', 'evidence')
  assert.deepEqual([ids(lines), skipped], [['fact-1'], 1])
})

test('a line this build cannot read is skipped and counted, and never rewritten', async () => {
  const logged: unknown[] = []
  const store = new EvidenceStore(tempDir('hd-evidence-store-'), (message, details) => void logged.push({ message, details }))
  await store.append('/work/repo', 'evidence', [factLine()])
  const file = join(store.folderOf('/work/repo'), 'evidence.ndjson')
  const newer = '{"v":2,"type":"evidence","record":{"id":"from-later"}}\n'
  const unknownKind = `${JSON.stringify({ v: 1, type: 'evidence', record: { ...checkFact({ id: 'x' }), fact: { kind: 'vibes', at: A } } })}\n`
  await appendFile(file, newer + unknownKind)
  await store.append('/work/repo', 'evidence', [factLine({ id: 'fact-2' })])

  const { lines, skipped } = await store.read('/work/repo', 'evidence')
  assert.equal(lines.length, 2)
  assert.equal(skipped, 2)
  assert.equal(logged.length, 1)
  const text = await readFile(file, 'utf8')
  assert.ok(text.includes(newer) && text.includes(unknownKind), 'what a later build wrote is still there, as written')
})

test('the one rule reads a line where it is: its file, its project, and within its limits', () => {
  // A Seat in the facts file, a fact in the Seats file, a Seat kept under another project: no line at all.
  assert.equal(lineOf({ v: 1, ...seatLine() }, FACTS), null)
  assert.equal(lineOf({ v: 1, ...factLine() }, SEATS), null)
  assert.equal(lineOf({ v: 1, ...seatLine() }, { file: 'seats', project: '/work/other' }), null)
  assert.ok(lineOf({ v: 1, ...seatLine() }, SEATS))
  // A tail longer than a record keeps, or a list longer than its limit, is not a record this build reads.
  assert.equal(lineOf({ v: 1, ...factLine({ fact: check({ tail: 'x'.repeat(TAIL_LIMIT + 1) }) }) }, FACTS), null)
  const crowd = Array.from({ length: 65 }, () => ({ seat: { runtime: 'fake' }, label: 'Fake', runtimeName: 'Fake', state: 'passed' }))
  assert.equal(lineOf({ v: 1, type: 'seat', record: { ...opening(), passedOver: crowd } }, SEATS), null)
  // A fact bound to something that is not a full commit id is not a fact about a revision.
  assert.equal(lineOf({ v: 1, type: 'evidence', record: { ...checkFact(), fact: check({ at: 'HEAD' }) } }, FACTS), null)
})

test('a Seat record says its standing order in either generation, and always has the ceiling slot', () => {
  // Today's generation: the Agent's `permission:`, and no ceiling yet.
  assert.ok(lineOf({ v: 1, ...seatLine() }, SEATS))
  // Phase 3's: an Agent that says only `ceiling:`, and the ceiling it ran under.
  const ceilingOnly = seatLine({ standing: { kind: 'ceiling', level: 'edit' }, ceiling: { level: 'edit', hold: 'held' } })
  assert.deepEqual(lineOf({ v: 1, ...ceilingOnly }, SEATS), ceilingOnly)
  // Neither generation, a mixture, or no ceiling slot at all is no record this build reads.
  const { standing: _standing, ...unordered } = opening()
  assert.equal(lineOf({ v: 1, type: 'seat', record: { ...unordered, permission: 'read' } }, SEATS), null)
  assert.equal(lineOf({ v: 1, type: 'seat', record: { ...opening(), standing: { kind: 'ceiling', permission: 'read' } } }, SEATS), null)
  const { ceiling: _ceiling, ...withoutSlot } = opening()
  assert.equal(lineOf({ v: 1, type: 'seat', record: withoutSlot }, SEATS), null)
  assert.equal(lineOf({ v: 1, type: 'seat', record: { ...opening(), ceiling: { level: 'owner', hold: 'held' } } }, SEATS), null)
})

test('a read, a judgement and an append are one step: two merges at once never add a record twice', async () => {
  const store = new EvidenceStore(tempDir('hd-evidence-store-'))
  const onlyNew: Admit = (line, here, added) =>
    [...here, ...added].some((one) => one.type === 'evidence' && line.type === 'evidence' && one.record.id === line.record.id)
      ? 'duplicate'
      : 'add'
  const lines = [factLine({ id: 'one' }), factLine({ id: 'two' })]
  const [first, second] = await Promise.all([
    store.merge('/work/repo', 'evidence', lines, onlyNew),
    store.merge('/work/repo', 'evidence', lines, onlyNew),
  ])
  assert.deepEqual([first.added + second.added, first.duplicate + second.duplicate], [2, 2])
  assert.deepEqual(ids((await store.read('/work/repo', 'evidence')).lines), ['one', 'two'])
})

test('a Seat is closed by its first closing, and a second changes nothing', () => {
  const seats = foldSeats([
    seatLine(),
    seatLine({ id: 'seat-2' }),
    { type: 'seat-closed', closing: { seat: 'seat-1', at: 9, why: 'deleted' } },
    { type: 'seat-closed', closing: { seat: 'seat-1', at: 12, why: 'released' } },
  ])
  assert.deepEqual(
    seats.map((seat) => [seat.id, seat.closed]),
    [
      ['seat-1', { at: 9, why: 'deleted' }],
      ['seat-2', null],
    ],
  )
})

test('a folder whose name does not match the project it claims is not listed', async () => {
  const dir = tempDir('hd-evidence-store-')
  const store = new EvidenceStore(dir)
  await store.append('/work/repo', 'seats', [seatLine()])
  await writeFile(join(store.folderOf('/work/repo'), 'project.json'), JSON.stringify({ root: '/work/elsewhere' }))
  assert.deepEqual(await store.projects(), [])
  assert.equal((await readdir(dir)).length, 1)
})

test('nothing in the store can change or remove a line once it is written: it only appends', () => {
  assert.deepEqual(
    Object.getOwnPropertyNames(EvidenceStore.prototype).sort(),
    ['append', 'constructor', 'flush', 'folderOf', 'merge', 'projects', 'read'],
  )
})
