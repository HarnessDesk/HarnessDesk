import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NO_CAPABILITIES, runtimeId, sessionId, sessionKey, type HistoryImportState, type HistorySummary, type RuntimeInfo, type Session } from '@harnessdesk/protocol'
import { DestinationPageScope } from '../panels/destination-page'
import { StoreProvider } from '../state/context'
import { AppStore, emptySnapshot } from '../state/store'
import '../panels/builtins'
import { AgentHistory, HistorySection } from './History'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const info: RuntimeInfo = { id: runtimeId('alpha'), name: 'Alpha', presentation: { name: 'Alpha' }, capabilities: { ...NO_CAPABILITIES, listHistory: true } }
const row = (id: string, patch: Partial<HistorySummary> = {}): HistorySummary => ({ runtime: info.id, id: sessionId(id), title: id, cwd: '/preview/project', repo: { root: '/preview/project', worktree: false }, preview: null, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2, hidden: false, ...patch })
const done: HistoryImportState = { state: 'done', count: 2000, importedAt: 1, lastScanAt: 2 }
let root: Root
let box: HTMLDivElement
let request: ReturnType<typeof vi.fn>
let own: AppStore
let onBrowse: ReturnType<typeof vi.fn<(id: string) => void>>
let onOpen: ReturnType<typeof vi.fn<() => void>>
let onOpenAgent: ReturnType<typeof vi.fn<(id: string) => void>>
const button = (name: string) => [...box.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent?.trim() === name)!
const input = (label: string, value: string) => act(() => {
  const field = box.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
})
const mount = async (state: HistoryImportState | null = done, agent = false, rows = [row('Imported')]) => {
  const snapshot = { ...emptySnapshot(), runtimes: [info], historyImports: { [info.id]: state } }
  request = vi.fn(async (method: string) => method === 'history/list' ? { data: rows, nextCursor: null } : null)
  own = { getSnapshot: () => snapshot, subscribe: () => () => {}, loadHistoryImport: vi.fn(async () => {}), transport: { request }, openSession: vi.fn(async () => true), showViewIn: vi.fn() } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={own}>{agent ? <AgentHistory info={info} onBrowse={onBrowse} /> : <HistorySection onOpen={onOpen} onOpenAgent={onOpenAgent} />}</StoreProvider>))
}
beforeEach(() => { box = document.createElement('div'); document.body.append(box); root = createRoot(box); onBrowse = vi.fn(); onOpen = vi.fn(); onOpenAgent = vi.fn() })
afterEach(() => { act(() => root.unmount()); box.remove() })

it('queries titles and hidden rows on the host and opens a preview', async () => {
  await mount()
  expect(request).toHaveBeenCalledWith('history/list', { pageSize: 100, includeHidden: false })
  input('Search history titles', '100%_')
  await act(async () => {})
  expect(request).toHaveBeenLastCalledWith('history/list', { pageSize: 100, includeHidden: false, query: '100%_' })
  await act(async () => box.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
  expect(request).toHaveBeenLastCalledWith('history/list', { pageSize: 100, includeHidden: true, query: '100%_' })
  await act(async () => button('Imported').click())
  expect(own.openSession).toHaveBeenCalledWith(sessionId('Imported'), { runtime: info.id, preview: true, reveal: false, preserveLayoutOnReadFailure: true })
  expect(onOpen).toHaveBeenCalled()
})

it('sends agent and project filters, then pages when scrolled near the end', async () => {
  await mount()
  const choose = async (label: string, value: string) => act(async () => {
    const select = box.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
    select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await choose('History agent', info.id)
  expect(request).toHaveBeenLastCalledWith('history/list', { pageSize: 100, includeHidden: false, runtimes: [info.id] })
  await choose('History project', '/preview/project')
  expect(request).toHaveBeenLastCalledWith('history/list', { pageSize: 100, includeHidden: false, runtimes: [info.id], repoRoot: '/preview/project' })
  request.mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, i) => row(`Row ${i}`)), nextCursor: 'next' })
  input('Search history titles', 'Row')
  await act(async () => {})
  expect(box.querySelectorAll('[data-slot="table-row"]')).toHaveLength(16)
  const scroll = box.querySelector<HTMLElement>('[data-history-scroll]')!
  Object.defineProperty(scroll, 'scrollTop', { configurable: true, value: 4000 })
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 440 })
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 4450 })
  request.mockResolvedValueOnce({ data: [row('Next page')], nextCursor: null })
  await act(async () => scroll.dispatchEvent(new Event('scroll', { bubbles: true })))
  expect(request).toHaveBeenLastCalledWith('history/list', { pageSize: 100, includeHidden: false, runtimes: [info.id], repoRoot: '/preview/project', query: 'Row', cursor: 'next' })
})

