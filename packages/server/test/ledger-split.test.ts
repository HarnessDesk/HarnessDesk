import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { runtimeId } from '@harnessdesk/protocol'

import { tempDir } from './scratch.js'

import { Ledger } from '../src/ledger/index.js'
import { Pricing } from '../src/ledger/pricing.js'
import { LedgerStore, type UsageRow } from '../src/ledger/store.js'

/**
 * The token split (`input`/`output`/`cacheRead`/`cacheWrite`/`reasoning`/
 * `requests`) that `LedgerRow`, `LedgerDay` and `LedgerReport.totals` now
 * carry, and the scan horizon `SpendCoverage.earliestDay` reads off the
 * store. Rows are written straight to the store, the same way
 * `ledger-agents.test.ts` checks persistence, because what is under test is
 * `Ledger#query`'s arithmetic, not a scanner's file format.
 */

const scratch = (): string => tempDir('hd-ledger-split-')
const DAY = 86_400_000
const NOON = Date.parse('2026-09-20T12:00:00Z')

const row = (over: Partial<UsageRow>): UsageRow => ({
  file: '/f',
  day: NOON,
  runtime: 'codex',
  model: 'm',
  project: '/p',
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  requests: 0,
  ...over,
})

const noRatesPricing = async (dir: string): Promise<Pricing> => {
  const pricing = new Pricing({
    cachePath: join(dir, 'cache.json'),
    overlayPath: join(dir, 'overlay.json'),
    fetchCatalogue: async () => ({}),
  })
  await pricing.warm()
  return pricing
}

test('the token split sums per day, per row and in the window totals, across two runtimes and two models', async () => {
  const dir = scratch()
  const dbPath = join(dir, 'usage.sqlite')
  const day1 = NOON
  const day2 = NOON + DAY

  const store = new LedgerStore(dbPath)
  store.commit(
    { path: '/codex-1', size: 1, mtime: 1, offset: 1, tail: [] },
    [
      row({
        file: '/codex-1',
        day: day1,
        runtime: 'codex',
        model: 'gpt-5.6-sol',
        input: 100,
        output: 50,
        cacheRead: 20,
        cacheWrite: 5,
        reasoning: 10,
        requests: 2,
      }),
    ],
    NOON,
    false,
  )
  store.commit(
    { path: '/codex-2', size: 1, mtime: 1, offset: 1, tail: [] },
    [
      row({
        file: '/codex-2',
        day: day2,
        runtime: 'codex',
        model: 'gpt-5.6-sol',
        input: 300,
        output: 60,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 5,
        requests: 1,
      }),
    ],
    NOON,
    false,
  )
  store.commit(
    { path: '/claude-1', size: 1, mtime: 1, offset: 1, tail: [] },
    [
      row({
        file: '/claude-1',
        day: day1,
        runtime: 'claude-code',
        model: 'claude-opus-5',
        input: 200,
        output: 80,
        cacheRead: 40,
        cacheWrite: 0,
        reasoning: 0,
        requests: 3,
      }),
    ],
    NOON,
    false,
  )
  store.close()

  const ledger = new Ledger({
    stateDir: dir,
    databasePath: dbPath,
    corpora: [],
    pricing: await noRatesPricing(dir),
    now: () => day2,
  })

  const byModel = ledger.query({ days: 30, groupBy: 'model' })

  // The window total: every row's split, summed once.
  assert.deepEqual(byModel.totals, {
    input: 600,
    output: 190,
    cacheRead: 60,
    cacheWrite: 5,
    reasoning: 15,
    requests: 6,
  })
  assert.equal(byModel.totalTokens, 600 + 190 + 60 + 5, 'the total still excludes reasoning, which is already inside output')

  // Per row: one model spans two codex rows, the other is claude's alone.
  const sol = byModel.rows.find((entry) => entry.key === 'gpt-5.6-sol')
  assert.deepEqual(
    { input: sol?.input, output: sol?.output, cacheRead: sol?.cacheRead, cacheWrite: sol?.cacheWrite, reasoning: sol?.reasoning, requests: sol?.requests },
    { input: 400, output: 110, cacheRead: 20, cacheWrite: 5, reasoning: 15, requests: 3 },
  )
  const opus = byModel.rows.find((entry) => entry.key === 'claude-opus-5')
  assert.deepEqual(
    { input: opus?.input, output: opus?.output, cacheRead: opus?.cacheRead, cacheWrite: opus?.cacheWrite, reasoning: opus?.reasoning, requests: opus?.requests },
    { input: 200, output: 80, cacheRead: 40, cacheWrite: 0, reasoning: 0, requests: 3 },
  )

  // Per day, split by runtime — the stacked chart's own granularity.
  const byRuntime = ledger.query({ days: 30, groupBy: 'runtime' })
  const day1Codex = byRuntime.daily.find((entry) => entry.day === day1 && entry.runtime === 'codex')
  assert.deepEqual(
    { input: day1Codex?.input, output: day1Codex?.output, cacheRead: day1Codex?.cacheRead, cacheWrite: day1Codex?.cacheWrite, reasoning: day1Codex?.reasoning, requests: day1Codex?.requests },
    { input: 100, output: 50, cacheRead: 20, cacheWrite: 5, reasoning: 10, requests: 2 },
  )
  const day1Claude = byRuntime.daily.find((entry) => entry.day === day1 && entry.runtime === 'claude-code')
  assert.deepEqual(
    { input: day1Claude?.input, output: day1Claude?.output, cacheRead: day1Claude?.cacheRead, requests: day1Claude?.requests },
    { input: 200, output: 80, cacheRead: 40, requests: 3 },
  )
  const day2Codex = byRuntime.daily.find((entry) => entry.day === day2 && entry.runtime === 'codex')
  assert.deepEqual(
    { input: day2Codex?.input, output: day2Codex?.output, reasoning: day2Codex?.reasoning, requests: day2Codex?.requests },
    { input: 300, output: 60, reasoning: 5, requests: 1 },
  )

  ledger.close()
})

