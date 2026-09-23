import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CompiledFlow, FlowExecution, FlowPreview, GoalView } from '@harnessdesk/protocol'

import { flowMethods } from '../src/methods/flows.js'
import type { HostContext } from '../src/methods/context.js'

/*
 * `methods/flows.ts` reaches the world only through `HostContext` — never a
 * private host field — so each v2 handler is exercised here against fakes
 * that record what they were asked, proving the wire routes to the owned
 * plane the plan names and nowhere else.
 */

const emptyCompiled: CompiledFlow = { document: { format: 'agents', flow: { version: 2, name: 'x', inputs: [], roles: [], rules: [], seed: { role: 'a', title: 't' }, messaging: 'board-only', wait: 1 } }, bindings: [], problems: [] }
const emptyPreview: FlowPreview = { token: 'tok-1', compiled: emptyCompiled, seats: [], commands: [], guards: [], messaging: 'board-only', problems: [] }

const fakeCtx = (overrides: Partial<{
  previewCalls: unknown[]
  redeemCalls: unknown[]
  startCalls: unknown[]
  updateCalls: unknown[]
  customizeCalls: unknown[]
}> = {}): HostContext => {
  const previewCalls = overrides.previewCalls ?? []
  const redeemCalls = overrides.redeemCalls ?? []
  const startCalls = overrides.startCalls ?? []
  const updateCalls = overrides.updateCalls ?? []
  const customizeCalls = overrides.customizeCalls ?? []
  return {
    flows: {
      catalog: async (root: string) => [{ id: 'x', origin: 'project', path: 'x.yml', name: 'x', description: null, format: 'agents', problem: null, shadows: [] }],
      catalogSource: async () => 'version: 2',
      startGoal: async (request: unknown) => {
        startCalls.push(request)
        return { version: 2, id: 'flow-1', goal: 'goal-1', document: emptyCompiled.document, state: 'running', rounds: [], operations: [], legacyRun: null, reason: null } satisfies FlowExecution
      },
      executionOf: (run: string) => (run === 'flow-1' ? { version: 2, id: 'flow-1', goal: 'goal-1', document: emptyCompiled.document, state: 'running', rounds: [], operations: [], legacyRun: null, reason: null } satisfies FlowExecution : null),
      storedRun: (run: string) => (run === 'flow-1' ? { source: 'version: 2', vars: {} } : null),
      retryCheck: async (run: string, card: number) => {
        startCalls.push({ retry: { run, card } })
        return { version: 2, id: run, goal: 'goal-1', document: emptyCompiled.document, state: 'running', rounds: [], operations: [], legacyRun: null, reason: null } satisfies FlowExecution
      },
    },
    flowPreviews: {
      preview: async (root: string, source: string, vars?: unknown, retry?: unknown) => {
        previewCalls.push({ root, source, vars, retry })
        return emptyPreview
      },
      redeem: async (token: string, root: string, source: string, vars: unknown) => {
        redeemCalls.push({ token, root, source, vars })
        return { compiled: emptyCompiled, commands: [] }
      },
      retryTarget: (token: string) => (token === 'retry-tok' ? { run: 'flow-1', card: 3 } : null),
    },
    flowUpdates: {
      preview: async (root: string, id: string) => {
        updateCalls.push({ root, id })
        return { token: 'u1', resuming: false, edits: [], problems: [] }
      },
      apply: async (root: string, token: string) => {
        updateCalls.push({ apply: { root, token } })
        return { state: 'applied', written: [], message: 'ok' }
      },
      customizePreview: async (root: string, id: string) => {
        customizeCalls.push({ root, id })
        return { token: 'c1', resuming: false, edits: [], problems: [] }
      },
      customizeApply: async (root: string, id: string, token: string) => {
        customizeCalls.push({ apply: { root, id, token } })
        return { state: 'applied', written: [], message: 'ok' }
      },
    },
    goals: {
      view: async (goal: string) => ({ goal: { id: goal, root: '/repo', cwd: '/repo' } } as unknown as GoalView),
    },
    workspaces: {
      confineRoom: async () => {},
    },
  } as unknown as HostContext
}

