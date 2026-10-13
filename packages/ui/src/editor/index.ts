import { lazy } from 'react'

/** The editor's public boundary. CodeMirror loads only when a view mounts. */
export const CodeView = lazy(async () => ({ default: (await import('./CodeView')).CodeView }))
export type { CodeViewProps } from './CodeView'
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
