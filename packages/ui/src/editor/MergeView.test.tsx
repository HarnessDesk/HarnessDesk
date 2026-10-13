import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { getOriginalDoc } from '@codemirror/merge'
import { openSearchPanel } from '@codemirror/search'
import { diagnosticCount } from '@codemirror/lint'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as editor from './index'
import { MergeView } from './MergeView'

vi.hoisted(() => Object.defineProperty(window.navigator, 'platform', { configurable: true, value: 'MacIntel' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
const appearance = { fontFamily: 'monospace', fontSize: 14, lineHeight: 1.5 }
const mount = async (props: Partial<editor.MergeViewProps> = {}) => {
  await act(async () => root.render(<MergeView original={'before\nkeep\n'} value={'after\nkeep\n'} path="file.ts" dark={false} look={appearance} {...props} />))
  const content = container.querySelector<HTMLElement>('.cm-content')!
  expect(content).not.toBeNull()
  return EditorView.findFromDOM(content)!
}

it('renders an editable unified merge and reports real edits and line counts', async () => {
  const onChange = vi.fn()
  const onCountsChange = vi.fn()
  const onSave = vi.fn()
  const view = await mount({ onChange, onCountsChange, onSave, decorations: [{ fromLine: 1, severity: 'warning', message: 'Check the change' }] })
  expect(getOriginalDoc(view.state).toString()).toBe('before\nkeep\n')
  expect(container.querySelector('.cm-deletedChunk')?.textContent).toContain('before')
  expect(onCountsChange).toHaveBeenLastCalledWith({ added: 1, removed: 1 })
  expect(diagnosticCount(view.state)).toBe(1)
  expect(onChange).not.toHaveBeenCalled()
  await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: 'extra\n' } }))
  expect(onChange).toHaveBeenLastCalledWith('after\nkeep\nextra\n')
  expect(onCountsChange).toHaveBeenLastCalledWith({ added: 2, removed: 1 })
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }))
  expect(onSave).toHaveBeenCalledOnce()
  expect(container.querySelector('.cm-chunkButtons')).toBeNull()
})

it('reconfigures original and external value without recreating the editor or marking dirty', async () => {
  const onChange = vi.fn()
  const onCountsChange = vi.fn()
  const view = await mount({ onChange, onCountsChange })
  view.dispatch({ selection: { anchor: 3 } })
  await mount({ original: 'after\nkeep\n', onChange, onCountsChange, dark: true, wrap: true })
  expect(EditorView.findFromDOM(container.querySelector('.cm-content')!)).toBe(view)
  expect(view.state.selection.main.anchor).toBe(3)
  expect(getOriginalDoc(view.state).toString()).toBe('after\nkeep\n')
  expect(onCountsChange).toHaveBeenLastCalledWith({ added: 0, removed: 0 })
  await mount({ original: 'reset\n', value: 'reset\n', onChange, onCountsChange })
  expect(view.state.doc.toString()).toBe('reset\n')
  expect(onChange).not.toHaveBeenCalled()
})

it.each(['g', 'l', 'k'])('keeps the app chord Command %s from merge content and search', async (key) => {
  const view = await mount()
  openSearchPanel(view)
  const search = container.querySelector<HTMLInputElement>('input[name="search"]')!
  for (const target of [view.contentDOM, search]) {
    const before = view.state.selection.toJSON()
    const event = new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(view.state.selection.toJSON()).toEqual(before)
  }
})

it('reports the selected current-document offsets and clears an empty selection', async () => {
  const onSelection = vi.fn()
  const view = await mount({ onSelection } as any)
  await act(async () => view.dispatch({ selection: { anchor: 0, head: 6 } }))
  expect(onSelection).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'after\nkeep\n', from: 0, to: 6 }))
  await act(async () => view.dispatch({ selection: { anchor: 6 } }))
  expect(onSelection).toHaveBeenLastCalledWith(null)
})
