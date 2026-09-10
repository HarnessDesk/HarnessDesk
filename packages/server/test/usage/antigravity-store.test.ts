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

/** A `.gemini` folder holding one conversation store, open on the server's side as a live one is. */
const store = (t: TestContext) => {
  const gemini = mkdtempSync(join(tmpdir(), 'hd-agy-'))
  const folder = join(gemini, 'antigravity-acp', 'conversations')
  mkdirSync(folder, { recursive: true })
  const path = join(folder, `${SESSION}.db`)
  const server = new DatabaseSync(path)
  server.exec('PRAGMA journal_mode=WAL')
  server.exec(
    'CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))',
  )
  let open = true
  const close = (): void => {
    if (open) server.close()
    open = false
  }
  // `t.after` runs its callbacks in the order they were added: close first.
  t.after(close)
  t.after(() => rmSync(gemini, { recursive: true, force: true }))
  let next = 0
  const add = (call: Call): void => {
    const data = blob(call)
    server.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(next++, data, data.length)
  }
  return { gemini, path, add, close }
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
  assert.equal(record.since(SESSION, 3), null, 'a turn that called no model has nothing to say')
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