test('flow/catalog and flow/source route to Flows, never a private field', async () => {
  const ctx = fakeCtx()
  const entries = await flowMethods['flow/catalog'](ctx, { root: '/repo' })
  assert.equal(entries.length, 1)
  const source = await flowMethods['flow/source'](ctx, { root: '/repo', id: 'x' })
  assert.equal(source, 'version: 2')
})

test('flow/preview routes to FlowPreviews with exactly the declared params', async () => {
  const previewCalls: unknown[] = []
  const ctx = fakeCtx({ previewCalls })
  const result = await flowMethods['flow/preview'](ctx, { root: '/repo', source: 'version: 2', vars: { a: '1' } })
  assert.equal(result.token, 'tok-1')
  assert.deepEqual(previewCalls, [{ root: '/repo', source: 'version: 2', vars: { a: '1' }, retry: undefined }])
})

test('flow/start-goal redeems the token through FlowPreviews before ever calling Flows.startGoal', async () => {
  const redeemCalls: unknown[] = []
  const startCalls: unknown[] = []
  const ctx = fakeCtx({ redeemCalls, startCalls })
  const execution = await flowMethods['flow/start-goal'](ctx, { root: '/repo', source: 'version: 2', token: 'tok-1', sentence: 'Go' })
  assert.equal(execution.id, 'flow-1')
  assert.equal(redeemCalls.length, 1)
  assert.equal(startCalls.length, 1)
  const started = startCalls[0] as { compiled: unknown; source: string; root: string }
  assert.equal(started.root, '/repo')
  assert.equal(started.source, 'version: 2')
  assert.equal(started.compiled, emptyCompiled, 'the frozen, redeemed compiled policy is what starts — never a fresh parse of the params')
})

test('flow/start-goal never calls Flows.startGoal when the token does not redeem', async () => {
  const startCalls: unknown[] = []
  const ctx = fakeCtx({ startCalls })
  ;(ctx.flowPreviews as unknown as { redeem: () => Promise<null> }).redeem = async () => null
  await assert.rejects(() => flowMethods['flow/start-goal'](ctx, { root: '/repo', source: 'version: 2', token: 'stale', sentence: 'Go' }))
  assert.equal(startCalls.length, 0, 'a refused redeem never reaches Flows.startGoal')
})

test('flow/execution reads Flows by run id alone', async () => {
  const ctx = fakeCtx()
  const execution = await flowMethods['flow/execution'](ctx, { run: 'flow-1' })
  assert.equal(execution.id, 'flow-1')
  await assert.rejects(async () => flowMethods['flow/execution'](ctx, { run: 'no-such-run' }))
})

test('flow/check/retry validates the token is bound to this exact run and card before retrying', async () => {
  const startCalls: unknown[] = []
  const ctx = fakeCtx({ startCalls })
  await assert.rejects(
    () => flowMethods['flow/check/retry'](ctx, { run: 'flow-1', card: 3, token: 'wrong-token' }),
    /changed/i,
    'a token not bound to this run/card is refused',
  )
  await assert.rejects(
    () => flowMethods['flow/check/retry'](ctx, { run: 'flow-1', card: 9, token: 'retry-tok' }),
    /changed/i,
    'a token bound to a different card is refused',
  )
  assert.equal(startCalls.length, 0)
  const execution = await flowMethods['flow/check/retry'](ctx, { run: 'flow-1', card: 3, token: 'retry-tok' })
  assert.equal(execution.id, 'flow-1')
  assert.equal(startCalls.length, 1)
})

test('flow/update and flow/customize route to FlowUpdates, not each other', async () => {
  const updateCalls: unknown[] = []
  const customizeCalls: unknown[] = []
  const ctx = fakeCtx({ updateCalls, customizeCalls })
  await flowMethods['flow/update/preview'](ctx, { root: '/repo', id: 'x' })
  await flowMethods['flow/update/apply'](ctx, { root: '/repo', token: 'u1' })
  await flowMethods['flow/customize/preview'](ctx, { root: '/repo', id: 'y' })
  await flowMethods['flow/customize/apply'](ctx, { root: '/repo', id: 'y', token: 'c1' })
  assert.equal(updateCalls.length, 2)
  assert.equal(customizeCalls.length, 2)
})
