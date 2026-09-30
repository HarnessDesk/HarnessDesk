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
    ceiling: 'read',
    ceilingFrom: 'ceiling',
    answers: [],
    produces: [],
    skills: [],
    mcp: [],
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
    ceiling: { level: 'read', hold: 'asked' },
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
    ceiling: null,
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
  expect(document.querySelector('[data-slot="choice-list"]')).not.toBeNull()

  await press('Seat Agent')
  expect(store.seatGoal).toHaveBeenCalledWith({ goal: 'goal-1', agent: 'reviewer' })
  expect(onClose).toHaveBeenCalled()
})

it('shows a refused Agent as selectable with its reason and partial fade', async () => {
  const store = rig()
  await render(store)
  const refused = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((one) => one.textContent?.includes('Judge'))
  expect(refused?.disabled).toBe(false)
  expect(refused?.hasAttribute('data-refused')).toBe(true)
  expect(refused?.textContent).toContain("Can't seat here · Agent runtime is signed out")
  expect(refused?.textContent).not.toContain('Checking…')

  const describedBy = refused?.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  const reason = describedBy ? document.getElementById(describedBy) : null
  expect(reason?.textContent).toContain("Can't seat here · Agent runtime is signed out")
  expect(reason?.getAttribute('data-slot')).toBe('choice-desc')

  expect(refused?.className).toContain('data-[refused]:[&_[data-slot=choice-icon]]:opacity-45')
  expect(refused?.className).toContain('data-[refused]:[&_[data-slot=choice-title]]:opacity-45')
  const icon = refused?.querySelector<HTMLElement>('[data-slot="choice-icon"]')
  const title = refused?.querySelector<HTMLElement>('[data-slot="choice-title"]')
  expect(icon).not.toBeNull()
  expect(title?.textContent).toBe('Judge')
  expect(reason?.className).not.toContain('opacity-45')
  expect(reason?.className).not.toContain('data-[refused]')
  await act(async () => refused?.click())
  expect(refused?.getAttribute('aria-checked')).toBe('true')

  const reviewer = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((one) => one.textContent?.includes('Reviewer'))
  expect(reviewer?.disabled).toBe(false)
  expect(reviewer?.textContent).toContain('Primary seat')
  await act(async () => reviewer?.click())
  expect(reviewer?.getAttribute('aria-checked')).toBe('true')
})

it('keeps the dialog open and shows the host refusal', async () => {
  const store = rig()
  ;(store.seatGoal as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('That Agent became unavailable.'))
  const onClose = await render(store)

  await press('Seat Agent')
  expect(onClose).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('became unavailable')
})

it('offers a refused candidate and lets the host decide when seating is pressed', async () => {
  const store = rig()
  const onClose = await render(store)
  const judge = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((one) => one.textContent?.includes('Judge'))
  expect(judge).not.toBeNull()
  expect(judge?.getAttribute('aria-checked')).toBe('false')
  await act(async () => judge?.click())
  expect(judge?.getAttribute('aria-checked')).toBe('true')
  await press('Seat Agent')
  expect(store.seatGoal).toHaveBeenCalledWith({ goal: 'goal-1', agent: 'judge' })
  expect(onClose).toHaveBeenCalled()
})

it('disables seating when the Goal disappeared', async () => {
  const store = rig(false)
  await render(store)
  expect(document.body.textContent).toContain('no longer available')
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.includes('Seat Agent'))
  expect(button?.disabled).toBe(true)
})
