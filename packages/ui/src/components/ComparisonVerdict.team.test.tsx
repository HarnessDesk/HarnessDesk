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
  expect(box.querySelector('[data-slot="comparison-decision"]')?.textContent).toContain('The judge picked A')
  await click('Merge A into main')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Merge into main')
  expect(box.querySelector('[data-slot="side-by-side-grid"]')).not.toBeNull()
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

it('compares recorded attempt revisions through the existing diff dialog', async () => {
  const {store} = await mount('picked')
  const request = vi.spyOn(store.transport, 'request')
  await click('Compare changes')
  expect(request).toHaveBeenCalledWith('git/diffRange', expect.objectContaining({from:'a'.repeat(40), to:'b'.repeat(40)}))
})
it('lets the person keep B for the pending merge without rewriting the judge', async () => {
  const {decide} = await mount('picked')
  await click('Keep B instead')
  const headers = [...box.querySelectorAll('[data-slot="side-by-side-tile"] header')]
  expect(headers[0]?.textContent).toContain('Not kept')
  expect(headers[1]?.textContent).toContain('Picked')
  expect(box.textContent).toContain('You picked B')
  expect(box.textContent).toContain('Judge picked A:')
  expect(decide).not.toHaveBeenCalled()
  await click('Merge B into main')
  expect(document.querySelector('[role="dialog"]')?.querySelector<HTMLSelectElement>('select')?.value).toBe('b'.repeat(40))
})
it('shows the merged summary from the saved person receipt and restores the attempts', async () => {
  await mount('merged')
  expect(box.textContent).toContain('A is in main')
  expect(box.querySelector('[data-slot="side-by-side-grid"]')).toBeNull()
  expect(box.textContent).toContain('The attempt stays in this Run')
  expect(box.textContent).not.toContain('7 days')
  await click('Show the attempts')
  expect(box.querySelector('[data-slot="side-by-side-grid"]')).not.toBeNull()
  expect(box.querySelector('[data-slot="comparison-decision"]')).toBeNull()
})
it('records completion only after a conflict-free merge and retains the merge receipt', async () => {
  const {store} = await mount('picked')
  const intent = vi.spyOn(store, 'teamIntent').mockResolvedValue()
  const request = vi.spyOn(store.transport, 'request')
  await click('Merge A into main')
  const dialog = document.querySelector('[role="dialog"]')!
  await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Merge')!.click())
  expect(request).toHaveBeenCalledWith('git/merge', {root:'/workspace/demo-client', ref:'a'.repeat(40)})
  expect(intent).toHaveBeenCalledWith(PREVIEW_ROOM, 6, 'done', undefined, 'merged', expect.stringContaining('"card":1'))
  expect(box.textContent).toContain('A is in main')
})
it('leaves a conflicted merge awaiting the person without recording completion', async () => {
  const {store} = await mount('picked')
  const intent = vi.spyOn(store, 'teamIntent').mockResolvedValue()
  const original = store.transport.request.bind(store.transport)
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string, params: never) => method === 'git/merge' ? Promise.resolve({summary:'Resolve the conflict', conflicts:['src/client.ts']}) : original(method as never, params)) as typeof store.transport.request)
  await click('Merge A into main')
  const dialog = document.querySelector('[role="dialog"]')!
  await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Merge')!.click())
  expect(intent).not.toHaveBeenCalled()
  expect(box.querySelector('[data-slot="comparison-summary"]')).toBeNull()
})

it('refuses a merge if the destination changed after the decision appeared', async () => {
  const {store} = await mount('picked')
  const original = store.transport.request.bind(store.transport)
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: never) => {
    const result = await original(method as never, params)
    return method === 'git/refs' ? {...result as object, branch:'release'} : result
  }) as typeof store.transport.request)
  await click('Merge A into main')
  const dialog = document.querySelector('[role="dialog"]')!
  await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Merge')!.click())
  expect(dialog.textContent).toContain('The destination branch changed')
  expect(request.mock.calls.some(([method]) => method === 'git/merge')).toBe(false)
  expect(box.querySelector('[data-slot="comparison-summary"]')).toBeNull()
})

it('keeps the question open when recording a completed merge fails', async () => {
  const {store} = await mount('picked')
  vi.spyOn(store, 'teamIntent').mockRejectedValue(new Error('The answer could not be saved'))
  await click('Merge A into main')
  const dialog = document.querySelector('[role="dialog"]')!
  await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Merge')!.click())
  expect(dialog.textContent).toContain('The answer could not be saved')
  expect(box.querySelector('[data-slot="comparison-summary"]')).toBeNull()
})
