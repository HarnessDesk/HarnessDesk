import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

import { compareTables } from './check-alignment-census.mjs'

/**
 * The census table's ceiling, against the shape that got through: #1161
 * re-recorded the table and the spec, reading the table it had just written,
 * passed. These hold the comparison itself; the gate's git plumbing is the
 * merge base and one `git show`.
 */

const table = (counts) =>
  Object.fromEntries(
    Object.entries(counts).map(([check, signatures]) => [
      check,
      { count: Object.values(signatures).reduce((a, b) => a + b, 0), signatures },
    ]),
  )

test('a table that only falls passes', () => {
  const base = table({ 'header-off-body': { a: 3, b: 1 }, 'lead-off-line': { c: 2 } })
  const head = table({ 'header-off-body': { a: 1 }, 'lead-off-line': { c: 2 } })
  assert.deepEqual(compareTables(base, head), [])
})

test('a new signature fails, even when the total falls', () => {
  const base = table({ 'header-off-body': { a: 5 } })
  const head = table({ 'header-off-body': { a: 1, b: 2 } })
  assert.deepEqual(compareTables(base, head), ['header-off-body: new (×2)  b'])
})

test('a risen signature and a risen total both fail', () => {
  const base = table({ 'header-off-body': { a: 1 } })
  const head = table({ 'header-off-body': { a: 3 } })
  assert.deepEqual(compareTables(base, head), ['header-off-body: total rose 1 → 3', 'header-off-body: rose 1 → 3  a'])
})

test('a check dropped from the table fails', () => {
  const base = table({ 'header-off-body': { a: 1 }, 'lead-off-line': {} })
  assert.deepEqual(compareTables(base, table({ 'lead-off-line': {} })), ['header-off-body: the check is gone from the table'])
})

test('a new check with findings fails; one with none does not', () => {
  assert.equal(compareTables({}, table({ x: { a: 1 } })).length, 1)
  assert.deepEqual(compareTables({}, table({ x: {} })), [])
})

test('#1161, replayed from history, is refused', (t) => {
  const path = 'packages/ui/src/design/alignment-census.json'
  const show = (rev) => JSON.parse(execFileSync('git', ['show', `${rev}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  let before, after
  try {
    before = show('a36b2dbdf')
    after = show('6c9cc2422')
  } catch {
    t.skip('a shallow clone without those commits')
    return
  }
  const problems = compareTables(before, after)
  assert.ok(problems.includes('header-off-body: total rose 80 → 92'), problems.join('\n'))
})