test('earliestDay is the unwindowed minimum, scoped by runtime, and null on an empty ledger', async () => {
  const dir = scratch()
  const dbPath = join(dir, 'usage.sqlite')
  const early = NOON - 10 * DAY
  const late = NOON - 2 * DAY

  const store = new LedgerStore(dbPath)
  assert.equal(store.earliestDay(), null, 'nothing recorded yet')
  assert.equal(store.earliestDay('codex'), null)

  store.commit(
    { path: '/codex-1', size: 1, mtime: 1, offset: 1, tail: [] },
    [row({ file: '/codex-1', day: early, runtime: 'codex', model: 'gpt-5.6-sol', input: 1, requests: 1 })],
    NOON,
    false,
  )
  store.commit(
    { path: '/claude-1', size: 1, mtime: 1, offset: 1, tail: [] },
    [row({ file: '/claude-1', day: late, runtime: 'claude-code', model: 'claude-opus-5', input: 1, requests: 1 })],
    NOON,
    false,
  )

  assert.equal(store.earliestDay('codex'), early, 'scoped to the runtime that actually has the early row')
  assert.equal(store.earliestDay('claude-code'), late, 'a runtime with only the later row does not inherit the other\'s horizon')
  assert.equal(store.earliestDay(), early, 'unscoped is the minimum across every runtime')
  assert.equal(store.earliestDay('gemini'), null, 'a runtime with no rows at all reads null, not zero')
  store.close()

  // Wired through the report: the query window is far narrower than the
  // scan horizon, which is the whole point — a horizon is not a query result.
  const ledger = new Ledger({
    stateDir: dir,
    databasePath: dbPath,
    corpora: [],
    pricing: await noRatesPricing(dir),
    now: () => NOON,
  })
  assert.equal(ledger.query({ days: 1, groupBy: 'runtime' }).coverage.earliestDay, early)
  assert.equal(ledger.query({ days: 1, groupBy: 'runtime', runtime: runtimeId('claude-code') }).coverage.earliestDay, late)
  ledger.close()
})
