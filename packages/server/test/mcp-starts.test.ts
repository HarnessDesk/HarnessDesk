import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseClientMessage, ValidationError } from '@harnessdesk/protocol'

import { McpStarts, localDay, type McpStartsClock } from '../src/mcp-starts.js'
import { tempDir } from './scratch.js'

/**
 * Whether an MCP client may start work, and how many starts today has left.
 * Off by default; a count of starts per local day when on; a failed start
 * refunded; a clock set back never resets the count.
 */
const day = (iso: string) => new Date(`${iso}T12:00:00`).getTime()
const clockAt = (start: number) => {
  let now = start
  const clock: McpStartsClock = { now: () => now, localDay }
  return { clock, set: (ms: number) => { now = ms } }
}
const fresh = (start = day('2026-11-11'), environment = false) => {
  const path = join(tempDir('hd-mcp-starts-'), 'client-starts.json')
  const time = clockAt(start)
  return { path, time, starts: new McpStarts(path, time.clock, () => environment) }
}

test('starting work from MCP is off until the person turns it on, and the default is five a day', async () => {
  const { starts } = fresh()
  const view = await starts.view()
  assert.equal(view.mayStart, false)
  assert.equal(view.dailyStarts, 5)
  assert.equal(view.started, 0)
  assert.equal(view.remaining, 5)
  assert.equal(view.source, 'stored')
  assert.equal(view.day, '2026-11-11')
  const refused = await starts.admit()
  assert.deepEqual(refused.ok ? null : refused.code, 'mcpStartsOff')
  assert.match(refused.ok ? '' : refused.detail, /Settings › Local clients/)
  assert.equal((await starts.view()).started, 0, 'a refusal counts nothing')
})

test('the daily number caps admissions, and is kept on disk for the next desk', async () => {
  const { starts, path, time } = fresh()
  await starts.set(0, { mayStart: true, dailyStarts: 2 })
  assert.equal((await starts.admit()).ok, true)
  assert.equal((await starts.admit()).ok, true)
  const third = await starts.admit()
  assert.equal(third.ok ? null : third.code, 'mcpDailyCap')
  assert.match(third.ok ? '' : third.detail, /Today's 2 starts from MCP clients are used\. They reset at midnight\./)
  const again = new McpStarts(path, time.clock, () => false)
  const view = await again.view()
  assert.deepEqual({ mayStart: view.mayStart, dailyStarts: view.dailyStarts, started: view.started, remaining: view.remaining, revision: view.revision },
    { mayStart: true, dailyStarts: 2, started: 2, remaining: 0, revision: 1 })
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1)
})

test('a new local day starts the count again, and a clock set back does not', async () => {
  const { starts, time } = fresh(day('2026-11-11'))
  await starts.set(0, { mayStart: true, dailyStarts: 1 })
  assert.equal((await starts.admit()).ok, true)
  assert.equal((await starts.admit()).ok, false)
  time.set(day('2026-11-10'))
  const back = await starts.admit()
  assert.equal(back.ok ? null : back.code, 'mcpDailyCap', 'yesterday is not a new day')
  assert.equal((await starts.view()).day, '2026-11-11')
  time.set(day('2026-11-12'))
  assert.equal((await starts.view()).started, 0)
  assert.equal((await starts.admit()).ok, true)
  assert.equal((await starts.view()).day, '2026-11-12')
})

test('a refund gives a start back only on the day it was taken', async () => {
  const { starts, time } = fresh(day('2026-11-11'))
  await starts.set(0, { mayStart: true, dailyStarts: 3 })
  const first = await starts.admit()
  assert.ok(first.ok)
  await starts.refund(first.ticket)
  assert.equal((await starts.view()).started, 0)
  const second = await starts.admit()
  assert.ok(second.ok)
  time.set(day('2026-11-12'))
  assert.equal((await starts.admit()).ok, true)
  await starts.refund(second.ticket)
  assert.equal((await starts.view()).started, 1, "yesterday's ticket refunds nothing today")
})

test('a stale revision is refused and changes nothing', async () => {
  const { starts } = fresh()
  await starts.set(0, { mayStart: true })
  await assert.rejects(starts.set(0, { dailyStarts: 9 }), (error: Error & { code?: string }) =>
    error.code === 'HD_MCP_STARTS_STALE' && /changed\. Read them again/.test(error.message))
  assert.equal((await starts.view()).dailyStarts, 5)
  await assert.rejects(starts.set(1, { dailyStarts: 51 }), /from 1 to 50/)
  await assert.rejects(starts.set(1, { dailyStarts: 0 }), /from 1 to 50/)
  // Lowering the number below what today used is allowed; the rest of the day is refused.
  assert.ok((await starts.admit()).ok); assert.ok((await starts.admit()).ok)
  const lowered = await starts.set(1, { dailyStarts: 1 })
  assert.equal(lowered.remaining, 0)
  assert.equal((await starts.admit()).ok, false)
})

test('the wire refuses a daily number of 0 or 51 before it reaches the host', () => {
  for (const dailyStarts of [0, 51]) {
    assert.throws(() => parseClientMessage({ id: 1, method: 'app/mcpStarts/set', params: { revision: 0, dailyStarts } }), ValidationError)
  }
})

test('a scripted desk grants starts from its environment, and says so', async () => {
  const { starts } = fresh(day('2026-11-11'), true)
  const view = await starts.view()
  assert.equal(view.mayStart, true)
  assert.equal(view.source, 'environment')
  assert.equal((await starts.admit()).ok, true, 'the daily number still applies')
})

test('two admissions at the same moment, with one start left, admit exactly one', async () => {
  const { starts } = fresh()
  await starts.set(0, { mayStart: true, dailyStarts: 1 })
  const results = await Promise.all([starts.admit(), starts.admit(), starts.admit()])
  assert.equal(results.filter(one => one.ok).length, 1)
  assert.equal((await starts.view()).started, 1)
})

test('a file the desk cannot read is no grant', async () => {
  const { path, time } = fresh()
  await writeFile(path, '{"version":1,"revision":4,"mayStart":true,"dailyStarts":500,"day":"2026-11-11","started":0}')
  const view = await new McpStarts(path, time.clock, () => false).view()
  assert.equal(view.mayStart, false)
  assert.equal(view.dailyStarts, 5)
})