it('points an empty import to its agent page and shows Archived on one line', async () => {
  await mount(null, false, [])
  expect(box.textContent).toContain('Import history from an agent’s settings page.')
  act(() => button('Alpha').click())
  expect(onOpenAgent).toHaveBeenCalledWith(info.id)
  await mount(done, false, [row('Filed', { archived: true })])
  expect(box.textContent).toContain('Archived')
  expect(box.querySelector('[data-slot="row-desc"]')).toBeNull()
})

it.each([
  [null, 'Import history', 'history/import'],
  [{ ...done, state: 'running' }, 'Cancel', 'history/cancel'],
  [done, 'Rescan', 'history/import'],
  [{ ...done, state: 'failed', error: 'Listing refused' }, 'Retry', 'history/import'],
] as const)('draws the import state and its action: %s', async (state, label, method) => {
  await mount(state as HistoryImportState | null, true)
  expect(button(label)).toBeTruthy()
  await act(async () => button(label).click())
  expect(request).toHaveBeenCalledWith(method, { runtime: info.id })
  if (state?.state === 'failed') expect(box.querySelector('[title="Listing refused"]')).not.toBeNull()
})

it('browses the agent filter and confirms removing only the imported records', async () => {
  await mount(done, true)
  act(() => button('Browse').click())
  expect(onBrowse).toHaveBeenCalledWith(info.id)
  act(() => button('Remove imported').click())
  expect(document.body.textContent).toContain('Alpha’s own files stay as they are.')
  await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(el => el.textContent === 'Remove imported')!.click())
  expect(request).toHaveBeenCalledWith('history/removeImported', { runtime: info.id })
})

it('discards a stale page after a new title query', async () => {
  await mount()
  let resolve!: (page: unknown) => void
  request.mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
  input('Search history titles', 'old')
  await act(async () => {})
  request.mockResolvedValueOnce({ data: [row('Current')], nextCursor: null })
  input('Search history titles', 'new')
  await act(async () => {})
  await act(async () => resolve({ data: [row('Stale')], nextCursor: 'wrong' }))
  expect(box.textContent).toContain('Current')
  expect(box.textContent).not.toContain('Stale')
})

it('rescans imported agents at open and focus but never starts a first import', async () => {
  await mount()
  expect(request).toHaveBeenCalledWith('history/import', { runtime: info.id })
  request.mockClear()
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(request).toHaveBeenCalledWith('history/import', { runtime: info.id })
  expect(request).toHaveBeenCalledWith('history/list', { pageSize: 100, includeHidden: false })
  await act(async () => root.unmount())
  root = createRoot(box)
  await mount(null)
  expect(request).not.toHaveBeenCalledWith('history/import', { runtime: info.id })
})

it('does not draw history on a runtime sharing another account’s store', async () => {
  await mount(null, true)
  await act(async () => root.render(<StoreProvider store={own}><AgentHistory info={{ ...info, capabilities: { ...info.capabilities, listHistory: false } }} onBrowse={onBrowse} /></StoreProvider>))
  expect(box.textContent).toBe('')
})


it.each(['index', 'focus'] as const)('keeps loaded pages and scroll while refreshing after %s', async (trigger) => {
  const store = new AppStore('ws://localhost:0/')
  const first = Array.from({ length: 100 }, (_, i) => row(`First ${i}`))
  const second = Array.from({ length: 100 }, (_, i) => row(`Second ${i}`))
  const listing = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { cursor?: string; pageSize?: number }) => {
    if (method !== 'history/list') return null
    if (params.cursor === 'second') return { data: second, nextCursor: 'third' }
    return { data: first, nextCursor: 'second' }
  }) as never)
  await act(async () => root.render(<StoreProvider store={store}><HistorySection onOpen={onOpen} onOpenAgent={onOpenAgent} /></StoreProvider>))
  const scroll = box.querySelector<HTMLDivElement>('[data-history-scroll]')!
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 440 })
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 4400 })
  scroll.scrollTop = 4000
  await act(async () => scroll.dispatchEvent(new Event('scroll', { bubbles: true })))
  expect(box.querySelector('table')?.getAttribute('aria-rowcount')).toBe('201')
  scroll.scrollTop = 4800
  // Defer refresh so the previous pages must stay mounted while reading.
  let resolve!: (page: { data: HistorySummary[]; nextCursor: string | null }) => void
  listing.mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
  await act(async () => {
    if (trigger === 'focus') window.dispatchEvent(new Event('focus'))
    else (store.transport as unknown as { handlers: { onNotification(value: unknown): void } }).handlers.onNotification({ method: 'session/indexChanged', params: { upserted: [], removed: [] } })
  })
  await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  expect(box.querySelector('[data-history-scroll]')).toBe(scroll)
  expect(scroll.scrollTop).toBe(4800)
  expect(box.querySelector('table')?.getAttribute('aria-rowcount')).toBe('201')
  await act(async () => resolve({ data: first, nextCursor: 'second' }))
  expect(box.querySelector('table')?.getAttribute('aria-rowcount')).toBe('201')
  expect(scroll.scrollTop).toBe(4800)
  listing.mockResolvedValueOnce({ data: [row('Third page')], nextCursor: null })
  await act(async () => scroll.dispatchEvent(new Event('scroll', { bubbles: true })))
  expect(listing).toHaveBeenLastCalledWith('history/list', { pageSize: 100, includeHidden: false, cursor: 'third' })
  input('Search history titles', 'new filter')
  await act(async () => {})
  expect(box.querySelector<HTMLDivElement>('[data-history-scroll]')?.scrollTop).toBe(0)
})


