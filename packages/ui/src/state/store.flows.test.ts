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

it('stopFlowExecution sends the reason and keeps the stopped Run without changing another Run', async () => {
  const other = { ...EXECUTION, id: 'other-run' }
  push({ method: 'flow/execution-changed', params: { execution: other } })
  const stopped: FlowExecution = { ...EXECUTION, state: 'stopped', reason: 'The brief changed.', end: { kind: 'stopped', by: 'person' } }
  const spy = vi.spyOn(store.transport, 'request').mockResolvedValue(stopped)
  expect(await store.stopFlowExecution('run-1', 'The brief changed.')).toEqual(stopped)
  expect(spy).toHaveBeenCalledWith('flow/execution/stop', { run: 'run-1', reason: 'The brief changed.' })
  expect(store.getSnapshot().flowExecutions.get('run-1')).toEqual(stopped)
  expect(store.getSnapshot().flowExecutions.get('other-run')).toEqual(other)
})

it('keeps a failed Stop after the stopped push and clears only that Run’s failure when cleanup succeeds', async () => {
  const reason = 'The brief changed.'
  const stopped: FlowExecution = { ...EXECUTION, state: 'stopped', reason, end: { kind: 'stopped', by: 'person' } }
  const failure = new Error('One Seat could not be released.')
  const spy = vi.spyOn(store.transport, 'request').mockImplementationOnce((async () => {
    push({ method: 'flow/execution-changed', params: { execution: stopped } })
    throw failure
  }) as never).mockRejectedValueOnce(failure).mockResolvedValue(stopped)
  await expect(store.stopFlowExecution('run-1', reason)).rejects.toBe(failure)
  expect(store.getSnapshot().flowExecutions.get('run-1')).toEqual(stopped)
  expect(store.getSnapshot().flowStopProblems?.get('run-1')).toEqual({ reason, message: failure.message })
  await expect(store.stopFlowExecution('other-run', 'Keep this other note.')).rejects.toBe(failure)
  push({ method: 'flow/execution-changed', params: { execution: stopped } })
  expect(store.getSnapshot().flowStopProblems.get('run-1')).toEqual({ reason, message: failure.message })
  await store.stopFlowExecution('run-1', reason)
  expect(spy).toHaveBeenLastCalledWith('flow/execution/stop', { run: 'run-1', reason })
  expect(store.getSnapshot().flowStopProblems.has('run-1')).toBe(false)
  expect(store.getSnapshot().flowStopProblems.get('other-run')?.reason).toBe('Keep this other note.')
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

it('readCheckAttempts reads one check card’s recorded results by run and card, and keeps nothing of them', async () => {
  const attempts = [
    { id: 'attempt-1', n: 1, at: 100, commit: 'a'.repeat(40), exit: 1, timedOut: false, outcome: 'fail', tail: 'FAIL: 1 test' },
    { id: 'attempt-2', n: 2, at: 200, commit: 'b'.repeat(40), exit: 0, timedOut: false, outcome: 'pass', tail: 'ok' },
  ]
  const response = { attempts, complete: true }
  const spy = vi.spyOn(store.transport, 'request').mockResolvedValue(response)
  const before = store.getSnapshot()
  expect(await store.readCheckAttempts('run-1', 3)).toEqual(response)
  expect(spy).toHaveBeenCalledWith('flow/check/attempts', { run: 'run-1', card: 3 })
  expect(store.getSnapshot()).toBe(before)
})

it('continueFlowAnswer calls the run-scoped wire verb and keeps the returned execution', async () => {
  const stalled: FlowExecution = { ...EXECUTION, state: 'stalled', keptAnswer: {
    card: 1, seat: 'seat-1', question: 'Which base branch?', answer: 'main', at: 1, canContinue: true, refusal: null,
  } }
  const spy = vi.spyOn(store.transport, 'request').mockResolvedValue(stalled)
  expect(await store.continueFlowAnswer('run-1')).toEqual(stalled)
  expect(spy).toHaveBeenCalledWith('flow/answer/continue', { run: 'run-1' })
  expect(store.getSnapshot().flowExecutions.get('run-1')).toEqual(stalled)
})

it('continueFlowAnswer shows a refusal in the host’s own words rather than dropping it', async () => {
  vi.spyOn(store.transport, 'request').mockRejectedValue(new Error('The Seat for card #1 is inside a turn now. Answer again once it ends.'))
  expect(await store.continueFlowAnswer('run-1')).toBeNull()
  const notice = store.getSnapshot().notices.at(-1)
  expect(notice?.level).toBe('warning')
  expect(notice?.message).toContain('The Seat for card #1 is inside a turn now. Answer again once it ends.')
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

it('loads every historical Run for a Team, including settled Runs after reconnect', async () => {
  push({ method: 'flow/execution-changed', params: { execution: EXECUTION } })
  const older = { ...EXECUTION, id: 'old-run', state: 'settled' as const, startedAt: 1 }
  const spy = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'flow/executions') return [{ id: older.id }, { id: EXECUTION.id }]
    if (method === 'flow/execution') return older
    return null
  }) as never)
  await store.loadTeamRuns('goal-1')
  expect(spy).toHaveBeenCalledWith('flow/executions', { team: 'goal-1', active: false })
  expect(spy).toHaveBeenCalledWith('flow/execution', { run: 'old-run' })
  expect(spy).not.toHaveBeenCalledWith('flow/execution', { run: 'run-1' })
  expect(store.getSnapshot().flowExecutions.get('old-run')).toEqual(older)
})
