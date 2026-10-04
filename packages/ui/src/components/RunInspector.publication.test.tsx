import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { FindingPublicationsView, FindingRunView } from '@harnessdesk/protocol'
import { runFixture } from '../preview/run-view-fixture'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { RunInspector } from './RunInspector'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const fixture = runFixture()
const run = fixture.execution.id
const goal = fixture.execution.goal
const publications = (patch: Partial<FindingPublicationsView> = {}): FindingPublicationsView => ({
  goal, run, items: [], backfill: null, backfillRefusal: 'This review has no candidate to post.', ...patch,
})
const findingRun = (state: FindingRunView['publication'] = 'local'): FindingRunView => ({
  run, goal, round: 3, total: 3, finished: 3, embargoed: false, open: 1, blocking: 1, reason: 'The review was not posted.',
  ceilingStop: false, stamp: 'review-stamp', publication: state, rounds: [{ round: 3, state, reason: null, pr: 7, cards: [3] }],
  reviewersFinished: null, reviewersTotal: null, pendingExceptions: [], repair: null,
  boundPr: { repo: 'acme/widgets', pr: 7 }, unbound: null, undecidable: null,
})
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === label)!
const mount = async (view: FindingPublicationsView, publish = vi.fn(async (_input: unknown) => publications()), state: FindingRunView['publication'] = 'local', patch: Partial<FindingRunView> = {}) => {
  let snapshot = { ...emptySnapshot(), findingRuns: new Map([[run, { ...findingRun(state), ...patch }]]) }
  const listeners = new Set<() => void>()
  const read = vi.fn(async () => view)
  const store = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    readFindingPublications: read, publishFinding: publish } as unknown as AppStore
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<StoreProvider store={store}><RunInspector input={{ ...fixture, findingRun: snapshot.findingRuns.get(run) }}
    selectedRow="card-3-3" seats={[]} reviewActions={{ goal, run, stamp: 'review-stamp' }} /></StoreProvider>))
  return { container, read, publish,
    change: async (next: FindingPublicationsView) => { view = next; snapshot = { ...snapshot, findingRuns: new Map([[run, { ...findingRun(state), stamp: 'read-again' }]]) }; await act(async () => { for (const listener of listeners) listener() }) },
    close: () => { act(() => root.unmount()); container.remove() },
  }
}
it('warns about a local review kept before its Run bound a pull request', async () => {
  const view = await mount(publications({ backfill: { pr: 7, stamp: 'backfill-stamp', rounds: [{ round: 3, findings: 0, reviews: 1 }] } }), undefined, 'local', {
    rounds: [{ round: 3, state: 'local', reason: 'Kept before binding.', pr: null, cards: [3] }],
  })
  try {
    expect(view.container.textContent).toContain('Not posted')
    expect(view.container.textContent).not.toContain('Kept on the desk')
    expect(button(view.container, 'Post to pull request').disabled).toBe(false)
  } finally { view.close() }
})
it('keeps Copy review usable and shows the host refusal beside a disabled posting button', async () => {
  const writeText = vi.fn(async (_text: string) => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const view = await mount(publications())
  try {
    expect(button(view.container, 'Post to pull request').disabled).toBe(true)
    expect(button(view.container, 'Post to pull request').title).toBe('This review has no candidate to post.')
    expect(view.container.textContent).toContain('This review has no candidate to post.')
    expect(button(view.container, 'Copy review').disabled).toBe(false)
    await act(async () => button(view.container, 'Copy review').click())
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText.mock.calls[0]?.[0]).toContain('Cap the attempts.')
  } finally { view.close() }
})
it('posts the selected round only once per press and preserves the host refusal', async () => {
  const publish = vi.fn(async () => { throw new Error('The pull request moved. Read it before posting again.') })
  const view = await mount(publications({ items: [
    { key: 'other-round', round: 1, finding: null, pr: 7, state: 'uncertain', reason: 'Earlier review' },
    { key: 'this-review', round: 3, finding: null, pr: 7, state: 'prepared', reason: 'The review is waiting.' },
  ] }), publish)
  try {
    const post = button(view.container, 'Post to pull request')
    expect(post.title).toBe('Posts this review to pull request #7 as you. Nothing else changes.')
    await act(async () => { post.click(); post.click() })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ goal, run, action: { kind: 'post-again', key: 'this-review' } })
    expect(view.container.textContent).toContain('The pull request moved.')
    expect(view.read).toHaveBeenCalledTimes(2)
  } finally { view.close() }
})
it('previews a backfill before posting its exact stamp and all its rounds', async () => {
  const view = await mount(publications({ backfill: { pr: 7, stamp: 'backfill-stamp', rounds: [{ round: 1, findings: 2, reviews: 1 }, { round: 3, findings: 1, reviews: 1 }] }, backfillRefusal: null }))
  try {
    await act(async () => button(view.container, 'Post to pull request').click())
    expect(view.publish).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Round 1: 2 findings and 1 review')
    expect(document.body.textContent).toContain('Round 3: 1 finding and 1 review')
    await act(async () => button(document.body, 'Post to #7').click())
    expect(view.publish).toHaveBeenCalledWith({ goal, run, action: { kind: 'backfill', stamp: 'backfill-stamp' } })
  } finally { view.close() }
})
it('reads the publication doors again after the cached Run is refreshed', async () => {
  const view = await mount(publications())
  try {
    expect(button(view.container, 'Post to pull request').disabled).toBe(true)
    await view.change(publications({ items: [{ key: 'new-review', round: 3, finding: null, pr: 7, state: 'started', reason: null }], backfillRefusal: null }))
    expect(view.read).toHaveBeenCalledTimes(2)
    expect(button(view.container, 'Post to pull request').disabled).toBe(false)
  } finally { view.close() }
})
it('names a finding-only offered posting precisely on hover', async () => {
 const view=await mount(publications({items:[{key:'one-finding',round:3,finding:'finding-1',pr:7,state:'prepared',reason:null}],backfillRefusal:null}))
 try {
  expect(button(view.container,'Post to pull request').title).toBe('Posts this finding to pull request #7 as you. Nothing else changes.')
  expect(view.container.textContent).toContain('finding-1')
 } finally {view.close()}
})
it('shows an identical Run and door reason only once', async () => {
 const view=await mount(publications({backfillRefusal:'The review was not posted.'}))
 try { expect(view.container.textContent?.split('The review was not posted.').length).toBe(2) }
 finally {view.close()}
})
