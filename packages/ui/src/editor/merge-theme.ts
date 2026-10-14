import { EditorView } from '@codemirror/view'

/** The same paired diff fills and inks as DiffView; no theme-specific colours. */
export const mergeTheme = EditorView.theme({
  '&.cm-merge-b .cm-changedLine': { backgroundColor: 'var(--hd-code-add-fill)' },
  '.cm-deletedChunk': { backgroundColor: 'var(--hd-code-remove-fill)', paddingLeft: '0' },
  '&.cm-merge-b .cm-changedText, .cm-deletedChunk .cm-deletedText': { background: 'none' },
  '&.cm-merge-b .cm-deletedText': { background: 'none' },
  '.cm-changeGutter': { width: '2ch', paddingLeft: '0' },
  '&.cm-merge-b .cm-changedLineGutter': { background: 'var(--hd-code-add-fill)', color: 'var(--hd-success-ink)' },
  '.cm-deletedLineGutter': { background: 'var(--hd-code-remove-fill)', color: 'var(--hd-danger-ink)' },
  '.cm-changedLineGutter::before': { content: '"+"' },
  '.cm-deletedLineGutter::before': { content: '"−"' },
  // The gutter carries the sign, as it does for an added line; the text lines up with the added text beside it.
  '.cm-deletedLine': { paddingLeft: 'var(--hd-space-4)' },
})
