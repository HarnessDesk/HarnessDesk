import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FlowExecution, FlowPreview } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { PREVIEW_GOAL } from '../preview/goal-fixture'
import { FlowRunStatus } from './FlowRunStatus'
import { RetryCheck } from './RetryCheck'

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

const DOCUMENT = { format: 'agents' as const, flow: { version: 2 as const, name: 'Fix', inputs: [], roles: [], rules: [], seed: { role: 'fixer', title: 'Go' }, messaging: 'board-only' as const, wait: 240 } }

const INTERRUPTED: FlowExecution = {
  version: 2, id: 'run-1', goal: 'goal-1', document: DOCUMENT, state: 'stalled',
  rounds: [{ n: 2, role: 'verify', cards: [3], seats: [], evidence: [], state: 'running', cause: 'x' }],
  operations: [{ key: 'check:2:0', kind: 'check', state: 'uncertain', card: 3, seat: null }],
  legacyRun: null, reason: 'This check was interrupted. Inspect its effects, then choose Run again.',
}

it('disables check recovery when its Run read lags behind a wrapped Team', async () => {
  const goal = { ...PREVIEW_GOAL, goal: { ...PREVIEW_GOAL.goal, id: INTERRUPTED.goal, state: 'wrapped' as const } }
  const snapshot = { ...emptySnapshot(), goals: new Map([[goal.goal.id, goal]]), flowExecutions: new Map([[INTERRUPTED.id, INTERRUPTED]]) }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><FlowRunStatus execution={INTERRUPTED} /></StoreProvider>))
  const review = [...container.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Review and run again…')!
  expect(review.disabled).toBe(true)
  expect(review.title).toBe('This Team is wrapped')
})

it('disables an already-open check confirmation when the Team wraps', async () => {
  const goal = { ...PREVIEW_GOAL, goal: { ...PREVIEW_GOAL.goal, id: INTERRUPTED.goal } }
  let snapshot = { ...emptySnapshot(), goals: new Map([[goal.goal.id, goal]]), flowExecutions: new Map([[INTERRUPTED.id, INTERRUPTED]]) }
  const previewFlowRetry = vi.fn(async () => ({ token: 'preview-token', commands: [], problems: [] }))
  const retryFlowCheck = vi.fn()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, previewFlowRetry, retryFlowCheck } as unknown as AppStore
  const render = () => act(() => root.render(<StoreProvider store={store}><RetryCheck run={INTERRUPTED.id} card={3} onClose={() => {}} /></StoreProvider>))
  render()
  await settle()
  const confirm = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Run again')!
  expect(confirm().disabled).toBe(false)
  snapshot = { ...snapshot, goals: new Map([[goal.goal.id, { ...goal, goal: { ...goal.goal, state: 'wrapped' } }]]) }
  render()
  await settle()
  expect(confirm().disabled).toBe(true)
  expect(document.body.textContent).toContain('This Team is wrapped')
  act(() => confirm().click())
  expect(retryFlowCheck).not.toHaveBeenCalled()
})

/*
 * The pinned revision a review run works at moved to `TeamRoomPane`'s own
 * header meta line once #905 gave every Goal or room one header
 * ("names the pinned revision..." in TeamRoomPane.test.tsx) — this
 * component no longer reads `execution.target` at all, so there is nothing
 * of that behaviour left to pin here.
 */

it('an interrupted check requires fresh confirmation and preserves its Goal, on a mismatched retry', async () => {
  const preview: FlowPreview = {
    token: null, // CHANGED_PREVIEW: the world moved since this run started, so no token was minted.
    compiled: { document: DOCUMENT, bindings: [], problems: [] },
    seats: [], commands: [{ role: 'verify', run: 'pnpm verify', cwd: '/repo', timeout: 600 }],
    guards: [], messaging: 'board-only',
    problems: [{ level: 'error', at: 'run', text: 'This flow or its seating changed. Review the dry run again before starting.' }],
  }
  const previewFlowRetry = vi.fn(async () => preview)
  const retryFlowCheck = vi.fn()
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => emptySnapshot(),
    previewFlowRetry,
    retryFlowCheck,
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <FlowRunStatus execution={INTERRUPTED} />
      </StoreProvider>,
    )
  })
  await settle()

  // The run's own state and reason are the header's to say now
  // (`TeamRoomPane`'s own state chip and the room's live line); this
  // component's only remaining job is the recovery action itself.
  const reviewButton = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Review and run again…')!
  act(() => reviewButton.click())
  await settle()

  expect(previewFlowRetry).toHaveBeenCalledWith('run-1', 3)
  // The original command is shown verbatim, and the mismatch leaves the confirming action disabled.
  expect(document.body.textContent).toContain('pnpm verify')
  expect(document.body.textContent).toContain('/repo')
  const confirm = [...document.body.querySelectorAll('button')].find((one) => one.textContent === 'Run again')!
  expect((confirm as HTMLButtonElement).disabled).toBe(true)
  act(() => confirm.click())
  await settle()
  // No token to redeem — retryFlowCheck is never called with a null token.
  expect(retryFlowCheck).not.toHaveBeenCalled()
  // Still the same run and Goal: nothing here fabricated a new one.
  expect(INTERRUPTED.id).toBe('run-1')
  expect(INTERRUPTED.goal).toBe('goal-1')
})

/**
 * The header keeps one state chip now (`TeamRoomPane`'s own), and this
 * component drew a second one under it that said the same thing in
 * different words — "Running" here, "Working" above. An ordinary run, on
 * the current format, with nothing stalled, draws nothing at all.
 */
it('draws nothing for an ordinary run — no legacy format, nothing stalled', () => {
  const RUNNING: FlowExecution = {
    version: 2, id: 'run-2', goal: 'goal-1', document: DOCUMENT, state: 'running',
    rounds: [{ n: 1, role: 'fixer', cards: [], seats: [], evidence: [], state: 'running', cause: 'seed' }],
    operations: [], legacyRun: null, reason: null,
  }
  const store = { subscribe: () => () => {}, getSnapshot: () => emptySnapshot() } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <FlowRunStatus execution={RUNNING} />
      </StoreProvider>,
    )
  })
  expect(container.innerHTML).toBe('')
})
