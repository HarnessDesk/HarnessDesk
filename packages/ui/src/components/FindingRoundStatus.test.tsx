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
  reason: null, ceilingStop: false, stamp: 'stamp-1', publication: 'local', rounds: [{ round: 2, state: 'local', reason: null, pr: 7, cards: [1] }], reviewersFinished: null, reviewersTotal: null,
  pendingExceptions: [], repair: null,
  boundPr: { repo: 'acme/widgets', pr: 7 }, unbound: null, undecidable: null,
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
  expect(container.textContent).toContain('Not confirmed')
  expect(container.textContent).not.toContain('Published')
})

it('a stopped run shows the recorded reason', () => {
  act(() => root.render(<FindingRoundStatus view={view({ reason: 'Round 3 ended with 2 open findings.' })} />))
  expect(container.textContent).toContain('Round 3 ended with 2 open findings.')
})

it('a merge-anyway override is shown as a durable confirmation, not left for a direct wire call to prove', () => {
  act(() => root.render(<FindingRoundStatus view={view({ override: { reason: 'shipping with a tracked follow-up', decidedAt: 1_700_000_000_000 } })} />))
  expect(container.textContent).toContain('Merged anyway')
  expect(container.textContent).toContain('shipping with a tracked follow-up')
})

it('says nothing about an override when none was recorded', () => {
  act(() => root.render(<FindingRoundStatus view={view()} />))
  expect(container.textContent).not.toContain('Merged anyway')
})

it.each([
  ['posted', true, 7, 'Posted to #7'], ['pending', true, 7, 'Waiting to post'],
  ['partial', true, 7, 'Partly posted'], ['uncertain', true, 7, 'Not confirmed'],
  ['local', true, 7, 'Not posted'], ['local', false, 7, 'Kept on the desk'], ['local', true, null, 'Kept on the desk'],
] as const)('shows the Run summary state %s with posting %s and PR %s', (publication, publicationOn, pr, label) => {
  act(() => root.render(<FindingRoundStatus view={view({ publication, boundPr: pr ? { repo: 'acme/widgets', pr } : null })} publicationOn={publicationOn} />))
  expect(container.querySelector('[data-slot="chip-words"]')?.textContent).toBe(label)
})
it('omits the Run publication when no findings exist', () => {
  act(() => root.render(<FindingRoundStatus view={view({ total: 3, open: 0, blocking: 0, publication: 'local', rounds: [{ round: 1, state: 'none', reason: null, pr: null, cards: [1] }] })} />))
  expect(container.textContent).not.toContain('Publication')
})
