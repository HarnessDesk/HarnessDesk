import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { FindingRunView } from '@harnessdesk/protocol'
import { FindingRoundStatus } from './FindingRoundStatus'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement; let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const view = (over: Partial<FindingRunView> = {}): FindingRunView => ({
  run: 'run-1', goal: 'g1', round: 2, finished: 1, total: 3, embargoed: false, open: 1, blocking: 1,
  reason: null, stamp: 'stamp-1', publication: 'local', reviewersFinished: null, reviewersTotal: null,
  pendingExceptions: [], repair: null,
  ...over,
})

it('a partial blind round says how many finished, never that every reviewer answered', () => {
  act(() => root.render(<FindingRoundStatus view={view({ embargoed: true, reviewersFinished: 2, reviewersTotal: 3 })} />))
  expect(container.textContent).toContain('2 of 3 reviewers finished')
  expect(container.textContent).toContain('published when the round closes')
  expect(container.textContent).not.toContain('3 of 3')
})

it('never implies remote success for an uncertain publication', () => {
  act(() => root.render(<FindingRoundStatus view={view({ publication: 'uncertain' })} />))
  expect(container.textContent).toContain('Publication uncertain')
  expect(container.textContent).not.toContain('Published')
})

it('a stopped run shows the recorded reason', () => {
  act(() => root.render(<FindingRoundStatus view={view({ reason: 'Round 3 ended with 2 open findings.' })} />))
  expect(container.textContent).toContain('Round 3 ended with 2 open findings.')
})
