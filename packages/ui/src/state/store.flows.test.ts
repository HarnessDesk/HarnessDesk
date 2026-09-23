import { beforeEach, expect, it, vi } from 'vitest'

import type { FlowEntry, FlowExecution, FlowPreview, FlowUpdatePreview, HostMethodName, WireNotification, WorkspaceEntry } from '@harnessdesk/protocol'

import { AppStore } from './store'

let store: AppStore

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
})

const push = (notification: WireNotification): void => {
  const transport = store.transport as unknown as { handlers: { onNotification(notification: WireNotification): void } }
  transport.handlers.onNotification(notification)
}

const ENTRY: FlowEntry = { id: 'fix', origin: 'project', path: '.harnessdesk/flows/fix.yml', name: 'Fix', description: null, format: 'agents', problem: null, shadows: [] }

const PREVIEW: FlowPreview = {
  token: 't1',
  compiled: { document: { format: 'agents', flow: { version: 2, name: 'Fix', inputs: [], roles: [], rules: [], seed: { role: 'fixer', title: 'Go' }, messaging: 'board-only', wait: 240 } }, bindings: [], problems: [] },
  seats: [], commands: [], guards: [], messaging: 'board-only', problems: [],
}

const EXECUTION: FlowExecution = {
  version: 2, id: 'run-1', goal: 'goal-1', document: PREVIEW.compiled.document, state: 'running',
  rounds: [], operations: [], legacyRun: null, reason: null,
}

it('reads the catalogue, one source and previews a flow with exact request shapes', async () => {
  const spy = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'flow/catalog') return [ENTRY]
    if (method === 'flow/source') return 'version: 2\nname: Fix\n'
    if (method === 'flow/preview') return PREVIEW
    return null
  }) as never)

  expect(await store.flowCatalog('/repo')).toEqual([ENTRY])
  expect(await store.flowSource('/repo', 'fix')).toBe('version: 2\nname: Fix\n')
  expect(await store.flowSource('/repo', 'fix', 'user')).toBe('version: 2\nname: Fix\n')
  expect(await store.previewFlow('/repo', 'version: 2\n', { task: 'ship it' })).toEqual(PREVIEW)

  expect(spy.mock.calls).toEqual([
    ['flow/catalog', { root: '/repo' }],
    ['flow/source', { root: '/repo', id: 'fix' }],
    ['flow/source', { root: '/repo', id: 'fix', origin: 'user' }],
    ['flow/preview', { root: '/repo', source: 'version: 2\n', vars: { task: 'ship it' } }],
  ])
})

it('starts exactly one Goal through flow/start-goal, passing the frozen token through unchanged', async () => {
  const spy = vi.spyOn(store.transport, 'request').mockResolvedValue(EXECUTION)
  const result = await store.startFlowGoal({ root: '/repo', source: 'version: 2\n', token: 't1', sentence: 'Ship it', vars: { task: 'ship it' } })
  expect(result).toEqual(EXECUTION)
  expect(spy).toHaveBeenCalledWith('flow/start-goal', { root: '/repo', source: 'version: 2\n', token: 't1', sentence: 'Ship it', vars: { task: 'ship it' } })
})

it('routes update and customize to their own wire methods, never mixing their param shapes', async () => {
  const preview: FlowUpdatePreview = { token: 'u1', resuming: false, edits: [], problems: [] }
  const spy = vi.spyOn(store.transport, 'request').mockImplementation((async () => preview) as never)

  await store.previewFlowUpdate('/repo', 'fix', 'update')
  await store.previewFlowUpdate('/repo', 'fix', 'customize')
  await store.applyFlowUpdate('/repo', 'fix', 'u1', 'update')
  await store.applyFlowUpdate('/repo', 'fix', 'u1', 'customize')

  expect(spy.mock.calls).toEqual([
    ['flow/update/preview', { root: '/repo', id: 'fix' }],
    ['flow/customize/preview', { root: '/repo', id: 'fix' }],
    // flow/update/apply's own wire shape carries no id — its token already
    // names the journal, and an id there would be an unexpected field.
    ['flow/update/apply', { root: '/repo', token: 'u1' }],
    ['flow/customize/apply', { root: '/repo', id: 'fix', token: 'u1' }],
  ])
})

