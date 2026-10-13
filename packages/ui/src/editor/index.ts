import { lazy } from 'react'

/** The editor's public boundary. CodeMirror loads only when a view mounts. */
export const CodeView = lazy(async () => ({ default: (await import('./CodeView')).CodeView }))
export type { CodeViewProps } from './CodeView'
export const MergeView = lazy(async () => ({ default: (await import('./MergeView')).MergeView }))
export type { MergeViewProps } from './MergeView'
export { MarkdownView, type MarkdownViewProps } from './MarkdownView'
export { countTextChanges, type ChangeCounts } from './counts'
export { readHead, reverseTextPatch, type HeadFile, type HeadRequest, type ReadHeadOptions } from './head'
export type { EditorLook } from './languages'
export {
  CANDIDATE_FACES,
  DEFAULT_EDITOR_PREFS,
  FONT_SIZES,
  INHERITED_CODE_FACE,
  TAB_SIZES,
  editorLook,
  installedFaces,
  readEditorPrefs,
  type EditorPrefs,
} from './prefs'

export { DiffView, type DiffViewProps } from './DiffView'
export {
  asAdditions,
  asRemovals,
  countChanges,
  countDrawn,
  countFileChange,
  drawnWhole,
  linesIn,
  parseDiff,
  splitByFile,
  splitHunks,
  wholeFileOf,
  wholeTextDiff,
  type DiffHunk,
  type DiffLine,
  type FileDiff,
  type LineKind,
  type WholeFile,
} from './diff'

export { FileView, type FileSaveHandle, type FileViewProps, type FileViewMode, type FileBase, type FileDocumentState, type FileTransfer } from './FileView'
export {
  emptyEditorConversation, editorConversation, updateEditorConversation, effectiveWindowMode, effectiveExplorerFilter,
  defaultFileView, openEditorTab, keepEditorTab, closeEditorTab, setEditorTabView,
  readEditorState, persistEditorState,
  type WindowMode, type ExplorerFilter, type EditorTab, type EditorConversation,
  type EditorState, type EditorDocuments, type OpenEditorTabOptions,
} from './state'
export { explorerChanges, explorerRows, explorerPath, type ExplorerEntry, type ExplorerChange, type ExplorerTreeRow, type ExplorerLetter } from './explorer-tree'
export { Explorer } from './Explorer'
export { FileTabs } from './FileTabs'
export { EditorMain } from './EditorMain'

export { requestAskInChat } from './ask'