it('hides with the landed Remove and Undo path without opening the preview', async () => {
  const store = new AppStore('ws://localhost:0/')
  let removed = false
  const spy = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { removed?: boolean; includeHidden?: boolean }) => {
    if (method === 'history/list') return { data: removed && !params.includeHidden ? [] : [row('Imported', { hidden: removed })], nextCursor: null }
    if (method === 'session/remove') {
      removed = params.removed === true
      ;(store.transport as unknown as { handlers: { onNotification(value: unknown): void } }).handlers.onNotification({ method: 'session/indexChanged', params: { upserted: [], removed: [{ runtime: info.id, id: sessionId('Imported') }] } })
      return { undoUntil: Date.now() + 8000 }
    }
    return null
  }) as never)
  const open = vi.spyOn(store, 'openSession')
  await act(async () => root.render(<StoreProvider store={store}><HistorySection onOpen={onOpen} onOpenAgent={onOpenAgent} /></StoreProvider>))
  const actions = box.querySelector<HTMLButtonElement>('[aria-label="Imported actions"]')
  expect(actions).not.toBeNull()
  await act(async () => actions!.click())
  const hide = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent === 'Hide from HarnessDesk')!
  await act(async () => hide.click())
  await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  expect(spy).toHaveBeenCalledWith('session/remove', { runtime: info.id, sessionId: sessionId('Imported'), removed: true })
  expect(box.textContent).not.toContain('Imported')
  expect(open).not.toHaveBeenCalled()
  const notice = store.getSnapshot().notices.at(-1)!
  expect(notice.action?.label).toBe('Undo')
  await act(async () => notice.action!.run())
  await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  expect(spy).toHaveBeenCalledWith('session/remove', { runtime: info.id, sessionId: sessionId('Imported'), removed: false })
  expect(box.textContent).toContain('Imported')
})

it.each(['trash', 'erase', false] as const)('uses the declared delete disposition (%s)', async (disposition) => {
  await mount()
  const snapshot = own.getSnapshot()
  const configured = { ...snapshot, runtimes: [{ ...info, capabilities: { ...info.capabilities, deleteHistory: disposition } }] }
  own.getSnapshot = () => configured
  own.deleteSession = vi.fn(async () => ({ disposition: 'trash' })) as unknown as AppStore['deleteSession']
  own.notice = vi.fn()
  await act(async () => root.render(<StoreProvider store={own}><HistorySection onOpen={onOpen} onOpenAgent={onOpenAgent} /></StoreProvider>))
  const actions = box.querySelector<HTMLButtonElement>('[aria-label="Imported actions"]')
  expect(actions).not.toBeNull()
  await act(async () => actions!.click())
  const deletion = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(el => el.querySelector('[data-menu-label]')?.textContent === 'Delete everywhere…')!
  expect(deletion.getAttribute('aria-disabled') === 'true').toBe(disposition !== 'trash')
  if (disposition !== 'trash') {
    const reason = disposition === 'erase' ? 'Alpha erases it for good, so delete it there' : 'Alpha keeps no way to delete one.'
    expect(deletion.title).toBe(reason)
    expect(deletion.querySelector('[data-menu-hint]')?.textContent).toBe(reason)
  } else {
    await act(async () => deletion.click())
    expect(document.body.textContent).toContain('Delete "Imported" everywhere?')
    expect(own.deleteSession).not.toHaveBeenCalled()
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(el => el.textContent === 'Move to Trash')!.click())
    expect(own.deleteSession).toHaveBeenCalledWith(sessionId('Imported'), info.id)
  }
  expect(own.openSession).not.toHaveBeenCalled()
})


