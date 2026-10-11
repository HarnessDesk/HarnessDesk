import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { MainPages } from '../app/MainPages'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'
import { reviewPageStore, type ReviewScene } from './review-page-fixture'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
const mount = async (scene: ReviewScene) => {
  const store = reviewPageStore(scene)
  store.openReview()
  const review = store.getSnapshot().workbench.navigation.current
  if (review.kind !== 'changes-review') throw new Error('review expected')
  await act(async () => root.render(<StoreProvider store={store}><TopBarProvider>
    <MainPages onSignIn={() => {}} />
    <TopBarOutlet owner="destination:changes-review" fallback={{place:'Fallback',more:()=>null}} />
  </TopBarProvider></StoreProvider>))
  return { store, review }
}
const click = async (selector: string) => {
  const button = document.querySelector<HTMLButtonElement>(selector)
  expect(button).not.toBeNull()
  await act(async () => button!.click())
}
it('working, staged and filtered reviews retain their exact file counts and paths', async () => {
  await mount('tree')
  expect(container.textContent).toContain('2 files · +3 −1')
  expect(container.querySelectorAll('[data-review-file]')).toHaveLength(2)
  const field = container.querySelector<HTMLInputElement>('[aria-label="Filter files"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'src/a')
    field.dispatchEvent(new Event('input', {bubbles:true}))
  })
  expect(container.querySelectorAll('[data-review-file]')).toHaveLength(1)
  expect(container.querySelector('[data-review-file="src/a.ts"]')).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '')
    field.dispatchEvent(new Event('input', {bubbles:true}))
  })
  await click('[title="Destination views"]')
  await click('[data-team-page="staged"]')
  expect(container.textContent).toContain('1 file · +1 −0')
  expect(container.querySelector('[data-review-file="ready.txt"]')).not.toBeNull()
  expect(container.querySelector('[data-review-file="src/a.ts"]')).toBeNull()
})
it('the body index jumps to its existing file section', async () => {
  await mount('tree')
  const target = container.querySelector<HTMLElement>('[data-review-file="src/a.ts"]')!
  target.scrollIntoView = vi.fn()
  const row = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="rows"] button')].find(button => button.textContent?.startsWith('a.ts'))!
  expect(row).toBeTruthy()
  await act(async () => row.click())
  expect(target.scrollIntoView).toHaveBeenCalledWith({block:'start',behavior:'auto'})
})
it('the exact 1800-character hunk cap and acknowledged quote survive return to captured work', async () => {
  const {store,review} = await mount('large')
  const composed: string[] = []
  const listen = (event: Event) => {
    const detail = (event as CustomEvent<{text:string;onReceived:()=>void}>).detail
    composed.push(detail.text); detail.onReceived()
  }
  window.addEventListener('harnessdesk:compose',listen)
  try {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Revise this hunk…')!
    await act(async()=>button.click())
    expect(store.getSnapshot().workbench.navigation.current).toEqual({kind:'work',view:review.returnTo})
    expect(composed).toHaveLength(1)
    const quote = composed[0]!.split('\n```diff\n')[1]!.split('\n```')[0]!
    expect(quote).toHaveLength(1802)
    expect(quote).toMatch(/\n…$/)
    expect(quote).not.toContain('diff --git')
    await act(async()=>store.navigateBack())
    expect(store.getSnapshot().workbench.navigation.current).toEqual(review)
  } finally { window.removeEventListener('harnessdesk:compose',listen) }
})
for (const scene of ['empty','not-repository'] as const) it(`preserves the existing ${scene} message`,async()=>{
  await mount(scene)
  expect(container.textContent).toContain(scene==='empty'?'No uncommitted changes.':'This folder is not a git repository, so there is nothing to compare against.')
})
it('the shared More menu offers only Terminal and opens the reviewed folder', async () => {
  const {store,review} = await mount('tree')
  const request = vi.spyOn(store.transport,'request')
  await click('[aria-label="More"]')
  const menu = document.querySelector('[role="menu"]')!
  expect(menu.textContent).toContain('Terminal')
  expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(0)
  expect(menu.querySelectorAll('[role="menuitemradio"]')).toHaveLength(1)
  await click('[role="menuitemradio"]')
  expect(request).toHaveBeenCalledWith('terminal/open',expect.objectContaining({cwd:review.root}))
})
