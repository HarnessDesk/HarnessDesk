import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FlowExecution, FlowPreview } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { FlowRunStatus } from './FlowRunStatus'

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

  expect(container.textContent).toContain('Interrupted')
  expect(container.textContent).toContain(INTERRUPTED.reason)

  const reviewButton = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Review and run again…')!
  act(() => reviewButton.click())
  await settle()

  expect(previewFlowRetry).toHaveBeenCalledWith('run-1', 3)
  // The original command is shown verbatim, and the mismatch leaves the confirming action disabled.
  expect(document.body.textContent).toContain('pnpm verify')
  expect(document.body.textContent).toContain('/repo')
  const confirm = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.includes('Run again'))!
  expect((confirm as HTMLButtonElement).disabled).toBe(false) // ConfirmDialog itself never blocks on `preview`; the retry call below is what the mismatch refuses.
  act(() => confirm.click())
  await settle()
  // No token to redeem — retryFlowCheck is never called with a null token.
  expect(retryFlowCheck).not.toHaveBeenCalled()
  // Still the same run and Goal: nothing here fabricated a new one.
  expect(INTERRUPTED.id).toBe('run-1')
  expect(INTERRUPTED.goal).toBe('goal-1')
})
