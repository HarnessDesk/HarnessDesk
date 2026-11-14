import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Decoration, EditorView } from '@codemirror/view'
import { StateEffect } from '@codemirror/state'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId, type SessionKey } from '@harnessdesk/protocol'
import { PaneProvider, StoreProvider } from '../state/context'
import { SelectionAction } from '../design'
import { emptySnapshot, type AppStore } from '../state/store'
import { FileView } from './FileView'
import { handOverToComposer } from '../lib/compose'

vi.mock('../design/patterns/SelectionAction', async importOriginal => {
  const design = await importOriginal<typeof import('../design/patterns/SelectionAction')>()
  return { ...design, SelectionAction: vi.fn(design.SelectionAction) }
})
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
  vi.mocked(SelectionAction).mockClear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue(new DOMRect(100, 100, 30, 20))
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 30, 20))
})
afterEach(() => { act(() => root.unmount()); container.remove(); document.getSelection()?.removeAllRanges(); vi.restoreAllMocks() })
it.each([false, true].flatMap(previous => ['removed', 'document', 'collapsed'].map(owner => ({ previous, owner }))))('retains removed ownership across redraws until a new document selection ($previous, $owner)', async ({ previous, owner }) => {
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
  await act(async () => {
    view.dispatch({})
    view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.decorations.of(Decoration.none)) })
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'draft' } })
    // jsdom does not draw the engine selection: reproduce the browser redraw.
    const restored = document.createRange()
    restored.selectNodeContents(container.querySelector('.cm-line')!)
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(restored)
    document.dispatchEvent(new Event('selectionchange'))
    view.scrollDOM.dispatchEvent(new Event('scroll'))
  })
  if (owner !== 'removed') {
    await act(async () => view.dispatch({ selection: { anchor: 0, head: owner === 'document' ? 5 : 0 } }))
    if (owner === 'collapsed') { expect(button()).toBeFalsy(); return }
  }
  expect(button()).toBeTruthy()
  await act(async () => button()!.click())
  expect(handOverToComposer).toHaveBeenCalledWith({ paneId: 'main', sessionKey: session, text: `auth.ts:1\n\`\`\`typescript\n${owner === 'document' ? 'after' : 'before'}\n\`\`\`\n` })
})

it('keeps the Ask rect when the selected removed widget is detached', async () => {
  await act(async () => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'main', view: { kind: 'conversation', session }, sessionKey: session }}>
    <FileView path="/work/auth.ts" runtime={runtimeId('fake')} root="/work" subject={`session:${session}`} view="changes" />
  </PaneProvider></StoreProvider>))
  await vi.waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull())
  const view = EditorView.findFromDOM(container.querySelector('.cm-content')!)!
  const deleted = container.querySelector('.cm-deletedText')!
  const range = document.createRange(); range.selectNodeContents(deleted)
  await act(async () => {
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  const before = vi.mocked(SelectionAction).mock.lastCall![0].rect
  expect(before.toJSON()).toMatchObject({ x: 100, y: 100, width: 30, height: 20 })
  // Native live ranges collapse onto the parent when their widget is removed.
  vi.mocked(Range.prototype.getBoundingClientRect).mockImplementation(function (this: Range) {
    return this.collapsed || !this.startContainer.isConnected || !this.endContainer.isConnected ? new DOMRect() : before
  })
  await act(async () => {
    deleted.remove()
    view.scrollDOM.dispatchEvent(new Event('scroll'))
  })
  expect(deleted.isConnected).toBe(false)
  expect(vi.mocked(SelectionAction).mock.lastCall![0].rect).toBe(before)
  const button = [...document.querySelectorAll('button')].find(one => one.textContent === 'Ask in chat ⌘L')!
  await act(async () => button.click())
  expect(handOverToComposer).toHaveBeenCalledWith({ paneId: 'main', sessionKey: session, text: 'auth.ts:1\n```typescript\nbefore\n```\n' })
})
