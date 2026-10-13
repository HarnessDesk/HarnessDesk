import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId, type SessionKey } from '@harnessdesk/protocol'
import { PaneProvider, StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { FileView } from './FileView'
import { handOverToComposer } from '../lib/compose'

vi.mock('../lib/compose', () => ({ handOverToComposer: vi.fn(async () => true) }))
vi.mock('./head', () => ({ readHead: vi.fn(async () => ({ content: 'before\nkeep\n', status: 'tracked' })) }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, container: HTMLDivElement
const snapshot = emptySnapshot(), session = 'fake:one' as SessionKey
Object.assign(snapshot.workbench.main, { root: { kind: 'pane', id: 'main', view: { kind: 'conversation', session } }, focused: 'main' })
const store = {
  getSnapshot: () => snapshot, subscribe: () => () => {},
  transport: { request: vi.fn(async (method: string) => method === 'workspace/readFile'
    ? { kind: 'text', content: 'after\nkeep\n', hash: 'hash', truncated: false } : { modifiedAt: 1 }) },
  chooseWorkTool: vi.fn(), focusPane: vi.fn(), notice: vi.fn(),
} as unknown as AppStore
beforeEach(async () => {
  await import('./MergeView')
  vi.mocked(handOverToComposer).mockClear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 30, 20))
})
afterEach(() => { act(() => root.unmount()); container.remove(); document.getSelection()?.removeAllRanges(); vi.restoreAllMocks() })
it.each([false, true])('preserves removed text and its original lines after scrolling (previous current selection: %s)', async previous => {
  await act(async () => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'main', view: { kind: 'conversation', session }, sessionKey: session }}>
    <FileView path="/work/auth.ts" runtime={runtimeId('fake')} root="/work" subject={`session:${session}`} view="changes" />
  </PaneProvider></StoreProvider>))
  // Wait for the lazy shared engine, not a synthetic stand-in.
  await vi.waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull())
  const view = EditorView.findFromDOM(container.querySelector('.cm-content')!)!
  if (previous) await act(async () => view.dispatch({ selection: { anchor: 6, head: 10 } }))
  const deleted = container.querySelector('.cm-deletedText')!
  expect(deleted.textContent).toBe('before')
  const range = document.createRange(); range.selectNodeContents(deleted)
  await act(async () => {
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  const button = () => [...document.querySelectorAll('button')].find(one => one.textContent === 'Ask in chat ⌘L')
  expect(button()).toBeTruthy()
  expect(view.state.selection.main.empty).toBe(!previous)
  await act(async () => view.scrollDOM.dispatchEvent(new Event('scroll')))
  expect(button()).toBeTruthy()
  await act(async () => button()!.click())
  expect(handOverToComposer).toHaveBeenCalledWith({ paneId: 'main', sessionKey: session, text: 'auth.ts:1\n```typescript\nbefore\n```\n' })
})
