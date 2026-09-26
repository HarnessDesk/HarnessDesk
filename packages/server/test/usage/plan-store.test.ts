import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { runtimeId } from '@harnessdesk/protocol'

import { PlanStore, accountKeyFor } from '../../src/usage/plan-store.js'
import { tempDir } from '../scratch.js'

const CLAUDE = runtimeId('claude-code')

test('an email account key is hashed, never written as plaintext', async () => {
  const key = accountKeyFor('dev@example.com')
  assert.ok(key.startsWith('sha256:'))
  assert.ok(!key.includes('example.com'))
  // Stable and case/whitespace-insensitive, so the same sign-in always maps to the same row.
  assert.equal(key, accountKeyFor(' Dev@Example.com '))
  // A non-email account label — Cline's organization name, say — is kept as itself.
  assert.equal(accountKeyFor('Acme Org'), 'Acme Org')
})

test('set() validates a positive amount and a three-letter currency', async () => {
  const dir = tempDir('hd-plans-')
  const store = new PlanStore(join(dir, 'plans.json'), { now: () => 1000 })
  await assert.rejects(
    store.set({ runtime: CLAUDE, account: 'dev@example.com', fee: { amount: -5, currency: 'USD', period: 'month' } }),
    /positive number/,
  )
  await assert.rejects(
    store.set({ runtime: CLAUDE, account: 'dev@example.com', fee: { amount: 20, currency: 'dollars', period: 'month' } }),
    /three-letter code/,
  )
  await assert.rejects(
    store.set({ runtime: CLAUDE, account: 'dev@example.com', budget: { amount: 0, currency: 'USD' } }),
    /positive number/,
  )
})

test('set() writes a fee, set() again writes a budget beside it, and each clears independently', async () => {
  const dir = tempDir('hd-plans-')
  const store = new PlanStore(join(dir, 'plans.json'), { now: () => 5000 })
  const withFee = await store.set({ runtime: CLAUDE, account: 'dev@example.com', fee: { amount: 20, currency: 'USD', period: 'month' } })
  assert.deepEqual(withFee.fee, { amount: 20, currency: 'USD', period: 'month', source: 'user', setAt: 5000 })
  assert.equal(withFee.budget, undefined)

  const withBudget = await store.set({ runtime: CLAUDE, account: 'dev@example.com', budget: { amount: 50, currency: 'USD' } })
  assert.deepEqual(withBudget.fee, { amount: 20, currency: 'USD', period: 'month', source: 'user', setAt: 5000 })
  assert.deepEqual(withBudget.budget, { amount: 50, currency: 'USD', period: 'month', setAt: 5000 })

  const feeCleared = await store.set({ runtime: CLAUDE, account: 'dev@example.com', fee: null })
  assert.equal(feeCleared.fee, undefined)
  assert.deepEqual(feeCleared.budget, { amount: 50, currency: 'USD', period: 'month', setAt: 5000 })

  const all = await store.read()
  assert.equal(all.length, 1)
  assert.equal(all[0]?.runtime, CLAUDE)
  assert.equal(all[0]?.entry.budget?.amount, 50)

  const budgetCleared = await store.set({ runtime: CLAUDE, account: 'dev@example.com', budget: null })
  assert.deepEqual(budgetCleared, {})
  assert.deepEqual(await store.read(), [])
})

test('entryFor answers null for an account nothing was ever set on', async () => {
  const dir = tempDir('hd-plans-')
  const store = new PlanStore(join(dir, 'plans.json'))
  assert.equal(await store.entryFor(CLAUDE, 'nobody@example.com'), null)
})

test('a file that cannot be read is never written over', async () => {
  const dir = tempDir('hd-plans-')
  const path = join(dir, 'plans.json')
  await writeFile(path, '{ not json')
  const store = new PlanStore(path)
  await assert.rejects(
    store.set({ runtime: CLAUDE, account: 'dev@example.com', fee: { amount: 20, currency: 'USD', period: 'month' } }),
    /not JSON/,
  )
  // Untouched: still the hand-written text, not overwritten with a fresh file.
  assert.equal(await readFile(path, 'utf8'), '{ not json')
})

test('the write is atomic: no leftover temp file, and the target is whole JSON', async () => {
  const dir = tempDir('hd-plans-')
  const path = join(dir, 'plans.json')
  const store = new PlanStore(path)
  await store.set({ runtime: CLAUDE, account: 'dev@example.com', fee: { amount: 20, currency: 'USD', period: 'month' } })
  const entries = await readdir(dir)
  assert.deepEqual(entries, ['plans.json'])
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  assert.equal(Object.keys(parsed).length, 1)
})

test('two accounts on the same runtime keep separate rows', async () => {
  const dir = tempDir('hd-plans-')
  const store = new PlanStore(join(dir, 'plans.json'))
  await store.set({ runtime: CLAUDE, account: 'a@example.com', fee: { amount: 20, currency: 'USD', period: 'month' } })
  await store.set({ runtime: CLAUDE, account: 'b@example.com', fee: { amount: 100, currency: 'USD', period: 'month' } })
  const all = await store.read()
  assert.equal(all.length, 2)
  assert.equal(await store.entryFor(CLAUDE, 'a@example.com').then((e) => e?.fee?.amount), 20)
  assert.equal(await store.entryFor(CLAUDE, 'b@example.com').then((e) => e?.fee?.amount), 100)
})
