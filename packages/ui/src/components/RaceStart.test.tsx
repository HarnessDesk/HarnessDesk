import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, FlowEntry, FlowPreview, SeatPlan } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { RaceStart } from './RaceStart'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const settle = (): Promise<void> => act(async () => {})

const COMPARISON_SOURCE = [
  'version: 2',
  'name: "Comparison"',
  'roles:',
  '  competitor:',
  '    kind: agent',
  '    uses: [implementer]',
  '    isolate: true',
  '    grant: edit',
  '    independentOf: []',
  '  verify:',
  '    kind: check',
  '    run: "pnpm verify"',
  '    timeout: 600',
  'seed: { role: competitor, title: "{{task}}" }',
  'rules:',
  '  - id: to-verify',
  '    on: competitor',
  '    then: { role: verify, title: "Check the attempt" }',
  'messaging: board-only',
  'wait: 240',
  'layout: {"race":"competitor"}',
  '',
].join('\n')

const ENTRY: FlowEntry = { id: 'comparison', origin: 'builtin', path: 'comparison.yml', name: 'Comparison', description: null, format: 'agents', problem: null, shadows: [] }
const AGENT: AgentEntry = {
  id: 'implementer', origin: 'builtin', path: '/app/agents/implementer/AGENT.md', digest: 'd1', shadows: [], problems: [],
  definition: { id: 'implementer', name: 'Implementer', description: null, ceiling: 'publish', ceilingFrom: 'ceiling', answers: [], produces: [], skills: [], mcp: [], prefer: [{ runtime: 'alpha' }], brief: 'Build it.' },
}
const PLAN: SeatPlan = {
  id: 'implementer', from: 'prefer', winner: 0, blocked: null, ceiling: { level: 'edit', hold: 'asked' },
  candidates: [
    { seat: { runtime: 'alpha' }, label: 'Alpha', runtimeName: 'Alpha', state: 'taken', reason: null, fix: null },
    { seat: { runtime: 'alpha', effort: 'high' }, label: 'Alpha · High', runtimeName: 'Alpha', state: 'taken', reason: null, fix: null },
  ],
}

const emptyPreview = (): FlowPreview => ({
  token: 't1',
  compiled: {
    document: {
      format: 'agents',
      flow: {
        version: 2, name: 'Comparison', inputs: [{ id: 'task', label: 'Task' }],
        roles: [
          { id: 'competitor', kind: 'agent', uses: ['implementer'], seats: [], isolate: true, grant: 'edit', independentOf: [] },
          { id: 'verify', kind: 'check', check: { run: 'pnpm verify', timeout: 600, exits: { 0: 'pass' }, otherwise: 'fail' } },
        ],
        rules: [{ id: 'to-verify', on: 'competitor', then: { role: 'verify', title: 'Check the attempt' } }],
        seed: { role: 'competitor', title: '{{task}}' },
        messaging: 'board-only', wait: 240,
        layout: { race: 'competitor' },
      },
    },
    bindings: [], problems: [],
  },
  seats: [], commands: [], guards: [], messaging: 'board-only', problems: [],
})

const fakeStore = (options: { readonly plan?: SeatPlan } = {}): { store: AppStore; startFlowGoal: ReturnType<typeof vi.fn>; previewFlow: ReturnType<typeof vi.fn> } => {
  const snapshot = emptySnapshot()
  const previewFlow = vi.fn(async () => emptyPreview())
  const startFlowGoal = vi.fn(async () => ({ version: 2 as const, id: 'run-1', goal: 'goal-1', document: emptyPreview().compiled.document, state: 'running' as const, rounds: [], operations: [], legacyRun: null, reason: null }))
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    flowCatalog: vi.fn(async () => [ENTRY]),
    flowSource: vi.fn(async () => COMPARISON_SOURCE),
    agentsIn: vi.fn(async () => [AGENT]),
    plansIn: vi.fn(async () => [options.plan ?? PLAN]),
    previewFlow,
    startFlowGoal,
    openGoal: vi.fn(),
    newSession: vi.fn(),
  } as unknown as AppStore
  return { store, startFlowGoal, previewFlow }
}

const render = (store: AppStore, onClose = vi.fn()): typeof onClose => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <RaceStart root="/repo" task="Fix the retry bug" onClose={onClose} />
      </StoreProvider>,
    )
  })
  return onClose
}

const selectAgent = async (id: string): Promise<void> => {
  const select = document.querySelector('select[aria-label="Agent"]') as HTMLSelectElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, id)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('one Agent and two exact seats produce a normal preview, never a session created directly', async () => {
  const { store, startFlowGoal, previewFlow } = fakeStore()
  render(store)
  await settle()
  await selectAgent('implementer')
  await settle()

  const startButton = [...document.body.querySelectorAll('button')].find((one) => one.textContent === 'Start') as HTMLButtonElement
  expect(startButton.disabled).toBe(false)
  // One call reads the file's own layout marker (learning what to substitute); the
  // second previews the actual substituted source — never a `newSession` call either way.
  expect(previewFlow).toHaveBeenCalledTimes(2)
  const [, substitutedSource] = previewFlow.mock.calls[1]!
  expect(substitutedSource).toContain('uses: ["implementer"]')
  expect(substitutedSource).toContain('seats: ["alpha", "alpha/high"]')

  act(() => startButton.click())
  await settle()
  expect(startFlowGoal).toHaveBeenCalledTimes(1)
  expect(store.newSession).not.toHaveBeenCalled()
  const [request] = startFlowGoal.mock.calls[0]!
  expect(request.token).toBe('t1')
  expect(request.sentence).toBe('Fix the retry bug')
})

it('an Agent that cannot be seated here is never the forced default', async () => {
  const unseatable: SeatPlan = { id: 'implementer', from: 'prefer', winner: null, blocked: null, ceiling: null, candidates: [] }
  const { store } = fakeStore({ plan: unseatable })
  render(store)
  await settle()
  // Never invented: the picker starts on no Agent, not a guess at one that cannot actually seat here.
  const agentSelect = document.querySelector('select[aria-label="Agent"]') as HTMLSelectElement
  expect(agentSelect.value).toBe('')
  const start = () => [...document.body.querySelectorAll('button')].find((one) => one.textContent === 'Start') as HTMLButtonElement
  expect(start().disabled).toBe(true)
})

it('identical seats cannot start, with an actionable reason on screen', async () => {
  const { store } = fakeStore()
  render(store)
  await settle()
  const start = () => [...document.body.querySelectorAll('button')].find((one) => one.textContent === 'Start') as HTMLButtonElement

  await selectAgent('implementer')
  await settle()
  expect(start().disabled).toBe(false)

  // Force both seat selects to the same candidate.
  const selects = [...document.body.querySelectorAll('select')].filter((one) => one.getAttribute('aria-label')?.includes('seat'))
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(selects[1], '0')
    selects[1]!.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  expect(document.body.textContent).toContain('Choose two different seats to compare.')
  expect(start().disabled).toBe(true)
})
