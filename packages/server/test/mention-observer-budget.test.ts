import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const modulePath = '../src/lead/mention-observer-budget.js'
const load = async (): Promise<any> => import(modulePath).catch(() => null)
const fixture = async () => {
  const module = await load()
  assert.ok(module?.MentionObserverBudget, 'independent durable observer budget exists')
  const dir = await mkdtemp(join(tmpdir(), 'observer-budget-'))
  let now = new Date(2026, 0, 2, 12).getTime()
  const file = join(dir, 'budget.json')
  const open = () => new module.MentionObserverBudget({ file, now: () => now })
  return { file, open, advance: (days: number) => { now += days * 86400_000 } }
}
const model = 'claude-haiku-5-5'

test('defaults off, durably reserves, and survives reopen without creating credit', async () => {
  const f = await fixture(), budget = f.open()
  assert.equal((await budget.view()).dailyCapUsdMicros, 0)
  assert.equal(await budget.reserve('first', 1000, 200, model), null)
  await budget.configure(1000000)
  const receipt = await budget.reserve('first', 1000, 200, model)
  assert.ok(receipt)
  const held = await budget.view()
  assert.ok(held.reservedUsdMicros > 0)
  assert.ok((await readFile(f.file, 'utf8')).includes('first'))
  const reopened = f.open(), state = await reopened.view()
  assert.equal(state.reservedUsdMicros, held.reservedUsdMicros)
  assert.equal(await reopened.reserve('first', 1000, 200, model), null)
  await receipt.unknown()
  await budget.storageIdle()
})

test('unknown settlement is idempotent and old pending holds carry over a day', async () => {
  const f = await fixture(), budget = f.open()
  await budget.configure(1000000)
  const receipt = await budget.reserve('a', 1000, 200, model)
  assert.ok(receipt)
  const before = await budget.view()
  f.advance(1)
  const rollover = await budget.view()
  assert.equal(rollover.reservedUsdMicros, before.reservedUsdMicros)
  await receipt.unknown()
  await receipt.unknown()
  const after = await budget.view()
  assert.equal(after.reservedUsdMicros, 0)
  assert.equal(after.uncertainUsdMicros, 0)
  assert.equal(after.compacted.uncertainUsdMicros, before.reservedUsdMicros)
  f.advance(-2)
  assert.equal((await budget.view()).day, rollover.day)
})

test('unreadable and symlinked state refuses spending without replacing evidence', async () => {
  const f = await fixture()
  await writeFile(f.file, '{invalid')
  const broken = f.open()
  assert.ok((await broken.view()).problem)
  await assert.rejects(broken.configure(1000000))
  assert.equal(await readFile(f.file, 'utf8'), '{invalid')
  const other = `${f.file}-link`
  await symlink(f.file, other)
  const module = await load()
  const linked = new module.MentionObserverBudget({ file: other })
  assert.ok((await linked.view()).problem)
  assert.equal(await linked.reserve('x', 1000, 200, model), null)
})

test('settlement remains idempotent across cap changes and reopening', async () => {
  const f = await fixture(), budget = f.open()
  await budget.configure(1000000)
  const receipt = await budget.reserve('known', 1000, 200, model)
  assert.ok(receipt)
  const hold = (await budget.view()).reservedUsdMicros
  await budget.configure(0)
  await receipt.settle({ inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 })
  const state = await budget.view()
  assert.equal(state.enabled, false)
  assert.equal(state.reservedUsdMicros, 0)
  assert.ok(state.spentUsdMicros > 0 && state.spentUsdMicros <= hold)
  await receipt.unknown()
  assert.equal((await f.open().view()).spentUsdMicros, state.spentUsdMicros)
  assert.equal(await budget.reserve('other', 1000, 200, model), null)
})

test('unknown models, exhausted caps and failed durable writes never reserve', async () => {
  const f = await fixture(), budget = f.open()
  await budget.configure(1)
  assert.equal(await budget.reserve('unknown', 1000, 200, 'unknown-model'), null)
  assert.equal(await budget.reserve('too-much', 1000, 200, model), null)
  await writeFile(f.file, '{changed outside the host')
  assert.equal(await budget.reserve('changed', 0, 0, model), null)
  assert.ok((await budget.view()).problem)
  assert.equal(await readFile(f.file, 'utf8'), '{changed outside the host')
})

test('closed periods compact safely; stale callbacks cannot settle a reused ID', async () => {
  const f = await fixture(), budget = f.open()
  await budget.configure(1000000)
  const old = await budget.reserve('reused', 1000, 200, model)
  assert.ok(old)
  await old.unknown()
  f.advance(1)
  const current = await budget.reserve('reused', 1000, 200, model)
  assert.ok(current)
  const held = (await budget.view()).reservedUsdMicros
  await old.settle({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  assert.equal((await budget.view()).reservedUsdMicros, held)
  await current.unknown()
  assert.equal((await budget.view()).uncertainUsdMicros, held)
})

test('concurrent reservations serialize and cannot overspend the cap', async () => {
  const f = await fixture(), budget = f.open()
  await budget.configure(1000000)
  const first = await budget.reserve('sizing', 1000, 200, model)
  assert.ok(first)
  const hold = (await budget.view()).reservedUsdMicros
  await first.settle({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  await budget.configure(hold)
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => budget.reserve(`concurrent-${i}`, 1000, 200, model)))
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal((await budget.view()).remainingUsdMicros, 0)
})

test('full pending capacity refuses new reservations and retains all evidence', async () => {
  const f = await fixture(), budget = f.open()
  await budget.configure(Number.MAX_SAFE_INTEGER)
  assert.ok(await budget.reserve('seed', 1000, 200, model))
  const data = JSON.parse(await readFile(f.file, 'utf8'))
  const seed = data.receipts[0]
  data.receipts = Array.from({ length: 1024 }, (_, i) => ({ ...seed, id: `pending-${i}` }))
  await writeFile(f.file, JSON.stringify(data))
  const reopened = f.open()
  assert.equal(await reopened.reserve('extra', 1000, 200, model), null)
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).receipts.length, 1024)
})

test('clock rollback after a persisted rollover cannot reopen an earlier allowance', async () => {
  const f = await fixture(), budget = f.open()
  await budget.configure(1000000)
  f.advance(1)
  const current = await budget.reserve('next-day', 1000, 200, model)
  assert.ok(current)
  const day = (await budget.view()).day
  f.advance(-2)
  const reopened = f.open(), state = await reopened.view()
  assert.equal(state.day, day)
  assert.ok(state.reservedUsdMicros > 0)
})
