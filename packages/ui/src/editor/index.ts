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
