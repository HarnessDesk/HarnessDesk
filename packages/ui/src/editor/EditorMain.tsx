import { useEffect, useRef, useState } from 'react'
import type { RuntimeId } from '@harnessdesk/protocol'
import { ConfirmDialog, ToolPane, ToolPaneMessage } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { sanitizeText } from '../lib/sanitize'
import { FileView, type FileSaveHandle } from './FileView'
import { FileTabs } from './FileTabs'
import { editorConversation } from './state'
import styles from './EditorMain.module.css'

/** Conversation metadata and drafts live in the store, beyond this main surface's lifetime. */
export const EditorMain = ({ subject, runtime, root }: { readonly subject: string; readonly runtime: RuntimeId; readonly root: string | null }) => {
  const store = useStore(), snapshot = useSnapshot()
  const state = editorConversation(snapshot.editorState, subject)
  const tab = state.tabs.find(one => one.path === state.active)
  const files = snapshot.editorDocuments.get(subject)
  const [closing, setClosing] = useState<{ subject: string; path: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const save = useRef<FileSaveHandle>(null)
  const currentSubject = useRef(subject); currentSubject.current = subject
  useEffect(() => { setClosing(null); setBusy(false) }, [subject])
  const question = closing?.subject === subject && closing.path === state.active ? closing : null
  useEffect(() => { if (closing && !question) setClosing(null) }, [closing, question])
  const close = (path: string) => {
    if (store.closeEditorFile(subject, path)) return
    store.selectEditorFile(subject, path)
    setClosing({ subject, path })
  }
  const saveAndClose = async () => {
    if (!question || busy || editorConversation(store.getSnapshot().editorState, question.subject).active !== question.path) return
    setBusy(true)
    const saved = await save.current?.save()
    if (currentSubject.current !== question.subject) return
    if (saved) store.closeEditorFile(question.subject, question.path)
    // A refusal belongs to FileView's error/conflict surface; keep its draft open.
    setClosing(null); setBusy(false)
  }
  return <div className={styles.main} data-slot="editor-main">
    {state.tabs.length > 0 && <FileTabs tabs={state.tabs} active={state.active} preview={state.preview}
      dirty={new Set(files?.keys())} onSelect={path => store.selectEditorFile(subject, path)}
      onKeep={path => store.keepEditorFile(subject, path)} onClose={close} />}
    {tab ? <FileView key={`${subject}:${tab.path}`} saveRef={save} path={tab.path} runtime={runtime} root={root} subject={subject}
      view={tab.view} onViewChange={view => store.setEditorFileView(subject, tab.path, view)} document={files?.get(tab.path)}
      liveDocument={snapshot.editorLiveDocuments.get(subject)?.has(tab.path) ? snapshot.editorLiveDocuments.get(subject)?.get(tab.path) : files?.get(tab.path)}
      readLiveDocument={() => {
        const latest = store.getSnapshot(), document = latest.editorLiveDocuments.get(subject)?.get(tab.path)
        return document === undefined ? latest.editorDocuments.get(subject)?.get(tab.path) : document
      }}
      onLiveDocumentChange={document => store.setEditorLiveDocument(subject, tab.path, document)}
      lineTarget={snapshot.editorLineTargets.get(subject)?.get(tab.path)}
      onLineTargetReached={request => store.clearEditorLineTarget(subject, tab.path, request)} />
      : <ToolPane variant="integrated"><ToolPaneMessage>No file open. Pick one in the Explorer, or press ⌘P.</ToolPaneMessage></ToolPane>}
    {question && <ConfirmDialog title={`Save changes to ${sanitizeText(question.path.split('/').pop() ?? question.path)}?`}
      confirmLabel="Save" busy={busy} busyLabel="Saving…" cancelLabel="Cancel"
      onConfirm={() => { void saveAndClose() }} onCancel={() => { if (!busy) setClosing(null) }}
      alternative={{ label: "Don't save", onClick: () => { store.closeEditorFile(question.subject, question.path, true); setClosing(null) } }}>
      Your unsaved changes will be lost if you close this file without saving.
    </ConfirmDialog>}
  </div>
}
