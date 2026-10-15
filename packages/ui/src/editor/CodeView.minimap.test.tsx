import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { undo, undoDepth } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CodeView, type CodeViewProps } from './CodeView'
import { MergeView } from './MergeView'

const loading = vi.hoisted(() => {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  return { started: vi.fn(), ready, release: () => release() }
})
vi.mock('@replit/codemirror-minimap', async importOriginal => {
  loading.started()
  await loading.ready
  return importOriginal()
})
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(() => {
  // The real extension owns the DOM/lifecycle; pixel drawing is verified in Chromium.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})
const render = async (merge = false, props: Partial<CodeViewProps> = {}) => {
  const common = { value: 'first\nsecond\nthird\n', dark: false, look: { fontFamily: 'monospace', fontSize: 13, lineHeight: 1.55 }, ...props }
  await act(async () => root.render(merge ? <MergeView {...common} original="old\nsecond\nthird\n" /> : <CodeView {...common} />))
  return EditorView.findFromDOM(host.querySelector('.cm-content')!)!
}

it('loads nothing when off and ignores a late import after the preference is switched off', async () => {
  await render()
  expect(loading.started).not.toHaveBeenCalled()
  expect(host.querySelector('.cm-minimap-gutter')).toBeNull()
  await render(false, { minimap: true })
  await vi.waitFor(() => expect(loading.started).toHaveBeenCalledOnce())
  await render(false, { minimap: false })
  await act(async () => { loading.release(); await loading.ready })
  // Drain the dynamic module result before checking the cancelled request.
  await import('@replit/codemirror-minimap')
  await act(async () => {})
  expect(host.querySelector('.cm-minimap-gutter')).toBeNull()
})

it.each([false, true])('toggles the real minimap without remounting or losing an edit in merge=%s', async merge => {
  const view = await render(merge)
  const onChange = vi.fn()
  await act(async () => view.dispatch({ changes: { from: 0, insert: 'my ' }, selection: { anchor: 6 } }))
  const edited = view.state.doc.toString()
  view.scrollDOM.scrollTop = 24
  openSearchPanel(view)
  const depth = undoDepth(view.state)
  for (const minimap of [true, false, true, false]) {
    await render(merge, { value: edited, minimap, onChange })
    await vi.waitFor(() => expect(Boolean(host.querySelector('.cm-minimap-gutter'))).toBe(minimap))
    expect(EditorView.findFromDOM(host.querySelector('.cm-content')!)).toBe(view)
    expect(view.state.doc.toString()).toBe(edited)
    expect(view.state.selection.main.anchor).toBe(6)
    expect(view.scrollDOM.scrollTop).toBe(24)
    expect(undoDepth(view.state)).toBe(depth)
    expect(host.querySelector('input[name="search"]')).not.toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  }
  await act(async () => { undo(view) })
  expect(view.state.doc.toString()).toBe('first\nsecond\nthird\n')
})

it('removes the exact global mouse listeners registered by the minimap when disabled', async () => {
  const add = vi.spyOn(window, 'addEventListener')
  const remove = vi.spyOn(window, 'removeEventListener')
  await render(false, { minimap: true })
  await vi.waitFor(() => expect(host.querySelector('.cm-minimap-gutter')).not.toBeNull())
  const listeners = add.mock.calls.filter(([name]) => name === 'mouseup' || name === 'mousemove')
  expect(listeners).toHaveLength(2)
  await render(false, { minimap: false })
  for (const [name, listener] of listeners) expect(remove.mock.calls.some(([removedName, removedListener]) => removedName === name && removedListener === listener)).toBe(true)
})

it('cancels the two queued minimap scroll frames when disabled', async () => {
  const view = await render(false, { minimap: true })
  await vi.waitFor(() => expect(host.querySelector('.cm-minimap-gutter')).not.toBeNull())
  let frame = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => ++frame)
  const cancel = vi.spyOn(window, 'cancelAnimationFrame')
  view.scrollDOM.dispatchEvent(new Event('scroll'))
  expect(frame).toBeGreaterThanOrEqual(2)
  await render(false, { minimap: false })
  const cancelled = new Set(cancel.mock.calls.map(([id]) => id))
  expect([...cancelled].filter(id => id > 0 && id <= frame)).toHaveLength(2)
})
