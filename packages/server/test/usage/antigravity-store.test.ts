import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'

import { antigravityUsageRecord, usageOfCalls, usageRecordFor } from '../../src/usage/antigravity-store.js'

/**
 * Antigravity's conversation store, rebuilt the way its server writes one:
 * the `gen_metadata` table as measured on 2026-09-09, in WAL mode, each row a
 * protobuf whose field 1 is the call's metadata and field 4 inside that
 * Codeium's `ModelUsageStats`. The numbers are real calls from that store.
 */

// A protobuf writer, only as far as these rows need one.
const varint = (value: number): number[] => {
  const out: number[] = []
  let rest = value
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  out.push(rest)
  return out
}
const int = (field: number, value: number): number[] => [...varint(field * 8), ...varint(value)]
const message = (field: number, body: readonly number[]): number[] => [...varint(field * 8 + 2), ...varint(body.length), ...body]
const text = (field: number, value: string): number[] => message(field, [...Buffer.from(value)])

interface Call {
  readonly input: number
  readonly output: number
  readonly read?: number
  readonly write?: number
  readonly thinking: number
  readonly response: number
}

const SESSION = '85b064c7-0b9c-4935-ab41-e68e372c1009'

/** One `gen_metadata` blob of the measured shape, fields in the order the server writes them. */
const blob = (call: Call): Uint8Array => {
  const usage = [
    ...int(2, call.input),
    ...int(3, call.output),
    ...(call.write === undefined ? [] : int(4, call.write)),
    ...(call.read === undefined ? [] : int(5, call.read)),
    ...int(9, call.thinking),
    ...int(10, call.response),
  ]
  const metadata = [...int(3, 326), ...message(4, usage), ...text(19, 'gemini-3.8-flash')]
  return Uint8Array.from([...message(2, [0x08, 0x01]), ...text(4, SESSION), ...int(10, 1), ...message(1, metadata)])
}

/**
 * A `.gemini` folder holding one conversation store, open on the server's
 * side as a live one is. `table: false` is a store caught between its file
 * and its schema — another of the server's tables is written, so the WAL and
 * its `-shm` exist, but not the one the usage lives in.
 */
const store = (t: TestContext, { table = true }: { table?: boolean } = {}) => {
  const gemini = mkdtempSync(join(tmpdir(), 'hd-agy-'))
  const folder = join(gemini, 'antigravity-acp', 'conversations')
  mkdirSync(folder, { recursive: true })
  const path = join(folder, `${SESSION}.db`)
  const server = new DatabaseSync(path)
  server.exec('PRAGMA journal_mode=WAL')
  server.exec('CREATE TABLE `trajectory_meta` (`trajectory_id` text, PRIMARY KEY (`trajectory_id`))')
  const createTable = (): void =>
    server.exec(
      'CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))',
    )
  if (table) createTable()
  let open = true
  const close = (): void => {
    if (open) server.close()
    open = false
  }
  // `t.after` runs its callbacks in the order they were added: close first.
  t.after(close)
  t.after(() => rmSync(gemini, { recursive: true, force: true }))
  let next = 0
  const addRaw = (data: Uint8Array): void => {
    server.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(next++, data, data.length)
  }
  const add = (call: Call): void => addRaw(blob(call))
  return { gemini, path, add, addRaw, createTable, close }
}

