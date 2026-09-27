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

/**
 * `usage/reports` and `usage/refresh` no longer merge a stored plan in —
 * that now happens exactly once, inside `UsageService` itself (its
 * `overlay` option, wired up in `host.ts`), so every report these methods
 * hand back is already whatever `ctx.usage()` gives them (BLOCKING 1: a
 * per-request merge here is exactly what let a pushed `usage/updated`
 * report skip it). `UsageService`'s own tests cover the merge; this file
 * only has to show these methods are a straight pass-through.
 */
test('usage/reports is a straight pass-through to ctx.usage().reports()', async () => {
  const ctx = { usage: () => ({ reports: async () => [report], refresh: async () => [report] }) } as unknown as HostContext
  const result = await usageMethods['usage/reports'](ctx)
  assert.deepEqual(result, [report])
})

test('usage/refresh is a straight pass-through to ctx.usage().refresh(runtime)', async () => {
  let askedRuntime: string | undefined
  const ctx = {
    usage: () => ({
      reports: async () => [report],
      refresh: async (runtime?: string) => {
        askedRuntime = runtime
        return [report]
      },
    }),
  } as unknown as HostContext
  const result = await usageMethods['usage/refresh'](ctx, { runtime: CLAUDE })
  assert.deepEqual(result, [report])
  assert.equal(askedRuntime, CLAUDE)
})

test('usage/plan/read passes params through and hands back the context\'s answer whole', async () => {
  const stored: PlanEntry = { fee: { amount: 20, currency: 'USD', period: 'month', source: 'user', setAt: 1 } }
  let askedParams: unknown = null
  const ctx = {
    plans: {
      read: async (params: unknown) => {
        askedParams = params
        return { entry: stored, suggestion: null, refusal: null }
      },
    },
  } as unknown as HostContext
  const read = await usageMethods['usage/plan/read'](ctx, { runtime: CLAUDE, account: 'dev@example.com', plan: 'Pro' })
  assert.deepEqual(read, { entry: stored, suggestion: null, refusal: null })
  assert.deepEqual(askedParams, { runtime: CLAUDE, account: 'dev@example.com', plan: 'Pro' })
})

test('usage/plan/read hands back a refusal from the context untouched', async () => {
  const ctx = {
    plans: { read: async () => ({ entry: null, suggestion: null, refusal: '~/.harnessdesk/plans.json was not read: it is not JSON' }) },
  } as unknown as HostContext
  const read = await usageMethods['usage/plan/read'](ctx, { runtime: CLAUDE, account: 'dev@example.com' })
  assert.equal(read.entry, null)
  assert.match(read.refusal ?? '', /plans\.json was not read/)
})

test('usage/plan/set reaches the context\'s plan store directly', async () => {
  let setCalled: unknown = null
  const ctx = {
    plans: {
      set: async (input: unknown) => {
        setCalled = input
        return { fee: undefined, budget: undefined }
      },
    },
  } as unknown as HostContext
  await usageMethods['usage/plan/set'](ctx, { runtime: CLAUDE, account: 'dev@example.com', fee: null })
  assert.deepEqual(setCalled, { runtime: CLAUDE, account: 'dev@example.com', fee: null })
})