it('omits Hide for a row already hidden', async () => {
  await mount(done, false, [row('Hidden import', { hidden: true })])
  await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="Hidden import actions"]')!.click())
  expect([...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].some(el => el.textContent === 'Hide from HarnessDesk')).toBe(false)
  expect(document.body.textContent).toContain('Delete everywhere…')
})

const pendingSession = () => {
  let resolve!: (value: Session) => void, reject!: (error: Error) => void
  const promise=new Promise<Session>((yes,no)=>{resolve=yes;reject=no})
  return {promise,resolve,reject}
}
it.each(['refused','success','refresh','hidden'] as const)('a real history read %s preserves destination until a successful current click',async(outcome)=>{
  const store=new AppStore('ws://localhost:0/'),pending=pendingSession()
  const imported:Session={...row('Imported'),status:{type:'idle'},turns:[],itemsLoaded:true}
  Object.assign(store.getSnapshot(),{runtimes:[info]})
  store.openDestination({kind:'settings',route:{kind:'section',section:'history',focus:null}})
  const selected=store.getSnapshot().workbench.navigation.current
  const listing=vi.spyOn(store.transport,'request').mockImplementation((async(method:string)=>{
    if(method==='history/list')return {data:[row('Imported')],nextCursor:null}
    if(method==='session/read')return pending.promise
    if(method==='session/resume')return imported
    return null
  }) as never)
  const render=(active:boolean)=>act(async()=>root.render(<StoreProvider store={store}><DestinationPageScope owner="destination:settings" active={active}><HistorySection onOpen={onOpen} onOpenAgent={onOpenAgent}/></DestinationPageScope></StoreProvider>))
  await render(true)
  act(()=>button('Imported').click())
  expect(store.getSnapshot().workbench.navigation.current).toBe(selected)
  expect(onOpen).not.toHaveBeenCalled()
  if(outcome==='refresh')await act(async()=>window.dispatchEvent(new Event('focus')))
  if(outcome==='hidden'){await render(false);store.openDestination({kind:'settings',route:{kind:'section',section:'general',focus:null}})}
  await act(async()=>outcome==='refused'?pending.reject(new Error('Read refused')):pending.resolve(imported))
  if(outcome==='success'||outcome==='refresh'){
    expect(store.getSnapshot().notices.map(one=>one.message)).toEqual([])
    expect(listing).toHaveBeenCalledWith('session/resume',{runtime:info.id,sessionId:sessionId('Imported')})
    expect(store.getSnapshot().workbench.navigation.current).toEqual({kind:'work',view:{kind:'conversation',session:sessionKey(info.id,'Imported')}})
    expect(onOpen).toHaveBeenCalledTimes(1)
  }else{
    expect(store.getSnapshot().workbench.navigation.current.kind).toBe('settings')
    expect(onOpen).not.toHaveBeenCalled()
  }
  expect(listing).toHaveBeenCalledWith('session/read',{runtime:info.id,sessionId:sessionId('Imported')})
})

it('retains the chosen agent and scroll when its destination leaves and returns',async()=>{
  await mount(done,false,Array.from({length:100},(_,i)=>row(`Row ${i}`)))
  const render=(active:boolean)=>act(async()=>root.render(<StoreProvider store={own}><DestinationPageScope owner="destination:settings" active={active}><HistorySection onOpen={onOpen} onOpenAgent={onOpenAgent}/></DestinationPageScope></StoreProvider>))
  await render(true)
  await act(async()=>{const select=box.querySelector<HTMLSelectElement>('select[aria-label="History agent"]')!;select.value=info.id;select.dispatchEvent(new Event('change',{bubbles:true}))})
  const viewport=box.querySelector<HTMLElement>('[data-history-scroll]')!;viewport.scrollTop=1200
  await act(async()=>viewport.dispatchEvent(new Event('scroll',{bubbles:true})))
  await render(false);await render(true)
  expect(box.querySelector<HTMLSelectElement>('select[aria-label="History agent"]')!.value).toBe(info.id)
  expect(box.querySelector('[data-history-scroll]')).toBe(viewport);expect(viewport.scrollTop).toBe(1200)
  expect(request.mock.calls.filter(call=>call[0]==='history/list').at(-1)).toEqual(['history/list',{pageSize:100,includeHidden:false,runtimes:[info.id]}])
})