it('keeps flow/execution-changed pushes, whole, keyed by run id', () => {
  expect(store.getSnapshot().flowExecutions.size).toBe(0)
  push({ method: 'flow/execution-changed', params: { execution: EXECUTION } })
  expect(store.getSnapshot().flowExecutions.get('run-1')).toEqual(EXECUTION)
  const settled: FlowExecution = { ...EXECUTION, state: 'settled' }
  push({ method: 'flow/execution-changed', params: { execution: settled } })
  expect(store.getSnapshot().flowExecutions.get('run-1')).toEqual(settled)
})

it('root switch and reconnect discard old preview tokens', async () => {
  const before = store.flowGeneration()
  const workspace: WorkspaceEntry = { path: '/other', name: 'other' } as WorkspaceEntry

  // An in-flight request from the previous root: it must not poison anything
  // once a newer root or connection has already moved past it. The caller
  // (a flow surface such as FlowStart) is the one that compares the
  // generation it captured before awaiting against this store's current one;
  // this proves the store actually moves it on both events, which is the
  // half a component cannot prove on its own.
  let resolveStale!: (value: readonly FlowEntry[]) => void
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'flow/catalog') return new Promise<readonly FlowEntry[]>((resolve) => { resolveStale = resolve })
    if (method === 'workspace/open') return workspace
    return null
  }) as never)
  const stale = store.flowCatalog('/repo')

  await store.openWorkspace('/other')
  expect(store.flowGeneration()).not.toBe(before)
  const afterSwitch = store.flowGeneration()

  const transport = store.transport as unknown as { handlers: { onStatus(status: 'closed' | 'open'): void } }
  transport.handlers.onStatus('closed')
  expect(store.flowGeneration()).not.toBe(afterSwitch)

  // The stale request itself still resolves — the store never cancels a
  // request in flight — but nothing in the store adopted its answer, and a
  // caller bound to the generation it captured knows to ignore it too.
  resolveStale([ENTRY])
  await stale
  expect(store.flowGeneration()).not.toBe(before)
})

it('readFlowExecution reads by run id and keeps the answer, whole, in flowExecutions', async () => {
  const spy = vi.spyOn(store.transport, 'request').mockResolvedValue(EXECUTION)
  const result = await store.readFlowExecution('run-1')
  expect(result).toEqual(EXECUTION)
  expect(spy).toHaveBeenCalledWith('flow/execution', { run: 'run-1' })
  expect(store.getSnapshot().flowExecutions.get('run-1')).toEqual(EXECUTION)
})

it('previewFlowRetry reads the run’s own saved source back before asking flow/preview, never a blank or guessed one', async () => {
  push({ method: 'flow/execution-changed', params: { execution: EXECUTION } })
  const spy = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'flow/execution/source') return { source: 'version: 2\nname: Fix\n', vars: { task: 'ship it' } }
    if (method === 'flow/preview') return PREVIEW
    return null
  }) as never)
  const result = await store.previewFlowRetry('run-1', 3)
  expect(result).toEqual(PREVIEW)
  expect(spy.mock.calls).toEqual([
    ['flow/execution/source', { run: 'run-1' }],
    ['flow/preview', { root: 'goal-1', source: 'version: 2\nname: Fix\n', vars: { task: 'ship it' }, retry: { run: 'run-1', card: 3 } }],
  ])
})

it('retryFlowCheck redeems a check-retry token and keeps the resulting execution', async () => {
  const settled: FlowExecution = { ...EXECUTION, state: 'settled' }
  const spy = vi.spyOn(store.transport, 'request').mockResolvedValue(settled)
  const result = await store.retryFlowCheck('run-1', 3, 'retry-token')
  expect(result).toEqual(settled)
  expect(spy).toHaveBeenCalledWith('flow/check/retry', { run: 'run-1', card: 3, token: 'retry-token' })
  expect(store.getSnapshot().flowExecutions.get('run-1')).toEqual(settled)
})

it('raceAgents opens dialog state only — no session, worktree or draft is created', async () => {
  const spy = vi.spyOn(store.transport, 'request')
  expect(store.getSnapshot().raceStart).toBeNull()
  await store.raceAgents('Fix the retry bug')
  expect(store.getSnapshot().raceStart).toEqual({ task: 'Fix the retry bug' })
  expect(spy).not.toHaveBeenCalled()
  store.closeRaceStart()
  expect(store.getSnapshot().raceStart).toBeNull()
})
