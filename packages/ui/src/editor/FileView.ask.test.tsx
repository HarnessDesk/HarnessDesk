import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId, type SessionKey } from '@harnessdesk/protocol'
import { KeyboardHereContext, PaneProvider, StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { FileView } from './FileView'
import { requestAskInChat } from './ask'
import { handOverToComposer } from '../lib/compose'

vi.mock('../lib/compose', () => ({ handOverToComposer: vi.fn(async () => true) }))
vi.mock('./head', () => ({ readHead: vi.fn(async () => ({ content: 'previous', status: 'tracked' })) }))
vi.mock('./CodeView', () => ({ CodeView: ({ value, onSelection }: any) => <button data-editor onClick={() => onSelection?.({ source: value, from: 0, to: 3, rect: new DOMRect(100, 100, 20, 20) })}>Select source</button> }))
vi.mock('./MergeView', () => ({ MergeView: ({ value, onSelection }: any) => <button data-editor onClick={() => onSelection?.({ source: value, from: 0, to: 3, rect: new DOMRect(100, 100, 20, 20) })}>Select change</button> }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, container: HTMLDivElement, store: AppStore
let request: ReturnType<typeof vi.fn>
const snapshot = emptySnapshot(), session = 'fake:one' as SessionKey
Object.assign(snapshot.workbench.main, { root: { kind: 'pane', id: 'main', view: { kind: 'conversation', session } }, focused: 'main' })
beforeEach(() => {
  vi.mocked(handOverToComposer).mockClear()
  request = vi.fn(async (method: string) => method === 'workspace/readFile' ? { kind: 'text', content: 'one\ntwo', hash: 'hash', truncated: false } : { modifiedAt: 1 })
  store = { getSnapshot: () => snapshot, subscribe: () => () => {}, transport: { request }, chooseWorkTool: vi.fn(), focusPane: vi.fn(), notice: vi.fn() } as unknown as AppStore
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(100, 100, 30, 20) })
})
afterEach(() => { act(() => root.unmount()); container.remove(); document.getSelection()?.removeAllRanges() })
const mount = async (view: 'source' | 'changes' | 'preview' = 'source', visible = true) => {
  await act(async () => root.render(<StoreProvider store={store}><KeyboardHereContext.Provider value={visible ? null : false}><PaneProvider scope={{ paneId: 'main', view: { kind: 'conversation', session }, sessionKey: session }}><FileView path={view === 'preview' ? '/work/README.md' : '/work/auth.ts'} runtime={runtimeId('fake')} root="/work" subject={`session:${session}`} view={view} /></PaneProvider></KeyboardHereContext.Provider></StoreProvider>))
}
const find = (text: string) => [...document.querySelectorAll('button')].find(one => one.textContent === text)!
it.each(['source', 'changes'] as const)('shows Ask for %s selection and inserts its quote through the owning conversation', async view => {
  await mount(view)
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-editor]')!.focus(); container.querySelector<HTMLButtonElement>('[data-editor]')!.click() })
  expect(find('Ask in chat ⌘L')).toBeTruthy()
  await act(async () => find('Ask in chat ⌘L').click())
  expect(handOverToComposer).toHaveBeenCalledWith({ paneId: 'main', sessionKey: session, text: 'auth.ts:1\n```typescript\none\n```\n' })
  expect(store.chooseWorkTool).toHaveBeenCalledWith('conversation')
  expect(request.mock.calls.map(([method]) => method)).not.toContain('turn/start')
})
it('uses the shared shortcut once and refuses a stale retained selection from another composer', async () => {
  await mount()
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-editor]')!.focus(); container.querySelector<HTMLButtonElement>('[data-editor]')!.click() })
  await act(async () => expect(requestAskInChat()).toBe(true))
  expect(handOverToComposer).toHaveBeenCalledOnce()
  const composer = document.createElement('textarea'); document.body.append(composer); await act(async () => composer.focus())
  await act(async () => expect(requestAskInChat()).toBe(false))
  expect(handOverToComposer).toHaveBeenCalledOnce(); composer.remove()
})
it('quotes a Preview selection and removes the action when the selection leaves the file', async () => {
  await mount('preview')
  const node = container.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 3)
  await act(async () => { document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange')) })
  expect(find('Ask in chat ⌘L')).toBeTruthy()
  await act(async () => find('Ask in chat ⌘L').click())
  expect(handOverToComposer).toHaveBeenCalledWith({ paneId: 'main', sessionKey: session, text: 'README.md:1\n```markdown\none\n```\n' })
  await act(async () => { document.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  expect(find('Ask in chat ⌘L')).toBeUndefined()
})

it('does not leave a selection action floating over a hidden retained file', async () => {
  await mount()
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-editor]')!.focus(); container.querySelector<HTMLButtonElement>('[data-editor]')!.click() })
  expect(find('Ask in chat ⌘L')).toBeTruthy()
  await mount('source', false)
  expect(find('Ask in chat ⌘L')).toBeUndefined()
  await act(async () => expect(requestAskInChat()).toBe(false))
  expect(handOverToComposer).not.toHaveBeenCalled()
})

it('does not consume an old file selection after the main pane changes conversation', async () => {
  await mount()
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-editor]')!.focus(); container.querySelector<HTMLButtonElement>('[data-editor]')!.click() })
  const main = snapshot.workbench.main.root
  if (main.kind !== 'pane') throw new Error('expected main pane')
  const before = main.view
  try {
    Object.assign(main, { view: { kind: 'conversation', session: 'fake:other' } })
    await act(async () => expect(requestAskInChat()).toBe(false))
    expect(handOverToComposer).not.toHaveBeenCalled()
  } finally { Object.assign(main, { view: before }) }
})
