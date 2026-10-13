import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { expect, it, vi } from 'vitest'
import { runtimeId } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { FileView } from './FileView'

vi.mock('../lib/coalesce', () => ({ coalesce: (fn: () => void) => fn }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

it.each(['\n', '\r\n'])('keeps both cursors while a shared %j file receives consecutive edits and saves', async newline => {
  await import('./CodeView')
  const store = new AppStore('ws://localhost:0/'), subject = 'session:fake:one', path = '/work/file.txt'
  let disk = { kind: 'text', content: `one${newline}two${newline}`, hash: 'read-hash', truncated: false }
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: any) => {
    if (method === 'workspace/readFile') return disk
    if (method === 'workspace/stat') return { modifiedAt: 1 }
    if (method === 'file/save') { disk = { ...disk, content: params.content, hash: 'saved-hash' }; return { saved: true, hash: disk.hash } }
    return null
  }) as never)
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const draw = () => {
    const live = store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)
    root.render(<StoreProvider store={store}><FileView {...{ path, subject }} root={null} runtime={runtimeId('fake')}
      liveDocument={live} readLiveDocument={() => store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)}
      onLiveDocumentChange={document => store.setEditorLiveDocument(subject, path, document)} /></StoreProvider>)
  }
  const unsubscribe = store.subscribe(draw)
  try {
    await act(async () => draw())
    await vi.waitFor(() => expect(host.querySelector('.cm-content')).not.toBeNull())
    const view = EditorView.findFromDOM(host.querySelector('.cm-content')!)!
    await act(async () => view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(4)]) }))
    for (const character of ['!', '?']) {
      await act(async () => view.dispatch(view.state.replaceSelection(character)))
      expect(view.state.selection.ranges).toHaveLength(2)
    }
    expect(view.state.doc.toString()).toBe('!?one\n!?two\n')
    expect(store.getSnapshot().editorLiveDocuments.get(subject)?.get(path)).toMatchObject({ content: `!?one${newline}!?two${newline}` })
    const save = [...host.querySelectorAll('button')].find(button => button.textContent === 'Unsaved · Save ⌘S')!
    await act(async () => save.click())
    expect(request).toHaveBeenCalledWith('file/save', expect.objectContaining({ content: `!?one${newline}!?two${newline}`, expectedHash: 'read-hash' }))
    expect(view.state.selection.ranges).toHaveLength(2)
  } finally { unsubscribe(); await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() }
})
