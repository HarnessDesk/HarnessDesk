import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { expect, it, vi } from 'vitest'
import { CodeView } from './CodeView'

vi.mock('@replit/codemirror-minimap', () => { throw new Error('Optional chunk unavailable') })
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('keeps the primary editor usable when the optional minimap import rejects', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const onChange = vi.fn()
  const render = async (minimap: boolean) => act(async () => root.render(<CodeView value="current draft" dark={false} look={{ fontFamily: 'monospace', fontSize: 13, lineHeight: 1.55 }} minimap={minimap} onChange={onChange} />))
  try {
    await render(false)
    const view = EditorView.findFromDOM(host.querySelector('.cm-content')!)!
    await render(true)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(EditorView.findFromDOM(host.querySelector('.cm-content')!)).toBe(view)
    expect(host.querySelector('.cm-minimap-gutter')).toBeNull()
    await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: ' still editable' } }))
    expect(onChange).toHaveBeenLastCalledWith('current draft still editable', expect.any(Function))
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
