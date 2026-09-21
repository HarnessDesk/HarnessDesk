import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, GoalView, SeatPlan } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AddMember } from './AddMember'

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

const agent = (id: string, name: string): AgentEntry => ({
  id,
  origin: 'builtin',
  path: `/app/agents/${id}/AGENT.md`,
  digest: 'd',
  shadows: [],
  problems: [],
  definition: {
    id,
    name,
    description: null,
    permission: 'read',
    answers: [],
    produces: [],
    skills: [],
    prefer: [{ runtime: 'codex' }],
    brief: 'Work.',
  },
})

const plans: readonly SeatPlan[] = [
  {
    id: 'reviewer',
    from: 'prefer',
    winner: 0,
    blocked: null,
    candidates: [{
      seat: { runtime: 'codex' },
      label: 'Primary seat',
      runtimeName: 'Agent runtime',
      state: 'taken',
      reason: null,
      fix: null,
    }],
  },
  {
    id: 'judge',
    from: 'prefer',
    winner: null,
    blocked: null,
    candidates: [{
      seat: { runtime: 'codex' },
      label: 'Fallback seat',
      runtimeName: 'Agent runtime',
      state: 'passed',
      reason: { kind: 'signedOut' },
      fix: { kind: 'signIn', runtime: 'codex' },
    }],
  },
]

const goal = {
  goal: { id: 'goal-1', root: '/repo' },
  board: { id: 'goal-1' },
  members: [],
} as unknown as GoalView

const rig = (withGoal = true) => {
  const snapshot = {
    ...emptySnapshot(),
    goals: new Map(withGoal ? [['goal-1', goal]] : []),
    runtimes: [{ id: 'codex', presentation: { name: 'Agent runtime' }, capabilities: {} }],
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    agentsIn: vi.fn().mockResolvedValue([agent('reviewer', 'Reviewer'), agent('judge', 'Judge')]),
    plansIn: vi.fn().mockResolvedValue(plans),
    seatGoal: vi.fn().mockResolvedValue({ id: 'seat-1' }),
  } as unknown as AppStore
  return store
}

const render = async (store: AppStore, onClose = vi.fn()) => {
  await act(async () => {
    root.render(<StoreProvider store={store}><AddMember room="goal-1" root="/repo" onClose={onClose} /></StoreProvider>)
  })
  return onClose
}

const press = async (label: string): Promise<void> => {
  const button = [...document.querySelectorAll('button')].find((one) => one.textContent?.includes(label))
  if (!button) throw new Error(`no button ${label}`)
  await act(async () => button.click())
}

it('lists project Agents with their seat result and seats the selected Agent durably', async () => {
  const store = rig()
  const onClose = await render(store)
  expect(store.agentsIn).toHaveBeenCalledWith('/repo')
  expect(document.body.textContent).toContain('Primary seat')
  expect(document.body.textContent).toContain("Can't seat here")

  await press('Seat Agent')
  expect(store.seatGoal).toHaveBeenCalledWith({ goal: 'goal-1', agent: 'reviewer' })
  expect(onClose).toHaveBeenCalled()
})

it('keeps the dialog open and shows the host refusal', async () => {
  const store = rig()
  ;(store.seatGoal as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('That Agent became unavailable.'))
  const onClose = await render(store)

  await press('Seat Agent')
  expect(onClose).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('became unavailable')
})

it('offers a refused candidate rather than hiding it', async () => {
  const store = rig()
  await render(store)
  const judge = document.querySelector<HTMLElement>('[aria-label="Judge"]')
  expect(judge).not.toBeNull()
  act(() => judge?.click())
  await press('Seat Agent')
  expect(store.seatGoal).toHaveBeenCalledWith({ goal: 'goal-1', agent: 'judge' })
})

it('disables seating when the Goal disappeared', async () => {
  const store = rig(false)
  await render(store)
  expect(document.body.textContent).toContain('no longer available')
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.includes('Seat Agent'))
  expect(button?.disabled).toBe(true)
})
