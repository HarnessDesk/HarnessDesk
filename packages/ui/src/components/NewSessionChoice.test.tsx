import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, FlowEntry, FlowExecution, FlowPreview, SeatPlan } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { NewSessionChoice } from './NewSessionChoice'

/**
 * The entry point for the collaborative half of the product.
 *
 * "New session" made a solo draft and a Room appeared later, once agents
 * happened to be in the folder — so somebody who came to run three agents on
 * one repository had no way to say so, and the Room was something you
 * discovered rather than chose.
 */
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

const rig = (
  history: readonly { cwd: string; archived?: boolean; repo?: unknown }[] = [],
  over: { workspace?: unknown; teams?: Map<string, unknown> } = {},
  agents: readonly AgentEntry[] = [],
  plans: ReadonlyMap<string, SeatPlan> = new Map(),
) => {
  const open = over.workspace ?? { path: '/repo', name: 'repo', lastOpenedAt: 1 }
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    workspace: open,
    workspaces: [open],
    history,
    agents,
    agentPlans: plans,
    ...(over.teams ? { teams: over.teams } : {}),
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    newDraft: vi.fn(),
    openTeamRoom: vi.fn(),
    createGoal: vi.fn().mockResolvedValue({ goal: { id: 'g1' } }),
    seatGoal: vi.fn(),
    openGoal: vi.fn(),
    loadAgents: vi.fn(async () => {}),
    startAsAgent: vi.fn(async () => null),
    flowGeneration: vi.fn(() => 0),
    flowCatalog: vi.fn(async () => []),
    agentsIn: vi.fn(async () => []),
    flowSource: vi.fn(async () => ''),
    previewFlow: vi.fn(async () => null),
    startFlowGoal: vi.fn(),
  } as unknown as AppStore
  return { store }
}

const render = (store: AppStore, onClose = vi.fn()): typeof onClose => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <NewSessionChoice onClose={onClose} />
      </StoreProvider>,
    )
  })
  return onClose
}

const choice = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find((one) =>
    one.textContent?.includes(name),
  )
  if (!found) throw new Error(`no choice named ${name}`)
  return found
}

it('offers both shapes of work, and starting a session is still a draft', () => {
  const { store } = rig()
  const onClose = render(store)

  act(() => choice('A session').click())
  expect(store.newDraft).toHaveBeenCalledTimes(1)
  expect(store.openTeamRoom).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})

it('opens Goal creation under the open project', async () => {
  const { store } = rig()
  const onClose = render(store)

  act(() => choice('A Goal').click())
  const field = document.querySelector<HTMLInputElement>('[aria-label="What finishes this?"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'Ship the release')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => choice('Create Goal').click())
  await act(async () => {})

  expect(store.createGoal).toHaveBeenCalledWith({ root: '/repo', sentence: 'Ship the release', checkout: 'shared' })
  expect(store.openGoal).toHaveBeenCalledWith('g1')
  expect(store.newDraft).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})

it('keys Goal creation from a worktree to its project and disables it without a folder', () => {
  const { store } = rig()
  const snapshot = store.getSnapshot() as unknown as { workspace: unknown }
  snapshot.workspace = {
    path: '/repo/.worktrees/feature',
    name: 'feature',
    lastOpenedAt: 1,
    repo: { root: '/repo', worktree: true },
  }
  render(store)
  act(() => choice('A Goal').click())
  expect(document.querySelector<HTMLInputElement>('[aria-label="What finishes this?"]')).not.toBeNull()

  act(() => root.unmount())
  root = createRoot(container)
  snapshot.workspace = null
  render(store)
  expect(choice('A Goal').disabled).toBe(true)
})

/*
 * As an Agent: the roster leads the dialog, and starting one starts a
 * conversation as it — but the plain choice still opens focused and is still
 * what Enter starts, whatever else is listed above it (the owner's rule that
 * a person who never touches Agents sees today's app, unchanged).
 */

const reviewer = (id: string, name: string): AgentEntry => ({
  id,
  origin: 'builtin',
  path: `/app/agents/${id}/AGENT.md`,
  digest: 'd',
  shadows: [],
  problems: [],
  definition: {
    id,
    name,
    description: `${name}.`,
    ceiling: 'edit',
    ceilingFrom: 'permission',
    answers: [],
    produces: [],
    skills: [],
    prefer: [{ runtime: 'claude-code' }],
    brief: 'Review.',
  },
})

const PLANS = new Map<string, SeatPlan>([
  [
    'code-reviewer',
    {
      id: 'code-reviewer',
      from: 'prefer',
      winner: 0,
      blocked: null,
      ceiling: { level: 'edit', hold: 'asked' },
      candidates: [{ seat: { runtime: 'claude-code' }, label: 'Claude', runtimeName: 'Claude', state: 'taken', reason: null, fix: null }],
    },
  ],
  [
    'judge',
    {
      id: 'judge',
      from: 'prefer',
      winner: null,
      blocked: null,
      ceiling: null,
      candidates: [
        { seat: { runtime: 'cursor' }, label: 'Cursor', runtimeName: 'Cursor', state: 'passed', reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'cursor' } },
      ],
    },
  ],
])