test('a turn is the calls it added to the store, counted the way the agent counted them', (t) => {
  const { gemini, add } = store(t)
  const record = antigravityUsageRecord({ env: { GEMINI_HOME: gemini } })
  add({ input: 7404, output: 558, read: 4057, thinking: 462, response: 96 }) // the turn before
  const mark = record.mark(SESSION)
  assert.equal(mark, 1)
  add({ input: 9509, output: 211, read: 4078, thinking: 112, response: 99 })
  add({ input: 14017, output: 324, thinking: 224, response: 100 })
  // Input excludes the cached part in the store and includes it in ACP, so
  // the reads are added back; output already includes the thinking.
  assert.deepEqual(record.since(SESSION, mark ?? -1), {
    totalTokens: 9509 + 4078 + 14017 + 211 + 324,
    inputTokens: 9509 + 4078 + 14017,
    outputTokens: 211 + 324,
    cachedReadTokens: 4078,
    thoughtTokens: 112 + 224,
  })
  assert.deepEqual(
    record.since(SESSION, 3),
    { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
    'a turn that called no model is a turn of nothing, and says so — or the one before it reads as the last',
  )
})

test('a store with no calls yet, or none at all, marks the start of the conversation', (t) => {
  const { gemini } = store(t)
  assert.equal(antigravityUsageRecord({ env: { GEMINI_HOME: gemini } }).mark(SESSION), 0)
  const nothing = mkdtempSync(join(tmpdir(), 'hd-agy-none-'))
  t.after(() => rmSync(nothing, { recursive: true, force: true }))
  assert.equal(antigravityUsageRecord({ env: { GEMINI_HOME: nothing } }).mark(SESSION), 0)
  assert.equal(antigravityUsageRecord({ env: { GEMINI_HOME: nothing } }).since(SESSION, 0), null)
})

test('a store the server has closed is left unread, because reading it would write beside it', (t) => {
  const { gemini, path, add, close } = store(t)
  add({ input: 100, output: 10, thinking: 0, response: 10 })
  close()
  assert.equal(existsSync(`${path}-shm`), false, 'the last connection took its -shm with it')
  const record = antigravityUsageRecord({ env: { GEMINI_HOME: gemini } })
  assert.equal(record.mark(SESSION), null)
  assert.equal(record.since(SESSION, 0), null)
  assert.equal(existsSync(`${path}-shm`), false, 'and the reader made none')
})

test('a write count appears only where a call named one — the wire format drops a zero', () => {
  const claude = usageOfCalls([
    blob({ input: 100, output: 12, write: 50, read: 20, thinking: 2, response: 10 }),
    blob({ input: 5, output: 1, read: 170, thinking: 0, response: 1 }),
  ])
  assert.equal(claude?.cachedWriteTokens, 50)
  assert.equal(claude?.inputTokens, 100 + 50 + 20 + 5 + 170)
  const gemini = usageOfCalls([blob({ input: 100, output: 10, read: 20, thinking: 0, response: 10 })])
  assert.ok(gemini)
  assert.equal('cachedWriteTokens' in gemini, false, 'not reported stays absent')
})

test('a row not of the measured shape is skipped, and a turn of nothing else says nothing', () => {
  const good = blob({ input: 10, output: 2, thinking: 1, response: 1 })
  assert.equal(usageOfCalls([Uint8Array.from([0xff, 0xff, 0xff])])?.totalTokens ?? null, null)
  assert.equal(usageOfCalls([Uint8Array.from([0x0a, 0x05, 0x01])]), null, 'a length past the end')
  assert.equal(usageOfCalls([Uint8Array.from(text(4, SESSION))]), null, 'no call metadata')
  assert.equal(usageOfCalls([Uint8Array.from([0xff, 0xff]), good])?.totalTokens, 12)
})

test('only a plain session id is ever joined to a path', () => {
  const record = antigravityUsageRecord({ env: { GEMINI_HOME: tmpdir() } })
  assert.equal(record.mark('../../etc/passwd'), null)
  assert.equal(record.since('../x', 0), null)
})

test('only Antigravity keeps a record this way', () => {
  assert.ok(usageRecordFor({ id: 'antigravity-acp' }))
  assert.equal(usageRecordFor({ id: 'gemini' }), undefined)
  assert.equal(usageRecordFor(undefined), undefined)
})

test('a row that lands after its turn was read is in no turn: never counted twice, never under the next', (t) => {
  const { gemini, add } = store(t)
  const record = antigravityUsageRecord({ env: { GEMINI_HOME: gemini } })
  const first = record.mark(SESSION) ?? -1
  add({ input: 100, output: 10, thinking: 0, response: 10 })
  assert.equal(record.since(SESSION, first)?.inputTokens, 100)
  // Committed after the turn above was read and before the next was marked.
  add({ input: 5000, output: 50, thinking: 0, response: 50 })
  const second = record.mark(SESSION) ?? -1
  add({ input: 200, output: 20, thinking: 0, response: 20 })
  assert.equal(record.since(SESSION, second)?.inputTokens, 200)
})

test('a store opened before its table exists is empty, not unreadable, and its calls count once the table arrives', (t) => {
  const { gemini, path, add, createTable } = store(t, { table: false })
  const record = antigravityUsageRecord({ env: { GEMINI_HOME: gemini } })
  assert.equal(existsSync(`${path}-shm`), true, 'the server has it open, so this is the table and not the -shm')
  assert.equal(record.mark(SESSION), 0)
  createTable()
  add({ input: 100, output: 12, read: 30, thinking: 2, response: 10 })
  assert.equal(record.since(SESSION, 0)?.inputTokens, 130)
})

test('a store not of the shape measured says so once, in the log, and shows nothing', (t) => {
  const { gemini, addRaw } = store(t)
  const said: unknown[][] = []
  const record = antigravityUsageRecord({
    env: { GEMINI_HOME: gemini },
    warn: (message, details) => said.push([message, details]),
  })
  addRaw(Uint8Array.from(text(4, SESSION)))
  assert.equal(record.since(SESSION, 0), null)
  assert.equal(record.since(SESSION, 0), null)
  assert.equal(said.length, 1, 'once for the session, not once a turn')
  assert.match(String(said[0]?.[0]), /not the shape/)
  assert.deepEqual(said[0]?.[1], { sessionId: SESSION, rows: 1 })
})

test('after a turn, a store still without its table is not the format either, and says so', (t) => {
  const { gemini } = store(t, { table: false })
  const said: unknown[] = []
  const record = antigravityUsageRecord({ env: { GEMINI_HOME: gemini }, warn: (_message, details) => said.push(details) })
  assert.equal(record.since(SESSION, 0), null)
  assert.deepEqual(said, [{ sessionId: SESSION, missing: 'gen_metadata' }])
})

test("the wire format's own rules: a field given twice is its last value, a message given twice is merged, and order is free", () => {
  const counts = [...int(3, 558), ...int(9, 462), ...int(10, 96)]
  const twice = Uint8Array.from(message(1, message(4, [...int(2, 1), ...int(2, 7404), ...counts])))
  assert.equal(usageOfCalls([twice])?.inputTokens, 7404)
  const split = Uint8Array.from([
    ...message(1, int(3, 326)),
    ...message(2, [0x08, 0x01]),
    ...message(1, message(4, [...int(2, 7404), ...counts])),
  ])
  assert.equal(usageOfCalls([split])?.inputTokens, 7404)
  const reversed = Uint8Array.from([
    ...int(10, 1),
    ...message(1, [
      ...text(19, 'gemini-3.8-flash'),
      ...message(4, [...int(10, 96), ...int(9, 462), ...int(5, 4057), ...int(3, 558), ...int(2, 7404)]),
      ...int(3, 326),
    ]),
    ...text(4, SESSION),
  ])
  assert.deepEqual(
    usageOfCalls([reversed]),
    usageOfCalls([blob({ input: 7404, output: 558, read: 4057, thinking: 462, response: 96 })]),
  )
})
