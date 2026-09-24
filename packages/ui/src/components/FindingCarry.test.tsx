import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FindingView, GoalReceipt, GoalView } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { FindingCarry } from './FindingCarry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement; let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const A = 'a'.repeat(40)
const finding = (id: string, lifecycle: FindingView['lifecycle']): FindingView => ({
  id, origin: { goal: 'source', run: 'run-1', round: 2, card: 1, seat: 'seat-1', at: A }, ownerGoal: 'source',
  title: `Title of ${id}`, body: '', category: 'ordinary', blocking: true, related: null, anchor: null,
  lifecycle, sequence: 1, evidence: [], posted: [], restored: false, problem: null,
} as FindingView)

const goalView = (id: string, over: Partial<GoalView['goal']> = {}, receipt: GoalReceipt | null = null): GoalView => ({
  goal: {
    id, root: '/repo', cwd: '/repo', sentence: `Goal ${id}`, state: 'open', revision: 3,
    checkout: 'shared', dependsOn: [], origin: { kind: 'person' }, createdAt: 1, updatedAt: 1, receipt: receipt?.id ?? null, ...over,
  },
  activity: null, waitingOn: [], members: [],
  board: { id, name: id, root: '/repo', updatedAt: 1, members: [], messaging: true, intents: [], channel: [] },
  receipt, problem: null,
} as unknown as GoalView)

const receipt = {
  version: 1, id: 'receipt-1', goal: 'source', sentence: 'Goal source', wrappedAt: 1, summary: 'Done.',
  cards: [], seats: [], evidence: [], answers: [], lanes: [], citations: [], gaps: [], revisions: [],
  findings: {
    version: 1, evidence: [], overrides: [],
    findings: [
      finding('finding-open', { state: 'open', confirmed: false, repairs: [] }),
      finding('finding-done', { state: 'repaired', confirmed: true, repairs: [] }),
    ],
  },
} as unknown as GoalReceipt

const rig = (carryFindings: (input: unknown) => Promise<readonly FindingView[]>): { store: AppStore; source: GoalView } => {
  const source = goalView('source', { state: 'wrapped' }, receipt)
  const snapshot = {
    ...emptySnapshot(),
    goals: new Map([
      ['source', source],
      ['target', goalView('target')],
      ['elsewhere', goalView('elsewhere', { root: '/other' })],
      ['closed', goalView('closed', { state: 'wrapped' })],
    ]),
  } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, carryFindings: vi.fn(carryFindings) } as unknown as AppStore
  return { store, source }
}

const button = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll('button')].find((one) => one.textContent === label)! as HTMLButtonElement

it('carries only unresolved findings, only into an open Goal of the same project, and says what it carried', async () => {
  const carryFindings = vi.fn(async () => [finding('finding-open', { state: 'open', confirmed: false, repairs: [] })])
  const { store, source } = rig(carryFindings)
  act(() => { root.render(<StoreProvider store={store}><FindingCarry source={source} /></StoreProvider>) })
  act(() => button('Carry unresolved findings…').click())
  expect(document.body.textContent).toContain('finding-open')
  expect(document.body.textContent).not.toContain('finding-done')
  const options = [...document.querySelectorAll('select option')].map((one) => (one as HTMLOptionElement).value)
  expect(options).toEqual(['target'])
  await act(async () => { button('Carry 1 finding').click() })
  expect(carryFindings).toHaveBeenCalledTimes(1)
  const input = (carryFindings.mock.calls[0] as unknown as [Record<string, unknown>])[0]
  expect(input).toMatchObject({ goal: 'target', revision: 3, source: 'source', receipt: 'receipt-1', findings: ['finding-open'] })
  expect(typeof input['request']).toBe('string')
  expect(container.textContent).toContain('Carried 1 finding into Goal target.')
})

it('with no open Goal in this project to carry into, the action is greyed and says so', () => {
  const { store, source } = rig(async () => [])
  const snapshot = store.getSnapshot() as AppSnapshot
  ;(snapshot.goals as Map<string, GoalView>).delete('target')
  act(() => { root.render(<StoreProvider store={store}><FindingCarry source={source} /></StoreProvider>) })
  expect(button('Carry unresolved findings…').disabled).toBe(true)
  expect(container.textContent).toContain('Open a Goal in this project to carry these findings into.')
})

it('a refused carry keeps the dialog open with the reason', async () => {
  const { store, source } = rig(async () => { throw new Error('This Goal changed. Read it again before carrying findings into it.') })
  act(() => { root.render(<StoreProvider store={store}><FindingCarry source={source} /></StoreProvider>) })
  act(() => button('Carry unresolved findings…').click())
  await act(async () => { button('Carry 1 finding').click() })
  expect(document.body.textContent).toContain('This Goal changed.')
})
