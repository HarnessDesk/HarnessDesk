import { act } from 'react'
import { EditorView } from '@codemirror/view'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { CodeView } from './CodeView'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
it('selects, marks and scrolls to a linked line once, then preserves the user selection on edits', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const target = { line: 3, request: 1 }, reached = vi.fn()
  const draw = async (lineTarget = target, value = 'one\ntwo\nthree\nfour') => act(async () => root.render(<CodeView {...{ lineTarget, onLineTargetReached: reached } as any} value={value} dark={false} look={{ fontFamily: 'monospace', fontSize: 13, lineHeight: 1.5 }} />))
  try {
    await draw(); const view = EditorView.findFromDOM(host.querySelector('.cm-content')!)!
    expect(view.state.selection.main.from).toBe(view.state.doc.line(3).from)
    expect(host.querySelector('.cm-linkedLine')?.textContent).toBe('three')
    expect(reached).toHaveBeenCalledExactlyOnceWith(1)
    view.dispatch({ selection: { anchor: 0 } }); await draw(target, 'one!\ntwo\nthree\nfour')
    expect(view.state.selection.main.from).toBe(0)
    await draw({ line: 2, request: 2 }, 'one!\ntwo\nthree\nfour')
    expect(view.state.selection.main.from).toBe(view.state.doc.line(2).from)
  } finally { await act(async () => root.unmount()); host.remove() }
})

it('reports actual edits that can be applied to a peer document instead of replacing its text', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host), changed = vi.fn()
  try {
    await act(async () => root.render(<CodeView value={'one\ntwo\nthree'} onChange={changed} dark={false} look={{ fontFamily: 'monospace', fontSize: 13, lineHeight: 1.5 }} />))
    const view = EditorView.findFromDOM(host.querySelector('.cm-content')!)!
    await act(async () => view.dispatch({ changes: [{ from: 0, insert: '!' }, { from: view.state.doc.length, insert: '!' }] }))
    expect(changed.mock.calls[0]?.[0]).toBe('!one\ntwo\nthree!')
    expect(changed.mock.calls[0]?.[1]('one\nTWO\nthree')).toBe('!one\nTWO\nthree!')
  } finally { await act(async () => root.unmount()); host.remove() }
})