it('lists Agents above the session door, and starting one starts a conversation as it', () => {
  const { store } = rig([], {}, [reviewer('code-reviewer', 'Code reviewer'), reviewer('judge', 'Judge')], PLANS)
  const onClose = render(store)
  const labels = [...document.querySelectorAll('button')].map((one) => one.textContent ?? '')
  expect(labels.findIndex((one) => one.startsWith('Code reviewer'))).toBeLessThan(labels.findIndex((one) => one.startsWith('A session')))
  act(() => choice('Code reviewer').click())
  expect(store.startAsAgent).toHaveBeenCalledWith('code-reviewer')
  expect(onClose).toHaveBeenCalled()
})

it('an Agent that cannot be seated here stays, greyed with its reason — and pressing it asks why', () => {
  const { store } = rig([], {}, [reviewer('judge', 'Judge')], PLANS)
  render(store)
  const judge = choice('Judge')
  expect(judge.hasAttribute('data-refused')).toBe(true)
  expect(judge.textContent).toContain('Cursor is signed out')
  expect(judge.disabled).toBe(false)
  act(() => judge.click())
  expect(store.startAsAgent).toHaveBeenCalledWith('judge')
})

it('the plain choice is what opens focused, Agents above it or not', () => {
  const { store } = rig([], {}, [reviewer('code-reviewer', 'Code reviewer')], PLANS)
  render(store)
  expect(document.activeElement).toBe(choice('A session'))
})

it('Enter still starts a plain conversation on the default runtime — agent/seat is never asked for it', () => {
  const { store } = rig([], {}, [reviewer('code-reviewer', 'Code reviewer')], PLANS)
  const onClose = render(store)
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  expect(store.newDraft).toHaveBeenCalled()
  expect(store.startAsAgent).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})

/*
 * A flow starts exactly one Goal through `flow/start-goal`: no bare Goal is
 * ever made first and a flow started into it after, which is the old room
 * path this dialog no longer takes.
 */

const FLOW: FlowEntry = { id: 'fix', origin: 'project', path: '.harnessdesk/flows/fix.yml', name: 'Fix', description: null, format: 'agents', problem: null, shadows: [] }
const FLOW_PREVIEW: FlowPreview = {
  token: 'tok-1',
  compiled: { document: { format: 'agents', flow: { version: 2, name: 'Fix', inputs: [], roles: [], rules: [], seed: { role: 'fixer', title: 'Go' }, messaging: 'board-only', wait: 240 } }, bindings: [], problems: [] },
  seats: [], commands: [], guards: [], messaging: 'board-only', problems: [],
}
const FLOW_EXECUTION: FlowExecution = {
  version: 2, id: 'run-1', goal: 'goal-1', document: FLOW_PREVIEW.compiled.document, state: 'running', rounds: [], operations: [], legacyRun: null, reason: null,
}

it('flow starts exactly one Goal through its host operation', async () => {
  const { store } = rig()
  vi.mocked(store.flowCatalog).mockResolvedValue([FLOW])
  vi.mocked(store.flowSource).mockResolvedValue('version: 2\nname: Fix\n')
  vi.mocked(store.previewFlow).mockResolvedValue(FLOW_PREVIEW)
  vi.mocked(store.startFlowGoal).mockResolvedValue(FLOW_EXECUTION)
  const onClose = render(store)

  act(() => choice('A flow').click())
  await act(async () => {})
  const select = document.querySelector('select') as HTMLSelectElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, 'fix')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {})

  const field = document.querySelector<HTMLInputElement>('[aria-label="What finishes this?"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'Ship the fix')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => choice('Start').click())
  await act(async () => {})

  expect(store.startFlowGoal).toHaveBeenCalledWith({ root: '/repo', source: 'version: 2\nname: Fix\n', token: 'tok-1', sentence: 'Ship the fix', vars: {} })
  expect(store.createGoal).not.toHaveBeenCalled()
  expect(store.seatGoal).not.toHaveBeenCalled()
  expect(store.openGoal).toHaveBeenCalledWith('goal-1')
  expect(onClose).toHaveBeenCalled()
})
