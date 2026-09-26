import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runtimeId, type PlanEntry, type UsageReport } from '@harnessdesk/protocol'

import { usageMethods } from '../src/methods/usage.js'
import type { HostContext } from '../src/methods/context.js'

const CLAUDE = runtimeId('claude-code')

const report: UsageReport = {
  runtime: CLAUDE,
  account: 'dev@example.com',
  plan: 'Pro',
  lanes: [],
  credits: null,
  spend: null,
  reached: null,
  source: { kind: 'file', label: 'from its own cache' },
  fetchedAt: 0,
  staleAfterMs: 0,
  error: null,
}

const contextWith = (stored: PlanEntry | null, reports: readonly UsageReport[]): HostContext =>
  ({
    usage: () => ({ reports: async () => reports, refresh: async () => reports }),
    plans: {
      read: async () => ({ entries: [], suggestions: [] }),
      set: async (input: unknown) => input as PlanEntry,
      entryFor: async () => stored,
    },
  }) as unknown as HostContext

test('usage/reports merges a stored fee and budget into the report, source "user"', async () => {
  const stored: PlanEntry = {
    fee: { amount: 20, currency: 'USD', period: 'month', source: 'user', setAt: 1 },
    budget: { amount: 50, currency: 'USD', period: 'month', setAt: 1 },
  }
  const ctx = contextWith(stored, [report])
  const result = await usageMethods['usage/reports'](ctx)
  assert.equal(result.length, 1)
  assert.deepEqual(result[0]?.billing?.fee, { amount: 20, currency: 'USD', period: 'month', source: 'user' })
  assert.deepEqual(result[0]?.billing?.budget, { amount: 50, currency: 'USD', period: 'month' })
})

test('usage/refresh merges the same way as usage/reports', async () => {
  const stored: PlanEntry = { fee: { amount: 100, currency: 'USD', period: 'month', source: 'user', setAt: 1 } }
  const ctx = contextWith(stored, [report])
  const result = await usageMethods['usage/refresh'](ctx, {})
  assert.deepEqual(result[0]?.billing?.fee, { amount: 100, currency: 'USD', period: 'month', source: 'user' })
})

test('an account-less report (no signed-in identity) is never asked about — nothing to key a stored entry on', async () => {
  const anonymous: UsageReport = { ...report, account: null }
  let asked = false
  const ctx = {
    usage: () => ({ reports: async () => [anonymous] }),
    plans: { entryFor: async () => { asked = true; return null } },
  } as unknown as HostContext
  const result = await usageMethods['usage/reports'](ctx)
  assert.equal(asked, false)
  assert.equal(result[0]?.billing, undefined)
})

test('usage/plan/read and usage/plan/set reach the context\'s plan store directly', async () => {
  let setCalled: unknown = null
  const ctx = {
    plans: {
      read: async () => ({ entries: [], suggestions: [] }),
      set: async (input: unknown) => {
        setCalled = input
        return { fee: undefined, budget: undefined }
      },
    },
  } as unknown as HostContext
  const read = await usageMethods['usage/plan/read'](ctx)
  assert.deepEqual(read, { entries: [], suggestions: [] })
  await usageMethods['usage/plan/set'](ctx, { runtime: CLAUDE, account: 'dev@example.com', fee: null })
  assert.deepEqual(setCalled, { runtime: CLAUDE, account: 'dev@example.com', fee: null })
})
