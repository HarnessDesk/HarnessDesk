import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ChangesReview } from './ChangesReview'
import { DestinationPageScope } from '../panels/destination-page'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'

/**
 * The review workspace: the tree grouped by folder with its ± counts, and
 * the one hunk action — "revise this hunk" quotes the hunk into the composer
 * and hands the window back. Staging stays git's: nothing here writes.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let mountedStore: AppStore

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const TREE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  '-old line',
  '+new line',
  ' kept',
  '@@ -10,1 +10,2 @@',
  ' context',
  '+another',
  'diff --git a/docs/guide.md b/docs/guide.md',
  '--- a/docs/guide.md',
  '+++ b/docs/guide.md',
  '@@ -1 +1,2 @@',
  ' hi',
  '+there',
].join('\n')

const STATUS = {
  root: '/w',
  branch: 'main',
  ahead: 0,
  behind: 0,
  files: [
    { path: 'src/a.ts', status: 'modified', staged: false },
    { path: 'docs/guide.md', status: 'modified', staged: false },
  ],
}

const answer = async (method: string): Promise<unknown> => {
  if (method === 'git/status') return STATUS
  return { diff: TREE_DIFF }
}
const request = vi.fn(answer)

const mount = (selectWork: () => boolean, active = true, reviewRoot = "/w"): void => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    workspace: { path: '/w', name: 'w' } as AppSnapshot['workspace'],
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request },
    openFile: vi.fn(),
    notice: vi.fn(),
    selectWork,
  } as unknown as AppStore
  mountedStore = store
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <TopBarProvider>
          <DestinationPageScope owner="destination:changes-review" active={active}>
            <ChangesReview root={reviewRoot} returnTo={{ kind: 'conversation', session: null }} />
          </DestinationPageScope>
          <TopBarOutlet owner="destination:changes-review" fallback={{ place: 'Fallback', more: () => null }} />
        </TopBarProvider>
      </StoreProvider>,
    )
  })
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('the review workspace', () => {
  it('replaces the filter, view tabs and file index when the tree has no changes', async () => {
    request.mockImplementation(async (method: string) => method === 'git/status'
      ? { ...STATUS, files: [] }
      : { diff: '' })
    try {
      mount(() => true)
      await flush()

      expect(container.textContent).toContain('No changes yet')
      expect(container.querySelector('[aria-label="Filter files"]')).toBeNull()
      expect(container.querySelector('[role="tab"]')).toBeNull()
      expect(container.querySelector('[data-slot="summary-list"]')).toBeNull()
      expect(container.querySelector('[data-slot="review-index"]')).toBeNull()
    } finally { request.mockImplementation(answer) }
  })

  it('groups the tree by folder and counts each file', async () => {
    mount(() => true)
    await flush()
    const text = container.textContent ?? ''
    expect(text).toContain('docs')
    expect(text).toContain('src')
    expect(text).toContain('a.ts')
    expect(text).toContain('guide.md')
    // src/a.ts gained two lines and lost one, across two hunks.
    expect(text).toContain('+2')
    expect(text).toContain('−1')
    // The header totals the whole read: 2 files, +3 −1, on the branch.
    expect(text).toContain('2 files')
    expect(text).toContain('+3 −1')
    expect(text).toContain('on main')
    expect(container.querySelector('[data-slot="toolbar-gap"]')).not.toBeNull()
  })

  it('parts one hunk from the next with the app\u2019s hairline, and never above the first', async () => {
    mount(() => true)
    await flush()
    const hunks = [...container.querySelectorAll('section')].filter((node) => node.querySelector(':scope > [data-slot="patch-header"][data-level="hunk"]'))
    // docs/guide.md (listed first, by folder) has one hunk, src/a.ts two.
    expect(hunks).toHaveLength(3)
    const rules = hunks.map((hunk) => hunk.firstElementChild?.getAttribute('data-slot') === 'separator')
    expect(rules).toEqual([false, false, true])
  })

  it('revise selects its captured work before requesting an acknowledged composer handover', async () => {
    const order: string[] = [], composed: string[] = []
    const select = vi.fn(() => { order.push('select-work'); return true })
    const listen = (event: Event): void => {
      const detail = (event as CustomEvent<{text:string;onReceived:()=>void}>).detail
      order.push('compose'); composed.push(detail.text); detail.onReceived?.()
    }
    window.addEventListener('harnessdesk:compose', listen)
    try {
      mount(select)
      await flush()
      const revise = [...container.querySelectorAll('button')].filter(button => button.textContent?.includes('Revise this hunk'))
      expect(revise).toHaveLength(3)
      await act(async () => revise[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      expect(order).toEqual(['select-work', 'compose'])
      expect(select).toHaveBeenCalledTimes(1)
      expect(composed[0]).toContain('Please revise this hunk of docs/guide.md')
      expect(composed[0]).toContain('@@ -1 +1,2 @@')
      expect(composed[0]).toContain('+there')
      expect(composed[0]).not.toContain('diff --git')
      expect(request.mock.calls.every(([method]) => method === 'git/status' || method === 'git/diff')).toBe(true)
    } finally { window.removeEventListener('harnessdesk:compose', listen) }
  })

  it('uses its captured folder instead of the current workspace', async () => {
    request.mockClear()
    mount(() => true, true, '/captured')
    await flush()
    expect(request.mock.calls).toEqual([['git/status', { root: '/captured' }], ['git/diff', { root: '/captured' }]])
  })

  it('an inactive review does not read its folder', async () => {
    request.mockClear()
    mount(() => true, false)
    await flush()
    expect(request).not.toHaveBeenCalled()
  })

  it('renders the canvas, body file index and shared section heads without a window or a redundant return action', async () => {
    mount(() => true)
    await flush()
    expect(container.querySelector('[data-slot="app-window"]')).toBeNull()
    expect(container.querySelector('[data-slot="page"][data-width="canvas"]')).not.toBeNull()
    expect(container.textContent).not.toContain(['Back', 'to', 'app'].join(' '))
    expect(container.querySelector('[data-slot="section-head"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-review-file]')).toHaveLength(2)
    expect(container.querySelector('[data-slot="summary-list"]')?.textContent).toContain('2 files · +3 −1')
  })

  it('reports a missing composer receipt after selecting work without sending a turn', async () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { queueMicrotask(() => callback(0)); return 1 })
    try {
      mount(() => true); await flush()
      const revise = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Revise this hunk…')!
      await act(async()=>{ revise.click(); await new Promise(resolve=>setTimeout(resolve,0)) })
      expect(mountedStore.notice).toHaveBeenCalledWith('warning', 'The message box did not take it — click into the conversation and try again.')
      expect(request.mock.calls.every(([method])=>method==='git/status'||method==='git/diff')).toBe(true)
    } finally { frame.mockRestore() }
  })

  it('late failed reads from a hidden review do not clear its captured data', async () => {
    mount(() => true); await flush()
    const rejects: Array<(error: Error) => void> = []
    request.mockImplementation(() => new Promise((_resolve, reject) => rejects.push(reject)))
    const render = (active: boolean, reviewRoot: string) => <StoreProvider store={mountedStore}><TopBarProvider>
      <DestinationPageScope owner="destination:changes-review" active={active}>
        <ChangesReview root={reviewRoot} returnTo={{kind:'conversation',session:null}} />
      </DestinationPageScope>
      <TopBarOutlet owner="destination:changes-review" fallback={{place:'Fallback',more:()=>null}} />
    </TopBarProvider></StoreProvider>
    try {
      await act(async () => root.render(render(false, '/w')))
      await act(async () => root.render(render(true, '/w')))
      expect(rejects).toHaveLength(2)
      await act(async () => root.render(render(false, '/w')))
      await act(async () => rejects.forEach(reject => reject(new Error('Synthetic late read'))))
      expect(container.textContent).toContain('2 files · +3 −1')
      expect(container.querySelectorAll('[data-review-file]')).toHaveLength(2)
    } finally { request.mockImplementation(answer) }
  })

  it('never exposes an earlier folder’s file actions while a different folder is loading', async () => {
    mount(() => true); await flush()
    request.mockImplementation(() => new Promise(() => {}))
    try {
      await act(async () => root.render(<StoreProvider store={mountedStore}><TopBarProvider>
        <DestinationPageScope owner="destination:changes-review" active>
          <ChangesReview root="/other" returnTo={{kind:'conversation',session:null}} />
        </DestinationPageScope>
      </TopBarProvider></StoreProvider>))
      expect(container.querySelectorAll('[data-review-file]')).toHaveLength(0)
      expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Open')).toBe(false)
      expect(container.textContent).not.toContain('Revise this hunk')
    } finally { request.mockImplementation(answer) }
  })

  it('never offers a working-tree hunk as a staged hunk while the staged read is pending', async () => {
    request.mockImplementation(async (method:string)=>method==='git/status' ? {...STATUS, files:STATUS.files.map(file=>({...file,staged:true}))} : {diff:TREE_DIFF})
    try {
      mount(()=>true);await flush()
      request.mockImplementation((method:string)=>method==='git/status' ? Promise.resolve({...STATUS, files:STATUS.files.map(file=>({...file,staged:true}))}) : new Promise(()=>{}))
      const views=container.querySelector<HTMLButtonElement>('[title="Changes views"]')
      if(views) await act(async()=>views.click())
      const staged=[...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(node => node.textContent === 'Staged')!
      expect(staged).toBeTruthy();await act(async()=>staged.click())
      expect(container.querySelectorAll('[data-level="hunk"]')).toHaveLength(0)
      expect(container.textContent).not.toContain('Revise this hunk')
    } finally {request.mockImplementation(answer)}
  })

  it('a refused work selection leaves the quote in review', async () => {
    const select = vi.fn(() => false), compose = vi.fn()
    window.addEventListener('harnessdesk:compose', compose)
    try {
      mount(select); await flush()
      const revise = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Revise this hunk'))!
      await act(async () => revise.click())
      expect(select).toHaveBeenCalledTimes(1)
      expect(compose).not.toHaveBeenCalled()
    } finally { window.removeEventListener('harnessdesk:compose', compose) }
  })

})

describe('which view a file is in (#180)', () => {
  it('lists a file staged and changed again in each view, and a conflict in the working tree only', async () => {
    request.mockImplementation(async (method: string) =>
      method === 'git/status'
        ? {
            ...STATUS,
            files: [
              { path: 'both.txt', status: 'modified', staged: true },
              { path: 'both.txt', status: 'modified', staged: false },
              { path: 'conflict.txt', status: 'conflicted', staged: false },
              // Staged and not changed since: in the staged view only.
              { path: 'ready.txt', status: 'added', staged: true },
            ],
          }
        : { diff: '' },
    )
    try {
      mount(() => true)
      await flush()
      const working = container.textContent ?? ''
      expect(working).toContain('both.txt')
      expect(working).toContain('conflict.txt')
      expect(working).not.toContain('ready.txt')

      const views = container.querySelector<HTMLButtonElement>('[title="Changes views"]')
      if (views) await act(async () => views.click())
      const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(node => node.textContent === 'Staged')
      expect(tab, 'the Staged tab').toBeTruthy()
      act(() => {
        tab?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
        tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
        tab?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
      })
      await flush()
      const stagedView = container.textContent ?? ''
      expect(stagedView).toContain('both.txt')
      expect(stagedView).toContain('ready.txt')
      expect(stagedView).not.toContain('conflict.txt')
    } finally {
      request.mockImplementation(answer)
    }
  })
})
