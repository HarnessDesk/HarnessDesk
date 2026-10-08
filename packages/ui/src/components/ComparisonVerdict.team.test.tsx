import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { TeamRoomPane } from './TeamRoomPane'
import { usePane, StoreProvider } from '../state/context'
import { MountProvider } from '../panels/mount'
import { PREVIEW_ROOM } from '../preview/harness'
import { SIDE_BY_SIDE_KEYS } from '../preview/side-by-side-fixture'
import { comparisonVerdictStore, type ComparisonScene } from '../preview/comparison-verdict-fixture'

vi.mock('./Conversation', () => ({ Conversation: () => <div data-conversation={usePane()?.sessionKey} /> }))
vi.mock('./Approvals', () => ({ Approvals: () => <div data-approval /> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let box: HTMLDivElement
let root: Root
const mount = async (scene: ComparisonScene) => {
  const store = comparisonVerdictStore(scene)
  const read = vi.spyOn(store, 'loadBoardEvidence')
  const candidates = vi.spyOn(store, 'flowReviewCandidates')
  const decide = vi.spyOn(store, 'decideFlowReview')
  box = document.createElement('div'); document.body.append(box); root = createRoot(box)
  const view = { kind: 'room' as const, room: PREVIEW_ROOM, sideBySide: { tiles: SIDE_BY_SIDE_KEYS.slice(0, 2), focused: SIDE_BY_SIDE_KEYS[0] } }
  await act(async () => root.render(<StoreProvider store={store}><MountProvider scope={{ area: 'main', id: 'verdict-test', view }}><TeamRoomPane room={PREVIEW_ROOM} /></MountProvider></StoreProvider>))
  return { store, read, candidates, decide }
}
afterEach(() => { if (root) act(() => root.unmount()); box?.remove(); vi.restoreAllMocks() })
const click = async (label: string) => {
  const control = [...box.querySelectorAll<HTMLElement>('button,[role=tab]')].find(one => one.textContent?.trim() === label || (label === 'Board' && one.textContent?.trim().startsWith('Board')) || one.getAttribute('aria-label') === label)
  expect(control, label).toBeDefined()
  await act(async () => control!.click())
}
it('reads comparison evidence on Side by side and maps the Run’s outcomes to competitor tile bars', async () => {
  const { read } = await mount('picked')
  expect(read).toHaveBeenCalledWith(PREVIEW_ROOM)
  const bars = [...box.querySelectorAll('[data-slot="side-by-side-tile"] header')]
  expect(bars[0]?.textContent).toContain('Picked')
  expect(bars[1]?.textContent).toContain('Not kept')
  expect(box.querySelector('[data-slot="comparison-notice"]')?.textContent).toContain('Gamma picked Attempt A')
  await click('Merge the picked change')
  expect(box.querySelector('[data-slot="side-by-side-grid"]')).toBeNull()
  expect(box.textContent).toContain('Merge the picked change')
})
it('keeps a dismissed verdict dismissed when returning to Side by side', async () => {
  await mount('picked')
  await click('Dismiss verdict')
  await click('Board')
  const toggle = box.querySelector<HTMLButtonElement>('button[aria-label="Side by side"]')!
  expect(toggle).not.toBeNull()
  await act(async () => toggle.click())
  expect(box.querySelector('[data-slot="side-by-side-grid"]')).not.toBeNull()
  expect(box.querySelector('[data-slot="comparison-notice"]')).toBeNull()
})
it('opens the Board’s same attempt dialog from a waiting person judge', async () => {
  const { candidates, decide } = await mount('person')
  expect(box.querySelector('[data-slot="comparison-notice"]')?.textContent).toContain('Your pick is next')
  expect(box.textContent).not.toContain('Not kept')
  await click('Pick an attempt…')
  expect(candidates).toHaveBeenCalledWith('run-comparison', 5)
  const question = document.querySelector('[role="dialog"]')!
  expect(question.textContent).toContain('Choose the attempt this step answers for.')
  const radio = question.querySelector<HTMLButtonElement>('[role="radio"]')!
  await act(async () => radio.click())
  const confirm = [...question.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Record answer')!
  await act(async () => confirm.click())
  expect(decide).toHaveBeenCalledWith('run-comparison', 5, 'candidate-1', 'picked')
})
for (const scene of ['before', 'no-pass'] as const) it(`shows no result for ${scene}`, async () => {
  await mount(scene)
  expect(box.querySelector('[data-slot="comparison-notice"]')).toBeNull()
  expect([...box.querySelectorAll('[data-slot="side-by-side-tile"] header')].some(one => /Picked|Not kept/.test(one.textContent ?? ''))).toBe(false)
})

it('does not carry an open picker into a later person verdict', async () => {
  const { store } = await mount('person')
  await click('Pick an attempt…')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  const patch = store as unknown as { patch: (next: Partial<ReturnType<typeof store.getSnapshot>>) => void }
  await act(async () => patch.patch(comparisonVerdictStore('picked').getSnapshot()))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  const next = comparisonVerdictStore('person').getSnapshot()
  const run = next.flowExecutions.get('run-comparison')!
  const goal = next.goals.get(PREVIEW_ROOM)!
  await act(async () => patch.patch({ ...next,
    flowExecutions: new Map([['run-next', { ...run, id: 'run-next' }]]),
    goals: new Map([[PREVIEW_ROOM, { ...goal, reservation: { run: 'run-next' }, goal: { ...goal.goal, origin: { kind: 'flow', run: 'run-next' } } }]]),
  }))
  expect(box.textContent).toContain('Your pick is next')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
