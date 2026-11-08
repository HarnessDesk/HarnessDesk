import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ForgeGitEntry } from '@harnessdesk/protocol'
import { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import { GitRecordRows, GitWriteSettings, ProjectGitWrites, ProjectGitRecord, OutsideHeadBanner } from './GitRecord'

let box: HTMLDivElement, root: Root
beforeEach(() => { box = document.createElement('div'); document.body.append(box); root = createRoot(box) })
afterEach(() => { act(() => root.unmount()); box.remove() })
const outside: ForgeGitEntry = { id: 'outside', repository: 'acme/widgets', branch: 'feature/widgets', sha: 'c'.repeat(40), at: 1, op: 'observed', outcome: 'ok', requester: { kind: 'outside' }, approval: null }
const mount = async (child: React.ReactNode, store = new AppStore('ws://localhost:0/')) => { await act(async () => root.render(<StoreProvider store={store}>{child}</StoreProvider>)); return store }
const mergeRows: ForgeGitEntry[] = ['unknown', 'intent', 'observed-merged', 'failed', 'refused', 'rejected', 'ok'].map((outcome, index) => ({
  id: `merge-${index}`, repository: 'acme/widgets', number: index + 1, at: 1, op: 'pr.merge', outcome: outcome as ForgeGitEntry['outcome'], requester: { kind: 'session', id: 'fixture' }, approval: null,
}))
it('PR record rows distinguish uncertain, pending and externally observed merge outcomes', async () => {
  await mount(<GitRecordRows entries={mergeRows} />)
  expect(box.textContent).toContain('Merge outcome unknown #1')
  expect(box.textContent).toContain('Merge pending #2')
  expect(box.textContent).toContain('PR merged (observed) #3')
  expect(box.textContent).toContain('Not attributed')
  expect(box.textContent).toContain('Merge failed #4')
  expect(box.textContent).toContain('Merge refused #5')
  expect(box.textContent).toContain('Merge refused #6')
  expect(box.textContent).toContain('Merged #7')
  expect(box.textContent).not.toContain('Merged #1')
})
it('project record marks uncertain merge as needing inspection, not done', async () => {
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockResolvedValue({ repository: 'acme/widgets', entries: mergeRows, counts: { all: 7, outside: 0, refused: 2 } } as any)
  await mount(<ProjectGitRecord root="/workspace/widgets" />, store)
  expect(box.textContent).toContain('Needs inspection')
  expect(box.textContent).toContain('PR merged (observed) #3')
  expect(box.textContent).toContain('Not attributed')
  expect(box.textContent).toContain('Merge failed #4')
  expect(box.textContent).toContain('Merge refused #5')
  expect(box.textContent).not.toContain('Merged #1')
})
it('outside PR rows name nobody and have no repeated trailing fact', async () => {
  await mount(<GitRecordRows entries={[outside]} />)
  expect(box.textContent).toContain('Outside')
  expect(box.textContent).toContain('Not written through HarnessDesk, so no one here is named.')
  expect(box.querySelector('[data-slot="row-ctl"]')).toBeNull()
})
it('settings persist partial choices and project overrides retain other projects', async () => {
  const store = new AppStore('ws://localhost:0/'), request = vi.spyOn(store.transport, 'request')
  let gitWrites = { steer: 'ask', recordOutside: false, projects: { '/other': 'off' } }
  request.mockImplementation(async (method, input) => {
    if (method === 'app/state/set') gitWrites = { ...gitWrites, ...(input as any).patch.gitWrites }
    if (method === 'git/record/list') return { repository: 'acme/widgets', entries: [], counts: { all: 0, outside: 0, refused: 0 } } as any
    return { gitWrites } as any
  })
  await mount(<><GitWriteSettings /><ProjectGitWrites root="/workspace/widgets" /></>, store)
  const select = box.querySelector<HTMLSelectElement>('select[aria-label="Agents\' own pushes"]')!
  await act(async () => { select.value = 'redirect'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(gitWrites.projects).toEqual({ '/other': 'off', '/workspace/widgets': 'redirect' })
  expect(box.textContent).toContain('Takes effect at once in open conversations')
})
it('an unpinned project explains the first approval without showing an empty table', async () => {
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockResolvedValue({ repository: null, entries: [], counts: { all: 0, outside: 0, refused: 0 } } as any)
  await mount(<ProjectGitRecord root="/workspace/widgets" />, store)
  expect(box.textContent).toContain("No pushes yet. The first push you approve pins this project's repository.")
  expect(box.querySelector('table')).toBeNull()
})
it('reclaims through the supplied head-bound action', async () => {
  const reclaim = vi.fn()
  await mount(<OutsideHeadBanner branch="feature/widgets" head={'c'.repeat(40)} onReclaim={reclaim} />)
  await act(async () => box.querySelector<HTMLButtonElement>('button')!.click())
  expect(reclaim).toHaveBeenCalledTimes(1)
})
it('Git write preferences refresh on focus after another settings surface changes them', async () => {
  const store = new AppStore('ws://localhost:0/'); let steer = 'ask'
  vi.spyOn(store.transport, 'request').mockImplementation(async () => ({ gitWrites: { steer, recordOutside: true, projects: {} } }) as any)
  await mount(<GitWriteSettings />, store)
  steer = 'off'
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(box.querySelector<HTMLSelectElement>('select')?.value).toBe('off')
})
