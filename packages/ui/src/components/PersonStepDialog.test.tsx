import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flowStepOf, type GitMergeOutcome, type ReviewCandidate } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { shapeFixture, SHAPE_REV } from '../preview/run-shapes-fixture'
import { PersonStepDialog } from './PersonStepDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === name)!

const rig = async (outcome: GitMergeOutcome = { summary: 'Merged', conflicts: [], merged: { branch: 'main', commit: SHAPE_REV[1]! } }, answer = 'merged') => {
  const input = shapeFixture('comparison')
  if (input.execution.document.format !== 'agents') throw new Error('wrong fixture')
  const execution = { ...input.execution, document: { ...input.execution.document, flow: { ...input.execution.document.flow,
    roles: input.execution.document.flow.roles.map(one => one.id === 'merge' ? { id: 'merge', kind: 'person' as const, outcomes: [answer], review: true } : one),
  } } }
  const intent = input.cards.find(one => one.id === 6)!
  const candidates: ReviewCandidate[] = [1, 2].map((card, index) => ({ id: `candidate-${card}`, card, at: SHAPE_REV[index]!, branch: `lane-${card}`, holder: 'Builder', evidence: [] }))
  // Candidate order may differ from the order the comparison opened its cards.
  const snapshot = { ...emptySnapshot(), teams: new Map([['room', { room: 'room', root: '/code/project', cwd: null, intents: input.cards }]]), flowExecutions: new Map([[execution.id, execution]]) }
  const request = vi.fn(async (method: string) => {
    if (method === 'git/refs') return { branch: 'main', headSha: 'f'.repeat(40), branches: [], remotes: [], tags: [], stashes: [] }
    if (method === 'git/merge') return outcome
    if (method === 'git/diffRange') return { diff: '' }
    throw new Error(method)
  })
  const decideFlowReview = vi.fn(async () => execution), onClose = vi.fn()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, flowReviewCandidates: vi.fn(async () => [...candidates].reverse()),
    decideFlowReview, teamIntent: vi.fn(), transport: { request }, notice: vi.fn(), openDetailsTab: vi.fn() } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><PersonStepDialog room="room" intent={intent} role={flowStepOf(intent, undefined, [execution])!} mode="review" onClose={onClose} /></StoreProvider>))
  const choose = async () => { await act(async () => [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find(one => one.textContent?.includes('lane-2'))!.click()) }
  return { choose, decideFlowReview, onClose, request, store }
}

it('names attempts in comparison order and shows their short commits', async () => {
  await rig()
  const rows = [...document.querySelectorAll('[role="radio"]')]
  expect(rows.map(one => one.textContent)).toEqual(expect.arrayContaining([
    expect.stringContaining('Attempt A'), expect.stringContaining('Attempt B'),
  ]))
  expect(rows.find(one => one.textContent?.includes('Attempt A'))?.textContent).toContain(SHAPE_REV[0]!.slice(0, 7))
  expect(rows.find(one => one.textContent?.includes('Attempt B'))?.textContent).toContain(SHAPE_REV[1]!.slice(0, 7))
})

it('offers the selected attempt as a merge and answers only after Git succeeds', async () => {
  const r = await rig()
  await r.choose()
  expect(button('Record answer')).toBeUndefined()
  await act(async () => button('Merge Attempt B into main…').click())
  expect(r.decideFlowReview).not.toHaveBeenCalled()
  await act(async () => button('Merge').click())
  expect(r.request).toHaveBeenCalledWith('git/merge', { root: '/code/project', ref: SHAPE_REV[1], expectedBranch: 'main' })
  expect(r.decideFlowReview).toHaveBeenCalledWith('run-comparison', 6, 'candidate-2', 'merged', 'main')
  expect(r.onClose).toHaveBeenCalledOnce()
})

it('leaves conflicts unanswered', async () => {
  const r = await rig({ summary: 'Resolve attempt.txt', conflicts: ['attempt.txt'] })
  await r.choose()
  await act(async () => button('Merge Attempt B into main…').click())
  await act(async () => button('Merge').click())
  expect(r.decideFlowReview).not.toHaveBeenCalled()
  expect(r.onClose).not.toHaveBeenCalled()
})

it('verifies a manual merge and keeps a refusal beside the choice', async () => {
  const r = await rig()
  r.decideFlowReview.mockRejectedValueOnce(new Error('Attempt B is not reachable from main.'))
  await r.choose()
  await act(async () => button('I merged it').click())
  expect(r.request.mock.calls.some(([method]) => method === 'git/merge')).toBe(false)
  expect(document.body.textContent).toContain('Attempt B is not reachable from main.')
  expect(r.onClose).not.toHaveBeenCalled()
})

it('keeps a person judge’s pick separate from the merge', async () => {
  const r = await rig(undefined, 'picked')
  await r.choose()
  await act(async () => button('Record answer').click())
  expect(r.decideFlowReview).toHaveBeenCalledWith('run-comparison', 6, 'candidate-2', 'picked')
  expect(r.request.mock.calls.some(([method]) => method === 'git/merge')).toBe(false)
})
